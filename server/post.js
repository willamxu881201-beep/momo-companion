// Messages between Mom and MoMo, passed on by the companion.
//  - Mom's words for MoMo are said out loud on the tablet ("妈妈让我告诉你：…") once it
//    is on and it isn't quiet time. Until the tablet reports it has said one, the
//    message is kept and offered again (when the tablet comes back, or every ten
//    minutes), so nothing is lost while the tablet sleeps.
//  - MoMo's words for Mom go straight to Mom's page, and wait there if it is closed.
// Both kinds also go into the day's record.

import { inQuiet } from './events.js';

const AGAIN_MS = 10 * 60000;

export class Post {
  constructor({ family, store, hub, momHub }) {
    Object.assign(this, { family, store, hub, momHub });
    this.offered = new Map(); // message id -> when it was last sent to the tablet
  }

  kid() {
    return this.family.profile().kidName;
  }

  toKid(text) {
    // "沫沫，…" would come out as "沫沫，妈妈让我告诉你：沫沫，…"
    const kid = this.kid();
    const clean = String(text || '').trim().replace(new RegExp(`^${kid.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[，,、\\s]*`), '').slice(0, 120);
    if (!clean) return null;
    const id = this.store.addMessage('mom', 'kid', clean);
    this.family.log('mom', 'message', `妈妈让转告：${clean}`);
    this.offer();
    return id;
  }

  toMom(text) {
    const clean = String(text || '').trim().slice(0, 120);
    if (!clean) return null;
    const kid = this.kid();
    const id = this.store.addMessage('kid', 'mom', clean);
    this.family.log('kid', 'message', `${kid}让转告妈妈：${clean}`);
    this.momHub.send({ type: 'message', id, from: 'kid', text: clean, line: `${kid}让我告诉你：${clean}` });
    if (this.momHub.size) this.store.markDelivered(id);
    return id;
  }

  // Sends the tablet what it hasn't said yet. fresh: a tablet just connected, so
  // everything is offered again.
  offer({ fresh = false } = {}) {
    if (!this.hub.size || inQuiet(this.family.now().minutes, this.store.getSetting('quiet'))) return 0;
    if (fresh) this.offered.clear();
    let n = 0;
    for (const m of this.store.undelivered('kid')) {
      if (Date.now() - (this.offered.get(m.id) || 0) < AGAIN_MS) continue;
      this.offered.set(m.id, Date.now());
      this.hub.send({ type: 'message', id: m.id, line: `${this.kid()}，妈妈让我告诉你：${m.text}` });
      n += 1;
    }
    return n;
  }

  heard(id) {
    this.store.markDelivered(Number(id));
    this.offered.delete(Number(id));
  }

  // Mom's recent words, so the companion knows what she passed on.
  recentForKid(hours = 3) {
    return this.store.recentMessages('kid', Date.now() - hours * 3600000).filter((m) => m.delivered_at);
  }

  // MoMo's messages Mom hasn't seen; they count as seen once returned.
  unreadForMom() {
    const list = this.store.undelivered('mom');
    for (const m of list) this.store.markDelivered(m.id);
    return list;
  }
}
