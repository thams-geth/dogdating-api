-- Manual city selection is a coarse alternative to the future displaced GPS anchor.
-- It must never be represented as a precise distance or a derived GPS cell.
ALTER TABLE identity.households
  ADD COLUMN location_source text CHECK (location_source IN ('manual_area')),
  ADD COLUMN location_updated_at timestamptz,
  ADD COLUMN location_change_after timestamptz;
COMMENT ON COLUMN identity.households.location_source IS
  'manual_area uses metro_id only, with city-level precision. It does not populate GPS anchor cells. Future discovery must handle city-only distances explicitly.';
