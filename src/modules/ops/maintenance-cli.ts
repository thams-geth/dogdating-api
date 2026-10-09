import { pool } from '../../db/pool.js';
import { runMaintenance } from './maintenance.js';
try{console.log(JSON.stringify(await runMaintenance(pool)));}
catch{console.error('Maintenance pass failed. Check database/service diagnostics and retry.');process.exitCode=1;}
finally{await pool.end();}
