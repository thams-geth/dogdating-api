import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from '../../db/transaction.js';
import { decodeCursor, page } from '../../http/pagination.js';
import { ApiError } from '../../middleware/error.js';
import type { StaffPrincipal } from '../admin/staff-auth.js';

export const areaRolloutInput = z.object({
  expectedVersion: z.number().int().positive(),
  state: z.enum(['prospect', 'seeding', 'waitlist', 'gated']),
  reasonCode: z.string().regex(/^[a-z0-9_-]{3,60}$/),
}).strict();

const fields = `id,name,country AS "countryCode",admin_region AS "adminRegion",timezone,
  launch_state AS state,rollout_version AS version,rollout_updated_at AS "updatedAt"`;
const editable = ['prospect', 'seeding', 'waitlist', 'gated'];

export class AreaAdminService {
  constructor(private readonly db: Pool) {}

  list(staff: StaffPrincipal, limit: number, cursor?: string) {
    return transaction(this.db, async tx => {
      const scope = 'admin:areas:IN', after = decodeCursor(cursor, scope);
      const rows = (await tx.query(`SELECT ${fields} FROM ops.metros WHERE country='IN'
        AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2`, [after, limit + 1])).rows;
      await tx.query(`INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type)
        VALUES($1,'staff','area.list','metro')`, [staff.id]);
      return page(rows, limit, scope);
    });
  }

  save(staff: StaffPrincipal, id: string, input: z.infer<typeof areaRolloutInput>) {
    return transaction(this.db, async tx => {
      const current = (await tx.query(`SELECT ${fields} FROM ops.metros WHERE id=$1 AND country='IN' FOR UPDATE`, [id])).rows[0];
      if (!current) throw new ApiError(404, 'not-found', 'Area is unavailable.');
      if (!editable.includes(current.state)) throw new ApiError(409, 'area-rollout-unavailable', 'This area needs a reviewed public-rollout workflow.');
      if (current.version !== input.expectedVersion) throw new ApiError(409, 'area-version-conflict', 'Refresh the current area rollout.');
      if (current.state === input.state) return current;
      const updated = (await tx.query(`UPDATE ops.metros SET launch_state=$2,rollout_version=rollout_version+1,
        rollout_updated_at=now(),rollout_updated_by=$3 WHERE id=$1 RETURNING ${fields}`,
      [id, input.state, staff.id])).rows[0];
      if (input.state !== 'seeding') {
        await tx.query(`UPDATE graph.dogs d SET publication_state='draft',updated_at=now()
          FROM identity.households h WHERE d.household_id=h.id AND h.metro_id=$1
          AND d.deleted_at IS NULL AND d.publication_state<>'draft'`, [id]);
        await tx.query(`DELETE FROM graph.dog_availability a USING graph.dogs d,identity.households h
          WHERE a.dog_id=d.id AND d.household_id=h.id AND h.metro_id=$1 AND a.beacon_until IS NOT NULL`, [id]);
      }
      await tx.query(`INSERT INTO ops.audit_log(actor_user_id,actor_kind,action,subject_type,subject_id,before,after)
        VALUES($1,'staff','area.rollout.update','metro',$2,$3,$4)`, [staff.id, id,
        {state: current.state, version: current.version},
        {state: updated.state, version: updated.version, reasonCode: input.reasonCode}]);
      return updated;
    });
  }
}
