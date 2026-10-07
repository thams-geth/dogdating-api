-- =============================================================================
-- 0003 — graph: breeds, dogs, media, temperament, availability, preferences
-- Plan: 04-data-model.md §4.
--
-- pgvector is deferred (see 0001): graph.dog_media.reid_vector and
-- graph.dog_temperament.compat_vector are NOT created here. The launch ranker is
-- the heuristic scorer in src/domain/matching/candidate.ts and needs neither.
-- =============================================================================

do $$ begin
  create type graph.size_class as enum ('toy','small','medium','large','giant');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.sex as enum ('male','female');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.dob_precision as enum ('exact','month','year','estimate');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.dog_status as enum ('active','rehomed','memorialised','removed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.breed_source as enum ('declared','dna_test','registry');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.media_kind as enum ('photo','video');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.moderation_state as enum ('pending','approved','rejected','quarantined');
exception when duplicate_object then null; end $$;

do $$ begin
  create type graph.play_style as enum ('wrestle','chase','parallel','fetch','sniff');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- breeds
-- ---------------------------------------------------------------------------
create table if not exists graph.breeds (
  id             uuid primary key,
  canonical_name text unique not null check (length(canonical_name) between 2 and 80),
  -- Indian registries first: KCI is the FCI member body for India. AKC/KC/FCI
  -- groups retained because imported dogs carry those papers.
  kci_group      text check (length(kci_group) <= 40),
  akc_group      text check (length(akc_group) <= 40),
  kc_group       text check (length(kc_group) <= 40),
  fci_group      text check (length(fci_group) <= 40),
  size_class     graph.size_class not null,
  typical_energy smallint check (typical_energy between 1 and 5),
  -- Breed-specific tests required for Tier 3 (Health Verified) on this breed.
  -- text[] not a lookup table: the set changes per breed as veterinary guidance
  -- changes, and operations must be able to edit it without a deploy.
  required_health_tests      text[] not null default '{}',
  -- Conformation flags. Advisory in India (no equivalent of the EU extreme-
  -- conformation rule), but recorded from day one so a later regulatory gate is a
  -- query, not a data-collection project. Brachycephaly also drives real product
  -- behaviour: heat-stress warnings on meetup proposals in an Indian summer.
  extreme_conformation_flags text[] not null default '{}',
  created_at     timestamptz not null default now()
);
comment on column graph.breeds.required_health_tests is
  'Breed-specific health panels required for Tier 3. Operations-editable; no deploy needed.';
comment on column graph.breeds.extreme_conformation_flags is
  'Advisory in India. Drives heat-stress guidance (brachycephalic) and future regulatory gates. Never a hard block without a named rule.';

-- ---------------------------------------------------------------------------
-- dogs
-- ---------------------------------------------------------------------------
create table if not exists graph.dogs (
  id                    uuid primary key,
  -- household_id, NOT user_id. This is the structural expression of Decision D1
  -- and is what makes co-guardianship, rehoming and multi-dog households
  -- representable without a later migration (04 §4).
  household_id          uuid not null references identity.households(id),
  name                  text not null check (length(name) between 1 and 40),
  date_of_birth         date,
  dob_precision         graph.dob_precision not null default 'exact',
  sex                   graph.sex not null,
  neutered              boolean,
  neutered_at           date,
  weight_g              integer check (weight_g between 500 and 120000),
  size_class            graph.size_class not null,
  bio                   text check (length(bio) <= 300),
  is_service_animal     boolean not null default false,
  -- PRIVACY: microchip numbers are a national registry key. Stored encrypted;
  -- uniqueness is enforced on the blind index below, never on plaintext, so a
  -- database dump does not yield a microchip registry (04 §4).
  microchip_encrypted   bytea,
  microchip_blind_index text check (length(microchip_blind_index) = 64),
  microchip_verified_at timestamptz,
  status                graph.dog_status not null default 'active',
  memorialised_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz
);
comment on column graph.dogs.household_id is
  'Decision D1: dogs belong to households, not users. Do not add a user_id.';
comment on column graph.dogs.microchip_encrypted is
  'PRIVACY: encrypted microchip number. Decrypt only in the verification code path.';
comment on column graph.dogs.microchip_blind_index is
  'HMAC of the normalised microchip number. Uniqueness is advisory, not enforced: the same chip on two active dogs is a high-severity T&S signal to be investigated, not a write error (04 §4).';

create index if not exists dogs_household_idx
  on graph.dogs (household_id) where deleted_at is null;
create index if not exists dogs_status_idx on graph.dogs (status);
-- NOT unique: a duplicate chip must be detectable, not rejected.
create index if not exists dogs_microchip_bi_idx
  on graph.dogs (microchip_blind_index) where microchip_blind_index is not null;

-- ---------------------------------------------------------------------------
-- dog_metro_ordinal — dense int32 ids for the roaring-bitmap retrieval design
-- Plan: 04-data-model.md §10 (Redis `geo:r8:{cell}:dogs` roaring bitmaps).
--
-- WHY: a roaring bitmap indexes dense small integers, not UUIDs. Retrieval
-- intersects a per-cell bitmap with per-filter bitmaps (`filt:tier2`,
-- `filt:vax_ok`), which is only cheap if every dog has a small dense integer id
-- within its metro. Metro-scoped rather than global so the bitmaps stay small and
-- a metro can be rebuilt independently.
--
-- Assigned at dog creation, never reused, never renumbered: a reused ordinal
-- would silently mis-target a cached bitmap at a different dog.
-- ---------------------------------------------------------------------------
create table if not exists graph.dog_metro_ordinal (
  dog_id     uuid primary key references graph.dogs(id) on delete cascade,
  metro_id   uuid not null,
  ordinal    integer not null check (ordinal >= 0),
  created_at timestamptz not null default now(),
  unique (metro_id, ordinal)
);
comment on table graph.dog_metro_ordinal is
  'Dense metro-scoped int32 id per dog, for roaring-bitmap candidate retrieval (04 §10). Never reuse or renumber an ordinal.';

-- Allocation counter. A dedicated row per metro taken FOR UPDATE keeps the
-- ordinals dense; a bigserial would leave gaps on every rolled-back insert and
-- density is the whole point of the design.
create table if not exists graph.metro_ordinal_counter (
  metro_id     uuid primary key,
  next_ordinal integer not null default 0 check (next_ordinal >= 0),
  created_at   timestamptz not null default now()
);

create or replace function graph.allocate_metro_ordinal(p_metro_id uuid)
returns integer
language plpgsql
as $$
declare
  v integer;
begin
  insert into graph.metro_ordinal_counter (metro_id, next_ordinal)
  values (p_metro_id, 0)
  on conflict (metro_id) do nothing;

  -- FOR UPDATE serialises allocation for this metro only. Contention is bounded
  -- by the dog-creation rate in one city, which is orders of magnitude below any
  -- level where this matters.
  update graph.metro_ordinal_counter
     set next_ordinal = next_ordinal + 1
   where metro_id = p_metro_id
  returning next_ordinal - 1 into v;

  return v;
end $$;

comment on function graph.allocate_metro_ordinal(uuid) is
  'Allocates the next dense ordinal for a metro. Call inside the dog-creation transaction.';

-- ---------------------------------------------------------------------------
-- dog_media
-- ---------------------------------------------------------------------------
create table if not exists graph.dog_media (
  id               uuid primary key,
  dog_id           uuid not null references graph.dogs(id) on delete cascade,
  kind             graph.media_kind not null,
  -- Object-store key. Bodies live in S3 (ap-south-1); Postgres holds hot columns
  -- only (04 §11).
  storage_key      text not null check (length(storage_key) <= 512),
  ordinal          smallint not null check (ordinal between 0 and 29),
  width            integer,
  height           integer,
  duration_ms      integer,
  -- Perceptual hash, 16 hex chars = 64 bits. Text rather than bit(64) because
  -- Hamming search is done app-side (or via a bk-tree extension later) and text
  -- is what the classifier emits.
  phash            text check (length(phash) = 16),
  -- MEDIA FAILS CLOSED: 'pending' until the vision classifier passes (05 §3.2).
  -- A default of 'approved' would make a classifier outage a moderation bypass.
  moderation_state graph.moderation_state not null default 'pending',
  moderated_at     timestamptz,
  created_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  unique (dog_id, ordinal)
);
comment on column graph.dog_media.moderation_state is
  'Fails closed. pending media is never served. A classifier outage must degrade to "no new media", never to "unmoderated media".';
comment on column graph.dog_media.phash is
  'Perceptual hash, 64 bits hex. Dogfishing countermeasure. reid_vector (pgvector) is deferred — see 0001.';

create index if not exists dog_media_dog_idx
  on graph.dog_media (dog_id, ordinal) where deleted_at is null;
create index if not exists dog_media_pending_idx
  on graph.dog_media (created_at) where moderation_state = 'pending';
create index if not exists dog_media_phash_idx
  on graph.dog_media (phash) where phash is not null;

-- ---------------------------------------------------------------------------
-- dog_temperament — the 7 dimensions
-- ---------------------------------------------------------------------------
create table if not exists graph.dog_temperament (
  dog_id                uuid primary key references graph.dogs(id) on delete cascade,
  -- Versioned so a questionnaire change does not rewrite history or silently
  -- reinterpret old answers on a different scale.
  questionnaire_version smallint not null default 1,
  -- The 7 dimensions consumed by src/domain/matching/candidate.ts Temperament.
  energy             smallint not null check (energy between 1 and 5),
  play_style         graph.play_style[] not null,
  dog_reactivity     smallint not null check (dog_reactivity between 1 and 5),
  human_reactivity   smallint not null check (human_reactivity between 1 and 5),
  resource_guarding  smallint not null check (resource_guarding between 1 and 5),
  recall_reliability smallint not null check (recall_reliability between 1 and 5),
  size_tolerance     graph.size_class[] not null,
  needs_to_know      text check (length(needs_to_know) <= 500),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  -- A declared-reactive dog must be routed to parallel-walk-only owners. The
  -- filter reads dog_reactivity >= 4 (candidate.ts); this index makes the
  -- audit query "are reactive dogs being silently excluded" cheap.
  check (array_length(play_style, 1) between 1 and 5)
);
create index if not exists dog_temperament_reactive_idx
  on graph.dog_temperament (dog_id) where dog_reactivity >= 4;

-- ---------------------------------------------------------------------------
-- dog_availability
-- ---------------------------------------------------------------------------
create table if not exists graph.dog_availability (
  id           uuid primary key,
  dog_id       uuid not null references graph.dogs(id) on delete cascade,
  -- null day_of_week means this row is an ad-hoc beacon ("walking now").
  day_of_week  smallint check (day_of_week between 0 and 6),
  start_min    smallint check (start_min between 0 and 1439),
  end_min      smallint check (end_min between 0 and 1440),
  -- Beacon expiry. Capped at 90 minutes by the API (05 §3.2) — an always-on
  -- beacon is a presence broadcast, which is a different privacy question.
  beacon_until timestamptz,
  created_at   timestamptz not null default now(),
  check ((day_of_week is not null and start_min is not null and end_min is not null
          and end_min > start_min)
         or beacon_until is not null)
);
-- Partial index: the beacon sweep only ever asks for live beacons.
create index if not exists dog_availability_beacon_idx
  on graph.dog_availability (beacon_until) where beacon_until is not null;
create index if not exists dog_availability_dog_idx
  on graph.dog_availability (dog_id, day_of_week);

-- ---------------------------------------------------------------------------
-- match_preferences
-- ---------------------------------------------------------------------------
create table if not exists graph.match_preferences (
  dog_id                uuid primary key references graph.dogs(id) on delete cascade,
  -- Distance is a BUCKET, everywhere, including in preferences. There is no
  -- max_distance_km column because there is no number of kilometres in this
  -- product (00 §4.1, 05 §2). Buckets are the India set from
  -- src/domain/geo/anchor.ts: under_2_km | km_2_5 | km_5_10 | km_10_25 | over_25_km.
  max_distance_bucket   text not null default 'km_5_10'
    check (max_distance_bucket in ('under_2_km','km_2_5','km_5_10','km_10_25','over_25_km')),
  size_classes          graph.size_class[] not null default '{}',
  age_min_months        smallint check (age_min_months >= 0),
  age_max_months        smallint check (age_max_months >= 0),
  energy_min            smallint check (energy_min between 1 and 5),
  energy_max            smallint check (energy_max between 1 and 5),
  play_styles           graph.play_style[],
  -- Floor of 1: Tier 0 dogs are never shown to anyone (00 §3.3), so the effective
  -- minimum is max(1, this). The scorer applies that; the default states intent.
  min_verification_tier smallint not null default 1
                          check (min_verification_tier between 0 and 4),
  parallel_walk_only    boolean not null default false,
  accepts_reactive      boolean not null default false,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (age_min_months is null or age_max_months is null or age_max_months >= age_min_months),
  check (energy_min is null or energy_max is null or energy_max >= energy_min)
);
comment on column graph.match_preferences.max_distance_bucket is
  'Bucket, never a number. No column in this schema holds a distance in km for matching purposes.';

-- ---------------------------------------------------------------------------
-- dog_breeds
-- ---------------------------------------------------------------------------
create table if not exists graph.dog_breeds (
  dog_id     uuid not null references graph.dogs(id) on delete cascade,
  breed_id   uuid not null references graph.breeds(id),
  percentage smallint check (percentage between 1 and 100),
  source     graph.breed_source not null default 'declared',
  created_at timestamptz not null default now(),
  primary key (dog_id, breed_id)
);
create index if not exists dog_breeds_breed_idx on graph.dog_breeds (breed_id);
