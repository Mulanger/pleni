-- Reverse 005_fix_auth_probe_role_columns.
--
-- There is nothing to revert to: the 003 version of this function raised
-- 42P01 on every call. Dropping it is the only honest down migration.
drop function if exists public.auth_probe();
