"""Expected answers computed in pure Python — deliberately WITHOUT SQL.

If generated SQL and these computations agree, that is genuine
two-implementation verification. Business rules mirror the ones given to the
model in the prompt (see run_spike.py PROMPT_RULES).
"""

from __future__ import annotations

from collections import defaultdict

import seed

TENANT = "t_alpha"


def _data():
    d = seed.generate()
    orders = {o["order_id"]: o for o in d["orders"] if o["tenant_id"] == TENANT}
    items = [i for i in d["order_items"] if i["tenant_id"] == TENANT]
    stores = {s["store_id"]: s for s in d["stores"] if s["tenant_id"] == TENANT}
    products = {p["product_id"]: p for p in d["products"] if p["tenant_id"] == TENANT}
    return orders, items, stores, products


def _confirmed_sales(date_from: str, date_to: str):
    """Yield (order, item, amount) for confirmed orders with confirmed_at date
    in [date_from, date_to] (inclusive, date part only)."""
    orders, items, _, _ = _data()
    for it in items:
        o = orders[it["order_id"]]
        if o["status"] != "confirmed" or not o["confirmed_at"]:
            continue
        day = o["confirmed_at"][:10]
        if date_from <= day <= date_to:
            yield o, it, it["quantity"] * it["unit_price"]


def q1_sales_june_2026():
    """2026年6月の売上合計 (scalar int)"""
    return sum(amt for _, _, amt in _confirmed_sales("2026-06-01", "2026-06-30"))


def q2_order_count_this_month():
    """今月(2026年7月)の注文件数: ordered_at基準, cancelled除外 (scalar int)"""
    orders, _, _, _ = _data()
    return sum(
        1 for o in orders.values()
        if o["status"] != "cancelled" and o["ordered_at"][:7] == "2026-07"
    )


def q3_sales_by_store_h1_2026():
    """2026年上半期の店舗別売上、降順 [(store_name, sales), ...]"""
    _, _, stores, _ = _data()
    agg = defaultdict(int)
    for o, _, amt in _confirmed_sales("2026-01-01", "2026-06-30"):
        agg[o["store_id"]] += amt
    rows = [(stores[sid]["name"], v) for sid, v in agg.items()]
    return sorted(rows, key=lambda r: -r[1])


def q4_top3_categories_q2_2026():
    """2026年Q2(4-6月)のカテゴリ別売上トップ3 [(category, sales), ...]"""
    orders, items, _, products = _data()
    agg = defaultdict(int)
    for _, it, amt in _confirmed_sales("2026-04-01", "2026-06-30"):
        agg[products[it["product_id"]]["category"]] += amt
    return sorted(agg.items(), key=lambda r: -r[1])[:3]


def q5_monthly_sales_2025():
    """2025年の月別売上 [(\"2025-01\", sales), ... ] 昇順12行"""
    agg = defaultdict(int)
    for o, _, amt in _confirmed_sales("2025-01-01", "2025-12-31"):
        agg[o["confirmed_at"][:7]] += amt
    return sorted(agg.items())


def q6_sales_last_30_days():
    """直近30日間(今日を含む30日: 2026-06-17〜2026-07-16)の売上合計 (scalar int)"""
    return sum(amt for _, _, amt in _confirmed_sales("2026-06-17", "2026-07-16"))


def q7_mom_growth_may_2026():
    """2026年5月売上の前月比(%) 小数1位 (scalar float)"""
    may = sum(a for _, _, a in _confirmed_sales("2026-05-01", "2026-05-31"))
    apr = sum(a for _, _, a in _confirmed_sales("2026-04-01", "2026-04-30"))
    return round((may - apr) / apr * 100, 1)


def q12_top3_products_by_qty_june_2026():
    """2026年6月に数量ベースで最も売れた商品トップ3 [(product_name, qty), ...]

    Top-3 chosen deliberately: quantities 47/46/41 with next rank at 40 —
    no tie at the boundary, so LIMIT-based SQL cannot be unfairly marked wrong.
    (Rank 5 had a 33/33 tie; a top-5 question would be ambiguous.)
    """
    _, _, _, products = _data()
    agg = defaultdict(int)
    for _, it, _ in _confirmed_sales("2026-06-01", "2026-06-30"):
        agg[it["product_id"]] += it["quantity"]
    rows = [(products[pid]["name"], q) for pid, q in agg.items()]
    return sorted(rows, key=lambda r: (-r[1], r[0]))[:3]


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("q") and callable(fn):
            print(f"{name}: {fn()}")
