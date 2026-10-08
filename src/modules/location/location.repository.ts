import type { PoolClient } from 'pg';
export const areaProjection = `id,name,country AS "countryCode",admin_region AS "adminRegion",timezone,
 CASE WHEN launch_state='seeding' THEN 'development' ELSE launch_state::text END AS rollout,
 (launch_state IN ('seeding','soft_launch','open')) AS selectable`;
export const selectableStates = ['seeding', 'soft_launch', 'open'];
export class LocationRepository {
  async status(tx: PoolClient, householdId: string) {
    const h = (await tx.query(`SELECT location_source,metro_id,location_updated_at,location_change_after
      FROM identity.households WHERE id=$1`, [householdId])).rows[0]!;
    const area = h.location_source === 'manual_area'
      ? (await tx.query(`SELECT ${areaProjection} FROM ops.metros WHERE id=$1`, [h.metro_id])).rows[0] ?? null : null;
    return { householdId, source: h.location_source, precision: area ? 'city' : null,
      area, updatedAt: h.location_updated_at, canChangeAt: h.location_change_after };
  }
  async invalidate(tx: PoolClient, householdId: string) {
    await tx.query("UPDATE graph.dogs SET publication_state='draft',updated_at=now() WHERE household_id=$1 AND deleted_at IS NULL", [householdId]);
    await tx.query(`DELETE FROM graph.dog_availability a USING graph.dogs d
      WHERE a.dog_id=d.id AND d.household_id=$1 AND a.beacon_until IS NOT NULL`, [householdId]);
    // Do not update other guardians' preferences here: that would reverse user->household lock order.
  }
}
