import { pool } from '../../db/pool.js';
import { processMeetupReminders } from './reminder-worker.js';
try{console.log(JSON.stringify(await processMeetupReminders(pool)));}
catch{console.error('Meetup reminder pass failed. Check service diagnostics and retry the scheduled job.');process.exitCode=1;}
finally{await pool.end();}
