-- =============================================================================
-- 0004 — verify: verification requests, granted tiers, health records, registries
-- Plan: 04-data-model.md §5.
--
-- The five tiers are consistent across the whole plan (99-VERIFICATION-REPORT
-- confirms this): 0 unverified, 1 Guardian Verified, 2 Dog Verified,
-- 3 Health Verified, 4 Breeder Verified.
-- =============================================================================

do $$ begin
  create type verify.subject_type as enum ('user','dog','breeder');
exception when duplicate_object then null; end $$;

do $$ begin
  create type verify.request_state as enum
    ('pending','in_review','needs_more_info','approved','rejected','expired','withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type verify.health_record_type as enum
    ('vaccination','rabies','deworming','hip_score','elbow_score','eye_exam',
     'cardiac_exam','dna_panel','vet_exam');
exception when duplicate_object then null; end $$;

do $$ begin
  create type verify.link_method as enum ('api','document','manual');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- verification_requests
-- ---------------------------------------------------------------------------
create table if not exists verify.verification_requests (
  id                   uuid primary key,
  subject_type         verify.subject_type not null,
  -- Polymorphic subject: no FK, because the target is one of three tables. The
  -- repository always writes both columns together and every read filters on
  -- subject_type first.
  subject_id           uuid not null,
  target_tier          smallint not null check (target_tier between 1 and 4),
  -- India-first providers: DigiLocker / Aadhaar-based eKYC via a licensed KUA,
  -- or manual review. 'persona' retained for non-India markets.
  provider             text check (length(provider) <= 40),
  -- PRIVACY: a provider reference ONLY. We never store document images or
  -- Aadhaar numbers — the Aadhaar Act prohibits storing the number for a
  -- non-authorised entity, and holding ID images is a breach magnet (04 §12).
  provider_ref         text check (length(provider_ref) <= 200),
  state                verify.request_state not null default 'pending',
  decided_by           uuid references identity.users(id),
  -- Reason codes, never free text, so "what is still missing" is renderable as
  -- actionable next steps rather than a bare "rejected" (05 §3.6).
  decision_reason_code text check (length(decision_reason_code) <= 60),
  parse_confidence     numeric(4,3) check (parse_confidence between 0 and 1),
  created_at           timestamptz not null default now(),
  decided_at           timestamptz
);
comment on column verify.verification_requests.provider_ref is
  'PRIVACY: provider inquiry id only. Identity documents and Aadhaar numbers are never stored by us.';

create index if not exists verification_requests_subject_idx
  on verify.verification_requests (subject_type, subject_id);
-- Partial index on the reviewer queue: the only hot read on this table.
create index if not exists verification_requests_queue_idx
  on verify.verification_requests (state, created_at)
  where state in ('pending','in_review','needs_more_info');

-- ---------------------------------------------------------------------------
-- tiers_granted
--
-- expires_at is what makes verification a LIVE claim rather than a badge. A
-- lapsed rabies vaccination must silently drop a dog out of in-person meetup
-- eligibility (04 §5). The sweep that enforces it is a P0 job, and the partial
-- index below is the query it runs.
-- ---------------------------------------------------------------------------
create table if not exists verify.tiers_granted (
  subject_type   verify.subject_type not null,
  subject_id     uuid not null,
  tier           smallint not null check (tier between 1 and 4),
  granted_at     timestamptz not null default now(),
  -- Vaccination currency and annual re-attestation. null == does not expire.
  expires_at     timestamptz,
  revoked_at     timestamptz,
  revoked_reason text check (length(revoked_reason) <= 200),
  source_request uuid references verify.verification_requests(id),
  created_at     timestamptz not null default now(),
  primary key (subject_type, subject_id, tier)
);
comment on column verify.tiers_granted.expires_at is
  'Live-claim expiry (vaccination currency, annual re-attestation). The expiry sweep is a P0 job — a lapsed tier must stop gating meetups immediately.';

create index if not exists tiers_granted_expiry_idx
  on verify.tiers_granted (expires_at)
  where revoked_at is null and expires_at is not null;
-- The feed asks "what is this subject's current effective tier" on every request.
create index if not exists tiers_granted_current_idx
  on verify.tiers_granted (subject_type, subject_id, tier desc)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- health_records
-- ---------------------------------------------------------------------------
create table if not exists verify.health_records (
  id               uuid primary key,
  dog_id           uuid not null references graph.dogs(id) on delete cascade,
  record_type      verify.health_record_type not null,
  result_code      text check (length(result_code) <= 40),
  tested_at        date,
  expires_at       date,
  -- India: rabies vaccination is the meetup-critical one. Registries are mostly
  -- veterinary practice records rather than a national database, so 'vet' is the
  -- common case and the parse-confidence path matters more here than in the US.
  registry         text check (length(registry) <= 60),
  registry_ref     text check (length(registry_ref) <= 120),
  -- PRIVACY: encrypted object key. Retained for audit; not served to any client.
  document_storage_key text check (length(document_storage_key) <= 512),
  verified_by      uuid references identity.users(id),
  verified_at      timestamptz,
  parse_confidence numeric(4,3) check (parse_confidence between 0 and 1),
  created_at       timestamptz not null default now()
);
comment on column verify.health_records.document_storage_key is
  'PRIVACY: encrypted-at-rest document. Audit retention only; never returned to a client.';

create index if not exists health_records_dog_type_idx
  on verify.health_records (dog_id, record_type);
-- Rabies currency is read on every meetup proposal.
create index if not exists health_records_vax_current_idx
  on verify.health_records (dog_id, expires_at)
  where record_type in ('vaccination','rabies');

-- ---------------------------------------------------------------------------
-- registry_links
-- ---------------------------------------------------------------------------
create table if not exists verify.registry_links (
  id                  uuid primary key,
  dog_id              uuid not null references graph.dogs(id) on delete cascade,
  -- KCI is the Indian FCI member body; INKC and others exist and are not
  -- equivalent, so the registry name is part of the uniqueness key.
  registry            text not null check (length(registry) <= 40),
  registration_number text not null check (length(registration_number) <= 80),
  link_method         verify.link_method not null,
  verified_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (registry, registration_number)
);
create index if not exists registry_links_dog_idx on verify.registry_links (dog_id);
