-- =============================================================================
-- 0007 — lineage: pedigree, COI cache, breeder profiles, listings, outcomes
-- Plan: 04-data-model.md §7.
--
-- INDIA REGULATORY BASIS
-- ---------------------------------------------------------------------------
-- Breeding in India is governed by the Prevention of Cruelty to Animals (Dog
-- Breeding and Marketing) Rules 2017, made under the PCA Act 1960:
--
--   * Rule 3  — no person shall carry on the business of breeding and selling
--               dogs without being registered with the STATE ANIMAL WELFARE
--               BOARD of the state in which the establishment is situated.
--               Registration is per-state, not national: there is no single
--               federal licence number, which is why the columns below are
--               state_board_registration_number + issuing_state_board rather
--               than a single licence_number.
--   * Rule 5  — the registration certificate is valid for TWO YEARS and must be
--               renewed; hence registration_expires_on and the renewal sweep.
--               A lapsed registration must delist, not merely warn.
--   * Rule 7  — record-keeping and reporting obligations on the breeder
--               (numbers of dogs, litters, sales, veterinary records), which is
--               what lineage.pairing_outcomes and verify.health_records exist to
--               satisfy on our side of the relationship.
--
-- The UK Schedule 6 / USDA / EU columns from doc 04 are NOT carried here: they
-- are the wrong jurisdiction for this drop and a nullable column that nothing
-- populates is worse than an absent one. `jurisdiction` keeps the table
-- extensible, and the domain layer already generalises the rule checks
-- (src/domain/lineage/regulatory.ts, Jurisdiction = 'IN'|'GB'|'EU'|'US'|'OTHER').
-- =============================================================================

do $$ begin
  create type lineage.provenance as enum
    ('registry_api','document_verified','owner_declared');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lineage.parent_role as enum ('sire','dam');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lineage.tier4_state as enum
    ('not_started','documents_pending','reference_check','premises_review','granted','revoked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lineage.listing_kind as enum
    ('stud_service','planned_litter','available_litter');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lineage.listing_state as enum
    ('draft','pending_review','published','expired','suppressed','withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type lineage.enquiry_state as enum
    ('sent','read','answered','declined','blocked','withdrawn');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- pedigree_nodes
-- ---------------------------------------------------------------------------
create table if not exists lineage.pedigree_nodes (
  id                  uuid primary key,
  -- null for off-platform historical ancestors, which are the majority of any
  -- real pedigree.
  dog_id              uuid unique references graph.dogs(id),
  call_name           text check (length(call_name) <= 60),
  registered_name     text check (length(registered_name) <= 120),
  registry            text check (length(registry) <= 40),
  registration_number text check (length(registration_number) <= 80),
  sex                 graph.sex,
  date_of_birth       date,
  -- provenance on EVERY node and edge means the product can never present an
  -- owner-declared ancestor as a verified one. A COI number is only as good as
  -- the graph beneath it (04 §7).
  provenance          lineage.provenance not null default 'owner_declared',
  -- Monotonic counter bumped whenever any edge in this node's ancestry subtree
  -- changes. coi_cache.graph_version stores max(node_a, node_b) subtree_version
  -- at computation time; a mismatch on read invalidates the cache entry. This is
  -- cheaper and far more reliable than trying to enumerate affected pairs.
  subtree_version     bigint not null default 1,
  created_at          timestamptz not null default now()
);
comment on column lineage.pedigree_nodes.provenance is
  'Never render a COI without the provenance of the graph it came from. An owner-declared ancestor must never be displayed as verified.';
comment on column lineage.pedigree_nodes.subtree_version is
  'Bumped by the edge trigger on any ancestry change. Drives coi_cache invalidation by version mismatch rather than by enumerating pairs.';

create unique index if not exists pedigree_nodes_registry_idx
  on lineage.pedigree_nodes (registry, registration_number)
  where registration_number is not null;

-- ---------------------------------------------------------------------------
-- pedigree_edges + cycle prevention
-- ---------------------------------------------------------------------------
create table if not exists lineage.pedigree_edges (
  child_id    uuid not null references lineage.pedigree_nodes(id) on delete cascade,
  parent_id   uuid not null references lineage.pedigree_nodes(id) on delete cascade,
  parent_role lineage.parent_role not null,
  provenance  lineage.provenance not null default 'owner_declared',
  created_at  timestamptz not null default now(),
  -- One sire and one dam per child. Biology, and it also bounds the graph.
  primary key (child_id, parent_role),
  check (child_id <> parent_id)
);
create index if not exists pedigree_edges_parent_idx on lineage.pedigree_edges (parent_id);

-- A cycle in a pedigree is not merely wrong data: the COI walk in
-- src/domain/lineage/coi.ts would not terminate, and a non-terminating query in
-- the enquiry path is an availability incident. The domain layer has findCycle()
-- for the in-memory graph; this trigger is the database-level guarantee that the
-- stored graph can never contain one in the first place.
create or replace function lineage.assert_pedigree_acyclic()
returns trigger
language plpgsql
as $$
declare
  cyclic boolean;
begin
  -- Would the new parent already have the child among its own ancestors?
  with recursive ancestry as (
    select new.parent_id as node_id, 1 as depth
    union all
    select e.parent_id, a.depth + 1
      from lineage.pedigree_edges e
      join ancestry a on e.child_id = a.node_id
      -- Depth bound: MAX_GENERATIONS in src/domain/lineage/coi.ts is 10. A bound
      -- here is defence in depth, not the primary protection.
     where a.depth < 32
  )
  select exists (select 1 from ancestry where node_id = new.child_id) into cyclic;

  if cyclic then
    raise exception 'pedigree edge % -> % would create a cycle', new.child_id, new.parent_id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- Any ancestry change invalidates cached COI for every pair touching this
  -- subtree. Bumping the version is O(1); the cache detects the mismatch on read.
  update lineage.pedigree_nodes
     set subtree_version = subtree_version + 1
   where id in (new.child_id, new.parent_id);

  return new;
end $$;

drop trigger if exists pedigree_edges_acyclic on lineage.pedigree_edges;
create trigger pedigree_edges_acyclic
  before insert or update on lineage.pedigree_edges
  for each row execute function lineage.assert_pedigree_acyclic();

comment on function lineage.assert_pedigree_acyclic() is
  'Rejects any edge that would create an ancestry cycle, and bumps subtree_version to invalidate coi_cache. A cycle here would make the COI walk non-terminating.';

-- ---------------------------------------------------------------------------
-- coi_cache
-- ---------------------------------------------------------------------------
create table if not exists lineage.coi_cache (
  node_a_id     uuid not null references lineage.pedigree_nodes(id) on delete cascade,
  node_b_id     uuid not null references lineage.pedigree_nodes(id) on delete cascade,
  generations   smallint not null check (generations between 1 and 10),
  coi           numeric(6,5) not null check (coi >= 0 and coi <= 1),
  -- NEVER cache a COI without its completeness. A 0.03 COI over a 40%-known
  -- pedigree is not a reassuring number, and the API contract (05 §4) makes it
  -- structurally impossible to return one without the other.
  completeness  numeric(4,3) not null check (completeness between 0 and 1),
  computed_at   timestamptz not null default now(),
  graph_version bigint not null,
  created_at    timestamptz not null default now(),
  primary key (node_a_id, node_b_id, generations),
  -- Canonical ordering so the unordered pair has one cache row, not two.
  check (node_a_id < node_b_id)
);
comment on column lineage.coi_cache.completeness is
  'Fraction of the pedigree actually known. A COI is never returned or rendered without it.';

-- ---------------------------------------------------------------------------
-- breeder_profiles — India registration shape
-- ---------------------------------------------------------------------------
create table if not exists lineage.breeder_profiles (
  id                uuid primary key,
  household_id      uuid not null unique references identity.households(id),
  kennel_name       text check (length(kennel_name) <= 120),
  -- ISO 3166-2 where possible ('IN-KA' for Karnataka). Drives which required-
  -- field rule set applies at publish time.
  jurisdiction      text not null default 'IN-KA' check (length(jurisdiction) <= 12),

  -- PCA (Dog Breeding and Marketing) Rules 2017, Rule 3: registration is with
  -- the State Animal Welfare Board of the state where the establishment sits.
  -- There is no national number, so the pair (number, board) is the identity.
  state_board_registration_number text check (length(state_board_registration_number) <= 80),
  issuing_state_board             text check (length(issuing_state_board) <= 120),
  -- Rule 5: the certificate is valid for TWO YEARS and must be renewed. A lapsed
  -- registration delists; it does not merely warn.
  registration_expires_on         date,

  breeding_females_count smallint check (breeding_females_count >= 0),
  tier4_state         lineage.tier4_state not null default 'not_started',
  premises_review_at  timestamptz,
  -- PRIVACY: encrypted, access-audited. A premises video is effectively a home
  -- video for most small Indian breeders.
  premises_video_storage_key text check (length(premises_video_storage_key) <= 512),
  next_reattestation_at date,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  -- Both halves of the registration identity, or neither. A number without an
  -- issuing board cannot be verified against anything.
  check ((state_board_registration_number is null) = (issuing_state_board is null))
);
comment on table lineage.breeder_profiles is
  'Breeder registration under the PCA (Dog Breeding and Marketing) Rules 2017. Rule 3: state-board registration, not national. Rule 5: two-year validity, renewal required. Rule 7: record-keeping, satisfied jointly with lineage.pairing_outcomes.';
comment on column lineage.breeder_profiles.state_board_registration_number is
  'PCA Rules 2017 Rule 3 — registration number issued by a State Animal Welfare Board. Meaningless without issuing_state_board.';
comment on column lineage.breeder_profiles.registration_expires_on is
  'PCA Rules 2017 Rule 5 — two-year validity. Expiry must delist the breeder''s listings, enforced by the renewal sweep.';

-- The renewal sweep: Rule 5 two-year expiry, run daily.
create index if not exists breeder_profiles_registration_expiry_idx
  on lineage.breeder_profiles (registration_expires_on)
  where registration_expires_on is not null and tier4_state = 'granted';

-- ---------------------------------------------------------------------------
-- breeder_premises — separated table with field-level access control (00 §4.5)
-- ---------------------------------------------------------------------------
create table if not exists lineage.breeder_premises (
  breeder_id        uuid primary key references lineage.breeder_profiles(id) on delete cascade,
  -- PRIVACY: pgcrypto-encrypted premises address. For most Indian breeders this
  -- IS a home address. Separate table so read access can be granted to the
  -- verification role without granting it on breeder_profiles.
  -- Production: dedicated KMS CMK, not a literal key. Same rule as
  -- identity.households.anchor_origin_* — see 0002.
  address_encrypted bytea not null,
  -- Coordinates for licence-authority matching only (which state board applies).
  -- PostGIS deferred; see 0001.
  latitude          numeric(9,6) check (latitude between -90 and 90),
  longitude         numeric(9,6) check (longitude between -180 and 180),
  -- Access audit: who last read this row and when. A support tool that reveals a
  -- breeder's home address is the same stalking vector as any other, with a
  -- login page.
  last_read_by      uuid references identity.users(id),
  last_read_at      timestamptz,
  created_at        timestamptz not null default now()
);
comment on table lineage.breeder_premises is
  'PRIVACY: separated so address read access is a distinct grant. Every read updates last_read_by/last_read_at and emits an ops.audit_log row.';
comment on column lineage.breeder_premises.address_encrypted is
  'PRIVACY: pgcrypto-encrypted. Production requires a dedicated KMS CMK, never a literal or env-file key.';

-- ---------------------------------------------------------------------------
-- listings
-- ---------------------------------------------------------------------------
create table if not exists lineage.listings (
  id               uuid primary key,
  breeder_id       uuid not null references lineage.breeder_profiles(id),
  dog_id           uuid references graph.dogs(id),
  kind             lineage.listing_kind not null,
  title            text not null check (length(title) between 3 and 120),
  body             text check (length(body) <= 4000),

  -- JURISDICTION-REQUIRED DISPLAY FIELDS, validated at publish time, not at
  -- draft time. Under the PCA Rules 2017 the registration details must be
  -- displayed on any advertisement, so publishing without them is not a UI
  -- nicety — it is publishing an unlawful advertisement on our surface.
  display_registration_number text check (length(display_registration_number) <= 80),
  display_issuing_board       text check (length(display_issuing_board) <= 120),
  -- A recognisable photo and the dog's age are both required display elements.
  display_dog_age_months      smallint check (display_dog_age_months >= 0),
  primary_media_id            uuid references graph.dog_media(id),

  -- INR minor units (paise). bigint + char(3), never float (04 §1).
  fee_minor        bigint check (fee_minor >= 0),
  fee_currency     char(3) not null default 'INR',
  state            lineage.listing_state not null default 'draft',
  published_at     timestamptz,
  expires_at       timestamptz,
  -- Geo suppression. India has no federal retail-sale ban, but state and
  -- municipal rules vary and the mechanism must exist before it is needed.
  suppressed_regions text[] not null default '{}',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- The publish-time gate, in the database as well as in the service: a
  -- published listing without its registration display fields cannot exist.
  check (
    state <> 'published' or (
      display_registration_number is not null
      and display_issuing_board is not null
      and display_dog_age_months is not null
      and primary_media_id is not null
    )
  )
);
comment on table lineage.listings is
  'The publish-time CHECK enforces the PCA Rules 2017 advertisement display requirements at the storage layer. The service returns validation-failed naming the rule; this constraint means no other code path can bypass it.';

create index if not exists listings_published_idx
  on lineage.listings (state, published_at desc) where state = 'published';
create index if not exists listings_breeder_idx on lineage.listings (breeder_id);

-- ---------------------------------------------------------------------------
-- enquiries
-- ---------------------------------------------------------------------------
create table if not exists lineage.enquiries (
  id                    uuid primary key,
  listing_id            uuid not null references lineage.listings(id),
  enquirer_household_id uuid not null references identity.households(id),
  enquirer_dog_id       uuid references graph.dogs(id),
  -- Snapshotted at enquiry time. The pedigree can change afterwards; what
  -- matters for an audit is what we told the user when they decided.
  coi_at_enquiry        numeric(6,5) check (coi_at_enquiry between 0 and 1),
  coi_completeness      numeric(4,3) check (coi_completeness between 0 and 1),
  -- Non-null means the pairing was BLOCKED and this is the rule reference.
  -- "Computer says no" on a breeding decision is bad product and bad compliance
  -- (05 §2), so the rule ref is stored, not just logged.
  regulatory_block      text check (length(regulatory_block) <= 200),
  structured_answers    jsonb not null default '{}',
  state                 lineage.enquiry_state not null default 'sent',
  created_at            timestamptz not null default now(),
  -- A COI without completeness is not a number we are willing to have stored.
  check ((coi_at_enquiry is null) = (coi_completeness is null))
);
create index if not exists enquiries_listing_idx on lineage.enquiries (listing_id, created_at desc);
create index if not exists enquiries_household_idx on lineage.enquiries (enquirer_household_id);
create index if not exists enquiries_blocked_idx
  on lineage.enquiries (created_at) where regulatory_block is not null;

-- ---------------------------------------------------------------------------
-- pairing_outcomes
-- ---------------------------------------------------------------------------
create table if not exists lineage.pairing_outcomes (
  id           uuid primary key,
  enquiry_id   uuid unique references lineage.enquiries(id),
  mated_at     date,
  whelped_at   date,
  litter_size  smallint check (litter_size >= 0),
  live_births  smallint check (live_births >= 0),
  -- caesarean exists because welfare rules in several jurisdictions prohibit
  -- further breeding after two caesareans (MAX_CAESAREANS in
  -- src/domain/lineage/regulatory.ts). Without recording it we cannot enforce a
  -- block we have promised. India's PCA Rules 2017 Rule 7 record-keeping
  -- obligations also reach veterinary interventions.
  caesarean    boolean,
  health_notes text check (length(health_notes) <= 2000),
  reported_by  uuid references identity.users(id),
  created_at   timestamptz not null default now(),
  check (whelped_at is null or mated_at is null or whelped_at >= mated_at),
  check (live_births is null or litter_size is null or live_births <= litter_size)
);
comment on column lineage.pairing_outcomes.caesarean is
  'Load-bearing: the two-caesarean breeding prohibition (regulatory.ts MAX_CAESAREANS) is unenforceable without this column.';

create index if not exists pairing_outcomes_enquiry_idx on lineage.pairing_outcomes (enquiry_id);
