"""Regenerate the two tenant Parquet fixtures used by the dynamic-data spike.

Run after `npm run sources && npm run build` inside app/ (that produces
app/build/data/needful_things/orders/<hash>/orders.parquet — tenant A's
source of truth). This script copies it as tenant A, then derives a
schema-identical but content-different tenant B (fewer categories, scaled
sales) so a byte-diff proves the gate serves genuinely different data.

Usage: python3 make_tenant_data.py
Requires: pip install duckdb
"""

from __future__ import annotations

import shutil
from pathlib import Path

import duckdb

HERE = Path(__file__).parent
BUILD_DATA = HERE / "app" / "build" / "data"
REL = "needful_things/orders/0710a0bd11ce3540d22511eef3ee8142/orders.parquet"


def main() -> None:
    src_build = BUILD_DATA / REL
    if not src_build.exists():
        raise SystemExit(f"missing {src_build} — run `npm run sources && npm run build` in app/ first")

    for tenant in ("tenant_a", "tenant_b"):
        (HERE / "data" / tenant / Path(REL).parent).mkdir(parents=True, exist_ok=True)
        shutil.copy(BUILD_DATA / "manifest.json", HERE / "data" / tenant / "manifest.json")
        shutil.copy(BUILD_DATA / Path(REL).parent / "orders.schema.json",
                    HERE / "data" / tenant / Path(REL).parent / "orders.schema.json")

    tenant_a = HERE / "data" / "tenant_a" / REL
    tenant_b = HERE / "data" / "tenant_b" / REL
    shutil.copy(src_build, tenant_a)

    con = duckdb.connect()
    con.execute(f"""
        COPY (
            SELECT * REPLACE (CAST(sales * 0.25 AS DOUBLE) AS sales)
            FROM read_parquet('{tenant_a}')
            WHERE category IN (
                SELECT DISTINCT category FROM read_parquet('{tenant_a}') ORDER BY category LIMIT 3
            )
        ) TO '{tenant_b}' (FORMAT PARQUET)
    """)

    a = con.execute(f"SELECT category, round(sum(sales)) s FROM read_parquet('{tenant_a}') GROUP BY 1 ORDER BY s DESC").fetchall()
    b = con.execute(f"SELECT category, round(sum(sales)) s FROM read_parquet('{tenant_b}') GROUP BY 1 ORDER BY s DESC").fetchall()
    print("tenant_a:", a)
    print("tenant_b:", b)


if __name__ == "__main__":
    main()
