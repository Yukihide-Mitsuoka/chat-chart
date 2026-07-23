-- System permission catalog (原則E②: the fixed vocabulary custom roles draw
-- from). Phase 1 ships the fixed three-tier roles built on these. Idempotent.

insert into permissions (key, description) values
  ('report:view',  'View published reports and their data'),
  ('report:edit',  'Create and edit report definitions (incl. AI-assisted)'),
  ('tenant:admin', 'Manage users, roles and datasource settings for the tenant')
on conflict (key) do nothing;
