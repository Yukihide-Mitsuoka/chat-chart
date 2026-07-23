-- Control-plane schema (system-design.md §3.2, production form of the draft).
-- Two zones: outside the tenant boundary (vendors, vendor_keys, permissions)
-- and tenant-owned tables, every one carrying tenant_id so a single uniform
-- RLS policy shape applies (002). Composite (tenant_id, id) uniques + FKs make
-- cross-tenant references unrepresentable at the schema level.

-- ============ outside the tenant boundary (no RLS) ============

create table vendors (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active'
              check (status in ('active','suspended')),
  created_at  timestamptz not null default now()
);

create table vendor_keys (            -- embed-JWT verification keys (public only, GR-001)
  vendor_id   uuid not null references vendors(id),
  kid         text not null,
  public_key  text not null,
  status      text not null default 'active'
              check (status in ('active','retired')),
  created_at  timestamptz not null default now(),
  primary key (vendor_id, kid)
);

create table permissions (            -- system-defined permission catalog
  key         text primary key,       -- 'report:view' | 'report:edit' | ...
  description text not null
);

-- ============ tenant-owned (uniform RLS in 002) ============

create table tenants (
  id          uuid primary key default gen_random_uuid(),
  vendor_id   uuid not null references vendors(id),
  name        text not null,
  status      text not null default 'active'
              check (status in ('active','suspended','closed')),
  auth_epoch  bigint not null default 0,
  created_at  timestamptz not null default now()
);

create table users (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id),
  external_subject text not null,     -- vendor-side user id (JWT sub)
  email            text,
  status           text not null default 'active'
                   check (status in ('active','disabled')),
  auth_epoch       bigint not null default 0,
  created_at       timestamptz not null default now(),
  unique (tenant_id, external_subject),
  unique (tenant_id, id)              -- composite-FK target
);

create table roles (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id),
  name        text not null,
  is_system   boolean not null default false,
  data_scope  jsonb not null default '{}'::jsonb,  -- normalized into scope_hash
  created_at  timestamptz not null default now(),
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table role_permissions (
  tenant_id      uuid not null,
  role_id        uuid not null,
  permission_key text not null references permissions(key),
  primary key (role_id, permission_key),
  foreign key (tenant_id, role_id) references roles (tenant_id, id)
    on delete cascade
);

create table user_roles (
  tenant_id  uuid not null,
  user_id    uuid not null,
  role_id    uuid not null,
  primary key (user_id, role_id),
  foreign key (tenant_id, user_id) references users (tenant_id, id)
    on delete cascade,
  foreign key (tenant_id, role_id) references roles (tenant_id, id)
    on delete cascade
);

create table reports (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  slug           text not null,
  title          text not null,
  definition_ref text not null,       -- where the shell definition lives
  report_version bigint not null default 1,   -- ① invalidation token (ADR-0005 §5)
  status         text not null default 'draft'
                 check (status in ('draft','published','archived')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, slug),
  unique (tenant_id, id)
);

create table report_queries (         -- QueryCatalog source: queryId → SQL text
  tenant_id  uuid not null,
  report_id  uuid not null,
  query_id   text not null,
  sql_text   text not null,
  primary key (report_id, query_id),
  foreign key (tenant_id, report_id) references reports (tenant_id, id)
    on delete cascade
);

create table role_reports (           -- allowed_reports
  tenant_id  uuid not null,
  role_id    uuid not null,
  report_id  uuid not null,
  primary key (role_id, report_id),
  foreign key (tenant_id, role_id)   references roles   (tenant_id, id)
    on delete cascade,
  foreign key (tenant_id, report_id) references reports (tenant_id, id)
    on delete cascade
);

create table datasources (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id),
  type           text not null check (type in ('bigquery')),  -- Phase 1
  dataset        text not null,       -- the tenant's dataset (① boundary fact)
  connection_ref text not null,       -- Secret Manager reference; never a credential
  data_version   bigint not null default 0,  -- ② invalidation token (ADR-0005 §5)
  status         text not null default 'active',
  created_at     timestamptz not null default now(),
  unique (tenant_id, id)
);

create table audit_logs (             -- insert-only
  id         bigint generated always as identity primary key,
  tenant_id  uuid not null references tenants(id),
  user_id    uuid,
  action     text not null,           -- 'query.execute' | 'query.refused' | ...
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table revocation_events (      -- SoR feeding the denylist KV
  id          bigint generated always as identity primary key,
  tenant_id   uuid not null references tenants(id),
  target_type text not null
              check (target_type in ('user','session','role','tenant')),
  target_id   text not null,
  reason      text,
  expires_at  timestamptz not null,   -- matches the JWT max TTL
  created_at  timestamptz not null default now()
);
