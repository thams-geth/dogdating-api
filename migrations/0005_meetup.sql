-- =============================================================================
-- 0005 — meetup: matches, conversations, messages, places, meetups, reviews
-- Plan: 04-data-model.md §6, 03-system-architecture.md ADR 007.
--
-- ===========================================================================
-- meetup.messages IS A POSTGRES STAND-IN FOR ScyllaDB. READ THIS FIRST.
-- ===========================================================================
-- Doc 04 §10 specifies message bodies in ScyllaDB, partitioned by
-- conversation_id and clustered by descending seq, so the common read (latest N
-- messages in one conversation) is a single contiguous partition scan.
--
-- WHY POSTGRES IS ACCEPTABLE AT LAUNCH
--   * One metro (Bengaluru), a few thousand conversations. The whole message
--     corpus fits in shared_buffers.
--   * The Scylla access pattern maps exactly onto a btree on
--     (conversation_id, seq desc) — the same contiguous scan, just in a B-tree
--     leaf instead of an SSTable. Reads are equivalent in shape and cost here.
--   * Running a Scylla cluster for a launch metro is operational cost with no
--     corresponding benefit, and doc 09's cost model does not carry it at M0.
--
-- WHEN IT MUST MOVE
--   * Sustained write rate above ~2,000 messages/sec, or
--   * more than ~500M rows in this table, or
--   * p99 insert latency above 20 ms attributable to index maintenance,
--     whichever comes first. Doc 04's M12 model implies the first of these lands
--     between M9 and M12 on the base-case growth curve.
--
-- WHY THE MIGRATION IS MECHANICAL
--   All access is behind MessageRepository. The Scylla implementation swaps the
--   two methods (appendMessage, readMessagesBefore) and nothing else changes.
--   `seq` is assigned server-side, monotonic per conversation, which is exactly
--   what the Scylla clustering key requires — the ordering contract is already
--   the Scylla contract.
--
-- One thing does NOT carry over automatically: per-conversation encryption of
-- `body`. In the Scylla design the body is encrypted with a per-conversation data
-- key wrapped by KMS, so a store compromise yields no plaintext. This table holds
-- `body_encrypted bytea` for the same reason, and the key-wrapping code path must
-- exist BEFORE launch, not at migration time — otherwise the migration silently
-- downgrades the threat model.
-- ===========================================================================
-- =============================================================================

do $$ begin
  create type meetup.mode as enum ('pack','lineage');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.match_state as enum ('active','ended','blocked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.conversation_state as enum ('open','closed','frozen');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.message_kind as enum ('text','photo','voice','place_card','system');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.place_kind as enum
    ('offleash_park','trail','fenced_area','venue','vet','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.place_state as enum ('pending','approved','rejected','closed');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.meetup_kind as enum ('parallel_walk','play','training','hike','group');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.meetup_state as enum
    ('proposed','accepted','declined','cancelled','in_progress','completed','no_show','incident');
exception when duplicate_object then null; end $$;

do $$ begin
  create type meetup.rsvp as enum ('pending','yes','no','maybe');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- matches
--
-- pair_key is the concurrency design, not a convenience. Two owners can like each
-- other in the same millisecond. The fix is not a distributed lock: derive one
-- canonical key from the unordered pair (src/domain/matching/pair.ts
-- canonicalPair) and put a UNIQUE constraint on (pair_key, mode). Both inserts
-- race for the same key; one wins, the loser gets SQLSTATE 23505 and reads the
-- winner's row. Correct by construction, no coordination (03 ADR 007).
--
-- Uniqueness is per MODE because the same two dogs may legitimately hold a Pack
-- match (playdates) AND a Lineage match (breeding introduction) simultaneously.
-- ---------------------------------------------------------------------------
create table if not exists meetup.matches (
  id          uuid primary key,
  pair_key    text not null check (length(pair_key) <= 80),
  dog_a_id    uuid not null references graph.dogs(id),
  dog_b_id    uuid not null references graph.dogs(id),
  mode        meetup.mode not null,
  state       meetup.match_state not null default 'active',
  created_at  timestamptz not null default now(),
  ended_at    timestamptz,
  ended_by    uuid references identity.users(id),
  end_reason  text check (length(end_reason) <= 120),
  -- Canonical ordering. Guarantees pair_key and the column pair agree, so
  -- (dog_a_id, dog_b_id) can be trusted as a sorted pair by every reader.
  check (dog_a_id < dog_b_id),
  unique (pair_key, mode)
);
comment on column meetup.matches.pair_key is
  'least(dogA,dogB) || '':'' || greatest(dogA,dogB). The unique constraint on (pair_key, mode) is how the concurrent-mutual-like race is resolved (03 ADR 007).';

create index if not exists matches_dog_a_active_idx
  on meetup.matches (dog_a_id) where state = 'active';
create index if not exists matches_dog_b_active_idx
  on meetup.matches (dog_b_id) where state = 'active';

-- ---------------------------------------------------------------------------
-- conversations
--
-- match_id IS NOT NULL, deliberately. Decision D4: Spark conversations live
-- wholly in the separate Spark cluster. A nullable spark_pair_id here would make
-- Spark membership derivable from the main cluster just by looking at which rows
-- have it set — which defeats the segregation entirely. There is therefore no
-- Spark column in this table and no nullable match_id to hang one on.
-- ---------------------------------------------------------------------------
create table if not exists meetup.conversations (
  id              uuid primary key,
  match_id        uuid not null unique references meetup.matches(id),
  state           meetup.conversation_state not null default 'open',
  last_message_at timestamptz,
  -- Server-assigned monotonic counter. This is the ScyllaDB clustering key in
  -- waiting; see the header note.
  last_seq        bigint not null default 0 check (last_seq >= 0),
  created_at      timestamptz not null default now()
);
comment on table meetup.conversations is
  'Pack and Lineage conversations ONLY. Spark conversations live in the separate Spark cluster (Decision D4). Never add a nullable spark_* column here.';

create table if not exists meetup.conversation_members (
  conversation_id uuid not null references meetup.conversations(id) on delete cascade,
  user_id         uuid not null references identity.users(id),
  last_read_seq   bigint not null default 0 check (last_read_seq >= 0),
  muted_until     timestamptz,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index if not exists conversation_members_user_idx
  on meetup.conversation_members (user_id);

-- ---------------------------------------------------------------------------
-- messages — see the ScyllaDB stand-in note in this file's header
-- ---------------------------------------------------------------------------
create table if not exists meetup.messages (
  conversation_id uuid not null references meetup.conversations(id) on delete cascade,
  -- Monotonic per conversation, assigned server-side. Ordering contract for the
  -- client's reconnect-and-catch-up path, and the Scylla clustering key.
  seq             bigint not null check (seq > 0),
  message_id      uuid not null unique,
  sender_user_id  uuid not null references identity.users(id),
  kind            meetup.message_kind not null default 'text',
  -- PRIVACY: encrypted with a per-conversation data key wrapped by KMS. A store
  -- compromise alone yields no plaintext. Do NOT add a plaintext body column,
  -- and do not log decrypted bodies — a moderator reading a message is an
  -- audited event (05 §3.10), not a log line.
  body_encrypted  bytea,
  media_ref       text check (length(media_ref) <= 512),
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  primary key (conversation_id, seq)
);
comment on table meetup.messages is
  'POSTGRES STAND-IN FOR ScyllaDB. See the header comment in 0005_meetup.sql for the acceptance rationale, the write-rate trigger to migrate, and why MessageRepository makes it mechanical.';
comment on column meetup.messages.body_encrypted is
  'PRIVACY: per-conversation data key, wrapped by KMS. Never store plaintext. Never log decrypted content.';

-- Descending seq: the common read is "latest N in this conversation".
create index if not exists messages_conversation_seq_idx
  on meetup.messages (conversation_id, seq desc);

-- ---------------------------------------------------------------------------
-- places — PUBLIC locations, so real geography is legitimate and necessary
--
-- PostGIS is deferred (0001), so latitude/longitude are plain numerics and
-- bbox queries are range scans. This is the ONE place in the schema where a
-- precise coordinate is correct: a public park's location is not personal data.
-- ---------------------------------------------------------------------------
create table if not exists meetup.places (
  id            uuid primary key,
  name          text not null check (length(name) between 1 and 120),
  kind          meetup.place_kind not null,
  latitude      numeric(9,6) not null check (latitude between -90 and 90),
  longitude     numeric(9,6) not null check (longitude between -180 and 180),
  address       text check (length(address) <= 300),
  metro_id      uuid,
  is_fenced     boolean,
  has_water     boolean,
  surface       text check (length(surface) <= 40),
  -- India-specific and load-bearing: shade and water decide whether a 2 p.m.
  -- Bengaluru meetup is safe for a brachycephalic dog.
  accessibility jsonb not null default '{}',
  busy_profile  jsonb,
  verified_at   timestamptz,
  verified_by   uuid references identity.users(id),
  submitted_by  uuid references identity.users(id),
  state         meetup.place_state not null default 'pending',
  created_at    timestamptz not null default now()
);
comment on table meetup.places is
  'Public places. Real coordinates are correct here and nowhere else in the matching path. Will move to geography(point,4326) when PostGIS lands (see 0001).';

create index if not exists places_metro_state_idx on meetup.places (metro_id, state);
-- Composite range index stands in for the GiST index until PostGIS lands.
create index if not exists places_bbox_idx
  on meetup.places (latitude, longitude) where state = 'approved';

-- ---------------------------------------------------------------------------
-- meetups
-- ---------------------------------------------------------------------------
create table if not exists meetup.meetups (
  id                 uuid primary key,
  match_id           uuid references meetup.matches(id),
  place_id           uuid references meetup.places(id),
  custom_place_label text check (length(custom_place_label) <= 120),
  kind               meetup.meetup_kind not null,
  -- Stored in UTC, rendered in Asia/Kolkata. Never store a local timestamp.
  window_start       timestamptz not null,
  window_end         timestamptz not null,
  state              meetup.meetup_state not null default 'proposed',
  proposed_by        uuid not null references identity.users(id),
  capacity           smallint check (capacity between 2 and 30),
  created_at         timestamptz not null default now(),
  check (window_end > window_start)
);
create index if not exists meetups_state_window_idx on meetup.meetups (state, window_start);
create index if not exists meetups_match_idx on meetup.meetups (match_id);
-- The escalation ladder (02 CV-8) sweeps for check-outs that never happened.
create index if not exists meetups_in_progress_idx
  on meetup.meetups (window_end) where state = 'in_progress';

create table if not exists meetup.meetup_participants (
  meetup_id      uuid not null references meetup.meetups(id) on delete cascade,
  dog_id         uuid not null references graph.dogs(id),
  user_id        uuid not null references identity.users(id),
  rsvp           meetup.rsvp not null default 'pending',
  checked_in_at  timestamptz,
  checked_out_at timestamptz,
  created_at     timestamptz not null default now(),
  primary key (meetup_id, dog_id)
);
create index if not exists meetup_participants_user_idx
  on meetup.meetup_participants (user_id);

-- ---------------------------------------------------------------------------
-- meetup_reviews — THE CANONICAL REVIEW SHAPE
--
-- Exactly 8 structured fields + 2 free-text. Doc 02 CV-10, doc 05 §3.5 and doc
-- 07 §4.6 all reference this table. Earlier drafts said "9 structured"; the
-- correct count is 8 structured (incident_type is CONDITIONAL on
-- incident_occurred, not a ninth independent field) plus 2 free-text.
--
-- This table is the LABEL SOURCE for the ranking model (doc 06). would_repeat and
-- play_compatibility are the training targets; incident_occurred is both a
-- negative label and a T&S trigger. That is why the ranking objective can be a
-- real-world outcome rather than a swipe.
-- ---------------------------------------------------------------------------
create table if not exists meetup.meetup_reviews (
  id                 uuid primary key,
  meetup_id          uuid not null references meetup.meetups(id) on delete cascade,
  reviewer_user_id   uuid not null references identity.users(id),
  subject_dog_id     uuid not null references graph.dogs(id),

  -- 1..8 structured
  showed_up          boolean not null,
  on_time            boolean,
  dog_as_described   smallint check (dog_as_described between 1 and 5),
  human_respectful   smallint check (human_respectful between 1 and 5),
  play_compatibility smallint check (play_compatibility between 1 and 5),
  would_repeat       boolean not null,
  incident_occurred  boolean not null default false,
  incident_type      text check (length(incident_type) <= 60),

  -- 9..10 free-text
  -- PRIVACY: routed to Trust & Safety, never shown to the reviewed party, never
  -- surfaced on a profile. Mixing this with public_note would make honest safety
  -- reporting unsafe for the reporter.
  private_note_to_safety text check (length(private_note_to_safety) <= 2000),
  public_note            text check (length(public_note) <= 500),

  created_at         timestamptz not null default now(),
  unique (meetup_id, reviewer_user_id, subject_dog_id),
  -- incident_type only means anything when an incident occurred.
  check (incident_occurred or incident_type is null)
);
comment on table meetup.meetup_reviews is
  'CANONICAL: 8 structured + 2 free-text fields. Label source for the ranking model (doc 06). Do not add a ninth structured field without updating docs 02, 05 and 07.';
comment on column meetup.meetup_reviews.private_note_to_safety is
  'PRIVACY: Trust & Safety only. Never visible to the reviewed party or on any profile.';

create index if not exists meetup_reviews_subject_idx
  on meetup.meetup_reviews (subject_dog_id);
-- Incident reviews must route to T&S within 60 s (05 §3.5); this is the sweep.
create index if not exists meetup_reviews_incident_idx
  on meetup.meetup_reviews (created_at) where incident_occurred;
