import { pool } from '../../db/pool.js';
import { cleanupDiscovery } from './cleanup.service.js';
try{console.log(JSON.stringify(await cleanupDiscovery(pool)));}
catch{console.error('Discovery cleanup failed. Retry the scheduled job.');process.exitCode=1;}
finally{await pool.end();}
