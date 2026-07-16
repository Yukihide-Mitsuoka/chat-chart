-- Synthetic multi-tenant retail schema for the NL→SQL accuracy spike.
-- Deliberately includes BOTH ordered_at (受注日時) and confirmed_at (確定日時)
-- to exercise the date-basis ambiguity identified in docs/discovery-log.md.

CREATE TABLE tenants (
    tenant_id TEXT PRIMARY KEY,
    name      TEXT NOT NULL
);

CREATE TABLE stores (
    store_id  INTEGER PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES tenants (tenant_id),
    name      TEXT NOT NULL,
    region    TEXT NOT NULL
);

CREATE TABLE products (
    product_id INTEGER PRIMARY KEY,
    tenant_id  TEXT NOT NULL REFERENCES tenants (tenant_id),
    name       TEXT NOT NULL,
    category   TEXT NOT NULL,
    unit_price INTEGER NOT NULL -- JPY
);

CREATE TABLE orders (
    order_id     INTEGER PRIMARY KEY,
    tenant_id    TEXT NOT NULL REFERENCES tenants (tenant_id),
    store_id     INTEGER NOT NULL REFERENCES stores (store_id),
    ordered_at   TEXT NOT NULL,           -- 受注日時 'YYYY-MM-DD HH:MM:SS'
    confirmed_at TEXT,                    -- 確定日時, NULL if pending/cancelled
    status       TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled'))
);

CREATE TABLE order_items (
    order_item_id INTEGER PRIMARY KEY,
    order_id      INTEGER NOT NULL REFERENCES orders (order_id),
    tenant_id     TEXT NOT NULL REFERENCES tenants (tenant_id),
    product_id    INTEGER NOT NULL REFERENCES products (product_id),
    quantity      INTEGER NOT NULL,
    unit_price    INTEGER NOT NULL -- price at time of order, JPY
);

CREATE INDEX idx_orders_tenant ON orders (tenant_id);
CREATE INDEX idx_items_tenant ON order_items (tenant_id);
CREATE INDEX idx_items_order ON order_items (order_id);
