import './network.js';
import { createServer } from 'node:http';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { openDb } from './db.js';
import { Family } from './family.js';
import { Brain } from './brain.js';
import { Auth } from './auth.js';
import { Hub, Scheduler } from './events.js';
import { Files } from './files.js';
import { Eyes } from './eyes.js';
import { Post } from './post.js';
import { Notify } from './notify.js';
import { Coach } from './coach.js';
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
const hub = new Hub(); // the tablet(s)
const momHub = new Hub(); // Mom's page(s)
const files = new Files(store, resolve(config.dataDir));
const eyes = new Eyes({ family, store, files, hub, momHub, config });
const post = new Post({ family, store, hub, momHub });
brain.attach({ eyes, post, hub, momHub });
const notify = new Notify({
  url: config.notifyUrl,
  kinds: config.notifyKinds,
  perDay: config.limits.notifyPerDay,
  link: config.publicUrl && `${config.publicUrl}/parent`,
  family,
  store,
  looking: () => momHub.size > 0,
});
family.onEvent = (id) => {
  momHub.send({ type: 'event' }); // Mom's page refreshes its record...
  notify.event(store.getEvent(id)); // ...or, while it is closed, her phone hears about it
};
// The companion speaks up about the day's tasks on her own, in her own words.
const coach = new Coach({ family, hub, momHub, say: (what) => brain.speakUp(what), note: (line) => brain.note('kid', line) });
new Scheduler(family, hub, { coach, post, files }).start();
eyes.resume(); // files that were still being read when the server last stopped

const handler = createHandler({ config, store, family, brain, auth, hub, momHub, files, eyes, post, notify, coach, webDir: join(root, 'web') });
const server = createServer(handler);
server.requestTimeout = 30 * 60000; // a big file over a slow phone line
server.listen(config.port, config.host, () => {
  const missing = [
    !config.arkApiKey && 'ARK_API_KEY',
    !config.parentPassword && 'PARENT_PASSWORD',
  ].filter(Boolean);
  console.log(`MoMo companion listening on http://${config.host}:${config.port} (${config.timeZone})`);
  if (missing.length) console.warn(`Missing settings: ${missing.join(', ')}`);
  if (!config.ttsAppId) console.warn('DOUBAO_APPID not set: the tablet will use its own voice.');
  if (notify.bad) console.warn('NOTIFY_URL is not a web address: no pushes to Mom\'s phone.');
  else if (notify.on) console.log(`Pushing to Mom's phone through ${notify.target.name} while her page is closed.`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
