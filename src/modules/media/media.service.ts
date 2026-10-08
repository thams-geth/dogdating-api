import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { z } from 'zod';
import sharp from 'sharp';
import { transaction } from '../../db/transaction.js';
import { ApiError } from '../../middleware/error.js';
import { MediaRepository, mediaProjection } from './media.repository.js';
import type { PhotoStorage } from './media.storage.js';
import type { uploadSchema } from './media.schemas.js';

export class MediaService {
  private readonly repo = new MediaRepository();
  private processing = 0;
  constructor(private readonly db: Pool, private readonly storage?: PhotoStorage) {}
  private enabled() {
    if (!this.storage) throw new ApiError(503, 'media-unavailable', 'Photo storage is not configured.');
    return this.storage;
  }
  create(userId: string, dogId: string, input: z.infer<typeof uploadSchema>) {
    this.enabled();
    return transaction(this.db, async tx => {
      const dog = await this.repo.dogs.lock(tx, dogId, userId, ['owner', 'co_guardian']);
      if (dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
      const recent = (await tx.query(`SELECT count(*)::int AS n FROM graph.dog_media WHERE dog_id=$1 AND created_at>now()-interval '1 day'`, [dogId])).rows[0]!.n;
      if (recent >= 60) throw new ApiError(429, 'upload-limit', 'Daily photo upload limit reached.');
      const used = (await tx.query('SELECT ordinal FROM graph.dog_media WHERE dog_id=$1 AND deleted_at IS NULL', [dogId])).rows.map(r => r.ordinal);
      const ordinal = Array.from({ length: 30 }, (_, i) => i).find(i => !used.includes(i));
      if (ordinal === undefined) throw new ApiError(409, 'photo-limit', 'At most thirty photo slots are allowed.');
      const id = randomUUID();
      await tx.query(`INSERT INTO graph.dog_media(id,dog_id,kind,storage_key,ordinal) VALUES ($1,$2,'photo',$3,$4)`, [id, dogId, `${id}.jpg`, ordinal]);
      await tx.query(`INSERT INTO graph.media_uploads(media_id,created_by,content_type,expected_bytes,expected_sha256) VALUES ($1,$2,$3,$4,$5)`, [id, userId, input.contentType, input.sizeBytes, input.sha256]);
      return { ...await this.repo.status(tx, id), upload: { method: 'PUT', path: `/v1/media/${id}/content`, authentication: 'bearer', contentType: input.contentType } };
    });
  }
  async upload(userId: string, id: string, contentType: string, bytes: Buffer) {
    const storage = this.enabled();
    if (this.processing >= 2) throw new ApiError(429, 'processor-busy', 'Retry the photo upload shortly.');
    this.processing++;
    try { return await transaction(this.db, async tx => {
      const row = await this.repo.lock(tx, id, userId, true);
      if (row.created_by !== userId) throw new ApiError(403, 'upload-owner', 'Only the upload creator can send its content.');
      if (row.state !== 'awaiting_upload') throw new ApiError(409, 'upload-consumed', 'This upload has already received content.');
      if (row.expires_at <= new Date()) throw new ApiError(410, 'upload-expired', 'Create a new photo upload.');
      if (!Buffer.isBuffer(bytes) || bytes.length !== row.expected_bytes || contentType !== row.content_type || createHash('sha256').update(bytes).digest('hex') !== row.expected_sha256) {
        throw new ApiError(400, 'upload-mismatch', 'Photo type, size or checksum does not match the upload request.');
      }
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      if (!(contentType === 'image/jpeg' ? isJpeg : isPng)) throw new ApiError(400, 'invalid-image', 'Only valid JPEG and PNG photos are supported.');
      let output;
      try {
        const image = sharp(bytes, { limitInputPixels: 20_000_000, failOn: 'warning' });
        const metadata = await image.metadata();
        if ((metadata.pages ?? 1) !== 1 || !['jpeg', 'png'].includes(metadata.format ?? '')) throw new Error('Unsupported image');
        output = await image.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true });
      } catch { throw new ApiError(400, 'invalid-image', 'Photo decoding failed or the 20-megapixel limit was exceeded.'); }
      // Only re-encoded bytes are persisted. EXIF/GPS and the original body are discarded.
      await storage.put(row.storage_key, output.data);
      await tx.query('UPDATE graph.dog_media SET width=$2,height=$3 WHERE id=$1', [id, output.info.width, output.info.height]);
      await tx.query("UPDATE graph.media_uploads SET state='uploaded' WHERE media_id=$1", [id]);
      return this.repo.status(tx, id);
    }); } finally { this.processing--; }
  }
  complete(userId: string, id: string) {
    const storage = this.enabled();
    return transaction(this.db, async tx => {
      const row = await this.repo.lock(tx, id, userId, true);
      if (row.state === 'completed') return this.repo.status(tx, id);
      if (row.expires_at <= new Date()) throw new ApiError(410, 'upload-expired', 'Create a new photo upload.');
      if (row.state !== 'uploaded') throw new ApiError(409, 'upload-incomplete', 'Upload photo content first.');
      await storage.get(row.storage_key); // Confirm durable object presence before accepting completion.
      await tx.query("UPDATE graph.media_uploads SET state='completed',completed_at=now() WHERE media_id=$1", [id]);
      // Moderation remains pending: this API never grants approval.
      return this.repo.status(tx, id);
    });
  }
  status(userId: string, id: string) { return transaction(this.db, async tx => {
    await this.repo.lock(tx, id, userId); return this.repo.status(tx, id);
  }); }
  list(userId: string, dogId: string) { return transaction(this.db, async tx => {
    await this.repo.dogs.lock(tx, dogId, userId);
    return { media: (await tx.query(`SELECT ${mediaProjection} FROM graph.dog_media m LEFT JOIN graph.media_uploads u ON u.media_id=m.id
      WHERE m.dog_id=$1 AND m.deleted_at IS NULL ORDER BY m.ordinal`, [dogId])).rows };
  }); }
  order(userId: string, dogId: string, ids: string[]) { return transaction(this.db, async tx => {
    const dog = await this.repo.dogs.lock(tx, dogId, userId, ['owner', 'co_guardian']);
    if (dog.status !== 'active') throw new ApiError(409, 'dog-inactive', 'This dog profile can no longer be edited.');
    const existing = (await tx.query('SELECT id FROM graph.dog_media WHERE dog_id=$1 AND deleted_at IS NULL', [dogId])).rows.map(r => r.id);
    if (existing.length !== ids.length || ids.some(id => !existing.includes(id))) throw new ApiError(400, 'invalid-media-order', 'Provide every live photo ID exactly once.');
    await tx.query('UPDATE graph.dog_media SET deleted_at=now() WHERE dog_id=$1 AND deleted_at IS NULL', [dogId]);
    for (const [ordinal, id] of ids.entries()) await tx.query('UPDATE graph.dog_media SET ordinal=$2,deleted_at=NULL WHERE id=$1', [id, ordinal]);
  }); }
  async remove(userId: string, dogId: string, id: string) {
    this.enabled();
    await transaction(this.db, async tx => {
      const row = await this.repo.lock(tx, id, userId, true);
      if (row.dog_id !== dogId) throw new ApiError(404, 'not-found', 'Photo not found.');
      await tx.query('UPDATE graph.dog_media SET deleted_at=now() WHERE id=$1', [id]);
      await tx.query("UPDATE graph.media_uploads SET state='deleted',cleanup_required=true WHERE media_id=$1", [id]);
      await this.repo.dogs.invalidate(tx, dogId);
    });
    // Durable cleanup flag survives storage failures. A cleanup run retries physical deletion.
    await this.cleanup(1, id);
  }
  async cleanup(limit = 100, onlyId?: string) {
    const storage = this.enabled();
    const candidates = (await this.db.query(`SELECT u.media_id,m.dog_id FROM graph.media_uploads u JOIN graph.dog_media m ON m.id=u.media_id
      WHERE (u.cleanup_required OR (u.state IN ('awaiting_upload','uploaded') AND u.expires_at<=now()))
      AND ($1::uuid IS NULL OR u.media_id=$1) ORDER BY u.expires_at LIMIT $2`, [onlyId ?? null, limit])).rows;
    let cleaned = 0;
    for (const candidate of candidates) {
      await transaction(this.db, async tx => {
        // Match the household lock used by uploads and dog edits; no user lock is taken here.
        await tx.query('SELECT h.id FROM identity.households h JOIN graph.dogs d ON d.household_id=h.id WHERE d.id=$1 FOR UPDATE OF h', [candidate.dog_id]);
        const row = (await tx.query(`SELECT m.storage_key,u.* FROM graph.media_uploads u JOIN graph.dog_media m ON m.id=u.media_id WHERE u.media_id=$1`, [candidate.media_id])).rows[0];
        if (!row || !(row.cleanup_required || (['awaiting_upload', 'uploaded'].includes(row.state) && row.expires_at <= new Date()))) return;
        await storage.remove(row.storage_key);
        await tx.query('UPDATE graph.dog_media SET deleted_at=COALESCE(deleted_at,now()) WHERE id=$1', [candidate.media_id]);
        await tx.query("UPDATE graph.media_uploads SET state='deleted',cleanup_required=false WHERE media_id=$1", [candidate.media_id]);
        cleaned++;
      });
    }
    return { cleaned };
  }
}
