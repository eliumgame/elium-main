-- Run only in the short-lived db-init container, never with API credentials.
-- psql quoting protects passwords containing quotes; no password is printed.
\getenv app_password APP_PASSWORD
BEGIN;
SELECT 'CREATE ROLE elium_app LOGIN' WHERE NOT EXISTS (
  SELECT FROM pg_roles WHERE rolname = 'elium_app'
) \gexec
ALTER ROLE elium_app NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE elium_app PASSWORD %L', :'app_password') \gexec
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
ALTER SCHEMA public OWNER TO elium_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE elium TO elium_app;
-- Only application tables in public; do not transfer shared databases or extensions.
SELECT format('ALTER TABLE %I.%I OWNER TO elium_app', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'elium')
  AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.objid = c.oid
                  AND d.classid = 'pg_class'::regclass AND d.deptype = 'e') \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO elium_app', n.nspname, c.relname)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'S'
  AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = 'elium') \gexec
COMMIT;
