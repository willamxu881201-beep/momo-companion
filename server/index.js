import { createServer } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { Family } from './family.js';
import { Brain } from './brain.js';
import { Auth } from './auth.js';
import { Hub, Scheduler } from './events.js';
import { createHandler } from './http.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const store = openDb(join(resolve(config.dataDir), 'momo.db'));
const family = new Family(store, { timeZone: config.timeZone });
const brain = new Brain(family, {
  apiKey: config.arkApiKey,
  routerModel: config.routerModel,
  personaModel: config.personaModel,
});
const auth = new Auth(store, { parentPassword: config.parentPassword });
const hub = new Hub();
new Scheduler(family, hub).start();

const handler = createHandler({ config, store, family, brain, auth, hub, webDir: join(root, 'web') });
const server = createServer(handler);
server.requestTimeout = 60000;
server.listen(config.port, config.host, () => {
  const missing = [
    !config.arkApiKey && 'ARK_API_KEY',
    !config.parentPassword && 'PARENT_PASSWORD',
  ].filter(Boolean);
  console.log(`MoMo companion listening on http://${config.host}:${config.port} (${config.timeZone})`);
  if (missing.length) console.warn(`Missing settings: ${missing.join(', ')}`);
  if (!config.ttsAppId) console.warn('DOUBAO_APPID not set: the tablet will use its own voice.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
