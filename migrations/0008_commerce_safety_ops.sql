-- =============================================================================
-- 0008 — commerce, safety, ops
-- Plan: 04-data-model.md §8, §10, §11.
-- =============================================================================

do $$ begin
  -- google_play FIRST, deliberately: India is an Android-majority market and
  -- Play is the primary store by an order of magnitude. 'web' exists because
  -- UPI-based web checkout avoids store commission entirely where policy allows.
  create type commerce.store as enum ('google_play','apple','web');
exception when duplicate_object then null; end $$;

do $$ begin
  create type commerce.sub_state as enum
    ('trialing','active','grace','on_hold','paused','expired','cancelled','refunded');
exception when duplicate_object then null; end $$;

do $$ begin
  create type safety.subject_type as enum
    ('user','dog','message','listing','media','meetup','household');
exception when duplicate_object then null; end $$;

do $$ begin
  create type safety.report_state as enum
    ('queued','in_review','actioned','dismissed','escalated');
exception when duplicate_object then null; end $$;

do $$ begin
  create type safety.action as enum
    ('warn','limit','shadow_limit','suspend','ban','law_enforcement_referral');
exception when duplicate_object then null; end $$;

do $$ begin
  create type safety.appeal_state as enum ('submitted','in_review','upheld','overturned','withdrawn');
exception when duplicate_object then null; end $$;

do $$ begin
  create type ops.launch_state as enum
    ('prospect','seeding','waitlist','soft_launch','gated','open');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- ops.metros — created here, referenced from 0002/0003/0005 (see those files)
-- ---------------------------------------------------------------------------
create table if not exists ops.metros (
  id             uuid primary key,
  name           text not null check (length(name) between 2 and 80),
  country        char(2) not null default 'IN',
  -- State/UT. 'KA' for Karnataka. Also selects the applicable State Animal
  -- Welfare Board for breeder registration (PCA Rules 2017 Rule 3).
  admin_region   text check (length(admin_region) <= 60),
  timezone       text not null default 'Asia/Kolkata' check (length(timezone) <= 64),
  currency       char(3) not null default 'INR',
  -- Metro-scale cell ids covering the metro. text[] rather than bigint[] because
  -- the launch cell index is geohash (see 0002); H3 res-5 ids drop straight in.
  metro_cells    text[] not null default '{}',
  launch_state   ops.launch_state not null default 'prospect',
  gate_passed_at timestamptz,
  -- Active-dog count, maintained by a scheduled job. Read by the scorer's
  -- fatigue term (candidate.ts metroActiveDogs): the impression cap must scale
  -- with the market or a thin metro is throttled into emptiness.
  active_dog_count integer not null default 0 check (active_dog_count >= 0),
  created_at     timestamptz not null default now()
);
comment on column ops.metros.active_dog_count is
  'Denormalised, job-maintained. Input to the fatigue-damping cap in the heuristic scorer. Stale-tolerant by design.';

-- Deferred foreign keys from the earlier migrations. Added here so ops.metros has
-- exactly one definition site. Guarded because ALTER TABLE ADD CONSTRAINT has no
-- IF NOT EXISTS in Postgres 17.
do $$ begin
  alter table identity.households
    add constraint households_metro_fk foreign key (metro_id) references ops.metros(id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table graph.dog_metro_ordinal
    add constraint dog_metro_ordinal_metro_fk foreign key (metro_id) references ops.metros(id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table graph.metro_ordinal_counter
    add constraint metro_ordinal_counter_metro_fk foreign key (metro_id) references ops.metros(id);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table meetup.places
    add constraint places_metro_fk foreign key (metro_id) references ops.metros(id);
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- commerce.subscriptions
-- ---------------------------------------------------------------------------
create table if not exists commerce.subscriptions (
  id              uuid primary key,
  user_id         uuid not null references identity.users(id) on delete cascade,
  product_id      text not null check (length(product_id) <= 120),
  store           commerce.store not null,
  store_txn_id    text unique check (length(store_txn_id) <= 200),
  -- RevenueCat app user id. Kept so a receipt can be reconciled without the
  -- client asserting anything about its own entitlements.
  rc_app_user_id  text check (length(rc_app_user_id) <= 120),
  tier            text not null check (length(tier) <= 40),
  state           commerce.sub_state not null default 'active',
  period_start    timestamptz not null,
  period_end      timestamptz not null,
  auto_renew      boolean not null default true,
  cancelled_at    timestamptz,
  -- INR minor units = paise. bigint, never float (04 §1). A ₹249/month plan is
  -- price_minor = 24900, currency = 'INR'.
  price_minor     bigint check (price_minor >= 0),
  currency        char(3) not null default 'INR',
  -- Statutory cancellation deadline, where a jurisdiction grants one. India has
  -- no direct equivalent of Cal. Civ. Code § 1694.1, but the column is retained
  -- because we build to the strictest requirement once rather than per market.
  statutory_cancel_deadline timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (period_end > period_start)
);
create index if not exists subscriptions_user_state_idx
  on commerce.subscriptions (user_id, state);
-- The renewal/expiry sweep.
create index if not exists subscriptions_period_end_idx
  on commerce.subscriptions (period_end) where state in ('trialing','active','grace');

-- ---------------------------------------------------------------------------
-- commerce.entitlements — the server-authoritative capability grid
--
-- The client NEVER infers entitlement from a receipt (05 §3.1). This table plus
-- verify.tiers_granted is the whole authority, read through
-- EntitlementsService.can().
-- ---------------------------------------------------------------------------
create table if not exists commerce.entitlements (
  user_id    uuid not null references identity.users(id) on delete cascade,
  -- Capability strings, not product names: 'pack.interest',
  -- 'pack.unlimited_interest', 'pack.super_sniff', 'lineage.listing',
  -- 'lineage.enquiry'. A product rename must not become an access-control change.
  capability text not null check (length(capability) <= 60),
  source     text not null check (length(source) <= 120),
  granted_at timestamptz not null default now(),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, capability)
);
comment on table commerce.entitlements is
  'Server-authoritative capabilities. Read only through EntitlementsService.can(). Never derive an entitlement client-side from a store receipt.';
create index if not exists entitlements_expiry_idx
  on commerce.entitlements (expires_at) where expires_at is not null;

-- ---------------------------------------------------------------------------
-- safety.reports
-- ---------------------------------------------------------------------------
create table if not exists safety.reports (
  id               uuid primary key,
  -- null for system-generated reports (classifier, velocity detector).
  reporter_user_id uuid references identity.users(id),
  subject_type     safety.subject_type not null,
  subject_id       uuid not null,
  category         text not null check (length(category) <= 60),
  free_text        text check (length(free_text) <= 2000),
  evidence         jsonb not null default '{}',
  severity         smallint not null check (severity between 0 and 4),
  state            safety.report_state not null default 'queued',
  priority_score   numeric(8,3),
  assigned_to      uuid references identity.users(id),
  first_action_at  timestamptz,
  resolved_at      timestamptz,
  created_at       timestamptz not null default now()
);
-- The moderator queue read. Partial index because resolved reports are the bulk
-- of the table and are never in this query.
create index if not exists reports_queue_idx
  on safety.reports (state, priority_score desc) where state in ('queued','in_review');
create index if not exists reports_subject_idx on safety.reports (subject_type, subject_id);

-- ---------------------------------------------------------------------------
-- safety.enforcement_actions
-- ---------------------------------------------------------------------------
create table if not exists safety.enforcement_actions (
  id                 uuid primary key,
  subject_type       safety.subject_type not null,
  subject_id         uuid not null,
  action             safety.action not null,
  reason_code        text not null check (length(reason_code) <= 60),
  -- policy_ref is NOT NULL on purpose. A statement of reasons naming the exact
  -- policy clause is required by the DSA Art 17 shape we build to everywhere,
  -- and it is also what makes an appeal reviewable by someone who was not there.
  policy_ref         text not null check (length(policy_ref) <= 120),
  decided_by         uuid references identity.users(id),
  double_reviewed_by uuid references identity.users(id),
  report_id          uuid references safety.reports(id),
  expires_at         timestamptz,
  reversed_at        timestamptz,
  reversal_reason    text check (length(reversal_reason) <= 300),
  created_at         timestamptz not null default now()
);
comment on column safety.enforcement_actions.policy_ref is
  'NOT NULL by design: an enforcement action without a named policy clause is unappealable and non-compliant with the statement-of-reasons requirement.';
create index if not exists enforcement_actions_subject_idx
  on safety.enforcement_actions (subject_type, subject_id);
create index if not exists enforcement_actions_active_idx
  on safety.enforcement_actions (expires_at) where reversed_at is null;

-- ---------------------------------------------------------------------------
-- safety.ban_notifications
--
-- Utah § 13-67-105 shape: notify anyone who received AND RESPONDED TO a message
-- from a subsequently-banned member, within 24 hours.
--
-- WHY THIS IS HERE IN AN INDIA-FIRST LAUNCH: Utah does not apply to us. We keep
-- the mechanism because it is the strictest formulation of an obligation we
-- believe in anyway — someone who talked to a banned user should be told — and
-- building it once at the strictest shape is cheaper than retrofitting it when a
-- market requires it. The 24-hour clock is the product commitment, not a legal
-- one, and doc 07 treats a missed due_at as an SLO breach.
-- ---------------------------------------------------------------------------
create table if not exists safety.ban_notifications (
  id               uuid primary key,
  banned_user_id   uuid not null references identity.users(id) on delete cascade,
  notified_user_id uuid not null references identity.users(id) on delete cascade,
  conversation_id  uuid references meetup.conversations(id),
  due_at           timestamptz not null,
  sent_at          timestamptz,
  channel          text check (length(channel) <= 40),
  created_at       timestamptz not null default now(),
  unique (banned_user_id, notified_user_id),
  check (banned_user_id <> notified_user_id)
);
comment on table safety.ban_notifications is
  'Utah § 13-67-105 shape, retained deliberately in an India-first launch: build to the strictest formulation once. A missed due_at is an SLO breach (doc 07).';
create index if not exists ban_notifications_due_idx
  on safety.ban_notifications (due_at) where sent_at is null;

-- ---------------------------------------------------------------------------
-- safety.blocks
-- ---------------------------------------------------------------------------
create table if not exists safety.blocks (
  blocker_user_id uuid not null references identity.users(id) on delete cascade,
  blocked_user_id uuid not null references identity.users(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);
-- Blocks are BIDIRECTIONAL in effect: the hard filter excludes the household in
-- either direction, so this reverse index is on the feed's hot path.
create index if not exists blocks_reverse_idx on safety.blocks (blocked_user_id);

-- ---------------------------------------------------------------------------
-- safety.appeals
-- ---------------------------------------------------------------------------
create table if not exists safety.appeals (
  id         uuid primary key,
  action_id  uuid not null references safety.enforcement_actions(id) on delete cascade,
  user_id    uuid not null references identity.users(id) on delete cascade,
  statement  text check (length(statement) <= 4000),
  state      safety.appeal_state not null default 'submitted',
  -- Must not equal enforcement_actions.decided_by. Enforced in the service, not
  -- by a constraint, because the check spans two tables.
  decided_by uuid references identity.users(id),
  outcome    text check (length(outcome) <= 300),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists appeals_user_idx on safety.appeals (user_id, created_at desc);
create index if not exists appeals_open_idx
  on safety.appeals (created_at) where state in ('submitted','in_review');

-- ---------------------------------------------------------------------------
-- ops.outbox — transactional outbox
--
-- Events are inserted in the SAME transaction as the state change that caused
-- them. That is the entire point: a match that exists without a match.created
-- event, or an event for a match that rolled back, are both bugs that a
-- publish-after-commit design produces routinely and this one cannot.
-- ---------------------------------------------------------------------------
create table if not exists ops.outbox (
  id           bigserial primary key,
  topic        text not null check (length(topic) <= 80),
  -- Kafka partition key. Same key == same partition == ordered per entity.
  event_key    text not null check (length(event_key) <= 120),
  event_id     uuid not null unique,
  payload      jsonb not null,
  attempts     smallint not null default 0 check (attempts >= 0),
  last_error   text check (length(last_error) <= 500),
  created_at   timestamptz not null default now(),
  published_at timestamptz
);
-- The relay's only query. Partial so the index stays the size of the backlog,
-- not the size of history.
create index if not exists outbox_unpublished_idx
  on ops.outbox (id) where published_at is null;

-- ---------------------------------------------------------------------------
-- ops.audit_log — monthly range partitions
-- ---------------------------------------------------------------------------
create table if not exists ops.audit_log (
  id            bigserial,
  actor_user_id uuid,
  actor_kind    text not null check (actor_kind in ('user','staff','system')),
  action        text not null check (length(action) <= 80),
  subject_type  text not null check (length(subject_type) <= 40),
  subject_id    uuid,
  -- PRIVACY: before/after must be REDACTED of anchor origins, phone numbers,
  -- microchip numbers and message bodies before insertion. An audit log that
  -- copies the sensitive field it is auditing is a second copy of the risk.
  before        jsonb,
  after         jsonb,
  request_id    uuid,
  created_at    timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

comment on table ops.audit_log is
  'Write-heavy, read-rare, legally required. Monthly partitions, 24-month retention (04 §11).';
comment on column ops.audit_log.before is
  'PRIVACY: redact anchor coordinates, phone numbers, microchip numbers and message bodies before writing. Audit the ACCESS, not the secret.';

-- Partition helper. Idempotent, so the scheduled job can run daily without care.
create or replace function ops.create_audit_partition(p_month date)
returns text
language plpgsql
as $$
declare
  start_d date := date_trunc('month', p_month)::date;
  end_d   date := (date_trunc('month', p_month) + interval '1 month')::date;
  part    text := format('audit_log_%s', to_char(start_d, 'YYYYMM'));
begin
  if not exists (
    select 1 from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'ops' and c.relname = part
  ) then
    execute format(
      'create table ops.%I partition of ops.audit_log for values from (%L) to (%L)',
      part, start_d, end_d
    );
    execute format('create index on ops.%I (subject_type, subject_id)', part);
    execute format('create index on ops.%I (actor_user_id)', part);
  end if;
  return part;
end $$;

comment on function ops.create_audit_partition(date) is
  'Idempotent monthly partition creation. Run daily by the ops job; running it for an existing month is a no-op. A missing partition makes every audited write fail, so the job creates NEXT month ahead of time.';

-- Previous, current and next month, so a deploy that crosses a month boundary
-- cannot land in a window with no partition.
select ops.create_audit_partition((now() - interval '1 month')::date);
select ops.create_audit_partition(now()::date);
select ops.create_audit_partition((now() + interval '1 month')::date);

-- Catch-all so a clock skew or a backdated insert cannot fail a write. Rows
-- landing here are a monitored anomaly, not a silent success.
create table if not exists ops.audit_log_default partition of ops.audit_log default;

-- ---------------------------------------------------------------------------
-- ops.impressions — the `feed.served` log
--
-- ===========================================================================
-- POSTGRES STAND-IN FOR ClickHouse `fct_impressions`.
-- ===========================================================================
-- Doc 04 §10 routes this through Kafka (`feed.served`) into ClickHouse
-- MergeTree, partitioned by toYYYYMMDD(served_at), ordered by
-- (metro_id, served_at, actor_dog_id), 90-day raw retention then a daily rollup.
--
-- WHY IT EXISTS AT ALL: decisions alone are not sufficient training data. The
-- ranker needs the cards that were SHOWN AND NOT ACTED ON as negatives (06
-- §5.3). Those never enter the decisions table, so they need their own store.
-- Three separate commitments rest on this table: unbiased ranker training, the
-- automated-decision attribution requirement, and doc 06 §12's promise that
-- every feed request is reconstructable.
--
-- WHY POSTGRES IS ACCEPTABLE AT LAUNCH: at one metro this is ~10^5 rows/day.
-- Doc 04 models ~12.6M rows/day at M12, which is where Postgres stops being the
-- right answer — that is two orders of magnitude away and the trigger is volume,
-- not query shape.
--
-- WHEN IT MUST MOVE: above ~2M rows/day sustained, or when the 90-day window
-- exceeds ~200M rows, or when the nightly training extract cannot complete
-- inside its window. The outbox already emits `feed.served`, so the ClickHouse
-- path is "point the existing consumer at ClickHouse" — this table is a
-- SECOND sink, not the source of truth for the event.
--
-- RETENTION: 90 days raw, a deliberate departure from the 25-month analytics
-- retention, justified by volume and by the fact that training only reads recent
-- weeks (04 §12).
-- ===========================================================================
-- ---------------------------------------------------------------------------
create table if not exists ops.impressions (
  id              bigserial primary key,
  -- Binds every card in one feed response together. The impressionToken signs
  -- over this, and a decision without a valid token is rejected (05 §3.3).
  feed_request_id uuid not null,
  position        smallint not null check (position >= 0),
  target_dog_id   uuid not null,
  actor_dog_id    uuid not null,
  metro_id        uuid,
  model_version   text not null check (length(model_version) <= 40),
  rank_score      real not null,
  -- True when this response came from the exploration slice, so propensity
  -- weighting can correct for the randomised ordering rather than learning it.
  randomised_slice boolean not null default false,
  -- Degraded means the heuristic scorer served this, not the model. Logged,
  -- never shown to the user (05 §3.3).
  degraded        boolean not null default false,
  served_at       timestamptz not null default now(),
  created_at      timestamptz not null default now()
);
comment on table ops.impressions is
  'POSTGRES STAND-IN FOR ClickHouse fct_impressions. See the header comment in 0008: why it exists, volume triggers to migrate, 90-day retention. The outbox feed.served event is the source of truth; this table is a launch-scale sink.';
comment on column ops.impressions.randomised_slice is
  'Exploration slice marker. Required for inverse-propensity weighting; without it the model learns the exploration noise.';

-- No FK to graph.dogs: this is an append-only analytics sink and a deleted dog
-- must not cascade away its training history or block the insert.
create index if not exists impressions_feed_request_idx
  on ops.impressions (feed_request_id);
create index if not exists impressions_actor_idx
  on ops.impressions (actor_dog_id, served_at desc);
-- Fatigue damping asks "how many impressions has this dog received in 24 h".
create index if not exists impressions_target_recent_idx
  on ops.impressions (target_dog_id, served_at desc);
-- Metro first, matching the ClickHouse ORDER BY: almost every analytical
-- question in this product is geographic (04 §10).
create index if not exists impressions_metro_served_idx
  on ops.impressions (metro_id, served_at);
