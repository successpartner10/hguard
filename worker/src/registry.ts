import { DurableObject } from 'cloudflare:workers';

/**
 * Registry — singleton Durable Object: the coordinator.
 *
 * Holds the durable state (camera directory, pairing codes, event log,
 * feedback) and routes messages between per-connection Session Durable
 * Objects. Mirrors what data/db.json + the in-memory maps did in the local
 * Node server, but on DO storage. It never sees video — only signaling,
 * presence and metadata, exactly like the local server.
 */

type Cam = { id: string; name: string; code: string; token: string; createdAt: number };
type Presence = {
  online?: boolean; lastSeen?: number; armed?: boolean;
  battery?: number | null; signal?: number | null; device?: string | null;
};
type Ev = {
  id: string; cameraId: string; cameraName: string; tag: string; at: number;
  dur: number; conf: number | null; zone: string | null; suppressed: boolean;
  energy?: number; thumb: string | null; clip: string | null; clipSize?: number;
  feedback?: 'up' | 'down';
};
type Watch = { cameraId: string; connId: string };

const MAX_EVENTS = 1000;
const MAX_FEEDBACK = 2000;

function randHex(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}
function pairCode() {
  return `${randHex(2).toUpperCase()}-${randHex(2).toUpperCase()}`;
}

export class Registry extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    let body: any = {};
    try { body = await request.json(); } catch { /* noop */ }
    const { op } = body;
    try {
      switch (op) {
        case 'register':          return this.ok(await this.register(body.name));
        case 'getCam':            return this.ok({ camera: await this.getCam(body.id) });
        case 'getCamByCode':      return this.ok({ camera: await this.getCamByCode(body.code) });
        case 'list':              return this.ok({ cameras: await this.list() });
        case 'setSession':        await this.ctx.storage.put(`sess:${body.camId}`, body.connId); return this.ok({});
        case 'getSession':        return this.ok({ connId: await this.ctx.storage.get<string>(`sess:${body.camId}`) });
        case 'touchPresence':     return this.ok({ camera: await this.touchPresence(body) });
        case 'addWatch':          return this.ok({ camera: await this.addWatch(body.camId, body.sessId, body.connId) });
        case 'removeWatch':       return this.ok({ cameraId: await this.removeWatch(body.sessId) });
        case 'routeToMonitor':    await this.routeToMonitor(body.sessId, body.msg); return this.ok({});
        case 'routeToCamera':     await this.routeToCamera(body.camId, body.sessId, body.msg); return this.ok({});
        case 'cameraPush':        await this.pushToCamera(body.camId, body.msg); return this.ok({});
        case 'registerMonitor': {
          const ms = await this.monitors();
          if (!ms.includes(body.connId)) { ms.push(body.connId); await this.ctx.storage.put('monitors', ms); }
          return this.ok({});
        }
        case 'unregisterMonitor': {
          const ms = await this.monitors();
          const next = ms.filter(c => c !== body.connId);
          if (next.length !== ms.length) await this.ctx.storage.put('monitors', next);
          return this.ok({});
        }
        case 'addEvent':          return this.ok({ event: await this.addEvent(body.event, body.camName) });
        case 'getEvents':         return this.ok({ events: await this.getEvents(body) });
        case 'attachClip':        return this.ok({ event: await this.attachClip(body.eventId, body.url, body.size) });
        case 'attachThumb':       return this.ok({ event: await this.attachThumb(body.eventId, body.url) });
        case 'addFeedback':       return this.ok({ event: await this.addFeedback(body.eventId, body.value) });
        case 'getFeedback':       return this.ok({ items: await this.getFeedback(body.cameraId) });
        default:                  return this.err(`unknown op: ${op}`);
      }
    } catch (e: any) {
      return this.err(e?.message || String(e));
    }
  }

  private ok(data: any, status = 200) { return Response.json({ ok: true, ...data }, { status }); }
  private err(msg: string, status = 400) { return Response.json({ ok: false, error: msg }, { status }); }

  // ------------------------------------------------------------- cameras
  private async register(name: string) {
    const cam: Cam = {
      id: 'cam-' + randHex(6),
      name: String(name || 'My Camera').trim().slice(0, 40) || 'My Camera',
      code: pairCode(),
      token: randHex(24),
      createdAt: Date.now(),
    };
    await this.ctx.storage.put(`cam:${cam.id}`, cam);
    await this.ctx.storage.put(`code:${cam.code.toUpperCase()}`, cam.id);
    await this.ctx.storage.put(`pres:${cam.id}`, { online: true, lastSeen: Date.now(), armed: true, battery: null, signal: null, device: null } satisfies Presence);
    return { camera: cam };
  }

  private async getCam(id: string): Promise<Cam | null> {
    return (await this.ctx.storage.get<Cam>(`cam:${id}`)) || null;
  }

  private async getCamByCode(code: string): Promise<any | null> {
    const c = String(code || '').replace(/\s/g, '').toUpperCase();
    const id = await this.ctx.storage.get<string>(`code:${c}`);
    if (!id) return null;
    const cam = await this.getCam(id);
    return cam ? this.publicCam(cam) : null;
  }

  private async list(): Promise<any[]> {
    const out: any[] = [];
    const list = await this.ctx.storage.list<Cam>({ prefix: 'cam:' });
    for (const [, cam] of list) out.push(await this.publicCam(cam));
    out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    return out;
  }

  private async publicCam(cam: Cam) {
    const pres = (await this.ctx.storage.get<Presence>(`pres:${cam.id}`)) || {};
    const watchers = await this.watchersFor(cam.id);
    return {
      id: cam.id, name: cam.name, code: cam.code, createdAt: cam.createdAt,
      online: !!pres.online, armed: !!pres.armed, lastSeen: pres.lastSeen || null,
      battery: pres.battery ?? null, signal: pres.signal ?? null, device: pres.device ?? null,
      viewers: watchers.length,
    };
  }

  private async touchPresence(p: { id: string; online?: boolean; lastSeen?: number; armed?: boolean; battery?: number | null; signal?: number | null; device?: string | null }) {
    const cam = await this.getCam(p.id);
    if (!cam) throw new Error('unknown camera');
    const cur = (await this.ctx.storage.get<Presence>(`pres:${cam.id}`)) || {};
    const next: Presence = {
      ...cur,
      online: p.online !== undefined ? p.online : cur.online,
      lastSeen: p.lastSeen ?? cur.lastSeen,
      armed: p.armed !== undefined ? p.armed : cur.armed,
      battery: p.battery !== undefined ? p.battery : cur.battery,
      signal: p.signal !== undefined ? p.signal : cur.signal,
      device: p.device !== undefined ? p.device : cur.device,
    };
    await this.ctx.storage.put(`pres:${cam.id}`, next);
    // push status to monitors only when something visible changed
    // (camera.hello passes force:true so monitors get an immediate status)
    if (p.force || next.online !== cur.online || next.armed !== cur.armed ||
        next.battery !== cur.battery || next.signal !== cur.signal) {
      await this.pushStatus(cam.id);
    }
    return this.publicCam(cam);
  }

  // ------------------------------------------------------------- watching
  private async watchersFor(camId: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(`watchers:${camId}`)) || [];
  }

  private async addWatch(camId: string, sessId: string, connId: string) {
    await this.ctx.storage.put(`watch:${sessId}`, { cameraId: camId, connId } satisfies Watch);
    const watchers = await this.watchersFor(camId);
    if (!watchers.includes(sessId)) watchers.push(sessId);
    await this.ctx.storage.put(`watchers:${camId}`, watchers);
    await this.pushStatus(camId);
    const cam = await this.getCam(camId);
    return cam ? this.publicCam(cam) : null;
  }

  private async removeWatch(sessId: string): Promise<string | null> {
    const w = await this.ctx.storage.get<Watch>(`watch:${sessId}`);
    if (!w) return null;
    await this.ctx.storage.delete(`watch:${sessId}`);
    const watchers = await this.watchersFor(w.cameraId);
    await this.ctx.storage.put(`watchers:${w.cameraId}`, watchers.filter(s => s !== sessId));
    await this.pushStatus(w.cameraId);
    return w.cameraId;
  }

  private async pushStatus(camId: string) {
    const cam = await this.getCam(camId);
    if (!cam) return;
    const pub = await this.publicCam(cam);
    await this.broadcast({ type: 'camera.status', camera: pub });
  }

  // ------------------------------------------------------------- monitors
  private async monitors(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>('monitors')) || [];
  }

  private async broadcast(msg: any) {
    for (const connId of await this.monitors()) await this.pushToConn(connId, msg);
  }

  // ------------------------------------------------------------- routing
  private async pushToConn(connId: string, msg: any) {
    try {
      const stub = this.env.SESSION.get(this.env.SESSION.idFromName(connId));
      const res = await stub.fetch('https://session/push', { method: 'POST', body: JSON.stringify(msg) });
    } catch (e: any) {
    }
  }

  private async pushToWatchers(camId: string, msg: any) {
    for (const sessId of await this.watchersFor(camId)) {
      const w = await this.ctx.storage.get<Watch>(`watch:${sessId}`);
      if (w) await this.pushToConn(w.connId, msg);
    }
  }

  private async pushToCamera(camId: string, msg: any) {
    const connId = await this.ctx.storage.get<string>(`sess:${camId}`);
    if (connId) await this.pushToConn(connId, msg);
  }

  private async routeToMonitor(sessId: string, msg: any) {
    const w = await this.ctx.storage.get<Watch>(`watch:${sessId}`);
    if (w) await this.pushToConn(w.connId, msg);
  }

  private async routeToCamera(camId: string, sessId: string, msg: any) {
    const connId = await this.ctx.storage.get<string>(`sess:${camId}`);
    if (connId) await this.pushToConn(connId, { ...msg, sessId });
  }

  // ------------------------------------------------------------- events
  private async events(): Promise<Ev[]> {
    return (await this.ctx.storage.get<Ev[]>('events')) || [];
  }

  private async addEvent(event: any, camName: string) {
    const ev: Ev = {
      id: event.id, cameraId: event.cameraId, cameraName: camName || event.cameraName,
      tag: event.tag || 'motion', at: event.at || Date.now(), dur: event.dur || 0,
      conf: event.conf ?? null, zone: event.zone || null, suppressed: !!event.suppressed,
      energy: event.energy, thumb: null, clip: null,
    };
    // attach clip/thumb if they arrived before the event record
    const pending = (await this.ctx.storage.get<any>('pending')) || {};
    const pa = pending[ev.id];
    if (pa) {
      if (pa.clip) { ev.clip = pa.clip; ev.clipSize = pa.clipSize; }
      if (pa.thumb) ev.thumb = pa.thumb;
      delete pending[ev.id];
      await this.ctx.storage.put('pending', pending);
    }
    const evs = await this.events();
    evs.unshift(ev);
    if (evs.length > MAX_EVENTS) evs.length = MAX_EVENTS;
    await this.ctx.storage.put('events', evs);
    await this.broadcast({ type: 'event.new', event: ev });
    return ev;
  }

  private async getEvents(o: { cameraId?: string; since?: number; tag?: string; limit?: number }) {
    let out = await this.events();
    if (o.cameraId) out = out.filter(e => e.cameraId === o.cameraId);
    if (o.since) out = out.filter(e => e.at >= o.since);
    if (o.tag) out = out.filter(e => e.tag === o.tag);
    out.sort((a, b) => b.at - a.at);
    if (o.limit) out = out.slice(0, o.limit);
    return out;
  }

  private async attachClip(eventId: string, url: string, size: number) {
    const evs = await this.events();
    const ev = evs.find(e => e.id === eventId);
    if (!ev) {
      // clip arrived before the event record — remember it and attach on addEvent
      const pending = (await this.ctx.storage.get<any>('pending')) || {};
      pending[eventId] = { ...(pending[eventId] || {}), clip: url, clipSize: size };
      await this.ctx.storage.put('pending', pending);
      return null;
    }
    ev.clip = url; ev.clipSize = size;
    await this.ctx.storage.put('events', evs);
    return ev;
  }

  private async attachThumb(eventId: string, url: string) {
    const evs = await this.events();
    const ev = evs.find(e => e.id === eventId);
    if (!ev) {
      const pending = (await this.ctx.storage.get<any>('pending')) || {};
      pending[eventId] = { ...(pending[eventId] || {}), thumb: url };
      await this.ctx.storage.put('pending', pending);
      return null;
    }
    ev.thumb = url;
    await this.ctx.storage.put('events', evs);
    return ev;
  }

  // ------------------------------------------------------------- feedback
  private async addFeedback(eventId: string, value: 'up' | 'down') {
    const evs = await this.events();
    const ev = evs.find(e => e.id === eventId);
    if (!ev) throw new Error('unknown event');
    ev.feedback = value;
    const fb = (await this.ctx.storage.get<any[]>('feedback')) || [];
    fb.push({ cameraId: ev.cameraId, eventId: ev.id, value, at: Date.now() });
    if (fb.length > MAX_FEEDBACK) fb.splice(0, fb.length - MAX_FEEDBACK);
    await this.ctx.storage.put('events', evs);
    await this.ctx.storage.put('feedback', fb);
    // tell the camera so its false-alarm learner can update (works offline
    // too — synced again on reconnect via getFeedback)
    await this.pushToCamera(ev.cameraId, {
      type: 'feedback', eventId: ev.id, value,
      tag: ev.tag, zone: ev.zone, at: ev.at, conf: ev.conf, dur: ev.dur,
    });
    return ev;
  }

  private async getFeedback(cameraId: string) {
    const fb = (await this.ctx.storage.get<any[]>('feedback')) || [];
    const evs = await this.events();
    return fb
      .filter(f => f.cameraId === cameraId)
      .map(f => {
        const ev = evs.find(e => e.id === f.eventId) || {};
        return { eventId: f.eventId, value: f.value, at: ev.at || f.at, tag: ev.tag, zone: ev.zone, energy: ev.energy };
      });
  }
}
