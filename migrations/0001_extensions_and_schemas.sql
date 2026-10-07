-- =============================================================================
-- 0001 — extensions and schemas
-- Plan: 04-data-model.md §1 (conventions), §16 (schema layout).
--
-- WHY schema-per-domain in one cluster: cross-domain queries stay possible where
-- they are legitimate (identity + graph), while the schema boundary makes an
-- illegitimate join visible in code review. Cross-schema foreign keys are
-- permitted ONLY toward `identity` and `graph` (04 §1).
--
-- DEFERRED EXTENSIONS — read before adding a geo or vector feature
-- ---------------------------------------------------------------------------
-- PostGIS and pgvector are deliberately NOT installed in this drop.
--
--   * PostGIS  — doc 04 §6 specifies `geography(point,4326)` on `meetup.places`
--                and `lineage.breeder_premises.geog`. Those are the only two
--                places real geography is legitimate (public parks; licence-
--                authority matching). Until PostGIS lands, both carry plain
--                `latitude`/`longitude` numeric columns and we do bounding-box
--                maths in SQL. Tables that will need PostGIS later:
--                  meetup.places            (geog geography(point,4326))
--                  lineage.breeder_premises (geog geography(point,4326))
--                MATCHING MUST NEVER USE POSTGIS. Household anchors are cell
--                strings, never points — see 00-SHARED-DECISIONS §4.1.
--
--   * pgvector — doc 04 §4 specifies `graph.dog_media.reid_vector vector(512)`
--                (dog re-identification, dogfishing countermeasure) and
--                `graph.dog_temperament.compat_vector vector(64)` (learned
--                ranker embedding). Both are omitted here; the launch ranker is
--                the heuristic scorer in src/domain/matching/candidate.ts, which
--                needs no embeddings. Tables that will need pgvector later:
--                  graph.dog_media          (reid_vector vector(512) + hnsw index)
--                  graph.dog_temperament    (compat_vector vector(64))
--
-- Candidate retrieval in this drop uses the cell index
-- (src/domain/geo/cell-index.ts) over a plain text `cell_coarse` column with a
-- btree index. That is a correct implementation of the design, not a shortcut:
-- the design never wanted a spatial index on household location.
-- =============================================================================

-- citext: case-insensitive email without lower() wrappers on every query and index.
create extension if not exists citext;

-- pgcrypto: pgp_sym_encrypt/pgp_sym_decrypt for the anchor origin and breeder
-- premises address. PRODUCTION MUST NOT USE A LITERAL KEY — see 0002 for the
-- KMS note attached to identity.households.
create extension if not exists pgcrypto;

create schema if not exists identity;
create schema if not exists graph;
create schema if not exists verify;
create schema if not exists meetup;
create schema if not exists lineage;
create schema if not exists commerce;
create schema if not exists safety;
create schema if not exists ops;

comment on schema identity is
  'Users, sessions, households, household anchors. DPDP Act 2023 principal data lives here.';
comment on schema graph is 'Dogs, breeds, media, temperament, preferences.';
comment on schema verify is 'Verification requests, granted tiers, health records, registry links.';
comment on schema meetup is
  'Matches, conversations, messages, places, meetups, reviews. Pack and Lineage only — Spark conversations never live here (Decision D4).';
comment on schema lineage is 'Pedigree, COI cache, breeder profiles, listings, enquiries, outcomes.';
comment on schema commerce is 'Subscriptions and entitlements. INR minor units.';
comment on schema safety is 'Reports, enforcement, appeals, blocks, ban notifications.';
comment on schema ops is 'Migrations, metros, outbox, audit log, impression log.';

-- Migration bookkeeping. The migrator (src/infra/db/migrate.ts) creates this too,
-- so it exists whichever way the first migration is applied.
create table if not exists ops.schema_migrations (
  version      text primary key,
  checksum     text not null,
  applied_at   timestamptz not null default now(),
  duration_ms  integer not null default 0,
  created_at   timestamptz not null default now()
);
comment on table ops.schema_migrations is
  'One row per applied migration file. checksum is sha256 of the file body; a changed checksum on an applied version is a hard error, not a warning.';
