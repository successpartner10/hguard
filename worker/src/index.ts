import * as QRCode from 'qrcode/lib/server.js';

export { Registry } from './registry';
export { Session } from './session';

/**
 * AI Home Guard — Cloudflare Worker entry point.
 *
 * Serves the static web app (web/), the REST API (health, qr, state, events,
 * clips, thumbs, probe, code) and upgrades WebSocket connections to per-
 * connection Session Durable Objects. Event clips + thumbnails live in the
 * R2 bucket; the DOs handle coordination only — video never passes through
 * the Worker.
 */

type Env = {
  REGISTRY: DurableObjectNamespace;
  SESSION: DurableObjectNamespace;
  CLIPS: R2Bucket;
  ASSETS?: Fetcher;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, bypass-tunnel-reminder',
  'Cache-Control': 'no-store',
};

const MIME: Record<string, string> = {
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
};

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
}

function withCors(res: Response) {
  for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
  return res;
}

async function registryRpc(env: Env, op: string, args: any = {}): Promise<any> {
  const stub = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
  const res = await stub.fetch('https://registry/', { method: 'POST', body: JSON.stringify({ op, ...args }) });
  const j: any = await res.json();
  if (!j.ok) throw new Error(j.error || 'registry rpc failed');
  return j;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // ---- WebSocket → per-connection Session DO ----
    if (url.pathname === '/ws') {
      const id = env.SESSION.idFromName(crypto.randomUUID());
      const stub = env.SESSION.get(id);
      return stub.fetch(request.url, request);
    }

    // ---- REST API ----
    if (url.pathname === '/api/health') {
      return json({ ok: true, time: Date.now(), version: 'cloudflare-0.1' });
    }

    if (url.pathname === '/api/qr') {
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return json({ error: 'bad code' }, 400);
      try {
        const svg = await QRCode.toString(`aihguard://pair/${code}`, { type: 'svg', width: 480, margin: 2, errorCorrectionLevel: 'M' });
        return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' } });
      } catch (e: any) {
        console.error('qr error:', e?.message, e?.stack);
        return json({ error: 'qr failed: ' + (e?.message || e) }, 500);
      }
    }

    if (url.pathname === '/api/code') {
      const j = await registryRpc(env, 'getCam', { id: url.searchParams.get('id') });
      const cam = j.camera;
      if (!cam || cam.token !== url.searchParams.get('token')) return json({ error: 'bad credentials' }, 403);
      return json({ code: cam.code });
    }

    if (url.pathname === '/api/state') {
      const [list, evs] = await Promise.all([
        registryRpc(env, 'list'),
        registryRpc(env, 'getEvents', { limit: Number(url.searchParams.get('events') || 100) }),
      ]);
      return json({ cameras: list.cameras || [], events: evs.events || [] });
    }

    if (url.pathname === '/api/events') {
      const q = url.searchParams;
      const j = await registryRpc(env, 'getEvents', {
        cameraId: q.get('camera') || undefined,
        since: q.get('since') ? Number(q.get('since')) : undefined,
        tag: q.get('tag') || undefined,
        limit: q.get('limit') ? Number(q.get('limit')) : undefined,
      });
      return json({ events: j.events || [] });
    }

    if (url.pathname === '/api/probe') {
      const kb = Math.min(8192, Math.max(64, Number(url.searchParams.get('kb') || 512)));
      const bytes = new Uint8Array(kb * 1024);
      for (let i = 0; i < bytes.length; i += 65536) {
        crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, bytes.length)));
      }
      return withCors(new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }));
    }

    if (url.pathname === '/api/clips' && request.method === 'POST') {
      const q = url.searchParams;
      const camJ = await registryRpc(env, 'getCam', { id: q.get('camera') });
      if (!camJ.camera) return json({ error: 'unknown camera' }, 404);
      const name = String(q.get('name') || '').replace(/[^\w.\-]/g, '_');
      if (!name) return json({ error: 'name required' }, 400);
      const key = `clips/${q.get('camera')}/${new Date().toISOString().slice(0, 10)}/${name}`;
      // buffer the body so the R2 put always has a known length
      const buf = await request.arrayBuffer();
      await env.CLIPS.put(key, new Uint8Array(buf), {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'video/webm' },
      });
      await registryRpc(env, 'attachClip', { eventId: q.get('event'), url: '/' + key, size: buf.byteLength });
      return json({ ok: true, url: '/' + key });
    }

    if (url.pathname === '/api/thumbs' && request.method === 'POST') {
      const q = url.searchParams;
      const camJ = await registryRpc(env, 'getCam', { id: q.get('camera') });
      if (!camJ.camera) return json({ error: 'unknown camera' }, 404);
      const key = `thumbs/${q.get('camera')}/${q.get('event')}.jpg`;
      const buf = await request.arrayBuffer();
      await env.CLIPS.put(key, new Uint8Array(buf), { httpMetadata: { contentType: 'image/jpeg' } });
      await registryRpc(env, 'attachThumb', { eventId: q.get('event'), url: '/' + key });
      return json({ ok: true, url: '/' + key });
    }

    if (url.pathname.startsWith('/clips/') || url.pathname.startsWith('/thumbs/')) {
      const key = url.pathname.slice(1);
      const obj = await env.CLIPS.get(key);
      if (!obj) return json({ error: 'not found' }, 404);
      const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
      return withCors(new Response(obj.body, {
        headers: {
          'Content-Type': (obj.httpMetadata && obj.httpMetadata.contentType) || MIME[ext] || 'application/octet-stream',
        },
      }));
    }

    // ---- static assets (web/) ----
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      // SPA fallback: unknown paths render the app shell
      if (request.method === 'GET') {
        const idx = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
        if (idx.status !== 404) return idx;
      }
    }

    return json({ error: 'not found' }, 404);
  },
};
