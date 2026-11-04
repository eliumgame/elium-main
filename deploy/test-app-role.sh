#!/usr/bin/env bash
# Integration in a disposable CI compose project; no operator configuration.
set -euo pipefail
export POSTGRES_PASSWORD=ci-admin-password POSTGRES_APP_PASSWORD=ci-app-password
export TOKEN_SECRET=ci-token-secret-not-production CORS_ORIGINS=http://localhost
export S3_SECRET_KEY=ci-s3-password REDIS_PASSWORD=ci-redis-password
export COMPOSE_PROJECT_NAME=elium-role-test
trap 'docker compose down -v' EXIT
docker compose up -d --wait db
docker compose exec -T db psql -U elium -d elium -v ON_ERROR_STOP=1 <<'SQL'
CREATE TABLE public.legacy_test (id serial PRIMARY KEY, value text);
INSERT INTO public.legacy_test (value) VALUES ('preserved');
SQL
docker compose run --rm db-init
docker compose run --rm db-init
docker compose exec -T -e PGPASSWORD="$POSTGRES_APP_PASSWORD" db psql -h db -U elium_app -d elium -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname=current_user AND
             (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'application has privileged role';
  END IF;
  IF (SELECT value FROM legacy_test WHERE id=1) <> 'preserved' THEN
    RAISE EXCEPTION 'legacy data lost';
  END IF;
END $$;
ALTER TABLE legacy_test ADD COLUMN migrated boolean;
INSERT INTO legacy_test (value) VALUES ('new');
CREATE TABLE migration_test (id uuid DEFAULT gen_random_uuid(), email citext);
DO $$ BEGIN
  BEGIN
    EXECUTE 'COPY legacy_test TO PROGRAM ''true''';
    RAISE EXCEPTION 'COPY PROGRAM unexpectedly allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
SQL
