-- =============================================================================
-- 0006 — decisions
--
-- ===========================================================================
-- meetup.decisions IS A POSTGRES STAND-IN FOR DynamoDB `waggle-decisions`.
-- READ THIS BEFORE OPTIMISING ANYTHING HERE.
-- ===========================================================================
-- Doc 04 §10 specifies this as a DynamoDB single table, on-demand capacity:
--     PK   DOG#<actorDogId>
--     SK   DEC#<targetDogId>
--     GSI1 PK DOG#<targetDogId>, SK DEC#<actorDogId>   (reciprocal lookup)
--     TTL  180 days on `pass`; `interest` retained while the dog is active
-- It is the write-heaviest data in the system at scale.
--
-- WHY POSTGRES IS ACCEPTABLE AT LAUNCH
--   * One metro. Doc 12's launch model is on the order of 10^4-10^5 decisions per
--     day — a few writes per second, three orders of magnitude inside what a
--     single Aurora writer handles without noticing.
--   * The two access patterns map exactly onto the composite primary key and one
--     secondary index below. The DynamoDB key design IS this table's key design;
--     nothing about the query shape changes on migration.
--   * Match detection needs the reciprocal read to be strongly consistent. In
--     Postgres it is free and in the same transaction as the match insert. In
--     DynamoDB the GSI is eventually consistent, so the mutual-like check needs
--     either a consistent read on the base table (possible, because the
--     reciprocal is a different partition — so it is a second GetItem) or a
--     tolerated race. Launching on Postgres means the transactional version ships
--     first and the DynamoDB version has a working reference to match.
--   * Keeping decisions transactional with match + conversation creation is what
--     lets ONE transaction handle the concurrent-mutual-like race via the
--     (pair_key, mode) unique constraint (03 ADR 007). Splitting the stores means
--     a distributed transaction or a compensating action, and that complexity is
--     not worth buying before there is load to justify it.
--
-- WHEN IT MUST MOVE
--   * Sustained write rate above ~1,500 decisions/sec (~130M/day), or
--   * more than ~1B rows, or
--   * autovacuum on this table becoming the dominant source of write
--     amplification on the cluster, or
--   * the 180-day TTL sweep on `pass` rows costing more in vacuum churn than the
--     rows are worth.
--   Doc 04's M12 impression model (~12.6M impressions/day) implies a decision
--   rate around 1-2M/day at M12 — comfortably inside Postgres. The trigger is
--   more likely to be row count than write rate, i.e. M18-M24 on the base case.
--
-- WHY THE MIGRATION IS MECHANICAL
--   Every access is behind DecisionRepository (src/modules/decisions/
--   decisions.repository.ts), which exposes exactly four operations:
--     record(), findReciprocal(), countToday(), listDecidedDogIds().
--   The DynamoDB implementation is those four methods plus a TTL attribute. The
--   ONE thing that does not carry over is transactional atomicity with the match
--   insert; the DynamoDB version must therefore write the decision first, then
--   attempt the match insert, and treat a crash between them as a decision that
--   will be re-evaluated on the next reciprocal write. That behaviour is designed
--   and must be tested BEFORE the switch, not discovered during it.
--
-- feed_request_id, position and rank_score are stored on the decision because
-- they are what make the ranker trainable — without position the training data is
-- hopelessly position-biased (04 §10, 06 §5.3).
-- ===========================================================================
-- =============================================================================

do $$ begin
  create type meetup.verdict as enum ('interest','pass','super_sniff');
exception when duplicate_object then null; end $$;

create table if not exists meetup.decisions (
  actor_dog_id    uuid not null references graph.dogs(id) on delete cascade,
  target_dog_id   uuid not null references graph.dogs(id) on delete cascade,
  mode            meetup.mode not null,
  verdict         meetup.verdict not null,
  -- Ranking provenance. Required for trainability and for the CPPA/DPDP
  -- automated-decision explainability commitment (06 §12: every feed request is
  -- reconstructable).
  feed_request_id uuid,
  position        smallint check (position >= 0),
  rank_score      real,
  model_version   text check (length(model_version) <= 40),
  decided_at      timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  -- DynamoDB PK/SK equivalent. mode is part of the key because the same two dogs
  -- decide independently in Pack and in Lineage.
  primary key (actor_dog_id, target_dog_id, mode),
  check (actor_dog_id <> target_dog_id)
);

comment on table meetup.decisions is
  'POSTGRES STAND-IN FOR DynamoDB waggle-decisions. See the header comment in 0006_decisions.sql: acceptance rationale, the write-rate/row-count triggers to migrate, and why DecisionRepository makes the migration mechanical.';
comment on column meetup.decisions.position is
  'Card position in the feed page. Without it the training data is position-biased and the ranker cannot be corrected (06 §5.3).';

-- GSI1 equivalent: the reciprocal lookup that detects a mutual like.
create index if not exists decisions_reciprocal_idx
  on meetup.decisions (target_dog_id, actor_dog_id, mode);

-- The daily-quota count and the already-decided exclusion set both read by actor.
create index if not exists decisions_actor_recent_idx
  on meetup.decisions (actor_dog_id, decided_at desc);

-- The TTL sweep on `pass` rows (180 days, doc 04 §10). Partial so it does not
-- carry the `interest` rows, which are retained while the dog is active.
create index if not exists decisions_pass_ttl_idx
  on meetup.decisions (decided_at) where verdict = 'pass';
