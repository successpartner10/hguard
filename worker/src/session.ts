import { DurableObject } from 'cloudflare:workers';

/**
 * Session — one Durable Object per WebSocket connection.
 *
 * Owns a single client socket (camera device or monitor device), authenticates
 * it, and performs the same message protocol the local Node server used.
 * All shared state lives in the Registry DO; sessions stay stateless so any
 * reconnect lands on a fresh instance and re-registers itself.
 */

type Env = {
  REGISTRY: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;
  CLIPS: R2Bucket;
};

function randHex(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export class Session extends DurableObject {
  ws: WebSocket | null = null;
  role: 'camera' | 'monitor' | null = null;
  camId: string | null = null;
  mySessIds: string[] = [];
  readonly connId = this.ctx.id.name;

  private registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry'));
  }

  private async rpc(stub: DurableObjectStub, op: string, args: any = {}): Promise<any> {
    const res = await stub.fetch('https://registry/', { method: 'POST', body: JSON.stringify({ op, ...args }) });
    const j: any = await res.json();
    if (!j.ok) throw new Error(j.error || 'registry rpc failed');
    return j;
  }

  private send(msg: any) {
    try { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); } catch { /* noop */ }
  }
  private reply(reqId: string, data: any = {}) { this.send({ type: 'resp', reqId, ok: true, ...data }); }
  private fail(reqId: string, message: string) { this.send({ type: 'error', reqId, message }); }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // internal push channel (Registry → this session)
    if (url.pathname === '/push') {
      let msg: any = {};
      try { msg = await request.json(); } catch { /* noop */ }
      this.send(msg);
      return new Response('ok');
    }

    // WebSocket upgrade from the client
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    this.ws = server;
    try {
      const j = await this.rpc(this.registry(), 'list');
      server.send(JSON.stringify({ type: 'hello', time: Date.now(), cameras: j.cameras || [] }));
    } catch { /* registry not ready — client reconnects anyway */ }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(_ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const reg = this.registry();
    try {
      switch (msg.type) {
        case 'ping':
          return this.reply(msg.reqId, { pong: Date.now() });

        // ---------------- camera side ----------------
        case 'camera.register': {
          const j = await this.rpc(reg, 'register', { name: msg.name });
          this.role = 'camera';
          this.camId = j.camera.id;
          await this.rpc(reg, 'setSession', { camId: j.camera.id, connId: this.connId });
          this.reply(msg.reqId, { camera: j.camera });
          await this.syncFeedback(reg);
          return;
        }
        case 'camera.hello': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return this.fail(msg.reqId, 'bad camera credentials');
          this.role = 'camera';
          this.camId = cam.id;
          await this.rpc(reg, 'setSession', { camId: cam.id, connId: this.connId });
          await this.rpc(reg, 'touchPresence', { id: cam.id, online: true, lastSeen: Date.now(), armed: msg.armed, force: true });
          this.reply(msg.reqId, { ok: true });
          await this.syncFeedback(reg);
          return;
        }
        case 'camera.heartbeat': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return;
          await this.rpc(reg, 'touchPresence', {
            id: cam.id, online: true, lastSeen: Date.now(),
            armed: msg.armed, battery: msg.battery, signal: msg.signal, device: msg.device,
          });
          return;
        }
        case 'camera.signal': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return;
          await this.rpc(reg, 'routeToMonitor', { sessId: msg.sessId, msg: { type: 'signal', cameraId: cam.id, sessId: msg.sessId, data: msg.data } });
          return;
        }
        case 'camera.snapshot': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return;
          await this.rpc(reg, 'routeToMonitor', { sessId: msg.sessId, msg: { type: 'snapshot', cameraId: cam.id, dataUrl: msg.dataUrl } });
          return;
        }
        case 'camera.event': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return;
          await this.rpc(reg, 'addEvent', { event: { ...msg.event, cameraId: cam.id }, camName: cam.name });
          return;
        }
        case 'camera.bye': {
          const cam = await this.authCamera(reg, msg.id, msg.token);
          if (!cam) return;
          await this.rpc(reg, 'touchPresence', { id: cam.id, online: false, lastSeen: Date.now() });
          return;
        }

        // ---------------- monitor side ----------------
        case 'monitor.hello':
          this.role = 'monitor';
          await this.rpc(reg, 'registerMonitor', { connId: this.connId });
          return this.reply(msg.reqId, { ok: true });

        case 'monitor.pair': {
          this.role = 'monitor';
          await this.rpc(reg, 'registerMonitor', { connId: this.connId });
          const j = await this.rpc(reg, 'getCamByCode', { code: msg.code });
          if (!j.camera) {
            return this.fail(msg.reqId, 'That code does not match any camera. Check the code on the camera device and try again.');
          }
          return this.reply(msg.reqId, { camera: j.camera });
        }

        case 'monitor.watch': {
          this.role = 'monitor';
          await this.rpc(reg, 'registerMonitor', { connId: this.connId });
          const sessId = msg.sessId || 'sess-' + randHex(6);
          this.mySessIds.push(sessId);
          await this.rpc(reg, 'addWatch', { camId: msg.cameraId, sessId, connId: this.connId });
          await this.rpc(reg, 'cameraPush', { camId: msg.cameraId, msg: { type: 'monitor.watch', sessId } });
          return this.reply(msg.reqId, { sessId });
        }

        case 'monitor.unwatch': {
          const j = await this.rpc(reg, 'removeWatch', { sessId: msg.sessId });
          if (j.cameraId) await this.rpc(reg, 'cameraPush', { camId: j.cameraId, msg: { type: 'monitor.unwatch', sessId: msg.sessId } });
          return;
        }

        case 'monitor.signal':
          await this.rpc(reg, 'routeToCamera', { camId: msg.cameraId, sessId: msg.sessId, msg: { type: 'signal', data: msg.data } });
          return;

        case 'monitor.snapshot':
          await this.rpc(reg, 'cameraPush', { camId: msg.cameraId, msg: { type: 'monitor.snapshot', sessId: msg.sessId } });
          return;

        case 'feedback':
          await this.rpc(reg, 'addFeedback', { eventId: msg.eventId, value: msg.value === false ? 'down' : 'up' });
          return;

        case 'monitor.bye':
          await this.cleanup();
          return;

        default:
          return;
      }
    } catch (e: any) {
      console.error('session error:', e?.message || e);
      if (msg.reqId) this.fail(msg.reqId, e?.message || 'server error');
    }
  }

  async webSocketClose() {
    await this.cleanup();
  }

  private async authCamera(reg: DurableObjectStub, id: string, token: string) {
    if (!id || !token) return null;
    try {
      const j = await this.rpc(reg, 'getCam', { id });
      const cam = j.camera;
      if (!cam || cam.token !== token) return null;
      return cam;
    } catch { return null; }
  }

  private async syncFeedback(reg: DurableObjectStub) {
    if (!this.camId) return;
    try {
      const j = await this.rpc(reg, 'getFeedback', { cameraId: this.camId });
      if (j.items && j.items.length) this.send({ type: 'feedback.sync', items: j.items });
    } catch { /* noop */ }
  }

  private async cleanup() {
    const reg = this.registry();
    if (this.role === 'monitor') {
      await this.rpc(reg, 'unregisterMonitor', { connId: this.connId }).catch(() => {});
    }
    if (this.role === 'camera' && this.camId) {
      await this.rpc(reg, 'touchPresence', { id: this.camId, online: false, lastSeen: Date.now() }).catch(() => {});
    }
    for (const sessId of this.mySessIds) {
      const j = await this.rpc(reg, 'removeWatch', { sessId }).catch(() => null);
      if (j && j.cameraId) {
        await this.rpc(reg, 'cameraPush', { camId: j.cameraId, msg: { type: 'monitor.unwatch', sessId } }).catch(() => {});
      }
    }
    this.mySessIds = [];
  }
}
