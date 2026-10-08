import type { PoolClient } from 'pg';
import { ApiError } from '../../middleware/error.js';
import { DogsRepository } from '../dogs/dogs.repository.js';

export const mediaProjection = `m.id,m.dog_id AS "dogId",m.ordinal,m.width,m.height,
 m.moderation_state AS "moderationState",u.state AS "uploadState",u.expires_at AS "expiresAt",m.created_at AS "createdAt"`;
export class MediaRepository {
  readonly dogs = new DogsRepository();
  async lock(tx: PoolClient, id: string, userId: string, edit = false) {
    const ref = (await tx.query('SELECT dog_id FROM graph.dog_media WHERE id=$1', [id])).rows[0];
    if (!ref) throw new ApiError(404, 'not-found', 'Photo not found.');
    const dog = await this.dogs.lock(tx, ref.dog_id, userId, edit ? ['owner', 'co_guardian'] : undefined);
    if (edit && dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
    const row = (await tx.query(`SELECT m.*,u.* FROM graph.dog_media m JOIN graph.media_uploads u ON u.media_id=m.id
      WHERE m.id=$1 AND m.deleted_at IS NULL`, [id])).rows[0];
    if (!row) throw new ApiError(404, 'not-found', 'Photo not found.');
    return row;
  }
  async status(tx: PoolClient, id: string) {
    return (await tx.query(`SELECT ${mediaProjection} FROM graph.dog_media m JOIN graph.media_uploads u ON u.media_id=m.id WHERE m.id=$1`, [id])).rows[0];
  }
}
