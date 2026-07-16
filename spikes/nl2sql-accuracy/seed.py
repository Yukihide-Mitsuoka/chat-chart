"""Deterministic synthetic data for the NL→SQL accuracy spike.

generate() returns plain Python dicts (importable by expected.py so the
expected answers can be computed WITHOUT SQL — two-implementation agreement
is the correctness check). Running as a script writes spike.db.
"""

from __future__ import annotations

import datetime
import random
import sqlite3
from pathlib import Path

HERE = Path(__file__).parent
DB_PATH = HERE / "spike.db"

TENANTS = ["t_alpha", "t_bravo", "t_charlie"]
STORE_COUNTS = {"t_alpha": 3, "t_bravo": 2, "t_charlie": 4}
CATEGORIES = ["飲料", "食品", "雑貨", "日用品"]
REGIONS = ["東京", "大阪", "名古屋"]
PRICES = [120, 150, 200, 300, 450, 500, 800, 1200]

DATA_START = datetime.date(2025, 1, 1)
REFERENCE_DATE = datetime.date(2026, 7, 16)  # 「今日」


def generate() -> dict:
    rng = random.Random(42)
    stores, products, orders, items = [], [], [], []
    sid = pid = oid = iid = 1

    for tenant in TENANTS:
        tenant_stores = []
        for i in range(STORE_COUNTS[tenant]):
            stores.append(
                dict(store_id=sid, tenant_id=tenant, name=f"{tenant}_店舗{i + 1}",
                     region=rng.choice(REGIONS))
            )
            tenant_stores.append(sid)
            sid += 1

        tenant_products = []
        for i in range(12):
            products.append(
                dict(product_id=pid, tenant_id=tenant, name=f"{tenant}_商品{i + 1}",
                     category=CATEGORIES[i % 4], unit_price=rng.choice(PRICES))
            )
            tenant_products.append(pid)
            pid += 1

        days = (REFERENCE_DATE - DATA_START).days
        for _ in range(1500):
            d = DATA_START + datetime.timedelta(days=rng.randrange(days + 1))
            ordered = datetime.datetime(d.year, d.month, d.day,
                                        rng.randrange(9, 21), rng.randrange(60))
            r = rng.random()
            if r < 0.80:
                confirmed = ordered + datetime.timedelta(
                    days=rng.randrange(0, 6), hours=rng.randrange(0, 12))
                if confirmed.date() > REFERENCE_DATE:
                    # confirmation date can't be in the future yet
                    status, confirmed = "pending", None
                else:
                    status = "confirmed"
            elif r < 0.92:
                status, confirmed = "pending", None
            else:
                status, confirmed = "cancelled", None

            orders.append(
                dict(order_id=oid, tenant_id=tenant,
                     store_id=rng.choice(tenant_stores),
                     ordered_at=ordered.strftime("%Y-%m-%d %H:%M:%S"),
                     confirmed_at=confirmed.strftime("%Y-%m-%d %H:%M:%S") if confirmed else None,
                     status=status)
            )
            for _ in range(rng.randrange(1, 4)):
                p = products[rng.choice(tenant_products) - 1]
                items.append(
                    dict(order_item_id=iid, order_id=oid, tenant_id=tenant,
                         product_id=p["product_id"],
                         quantity=rng.randrange(1, 6), unit_price=p["unit_price"])
                )
                iid += 1
            oid += 1

    return dict(stores=stores, products=products, orders=orders, order_items=items)


def write_db(path: Path = DB_PATH) -> None:
    path.unlink(missing_ok=True)
    conn = sqlite3.connect(path)
    conn.executescript((HERE / "schema.sql").read_text())
    data = generate()
    conn.executemany("INSERT INTO tenants VALUES (?, ?)",
                     [(t, f"{t} 株式会社") for t in TENANTS])
    conn.executemany(
        "INSERT INTO stores VALUES (:store_id, :tenant_id, :name, :region)",
        data["stores"])
    conn.executemany(
        "INSERT INTO products VALUES (:product_id, :tenant_id, :name, :category, :unit_price)",
        data["products"])
    conn.executemany(
        "INSERT INTO orders VALUES (:order_id, :tenant_id, :store_id, :ordered_at, :confirmed_at, :status)",
        data["orders"])
    conn.executemany(
        "INSERT INTO order_items VALUES (:order_item_id, :order_id, :tenant_id, :product_id, :quantity, :unit_price)",
        data["order_items"])
    conn.commit()
    conn.close()
    print(f"wrote {path}")


if __name__ == "__main__":
    write_db()
