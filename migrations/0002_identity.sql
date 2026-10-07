-- =============================================================================
-- 0002 — identity: users, credentials, sessions, OTP, households, members
-- Plan: 04-data-model.md §2, §3. India adaptation per the India-first brief.
--
-- FORWARD REFERENCE: `metro_id` columns here and in 0003 are plain uuid with no
-- foreign key, because `ops.metros` is created in 0008. 0008 adds the FK
-- constraints with ALTER TABLE. Keeping the constraint addition in one place is
-- clearer than sprinkling ops.metros across early migrations.
-- =============================================================================

do $$ begin
  create type identity.user_status as enum
    ('pending','active','limited','suspended','banned','deleted');
exception when duplicate_object then null; end $$;

do $$ begin
  create type identity.credential_kind as enum ('passkey','apple','google','otp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type identity.household_role as enum ('owner','co_guardian','walker','view_only');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
create table if not exists identity.users (
  id                 uuid primary key,
  -- E.164. Stored so we can SMS the user; never used as a lookup key (see
  -- phone_blind_index). Length-bounded because unbounded text is a DoS vector (04 §1).
  phone_e164         text not null
                       check (phone_e164 ~ '^\+[1-9]\d{6,14}$'),
  -- India-first shape check that still permits every other country: if the number
  -- IS +91 it must be a valid 10-digit Indian mobile (leading 6-9 per TRAI's
  -- allocation); anything not starting +91 only has to satisfy generic E.164.
  constraint users_phone_in_shape
    check (phone_e164 !~ '^\+91' or phone_e164 ~ '^\+91[6-9]\d{9}$'),
  -- PRIVACY: HMAC(server key, normalised phone). This — not phone_e164 — is what
  -- every lookup uses, and it carries the uniqueness constraint. A database dump
  -- without the HMAC key yields no phone directory. Key lives in Secrets Manager,
  -- never in this database (src/domain/crypto/hmac.ts blindIndex()).
  phone_blind_index  text not null unique check (length(phone_blind_index) = 64),
  phone_verified_at  timestamptz,
  email              citext unique,
  email_verified_at  timestamptz,
  display_name       text not null check (length(display_name) between 1 and 50),
  date_of_birth      date,
  -- Materialised, not computed at read time: every gate that needs adult status
  -- must read one column written by one code path (04 §2 design note).
  is_adult_verified  boolean not null default false,
  -- DPDP Act 2023, not GDPR. 'in' is the launch residency; the column exists so a
  -- second region is a data change, not a migration. Residency drives which
  -- cluster and which KMS key a Data Principal's records may occupy.
  residency_region   text not null default 'in'
                       check (residency_region in ('in','us','eu','uk')),
  locale             text not null default 'en-IN' check (length(locale) <= 16),
  timezone           text not null default 'Asia/Kolkata' check (length(timezone) <= 64),
  status             identity.user_status not null default 'pending',
  -- DPDP §12/§13: erasure and grievance. Set when the user files a deletion
  -- request; the 30-day pipeline reads this, the row is hard-deleted at the end.
  deletion_requested_at timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

comment on table identity.users is
  'Data Principals under the Digital Personal Data Protection Act 2023. Every column here is personal data; treat exports and logs accordingly.';
comment on column identity.users.phone_e164 is
  'PRIVACY: raw phone number. Never log. Never use for lookup — use phone_blind_index.';
comment on column identity.users.phone_blind_index is
  'PRIVACY: HMAC-SHA256 of the normalised E.164 number under a Secrets-Manager-held key. The only lookup key for a phone number.';
comment on column identity.users.residency_region is
  'DPDP Act 2023 residency. Drives KMS key selection and cross-border transfer rules. Default in (India).';
comment on column identity.users.is_adult_verified is
  'Materialised adult status. Gates Spark and age-restricted surfaces. Written by one code path only.';

create index if not exists users_status_idx
  on identity.users (status) where deleted_at is null;
create index if not exists users_deletion_requested_idx
  on identity.users (deletion_requested_at) where deletion_requested_at is not null;

-- ---------------------------------------------------------------------------
-- auth_credentials — passkeys and social, alongside OTP
-- ---------------------------------------------------------------------------
create table if not exists identity.auth_credentials (
  id            uuid primary key,
  user_id       uuid not null references identity.users(id) on delete cascade,
  kind          identity.credential_kind not null,
  -- provider subject or WebAuthn credential id. Opaque to us.
  subject       text not null check (length(subject) <= 512),
  public_key    bytea,
  sign_count    bigint,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (kind, subject)
);
create index if not exists auth_credentials_user_idx on identity.auth_credentials (user_id);

-- ---------------------------------------------------------------------------
-- sessions — refresh-token families with reuse detection
-- ---------------------------------------------------------------------------
create table if not exists identity.sessions (
  id             uuid primary key,
  user_id        uuid not null references identity.users(id) on delete cascade,
  device_id      uuid not null,
  -- The refresh token FAMILY. Rotation creates a new session row in the same
  -- family; presenting an already-rotated token revokes every row in the family
  -- (05 §3.1: "reuse of a rotated token revokes the whole family").
  family_id      uuid not null,
  -- argon2id hash of the refresh token secret. Never the token itself.
  refresh_hash   text not null,
  -- set when this row's token has been exchanged. Non-null + a presented token
  -- that matches == replay == compromise.
  rotated_at     timestamptz,
  replaced_by    uuid references identity.sessions(id),
  attestation    jsonb,
  -- PRIVACY: country only, never the address (04 §2, 00 §4.2). A two-letter code
  -- is enough for anomaly detection and is not a location.
  ip_country     char(2),
  user_agent     text check (length(user_agent) <= 512),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text check (length(revoked_reason) <= 120),
  created_at     timestamptz not null default now()
);
comment on column identity.sessions.ip_country is
  'PRIVACY: ISO-3166-1 alpha-2 country only. Storing the IP address is prohibited (00 §4.2).';
comment on column identity.sessions.family_id is
  'Refresh-token family. Reuse of a rotated token revokes the entire family — see src/modules/identity/token.service.ts.';

create index if not exists sessions_user_active_idx
  on identity.sessions (user_id) where revoked_at is null;
create index if not exists sessions_family_idx on identity.sessions (family_id);
create index if not exists sessions_expiry_idx
  on identity.sessions (expires_at) where revoked_at is null;

-- ---------------------------------------------------------------------------
-- otp_challenges
-- ---------------------------------------------------------------------------
create table if not exists identity.otp_challenges (
  id               uuid primary key,
  -- Keyed on the blind index, not the number: an attacker with read access to
  -- this table learns nothing about which numbers were challenged.
  phone_blind_index text not null check (length(phone_blind_index) = 64),
  -- HMAC(server pepper, phone || code). Comparison is constant time via
  -- safeEqual() (src/domain/crypto/hmac.ts). A plaintext or unpeppered-hash code
  -- column would make a read of this table a login.
  code_hash        text not null check (length(code_hash) = 64),
  attempt_count    smallint not null default 0 check (attempt_count >= 0),
  -- 5-attempt lockout (05 §3.1). Enforced in code; stored so the lockout survives
  -- a process restart and a Redis flush.
  max_attempts     smallint not null default 5,
  consumed_at      timestamptz,
  expires_at       timestamptz not null,
  -- PRIVACY: country only, same rule as sessions.
  ip_country       char(2),
  created_at       timestamptz not null default now()
);
comment on table identity.otp_challenges is
  'PRIVACY: existence of a row does not imply an account exists — OTP request always returns 202 to avoid an enumeration oracle (05 §3.1).';
comment on column identity.otp_challenges.code_hash is
  'PRIVACY: HMAC of the code under a server pepper. Never store or log the code.';

create index if not exists otp_challenges_lookup_idx
  on identity.otp_challenges (phone_blind_index, created_at desc)
  where consumed_at is null;
create index if not exists otp_challenges_expiry_idx
  on identity.otp_challenges (expires_at) where consumed_at is null;

-- ---------------------------------------------------------------------------
-- households — THE ANCHOR TABLE. The most-reviewed table in the schema.
-- Plan: 00-SHARED-DECISIONS.md §4.1, 04-data-model.md §3.
--
-- The published value is a FROZEN displaced cell, not a per-request fuzz and not
-- a per-true-cell displacement. Both of those are defeated by averaging N samples
-- at O(1/sqrt(N)). Freezing the published value is the only construction that
-- resists repeated sampling: the query has a fixed answer, so there is nothing
-- to average. Routine movement writes NOTHING.
-- ---------------------------------------------------------------------------
create table if not exists identity.households (
  id            uuid primary key,
  name          text check (length(name) <= 80),

  -- PUBLISHED ANCHOR CELLS. Derived from a point displaced 1.0-1.5 km from the
  -- true home along a salt-derived bearing. Safe to index, safe to query, never
  -- returned to a client as anything but a distance BUCKET.
  -- Named h3_r8 for continuity with doc 04; the launch cell index is geohash p5
  -- (src/domain/geo/cell-index.ts) and the column is text so swapping to H3 res-8
  -- is a value change, not a type change.
  cell_coarse   text check (length(cell_coarse) <= 24),
  cell_fine     text check (length(cell_fine) <= 24),
  -- Doc-04 compatibility alias kept as a generated-free plain column so existing
  -- analytics references resolve. Written identically to cell_coarse.
  h3_r8         text check (length(h3_r8) <= 24),

  -- PRIVACY: per-household secret. Makes the displacement deterministic (so the
  -- anchor is stable) and unguessable (so it cannot be inverted). If this leaks
  -- together with the published cell, the true home is recoverable to ~0 metres.
  geo_salt      bytea not null,

  -- PRIVACY - HIGHEST SENSITIVITY IN THE SCHEMA.
  -- The TRUE coordinates the current anchor was derived from. Retained for ONE
  -- purpose: measuring the 5 km re-anchor threshold. This is the accepted residual
  -- risk named in 04 §3 and in the doc 09 threat model.
  --
  -- Encrypted with pgcrypto pgp_sym_encrypt at write time.
  -- *** PRODUCTION MUST NOT USE A LITERAL OR ENV-FILE KEY. ***
  -- The key must be a KMS-held CMK (ap-south-1, dedicated location CMK, separate
  -- from the general data key), fetched per request by the anchor code path only,
  -- with CloudTrail auditing on every Decrypt call. The pgcrypto symmetric key in
  -- local/dev config exists so the migration and the seed run without AWS; it is
  -- a development affordance and a production incident.
  --
  -- These columns must never appear in: an API response, a log line, a metric
  -- label, a URL, an analytics export, or a support tool.
  anchor_origin_lat bytea,
  anchor_origin_lon bytea,

  anchor_set_at   timestamptz,
  -- Rate-limit and abuse signal. Once per 24 h (00 §4.1); a household re-anchoring
  -- repeatedly is either moving house or probing the construction.
  reanchor_count  integer not null default 0 check (reanchor_count >= 0),
  metro_id        uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz
);

comment on table identity.households is
  'Households own dogs (Decision D1). Holds the frozen matching anchor. Read 00-SHARED-DECISIONS §4.1 before touching any anchor_* or cell_* column.';
comment on column identity.households.cell_coarse is
  'Published DISPLACED coarse cell. Candidate retrieval key. Never a true location.';
comment on column identity.households.cell_fine is
  'Published DISPLACED fine cell. Used for anchor-to-anchor distance bucketing only.';
comment on column identity.households.geo_salt is
  'PRIVACY: per-household displacement secret. Leaking this with the published cell recovers the true home.';
comment on column identity.households.anchor_origin_lat is
  'PRIVACY MAXIMUM: pgcrypto-encrypted true latitude the anchor derives from. Sole purpose: the 5 km re-anchor threshold. Production requires a KMS-held CMK. Never returned by any API.';
comment on column identity.households.anchor_origin_lon is
  'PRIVACY MAXIMUM: pgcrypto-encrypted true longitude. Same rules as anchor_origin_lat.';
comment on column identity.households.reanchor_count is
  'Audit and abuse signal. Re-anchoring is limited to once per 24 h and written to ops.audit_log.';

-- Partial index: the active working set is a small fraction of the table (04 §11).
create index if not exists households_cell_coarse_idx
  on identity.households (cell_coarse) where deleted_at is null;
create index if not exists households_metro_idx
  on identity.households (metro_id) where deleted_at is null;

-- ---------------------------------------------------------------------------
-- household_members + the at-least-one-owner trigger
-- ---------------------------------------------------------------------------
create table if not exists identity.household_members (
  household_id uuid not null references identity.households(id) on delete cascade,
  user_id      uuid not null references identity.users(id) on delete cascade,
  role         identity.household_role not null,
  invited_by   uuid references identity.users(id),
  accepted_at  timestamptz,
  created_at   timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index if not exists household_members_user_idx on identity.household_members (user_id);
create index if not exists household_members_owner_idx
  on identity.household_members (household_id) where role = 'owner';

-- A household with no owner is unadministrable: nobody can invite, nobody can
-- re-anchor, nobody can delete the dogs. The API returns 409 before it gets here
-- (05 §3.2); this trigger is the backstop for every other write path, including
-- a psql session.
--
-- IT IS A **DEFERRED CONSTRAINT TRIGGER**, and that is load-bearing (04 §2 calls
-- for exactly this). An immediate AFTER trigger fires at the end of the DELETE
-- statement, which is BEFORE the service's own owner count runs — so the service
-- could never return its 409 with a useful message, and the user would get a
-- 500 from a raised exception instead. Deferring to COMMIT lets the application
-- detect and report the condition properly, while still making it impossible to
-- commit a household with no owner by any route.
--
-- Deferring also fixes the cascade case: when a household is deleted, its
-- members cascade away, and at COMMIT the household row is gone so the guard
-- returns early rather than complaining that the (now non-existent) household
-- has no owner.
--
-- Constraint triggers cannot carry a column list, so this fires on INSERT too.
-- That is harmless: an insert can only ever increase the owner count.
create or replace function identity.assert_household_has_owner()
returns trigger
language plpgsql
as $$
declare
  remaining integer;
  hh        uuid;
begin
  hh := coalesce(old.household_id, new.household_id);

  -- If the household itself is gone (cascade delete), there is nothing to protect.
  if not exists (select 1 from identity.households h where h.id = hh) then
    return coalesce(new, old);
  end if;

  select count(*) into remaining
  from identity.household_members m
  where m.household_id = hh and m.role = 'owner';

  if remaining = 0 then
    raise exception 'household % would be left with no owner', hh
      using errcode = 'integrity_constraint_violation';
  end if;

  return coalesce(new, old);
end $$;

drop trigger if exists household_members_owner_guard on identity.household_members;
create constraint trigger household_members_owner_guard
  after insert or update or delete on identity.household_members
  deferrable initially deferred
  for each row execute function identity.assert_household_has_owner();

comment on function identity.assert_household_has_owner() is
  'Backstop for the orphaned-household invariant, checked at COMMIT via a deferred constraint trigger so the application can return a 409 with a useful message first. See the comment above the function for why it must be deferred.';

-- ---------------------------------------------------------------------------
-- trusted_contacts — walk-sharing designees (02 CV-8)
-- ---------------------------------------------------------------------------
create table if not exists identity.trusted_contacts (
  id            uuid primary key,
  user_id       uuid not null references identity.users(id) on delete cascade,
  name          text not null check (length(name) <= 80),
  -- PRIVACY: a third party's phone number, and that person is not a user of the
  -- platform. Same handling rules as identity.users.phone_e164.
  phone_e164    text not null check (phone_e164 ~ '^\+[1-9]\d{6,14}$'),
  relationship  text check (length(relationship) <= 40),
  is_default    boolean not null default false,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
comment on column identity.trusted_contacts.phone_e164 is
  'PRIVACY: a non-user third party phone number, collected for safety escalation only. Never used for marketing, growth or contact-graph building.';

create index if not exists trusted_contacts_user_idx
  on identity.trusted_contacts (user_id) where deleted_at is null;
-- Exactly one default per user, enforced by a partial unique index.
create unique index if not exists trusted_contacts_one_default_idx
  on identity.trusted_contacts (user_id) where is_default and deleted_at is null;
