import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { LocalPhotoStorage, S3PhotoStorage } from './media.storage.js';
import { MediaService } from './media.service.js';
try {
  if (config.MEDIA_MODE === 'disabled') throw new Error('Configure MEDIA_MODE=local or s3 for media cleanup.');
  const storage = config.MEDIA_MODE === 'local'
    ? new LocalPhotoStorage(config.MEDIA_LOCAL_DIR, config.NODE_ENV)
    : new S3PhotoStorage(config.MEDIA_BUCKET!, config.MEDIA_REGION!);
  const service = new MediaService(pool, storage);
  console.log(await service.cleanup());
} finally { await pool.end(); }
