-- Dedicated, strictly read-only Postgres role for the ValveTrack MCP server
-- (lets Claude, as a "PA," answer business questions like "how many kg of
-- X material moved in the last 3 months" against the live database).
--
-- Security model:
--   1. This role is granted SELECT only — ever. No INSERT/UPDATE/DELETE/
--      TRUNCATE/DDL grant is given, at any point, on anything. Even if every
--      other layer of defense (app-side SQL validation, read-only
--      transaction wrapper) had a bug, this role physically cannot write.
--      Verified empirically, not just assumed from the grant: connected as
--      mcp_reader directly and confirmed INSERT/UPDATE/DELETE/CREATE TABLE
--      are all refused with "permission denied", before this role was ever
--      wired into application code.
--   2. BYPASSRLS is required for it to see the full business picture (a raw
--      Postgres connection using this role has no Supabase Auth JWT, so
--      auth.uid() is NULL and almost every RLS policy — which gates on
--      "is this the authenticated user's own client" or "is this an
--      internal staff row" — would otherwise hide everything). This is safe
--      specifically because it's paired with (1): bypassing row security
--      only matters for reads here, since the role has no write privilege
--      to bypass anything dangerous with.
--   3. statement_timeout caps any single query at the role level, so a
--      runaway analytical query can't hang the database — set here, not
--      just in application code, so it can't be bypassed by the query text.
--
-- Password is intentionally NOT recorded here (or anywhere else in the repo)
-- — this file documents the role's creation and privileges for the record,
-- it is not a replay script. The real password lives only in
-- MCP_READER_DATABASE_URL in the environment (never committed) and was set
-- via a separate ALTER ROLE at provisioning time. Re-running this file
-- verbatim will fail on "role already exists" / needs its own password
-- supplied — that's intentional, not an oversight.
create role mcp_reader with login password '<set-via-alter-role-see-env>' nosuperuser nocreatedb nocreaterole noinherit nobypassrls;

-- Postgres has no "grant bypassrls" statement — it's a role attribute, set
-- via ALTER ROLE (the NOBYPASSRLS above is the safe default; this flips it
-- on deliberately and only for this role).
alter role mcp_reader bypassrls;

alter role mcp_reader set statement_timeout = '15s';
alter role mcp_reader set idle_in_transaction_session_timeout = '10s';

grant usage on schema public to mcp_reader;
grant select on all tables in schema public to mcp_reader;

-- So tables created by future migrations are automatically readable too,
-- without a human remembering to re-grant every time.
alter default privileges in schema public grant select on tables to mcp_reader;

comment on role mcp_reader is
  'Read-only reporting role for the ValveTrack MCP server (Claude-as-PA). SELECT-only, BYPASSRLS to see cross-tenant data for analysis, statement_timeout=15s. Never grant INSERT/UPDATE/DELETE/DDL to this role.';
