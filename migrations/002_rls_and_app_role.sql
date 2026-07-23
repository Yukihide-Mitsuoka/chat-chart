-- RLS policies + the application role (system-design.md §3.3; mechanics proven
-- on stock Postgres 16 in spikes/rls-isolation, LOG-0032 — Neon runs stock
-- Postgres, so behavior is identical).
--
-- app_runtime is created NOLOGIN here because a password cannot appear in a
-- committed file (GR-001); the migration runner enables LOGIN with the
-- password from the environment. FORCE ROW LEVEL SECURITY subjects even the
-- table owner, but the app must still connect as app_runtime — a non-owner
-- cannot ALTER the policies it is constrained by.

do $$
begin
  if not exists (select from pg_roles where rolname = 'app_runtime') then
    create role app_runtime nologin;
  end if;
end $$;

do $$
declare
  t   text;
  col text;
begin
  foreach t in array array[
    'tenants','users','roles','role_permissions','user_roles',
    'reports','report_queries','role_reports','datasources',
    'audit_logs','revocation_events'
  ] loop
    col := case when t = 'tenants' then 'id' else 'tenant_id' end;
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    -- USING filters reads; WITH CHECK blocks writing into another tenant.
    -- nullif(..., '') is load-bearing on a connection pooler: once the GUC has
    -- been set in a session, a later request that does NOT set it gets '' back
    -- from current_setting, and ''::uuid would ERROR. Mapping '' → NULL keeps
    -- an unset tenant fail-closed (NULL = no rows) instead of throwing.
    execute format(
      $p$create policy tenant_isolation on %I
           using (%I = nullif(current_setting('app.tenant_id', true), '')::uuid)
           with check (%I = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$,
      t, col, col
    );
  end loop;
end $$;

-- Least privilege: reads for authz resolution, writes only where the runtime
-- writes. No DELETE anywhere (retention/off-boarding is an owner operation).
grant usage on schema public to app_runtime;
grant select on tenants, users, roles, role_permissions, user_roles,
                reports, report_queries, role_reports, datasources,
                permissions, vendor_keys
  to app_runtime;
grant insert on audit_logs, revocation_events to app_runtime;
grant update (auth_epoch) on tenants to app_runtime;
grant update (auth_epoch) on users   to app_runtime;
grant update (report_version) on reports     to app_runtime;
grant update (data_version)   on datasources to app_runtime;
