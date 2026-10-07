-- =============================================================================
-- 0010 — meetup.conversations.last_seq: the per-conversation sequence counter
-- Plan: 05-api-design.md §3.4, 04-data-model.md §10.
--
-- CHECKED FIRST: `last_seq bigint not null default 0` was ALREADY added by
-- 0005_meetup.sql. This file is therefore a guarded no-op on any database that
-- has run 0005 as it currently stands. It is kept rather than deleted for two
-- reasons:
--   * 0005 is an APPLIED migration and applied migrations are immutable (see the
--     checksum rule in src/infra/db/migrate.ts). An environment that applied an
--     earlier revision of 0005 — before last_seq was folded into it — has no
--     other path to the column.
--   * Expand/contract policy (04 §11) is forward-only. The idempotent
--     `add column if not exists` is the correct shape for "ensure this exists"
--     regardless of which revision of 0005 a given environment saw.
--
-- ---------------------------------------------------------------------------
-- WHY A COLUMN AND AN UPDATE, AND NOT THE TWO OBVIOUS ALTERNATIVES
-- ---------------------------------------------------------------------------
-- `seq` must be strictly monotonic per conversation, with NO GAPS and NO
-- DUPLICATES, because the client's reconnect path asks the server for
-- "everything after N" and `meetup.messages` has primary key
-- (conversation_id, seq).
--
--   1. A POSTGRES SEQUENCE (`create sequence` + `nextval`) IS WRONG.
--      Sequences are deliberately NON-TRANSACTIONAL so concurrent inserters
--      never block on each other. The direct consequence is that a rolled-back
--      transaction keeps its number: `nextval` leaks a GAP on every rollback,
--      deadlock, statement timeout and dropped connection. A gap is
--      indistinguishable, to the client, from a message it has not yet
--      received — so it either waits forever for a message that will never
--      exist or re-downloads the whole history on every reconnect. Sequences
--      are also global, not per-conversation, so every conversation would share
--      one ordering and `seq` would stop being a dense per-conversation index.
--
--   2. `select coalesce(max(seq), 0) + 1` IS WRONG.
--      It races. Under READ COMMITTED two concurrent senders both read the same
--      max before either has inserted, both compute the same next value, one
--      insert wins and the other takes a primary-key violation — a silently
--      lost message, not a visible error. Making the read safe requires taking
--      a lock, at which point you have written option 3 with extra steps and an
--      extra scan.
--
--   3. `update meetup.conversations set last_seq = last_seq + 1
--       where id = $1 returning last_seq`, IN THE SAME TRANSACTION AS THE
--      MESSAGE INSERT, IS CORRECT.
--      The UPDATE takes a row-level exclusive lock on the conversation row, so
--      allocation is SERIALISED per conversation: concurrent senders queue
--      behind each other for microseconds. Because it is an ordinary
--      transactional UPDATE it rolls back together with the message insert, so a
--      failed send consumes no number and there is no gap. Contention is scoped
--      to a single conversation row, which is exactly the concurrency the
--      product has — two humans typing at each other.
--
-- The invariant is pinned by test/unit/chat-sequence.test.ts, which models all
-- three allocators and asserts that only the third satisfies the contract.
-- =============================================================================

-- Idempotent: present since 0005 in the current tree. See the header.
alter table meetup.conversations
  add column if not exists last_seq bigint not null default 0;

-- NO CHECK CONSTRAINT IS ADDED HERE. 0005 already declares `check (last_seq >= 0)`
-- inline, and Postgres permits two check constraints with the same expression
-- under different names — so a "guarded" ADD CONSTRAINT would not be skipped,
-- it would silently create a redundant second constraint that every future
-- reader has to reason about. An environment old enough to lack the column is
-- also old enough to lack the check; the application-side guard is
-- `nextSeq()` in src/domain/chat/sequence.ts, which refuses a negative last_seq.

comment on column meetup.conversations.last_seq is
  'Per-conversation monotonic message counter. Allocated by UPDATE ... SET last_seq = last_seq + 1 RETURNING last_seq inside the message-insert transaction, so the row lock serialises allocation and a rollback consumes no number. A Postgres SEQUENCE would leak gaps on rollback and max(seq)+1 races — see the header of migrations/0010_conversation_seq.sql.';

-- Repair path for any environment whose messages predate the counter: bring
-- last_seq up to the highest message actually stored. Without this, the first
-- allocation after the column is added would hand out a seq that already exists
-- and the insert would fail on the primary key.
update meetup.conversations c
   set last_seq = m.max_seq
  from (
    select conversation_id, max(seq) as max_seq
      from meetup.messages
     group by conversation_id
  ) m
 where m.conversation_id = c.id
   and c.last_seq < m.max_seq;
