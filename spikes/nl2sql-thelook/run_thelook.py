"""NL→SQL accuracy spike on a REAL messy schema: BigQuery thelook_ecommerce.

Follow-up to spikes/nl2sql-accuracy (synthetic, 12/12): validates the same
pipeline against a public dataset we did not design, with real-world traps —
4 nullable date columns, 3 price columns, category vs department, free-text
statuses, BigQuery dialect + full table qualification.

Verification: SQL-vs-SQL, same run. thelook is a living dataset, so the
hand-written gold SQL and the model SQL both execute in the same session and
their result sets are compared. (No cross-day caching.)

Usage:
  ../nl2sql-accuracy/.venv/bin/python run_thelook.py --project kotonoha-bi-dev
  # options: --model (default gemini-3.5-flash), --provider anthropic (Opus fallback)

Guards: SELECT-only, thelook-only table references, maximum_bytes_billed cap.
"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).parent
DATASET = "bigquery-public-data.thelook_ecommerce"
MAX_BYTES_BILLED = 200 * 1024 * 1024  # 200MB — whole dataset is far smaller

# USD per 1M tokens (input, output). Gemini price is an ESTIMATE — verify on GCP billing.
PRICING = {
    "gemini-3.5-flash": (0.30, 2.50),
    "gemini-2.5-flash": (0.30, 2.50),
    "gemini-flash-latest": (0.30, 2.50),
    "claude-opus-4-8": (5.00, 25.00),
}
PRICE_ESTIMATE = {"gemini-3.5-flash", "gemini-2.5-flash", "gemini-flash-latest"}
USD_JPY = 155.0
DEFAULT_MODEL = {"gemini": "gemini-3.5-flash", "anthropic": "claude-opus-4-8"}

# Hand-transcribed from `bq show` (2026-07-17). All 7 tables on purpose —
# noise tables (events, inventory_items with denormalized product_* columns)
# are part of the realism: the model must pick the right tables.
SCHEMA_DDL = """
-- dataset: bigquery-public-data.thelook_ecommerce (BigQuery, US)
CREATE TABLE orders (
  order_id INT64, user_id INT64, status STRING,      -- status: 'Cancelled'|'Complete'|'Processing'|'Returned'|'Shipped'
  gender STRING, created_at TIMESTAMP,               -- 注文作成日時
  returned_at TIMESTAMP, shipped_at TIMESTAMP, delivered_at TIMESTAMP,  -- 未発生はNULL
  num_of_item INT64
);
CREATE TABLE order_items (
  id INT64, order_id INT64, user_id INT64, product_id INT64, inventory_item_id INT64,
  status STRING,                                     -- 明細status(ordersと同じ値域)
  created_at TIMESTAMP, shipped_at TIMESTAMP, delivered_at TIMESTAMP, returned_at TIMESTAMP,
  sale_price FLOAT64                                 -- 実売単価(1明細=1個)
);
CREATE TABLE products (
  id INT64, cost FLOAT64, category STRING, name STRING, brand STRING,
  retail_price FLOAT64, department STRING,           -- department: 'Women'|'Men'
  sku STRING, distribution_center_id INT64
);
CREATE TABLE users (
  id INT64, first_name STRING, last_name STRING, email STRING, age INT64, gender STRING,
  state STRING, street_address STRING, postal_code STRING, city STRING, country STRING,
  latitude FLOAT64, longitude FLOAT64, traffic_source STRING, created_at TIMESTAMP
);
CREATE TABLE distribution_centers ( id INT64, name STRING, latitude FLOAT64, longitude FLOAT64 );
CREATE TABLE inventory_items (
  id INT64, product_id INT64, created_at TIMESTAMP, sold_at TIMESTAMP, cost FLOAT64,
  product_category STRING, product_name STRING, product_brand STRING,
  product_retail_price FLOAT64, product_department STRING, product_sku STRING,
  product_distribution_center_id INT64
);
CREATE TABLE events (
  id INT64, user_id INT64, sequence_number INT64, session_id STRING, created_at TIMESTAMP,
  ip_address STRING, city STRING, state STRING, postal_code STRING, browser STRING,
  traffic_source STRING, uri STRING, event_type STRING
);
"""

PROMPT_RULES = f"""あなたはBIシステムのSQL生成アシスタントです。ユーザーの質問をBigQuery標準SQLに変換します。

# スキーマ
{SCHEMA_DDL}

# コンテキスト
- 今日の日付: 2026-07-16
- テーブル参照は必ず `bigquery-public-data.thelook_ecommerce.<table>` と完全修飾すること。

# ビジネスルール(必ず従うこと)
- 「売上」= order_items.sale_price の合計。status = 'Complete' のみ。期間判定は order_items.created_at 基準。
- 「返品額」= order_items で status = 'Returned' の sale_price 合計。期間判定は returned_at 基準。
- 「粗利」= 売上 − 原価。原価は販売した商品の products.cost。
- 「注文件数」= orders の行数。created_at 基準。status = 'Cancelled' は除く。
- 「カテゴリ」= products.category。「部門」= products.department。
- 「上半期」= 1月〜6月。「Q2」= 4月〜6月。「前月比」= (当月 − 前月) / 前月 × 100。
- 「直近30日間」= 今日を含む過去30日(2026-06-17 〜 2026-07-16)。
- 上記ルールまたは質問文が明示的に要求している条件以外の絞り込みを勝手に追加しないこと。特に、事象(配達完了・発送・返品など)について問われた場合は該当する日時列だけで判定し、質問に無い status 条件を足さないこと。
- 質問が曖昧でSQLを一意に決められない場合は、推測せずに確認質問を返すこと。

# 出力形式(JSONのみを出力)
SQLを生成する場合:      {{"action": "sql", "sql": "SELECT ..."}}
確認質問を返す場合:      {{"action": "clarify", "question": "..."}}
対応できない場合:        {{"action": "refuse", "reason": "..."}}
"""

_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["sql", "clarify", "refuse"]},
        "sql": {"type": "string"},
        "question": {"type": "string"},
        "reason": {"type": "string"},
    },
    "required": ["action"],
}


# ---------- generation (same provider policy as nl2sql-accuracy) ----------

def make_client(args):
    if args.provider == "gemini":
        from google import genai
        return "gemini", genai.Client(vertexai=True, project=args.project,
                                      location=args.region)
    from anthropic import AnthropicVertex
    return "anthropic", AnthropicVertex(project_id=args.project, region=args.region)


def generate(provider, client, question: str, model: str):
    if provider == "gemini":
        from google.genai import types
        resp = client.models.generate_content(
            model=model, contents=question,
            config=types.GenerateContentConfig(
                system_instruction=PROMPT_RULES,
                response_mime_type="application/json",
                response_schema={**_JSON_SCHEMA,
                                 "propertyOrdering": ["action", "sql", "question", "reason"]},
                temperature=0,
            ),
        )
        um = resp.usage_metadata
        return json.loads(resp.text), {
            "input_tokens": um.prompt_token_count or 0,
            "output_tokens": um.candidates_token_count or 0,
            "cache_read": getattr(um, "cached_content_token_count", 0) or 0,
            "cache_write": 0,
        }
    resp = client.messages.create(
        model=model, max_tokens=2048, thinking={"type": "adaptive"},
        system=[{"type": "text", "text": PROMPT_RULES,
                 "cache_control": {"type": "ephemeral"}}],
        messages=[{"role": "user", "content": question}],
        output_config={"format": {"type": "json_schema",
                                  "schema": {**_JSON_SCHEMA, "additionalProperties": False}}},
    )
    text = next(b.text for b in resp.content if b.type == "text")
    u = resp.usage
    return json.loads(text), {
        "input_tokens": u.input_tokens, "output_tokens": u.output_tokens,
        "cache_read": u.cache_read_input_tokens, "cache_write": u.cache_creation_input_tokens,
    }


def cost_jpy(model: str, u: dict) -> float:
    pin, pout = PRICING[model]
    usd = (u["input_tokens"] * pin + u["cache_write"] * pin * 1.25
           + u["cache_read"] * pin * 0.1 + u["output_tokens"] * pout) / 1e6
    return usd * USD_JPY


# ---------- BigQuery execution (guarded) ----------

def exec_bq(bq, sql: str):
    """Execute read-only against BigQuery; returns (rows, error)."""
    from google.cloud import bigquery

    s = sql.strip().rstrip(";")
    if not re.match(r"^(select|with)\b", s, re.I):
        return None, "rejected: not a SELECT"
    if re.search(r"\b(insert|update|delete|drop|create|merge|alter|call|export|grant)\b",
                 re.sub(r"'[^']*'", "", s), re.I):
        return None, "rejected: forbidden keyword"
    if DATASET not in s.replace("`", ""):
        return None, "rejected: must fully-qualify thelook_ecommerce tables"
    # any other project.dataset reference → reject
    for m in re.finditer(r"`?([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_]+)\.[a-zA-Z0-9_]+`?", s):
        if f"{m.group(1)}.{m.group(2)}" != DATASET:
            return None, f"rejected: foreign table ref {m.group(0)}"
    try:
        job = bq.query(s, job_config=bigquery.QueryJobConfig(
            maximum_bytes_billed=MAX_BYTES_BILLED, use_query_cache=True))
        return [tuple(r.values()) for r in job.result(timeout=60)], None
    except Exception as e:
        return None, f"bq error: {str(e)[:200]}"


# ---------- comparison (same semantics as nl2sql-accuracy, money→2dp) ----------

def _norm(c):
    if isinstance(c, float):
        return round(c, 2)
    return c


def compare(kind: str, got_rows, want_rows):
    got = [tuple(_norm(c) for c in r) for r in got_rows]
    want = [tuple(_norm(c) for c in r) for r in want_rows]
    if kind == "scalar":
        if len(got) == 1 and len(got[0]) == 1 and len(want) == 1:
            g, w = got[0][0], want[0][0]
            if isinstance(g, float) or isinstance(w, float):
                ok = abs(float(g) - float(w)) <= 0.02  # float-sum ordering noise
            else:
                ok = g == w
            return ok, f"got={g} want={w}"
        return False, f"expected 1x1, got {got[:3]} want {want[:3]}"
    if kind == "scalar_pct":
        if len(got) == 1 and len(got[0]) == 1 and len(want) == 1:
            ok = abs(float(got[0][0]) - float(want[0][0])) <= 0.05
            return ok, f"got={got[0][0]} want={want[0][0]}"
        return False, f"expected 1x1 numeric, got {got[:3]}"
    if kind == "rows_ordered":
        return got == want, f"got={got[:4]}... want={want[:4]}..."
    raise ValueError(kind)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--provider", choices=["gemini", "anthropic"], default="gemini")
    ap.add_argument("--model", help="override model id (default per provider)")
    ap.add_argument("--project", required=True, help="GCP project_id (billing/quota)")
    ap.add_argument("--region", default="global", help="Vertex region")
    args = ap.parse_args()
    model = args.model or DEFAULT_MODEL[args.provider]

    from google.cloud import bigquery
    bq = bigquery.Client(project=args.project)
    provider, client = make_client(args)

    spec = json.loads((HERE / "questions.json").read_text())
    results, total_cost = [], 0.0
    for q in spec["questions"]:
        try:
            ans, usage = generate(provider, client, q["text"], model)
        except Exception as e:
            results.append((q, "ERROR", f"api error: {str(e)[:160]}", None))
            continue
        total_cost += cost_jpy(model, usage)
        action = ans.get("action")

        if q["expect"] == "clarify":
            ok = action == "clarify"
            results.append((q, "PASS" if ok else "FAIL",
                            f"action={action}" + ("" if ok else f" sql={ans.get('sql','')[:100]}"),
                            usage))
            continue
        if action != "sql":
            results.append((q, "FAIL", f"expected sql, got action={action} "
                            f"({ans.get('question') or ans.get('reason') or ''})"[:160], usage))
            continue

        got, err = exec_bq(bq, ans["sql"])
        if err:
            results.append((q, "FAIL", f"model sql: {err}", usage))
            continue
        want, gerr = exec_bq(bq, q["gold_sql"])
        if gerr:
            results.append((q, "GOLD_ERR", f"gold sql broken: {gerr}", usage))
            continue
        ok, detail = compare(q["compare"], got, want)
        results.append((q, "PASS" if ok else "FAIL", detail, usage))

    n = len(results)
    passed = len([r for r in results if r[1] == "PASS"])
    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"# NL→SQL thelook run — {stamp} — {provider} ({model})", "",
             f"**{passed}/{n} PASS** — real schema: `{DATASET}` (SQL-vs-SQL, same-run)", "",
             "| Q | category | verdict | detail |", "|---|---|---|---|"]
    for q, verdict, detail, usage in results:
        d = str(detail).replace("|", "\\|")[:170]
        lines.append(f"| {q['id']} | {q['category']} | {verdict} | {d} |")
    est = " — ⚠️ Gemini price is an ESTIMATE, confirm on GCP billing" if model in PRICE_ESTIMATE else ""
    lines += ["", f"**Total measured LLM cost: ~¥{total_cost:.4f}** "
                  f"(~¥{total_cost / n:.4f}/question @{USD_JPY} JPY/USD){est}"]
    report = "\n".join(lines) + "\n"
    out = HERE / "results" / f"run-{datetime.datetime.now():%Y%m%d-%H%M%S}.md"
    out.parent.mkdir(exist_ok=True)
    out.write_text(report)
    print(report)
    print(f"written: {out}")
    return 0 if passed == n else 1


if __name__ == "__main__":
    sys.exit(main())
