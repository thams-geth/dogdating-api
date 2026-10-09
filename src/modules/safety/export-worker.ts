import { pool } from '../../db/pool.js';import { config } from '../../config.js';import { LocalMessageCipher } from '../messages/message-cipher.js';import { processAccountExports } from './account-export.js';
try{if(!config.MESSAGE_KEY)throw new Error();console.log(JSON.stringify(await processAccountExports(pool,new LocalMessageCipher(config.MESSAGE_KEY,config.NODE_ENV))));}
catch{console.error('Account export worker unavailable or failed. Configure private encryption; no artifact contents are logged.');process.exitCode=1;}finally{await pool.end();}
