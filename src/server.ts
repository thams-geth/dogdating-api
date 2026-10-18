import { attachRealtime } from './modules/messages/realtime.js';
import { app } from './app.js';
import { config } from './config.js';
import { pool } from './db/pool.js';

const server = app.listen(config.PORT, () => {
  console.log(`Waggle Express API listening on port ${config.PORT}`);
});

const sockets=app.locals.realtime?attachRealtime(server,app.locals.realtime):undefined;

let shuttingDown = false;
function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for(const socket of sockets?.clients??[])socket.close(1001,'Server shutting down');
  server.close(() => {
    pool.end().then(() => { process.exitCode = 0; }).catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
