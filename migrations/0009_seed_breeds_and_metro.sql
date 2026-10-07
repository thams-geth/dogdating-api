-- =============================================================================
-- 0009 — reference data: Bengaluru metro + India-relevant breeds
--
-- This is REFERENCE data, not demo data, so it ships as a migration. Demo
-- households and dogs come from `make seed` (src/infra/db/seed-cli.ts), which is
-- never run in production.
--
-- UUIDs are literal and fixed. Reference rows are referenced by id from
-- fixtures, analytics and support runbooks, so a regenerated id on every
-- environment would be a permanent source of confusion. They are UUIDv7-shaped
-- (version nibble 7, variant 8) so they sort and validate like every other id in
-- the system.
--
-- Every insert is ON CONFLICT DO NOTHING: this migration is safely re-runnable.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Launch metro: Bengaluru (doc 11 §1 — the launch metro)
--
-- metro_cells are geohash precision-4 cells (~39 km) covering the BBMP area plus
-- Whitefield and Electronic City. These are the ACTUAL cells for the bounding
-- box lat 12.80-13.16, lon 77.40-77.82, computed with the same
-- geohashEncode() the application uses (src/domain/geo/cell-index.ts):
--
--   tdr1  central and south Bengaluru (Indiranagar, Koramangala, Jayanagar)
--   tdr3  east (Whitefield)
--   tdr0, tdr2, tdr4, tdr6  boundary cells
--
-- The boundary cells are included deliberately. A metro boundary is not a cell
-- boundary, so covering only the cells containing the city centre silently
-- truncates the candidate pool at the edges — and a household in Whitefield
-- whose DISPLACED anchor lands in tdr6 would fail the metro lookup entirely and
-- be assigned no metro, which means no dog ordinal and an invisible profile.
--
-- Swapping to H3 res-5 replaces these strings and nothing else.
-- ---------------------------------------------------------------------------
insert into ops.metros (
  id, name, country, admin_region, timezone, currency,
  metro_cells, launch_state, active_dog_count
) values (
  '01920000-0000-7000-8000-0000000e0001'::uuid,
  'Bengaluru', 'IN', 'KA', 'Asia/Kolkata', 'INR',
  array['tdr0','tdr1','tdr2','tdr3','tdr4','tdr6'],
  'seeding', 0
) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Breeds relevant to the Indian market.
--
-- Ordering note: the Indie (Indian Pariah Dog) is FIRST and is not a courtesy.
-- It is the most common dog in the country by an enormous margin, the default
-- adoption path, and the breed with the fewest inherited health problems. A
-- breed list that treats it as an afterthought is a product that does not
-- understand its market.
--
-- CLIMATE NOTE — advisory, never a block:
--   Great Dane, Saint Bernard and Siberian Husky are poorly suited to most of
--   India's climate. Bengaluru is the mildest major metro and these dogs do
--   exist here in numbers. We flag 'heat_intolerant' so the product can warn
--   about midday meetups and suggest early-morning windows, and so the breeder
--   surface can show welfare guidance. We do NOT filter them out of matching and
--   we do NOT refuse to list them: the dogs already exist, their owners need the
--   product more than most, and a block would simply push them off-platform
--   where nobody is giving them heat advice at all.
--
--   'brachycephalic' on Pug and Boxer is the same mechanism with a sharper edge:
--   brachycephalic obstructive airway syndrome plus 35 degrees C is a genuine
--   emergency risk, so this flag drives a hard warning on any meetup proposed
--   between 11:00 and 16:00 IST.
--
-- required_health_tests values are verify.health_record_type members where one
-- exists, so a granted Tier 3 can be checked against actual records.
-- ---------------------------------------------------------------------------
insert into graph.breeds (
  id, canonical_name, kci_group, size_class, typical_energy,
  required_health_tests, extreme_conformation_flags
) values
  ('01920000-0000-7000-8000-0000000b0001'::uuid, 'Indian Pariah Dog (Indie)', 'Indigenous',
   'medium', 4, array['vaccination','rabies'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0002'::uuid, 'Labrador Retriever', 'Gundog',
   'large', 4, array['hip_score','elbow_score','eye_exam','dna_panel'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0003'::uuid, 'Golden Retriever', 'Gundog',
   'large', 4, array['hip_score','elbow_score','eye_exam','cardiac_exam'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0004'::uuid, 'German Shepherd Dog', 'Working',
   'large', 4, array['hip_score','elbow_score','dna_panel'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0005'::uuid, 'Beagle', 'Hound',
   'small', 4, array['eye_exam','dna_panel','hip_score'], array[]::text[]),

  -- Brachycephalic. Heat-stress warnings are mandatory on this breed in India.
  ('01920000-0000-7000-8000-0000000b0006'::uuid, 'Pug', 'Toy',
   'toy', 2, array['eye_exam','vet_exam'],
   array['brachycephalic','heat_intolerant']),

  ('01920000-0000-7000-8000-0000000b0007'::uuid, 'Shih Tzu', 'Toy',
   'toy', 2, array['eye_exam','hip_score'], array['brachycephalic_mild']),

  ('01920000-0000-7000-8000-0000000b0008'::uuid, 'Rottweiler', 'Working',
   'large', 3, array['hip_score','elbow_score','cardiac_exam','eye_exam'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0009'::uuid, 'Doberman Pinscher', 'Working',
   'large', 4, array['cardiac_exam','dna_panel','hip_score'], array[]::text[]),

  -- Giant + heat intolerant + short-lived. Advisory only; see the climate note.
  ('01920000-0000-7000-8000-0000000b000a'::uuid, 'Great Dane', 'Working',
   'giant', 3, array['cardiac_exam','hip_score','eye_exam'],
   array['giant_stature','heat_intolerant']),

  ('01920000-0000-7000-8000-0000000b000b'::uuid, 'Indian Spitz', 'Indigenous',
   'small', 3, array['vaccination','eye_exam'], array[]::text[]),

  -- Indigenous sighthounds. Well adapted to Indian conditions; under-represented
  -- on every existing platform, which is part of why this list exists.
  ('01920000-0000-7000-8000-0000000b000c'::uuid, 'Rajapalayam', 'Indigenous',
   'large', 4, array['eye_exam','vaccination'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b000d'::uuid, 'Mudhol Hound (Caravan Hound)', 'Indigenous',
   'large', 5, array['cardiac_exam','vaccination'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b000e'::uuid, 'Chippiparai', 'Indigenous',
   'medium', 5, array['vaccination'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b000f'::uuid, 'Kombai (Combai)', 'Indigenous',
   'medium', 5, array['vaccination','hip_score'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0010'::uuid, 'Cocker Spaniel', 'Gundog',
   'medium', 3, array['eye_exam','hip_score','dna_panel'], array[]::text[]),

  ('01920000-0000-7000-8000-0000000b0011'::uuid, 'Dachshund', 'Hound',
   'small', 3, array['dna_panel','eye_exam'], array['chondrodystrophic']),

  -- Giant, heavy-coated, heat intolerant. Advisory only.
  ('01920000-0000-7000-8000-0000000b0012'::uuid, 'Saint Bernard', 'Working',
   'giant', 2, array['hip_score','elbow_score','eye_exam','cardiac_exam'],
   array['giant_stature','heat_intolerant']),

  ('01920000-0000-7000-8000-0000000b0013'::uuid, 'Siberian Husky', 'Working',
   'large', 5, array['eye_exam','hip_score'],
   array['heat_intolerant','double_coat']),

  -- Brachycephalic, like the Pug. Same mandatory heat warning.
  ('01920000-0000-7000-8000-0000000b0014'::uuid, 'Boxer', 'Working',
   'large', 4, array['cardiac_exam','hip_score','dna_panel'],
   array['brachycephalic','heat_intolerant'])
on conflict (canonical_name) do nothing;

-- ---------------------------------------------------------------------------
-- Ordinal counter for the launch metro, so the first dog creation does not have
-- to take the insert-on-conflict path inside a user-facing transaction.
-- ---------------------------------------------------------------------------
insert into graph.metro_ordinal_counter (metro_id, next_ordinal)
select id, 0 from ops.metros where name = 'Bengaluru'
on conflict (metro_id) do nothing;
