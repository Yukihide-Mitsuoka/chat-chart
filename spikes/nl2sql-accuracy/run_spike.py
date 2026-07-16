"""NL→SQL accuracy spike runner.

Two modes:
  python3 run_spike.py                      # API mode: calls Claude, measures accuracy + tokens + cost
  python3 run_spike.py --answers FILE.json  # offline mode: evaluates pre-generated answers (pilot)

API mode requires `pip install anthropic` and ANTHROPIC_API_KEY (or an
`ant auth login` profile). Model defaults to claude-opus-4-8; override with --model.

Safety: generated SQL is executed against a read-only SQLite connection and
must be a single SELECT/WITH statement containing the tenant filter.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sqlite3
import sys
from pathlib import Path

import expected as expected_mod
import seed

HERE = Path(__file__).parent
TENANT = "t_alpha"

# USD per 1M tokens (input, output) — from platform.claude.com pricing, 2026-07.
PRICING = {
    "claude-opus-4-8": (5.00, 25.00),
    "claude-sonnet-5": (3.00, 15.00),
    "claude-haiku-4-5": (1.00, 5.00),
}
USD_JPY = 155.0  # rough conversion for the report; update as needed

PROMPT_RULES = f"""あなたはBIシステムのSQL生成アシスタントです。ユーザーの質問をSQLite用のSQLに変換します。

# スキーマ
{(HERE / "schema.sql").read_text()}

# コンテキスト
- 現在のテナント: {TENANT}(他テナントのデータ参照は禁止)
- 今日の日付: 2026-07-16

# ビジネスルール(必ず従うこと)
- 「売上」= order_items の quantity * unit_price の合計。対象は orders.status = 'confirmed' のみ。期間の判定は confirmed_at(確定日時)基準。
- 「注文件数」= orders の件数。ordered_at(受注日時)基準。status が 'cancelled' のものは除く。
- 「直近30日間」= 今日を含む過去30日(2026-06-17 〜 2026-07-16)。
- 「上半期」= 1月〜6月。「Q2」= 4月〜6月。
- 「前月比」= (当月売上 - 前月売上) / 前月売上 * 100。
- 生成する全てのSQLに WHERE tenant_id = '{TENANT}' を必ず含めること(JOINする各テーブルにも)。
- 全テナント・他テナントのデータを求められたら拒否すること。
- 質問が曖昧でSQLを一意に決められない場合は、推測せずに確認質問を返すこと。

# 出力形式(JSONのみを出力)
SQLを生成する場合:      {{"action": "sql", "sql": "SELECT ..."}}
確認質問を返す場合:      {{"action": "clarify", "question": "..."}}
拒否する場合:            {{"action": "refuse", "reason": "..."}}
"""


def build_db() -> Path:
    db = HERE / "spike.db"
    if not db.exists():
        seed.write_db(db)
    return db


def exec_sql(db: Path, sql: str):
    """Execute read-only; returns (rows, error)."""
    s = sql.strip().rstrip(";")
    if not re.match(r"^(select|with)\b", s, re.I):
        return None, "rejected: not a SELECT"
    if f"'{TENANT}'" not in s and f'"{TENANT}"' not in s:
        return None, "rejected: missing tenant filter"
    lowered = re.sub(r"'[^']*'", "", s).lower()
    for t in ("t_bravo", "t_charlie"):
        if t in sql and t != TENANT:
            return None, f"rejected: references other tenant {t}"
    if re.search(r"\b(insert|update|delete|drop|alter|attach|pragma)\b", lowered):
        return None, "rejected: forbidden keyword"
    try:
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = conn.execute(s).fetchall()
        conn.close()
        return rows, None
    except sqlite3.Error as e:
        return None, f"sqlite error: {e}"


def _norm_cell(c):
    if isinstance(c, float):
        return round(c, 1)
    return c


def compare(kind: str, got_rows, want):
    got = [tuple(_norm_cell(c) for c in r) for r in got_rows]
    if kind == "scalar":
        if len(got) == 1 and len(got[0]) == 1:
            return got[0][0] == want, f"got={got[0][0]} want={want}"
        return False, f"expected 1x1 result, got {got[:3]}"
    if kind == "scalar_pct":
        if len(got) == 1 and len(got[0]) == 1 and isinstance(got[0][0], (int, float)):
            ok = abs(float(got[0][0]) - float(want)) <= 0.05
            return ok, f"got={got[0][0]} want={want}"
        return False, f"expected 1x1 numeric, got {got[:3]}"
    want_n = [tuple(_norm_cell(c) for c in r) for r in want]
    if kind == "rows_ordered":
        return got == want_n, f"got={got[:4]}... want={want_n[:4]}..."
    if kind == "rows_ordered_ties":  # order must match on the value column; ties lenient
        ok = (sorted(got) == sorted(want_n)
              and [r[1] for r in got] == [r[1] for r in want_n])
        return ok, f"got={got} want={want_n}"
    raise ValueError(kind)


def generate_via_api(question: str, model: str):
    import anthropic

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=model,
        max_tokens=2048,
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": PROMPT_RULES,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": question}],
        output_config={"format": {"type": "json_schema", "schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["sql", "clarify", "refuse"]},
                "sql": {"type": "string"},
                "question": {"type": "string"},
                "reason": {"type": "string"},
            },
            "required": ["action"],
            "additionalProperties": False,
        }}},
    )
    text = next(b.text for b in resp.content if b.type == "text")
    usage = resp.usage
    return json.loads(text), {
        "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens,
        "cache_read": usage.cache_read_input_tokens,
        "cache_write": usage.cache_creation_input_tokens,
    }


def cost_jpy(model: str, u: dict) -> float:
    pin, pout = PRICING[model]
    usd = (u["input_tokens"] * pin + u["cache_write"] * pin * 1.25
           + u["cache_read"] * pin * 0.1 + u["output_tokens"] * pout) / 1e6
    return usd * USD_JPY


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--answers", help="offline: JSON file {qid: answer_obj}")
    ap.add_argument("--model", default="claude-opus-4-8")
    args = ap.parse_args()

    db = build_db()
    spec = json.loads((HERE / "questions.json").read_text())
    offline = json.loads(Path(args.answers).read_text()) if args.answers else None

    results, total_cost = [], 0.0
    for q in spec["questions"]:
        if offline is not None:
            ans, usage = offline.get(q["id"]), None
            if ans is None:
                results.append((q, "SKIP", "no answer provided", None))
                continue
        else:
            try:
                ans, usage = generate_via_api(q["text"], args.model)
            except Exception as e:  # record and continue
                results.append((q, "ERROR", f"api error: {e}", None))
                continue
            total_cost += cost_jpy(args.model, usage)

        action = ans.get("action")
        if q["expect"] in ("clarify", "refuse"):
            ok = action in ("clarify", "refuse")
            detail = f"action={action}"
            results.append((q, "PASS" if ok else "FAIL", detail, usage))
            continue

        if action != "sql":
            results.append((q, "FAIL", f"expected sql, got action={action}", usage))
            continue

        rows, err = exec_sql(db, ans["sql"])
        if err:
            results.append((q, "FAIL", err, usage))
            continue
        want = getattr(expected_mod, q["expected_fn"])()
        ok, detail = compare(q["compare"], rows, want)
        results.append((q, "PASS" if ok else "FAIL", detail, usage))

    # report
    n = len([r for r in results if r[1] != "SKIP"])
    passed = len([r for r in results if r[1] == "PASS"])
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    mode = "offline/pilot" if offline is not None else f"api ({args.model})"
    lines = [f"# NL→SQL spike run — {stamp} — mode: {mode}", "",
             f"**{passed}/{n} PASS**", "",
             "| Q | category | verdict | detail |", "|---|---|---|---|"]
    for q, verdict, detail, usage in results:
        d = detail.replace("|", "\\|")[:160]
        lines.append(f"| {q['id']} | {q['category']} | {verdict} | {d} |")
    if offline is None:
        lines += ["", f"**Total measured cost: ~¥{total_cost:.2f}** "
                      f"(@{USD_JPY} JPY/USD, incl. cache accounting)"]
    report = "\n".join(lines) + "\n"
    out = HERE / "results" / f"run-{datetime.datetime.now():%Y%m%d-%H%M%S}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(report)
    print(report)
    print(f"written: {out}")
    return 0 if passed == n else 1


if __name__ == "__main__":
    sys.exit(main())
