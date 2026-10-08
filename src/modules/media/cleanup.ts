import { config } from '../../config.js';
import { pool } from '../../db/pool.js';
import { LocalPhotoStorage } from './media.storage.js';
import { MediaService } from './media.service.js';
try {
  if (config.MEDIA_MODE !== 'local') throw new Error('Configure MEDIA_MODE=local for local cleanup.');
  const service = new MediaService(pool, new LocalPhotoStorage(config.MEDIA_LOCAL_DIR, config.NODE_ENV));
  console.log(await service.cleanup());
} finally { await pool.end(); }
