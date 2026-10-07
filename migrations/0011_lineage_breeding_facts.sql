-- =============================================================================
-- 0011 — lineage.dog_breeding_facts, and dam/sire attribution on pairing outcomes
-- Plan: 04-data-model.md §7, 06-matching-and-ml.md §9.
--
-- WHY THIS MIGRATION EXISTS
-- ---------------------------------------------------------------------------
-- src/domain/lineage/regulatory.ts checkDogFacts() enforces three hard blocks
-- that need per-dog breeding history:
--
--   * caesarean.limit_reached            needs caesareanCount
--   * frequency.litter_in_last_12_months needs littersInLast12Months
--   * (record-keeping, PCA Rules 2017 Rule 7) needs littersLifetime
--
-- Nothing in 0001-0009 stores any of them. `lineage.pairing_outcomes.caesarean`
-- records a single event but has no dam reference, so it cannot be aggregated
-- per dog — which means the two-caesarean prohibition we have promised to
-- enforce was, before this migration, unenforceable. A block that cannot be
-- computed is worse than an absent block: the product claims a protection it
-- does not have.
--
-- WHY A DENORMALISED COUNTER RATHER THAN count(*) OVER pairing_outcomes
-- ---------------------------------------------------------------------------
-- Three reasons, in order of weight:
--   1. CORRECTNESS OF HISTORY. A dam's caesareans and litters overwhelmingly
--      predate her arrival on Waggle. The counter is a declared-and-then-
--      verified figure with a starting value, not a count of rows we happen to
--      hold. A count(*) would report zero caesareans for a dam with two,
--      i.e. it would silently unblock the pairing the rule prohibits.
--   2. The regulatory check runs on the COI/enquiry hot path (400 ms p95 budget,
--      06 §9). A single indexed row read is the right cost; a join-and-aggregate
--      over outcomes per dog per check is not.
--   3. Outcomes are reported against an ENQUIRY, and a pairing that happened off
--      platform has no enquiry to hang an outcome on. The counter can still be
--      corrected by an operator; a derived count cannot.
--
-- The counter is maintained in the SAME TRANSACTION as the outcome insert, so it
-- cannot drift from the rows that justify it. `source` records whether a figure
-- is owner-declared or document-verified, for the same reason every pedigree
-- node carries provenance: a welfare block resting on an unverified self-report
-- must be visibly doing so.
-- =============================================================================

do $$ begin
  create type lineage.fact_source as enum ('owner_declared','document_verified','platform_recorded');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- dog_breeding_facts
-- ---------------------------------------------------------------------------
create table if not exists lineage.dog_breeding_facts (
  dog_id                uuid primary key references graph.dogs(id) on delete cascade,

  -- MAX_CAESAREANS in src/domain/lineage/regulatory.ts is 2. At 2 the dam is
  -- blocked from further breeding, permanently and without an in-product
  -- override — only an audited support action can change this number.
  caesarean_count       smallint not null default 0 check (caesarean_count >= 0),
  litters_lifetime      smallint not null default 0 check (litters_lifetime >= 0),

  -- MAX_LITTERS_PER_12_MONTHS is 1, so the only question the frequency rule asks
  -- is "has she whelped within the last twelve months". A date answers that in
  -- one column read; a count over a rolling window would need a scan.
  last_whelped_on       date,

  source                lineage.fact_source not null default 'owner_declared',
  -- Who last changed these numbers and when. A welfare block is an adverse
  -- decision about a user's animal, so its inputs must be attributable.
  last_updated_by       uuid references identity.users(id),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
comment on table lineage.dog_breeding_facts is
  'Per-dog breeding history that the welfare blocks in src/domain/lineage/regulatory.ts depend on. Maintained transactionally by the whelp-report path; correctable only by an audited support action.';
comment on column lineage.dog_breeding_facts.caesarean_count is
  'Load-bearing: MAX_CAESAREANS = 2 in regulatory.ts. Reaching 2 blocks further breeding with no in-product override.';
comment on column lineage.dog_breeding_facts.last_whelped_on is
  'PCA (Dog Breeding and Marketing) Rules 2017, Second Schedule — breeding frequency. One column read answers the only question the rule asks.';

-- The re-check sweep: which dams come back inside the 12-month window, and when.
create index if not exists dog_breeding_facts_last_whelped_idx
  on lineage.dog_breeding_facts (last_whelped_on)
  where last_whelped_on is not null;
-- The dams at or over the caesarean limit. Small, and read by the ops review.
create index if not exists dog_breeding_facts_caesarean_limit_idx
  on lineage.dog_breeding_facts (caesarean_count)
  where caesarean_count >= 2;

-- ---------------------------------------------------------------------------
-- pairing_outcomes — explicit dam and sire
--
-- Both are derivable today (one side of the enquiry is the listing's dog, the
-- other is the enquirer's, and the female is the dam), but derivation depends on
-- graph.dogs.sex still holding the value it held at the time. A sex correction —
-- which does happen, on a young dog — would silently reattribute a caesarean to
-- the wrong animal years later. This is a welfare record; it is written down.
-- ---------------------------------------------------------------------------
alter table lineage.pairing_outcomes
  add column if not exists dam_dog_id uuid references graph.dogs(id);
alter table lineage.pairing_outcomes
  add column if not exists sire_dog_id uuid references graph.dogs(id);

comment on column lineage.pairing_outcomes.dam_dog_id is
  'Recorded explicitly rather than derived through the enquiry, so a later correction to graph.dogs.sex cannot reattribute a caesarean to the wrong dog.';

create index if not exists pairing_outcomes_dam_idx
  on lineage.pairing_outcomes (dam_dog_id, whelped_at desc)
  where dam_dog_id is not null;
