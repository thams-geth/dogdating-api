import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const server = app.listen(config.PORT, () => {
  console.log(`Waggle Express API listening on port ${config.PORT}`);
});

function shutdown(): void {
  server.close(() => {
    pool.end().then(() => { process.exitCode = 0; }).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
