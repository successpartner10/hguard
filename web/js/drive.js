// Google Drive storage (user's own account, drive.file scope).
//
// Fully client-side: the user signs in with their own Google account in the
// browser. The app only ever sees files it created — never the rest of the
// Drive (OAuth scope `drive.file`). Clips land in:
//   AI Home Guard/<CameraName>/YYYY-MM-DD/HH-MM-SS_tag.webm
// plus a small JSON sidecar with AI metadata.
//
// To enable, create a Google Cloud OAuth Client ID (Web application) with:
//   Authorized JS origins: http://localhost:3000 (and your LAN address)
//   Scopes: https://www.googleapis.com/auth/drive.file
// then paste the Client ID into Settings → Storage.
import { store } from './utils.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.file';
const ROOT_NAME = 'AI Home Guard';
const API = 'https://www.googleapis.com/drive/v3';

function gapiFetch(path, opts = {}) {
  const token = localStorage.getItem('ahg.gtoken');
  if (!token) return Promise.reject(new Error('not signed in'));
  const headers = { Authorization: 'Bearer ' + token, ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return fetch(API + path, { ...opts, headers }).then(async (res) => {
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`Drive API ${res.status}: ${t.slice(0, 140)}`);
    }
    return res.status === 204 ? null : res.json();
  });
}

export class DriveManager {
  constructor() {
    this.tokenClient = null;
    this.signedIn = false;
    this.user = null;
    this.folderId = null;
    this.onStatus = null;
    this.loaded = false;
  }

  get clientId() { return (store.get('settings', {}).driveClientId || '').trim(); }
  get retentionDays() { return Number(store.get('settings', {}).retention || 0); } // 0 = forever

  async init() {
    if (!this.clientId) return { available: false, reason: 'no-client-id' };
    if (this.loaded) return { available: true };
    if (!window.google?.accounts) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.onload = resolve; s.onerror = () => reject(new Error('Could not load Google sign-in script (offline?)'));
        document.head.appendChild(s);
      });
    }
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: this.clientId,
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { this.onStatus && this.onStatus({ ok: false, error: resp.error_description || resp.error }); return; }
        localStorage.setItem('ahg.gtoken', resp.access_token);
        this.signedIn = true;
        this.afterAuth();
      },
    });
    this.loaded = true;
    return { available: true };
  }

  // returns true if a stored token still works (lazy validation on use)
  async restore() {
    if (!this.clientId || !localStorage.getItem('ahg.gtoken')) return false;
    try {
      const about = await gapiFetch('/about?fields=user,storageQuota');
      this.user = about.user;
      this.signedIn = true;
      this.afterAuth();
      return true;
    } catch { localStorage.removeItem('ahg.gtoken'); return false; }
  }

  signIn() {
    if (!this.tokenClient) return;
    this.tokenClient.requestAccessToken({ prompt: '' });
  }

  signOut() {
    localStorage.removeItem('ahg.gtoken');
    this.signedIn = false; this.folderId = null; this.user = null;
    this.onStatus && this.onStatus({ ok: true, signedOut: true });
  }

  async afterAuth() {
    try {
      await this.ensureFolders();
      const about = await gapiFetch('/about?fields=user,storageQuota');
      this.user = about.user;
      this.onStatus && this.onStatus({ ok: true, user: about.user, quota: about.storageQuota });
    } catch (e) {
      this.onStatus && this.onStatus({ ok: false, error: e.message });
    }
  }

  async ensureFolders() {
    if (this.folderId) return this.folderId;
    const list = await gapiFetch(`/files?q=${encodeURIComponent(`name='${ROOT_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`)}&fields=files(id,name)&pageSize=10`);
    if (list.files && list.files.length) { this.folderId = list.files[0].id; return this.folderId; }
    const created = await gapiFetch('/files', {
      method: 'POST',
      body: JSON.stringify({ name: ROOT_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    });
    this.folderId = created.id;
    return this.folderId;
  }

  async cameraFolder(cameraName) {
    const root = await this.ensureFolders();
    const safe = cameraName.replace(/[\\/:"*?<>|]/g, '_').slice(0, 60);
    const q = encodeURIComponent(`name='${safe}' and '${root}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const list = await gapiFetch(`/files?q=${q}&fields=files(id,name)&pageSize=10`);
    if (list.files && list.files.length) return list.files[0].id;
    const created = await gapiFetch('/files', {
      method: 'POST',
      body: JSON.stringify({ name: safe, mimeType: 'application/vnd.google-apps.folder', parents: [root] }),
    });
    return created.id;
  }

  // Upload a clip + sidecar. Returns the Drive file id.
  async uploadClip({ cameraName, tag, conf, zone, dur, at, blob, fileName }) {
    const folderId = await this.cameraFolder(cameraName);
    const metadata = { name: fileName, parents: [folderId], description: `AI Home Guard event clip` };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    form.append('file', blob, fileName);
    const file = await gapiFetch('/files?uploadType=multipart&fields=id,name,size', { method: 'POST', body: form });

    // JSON sidecar with AI metadata
    const sidecar = {
      app: 'AI Home Guard', version: 1,
      camera: cameraName, tag, confidence: conf, zone: zone || null,
      recordedAt: new Date(at).toISOString(), durationSec: Math.round(dur * 10) / 10,
    };
    const sm = { name: fileName.replace(/\.[a-z0-9]+$/i, '.json'), parents: [folderId] };
    const sform = new FormData();
    sform.append('metadata', new Blob([JSON.stringify(sm)], { type: 'application/json' }));
    sform.append('file', new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' }), sm.name);
    await gapiFetch('/files?uploadType=multipart', { method: 'POST', body: sform });
    return file;
  }

  // Retention: delete files older than retentionDays (0 = keep forever).
  async runRetention(cameraName) {
    const days = this.retentionDays;
    if (!days) return { deleted: 0, kept: Infinity };
    const folderId = await this.cameraFolder(cameraName);
    const cutoff = Date.now() - days * 86400_000;
    const list = await gapiFetch(`/files?q=${encodeURIComponent(`'${folderId}' in parents and trashed=false`)}&fields=files(id,createdTime,name)&pageSize=100`);
    let deleted = 0;
    for (const f of list.files || []) {
      if (new Date(f.createdTime).getTime() < cutoff) {
        await gapiFetch(`/files/${f.id}`, { method: 'DELETE' }).catch(() => {});
        deleted++;
      }
    }
    return { deleted, kept: (list.files || []).length - deleted };
  }

  // Storage usage indicator (may be unavailable with drive.file scope)
  async quota() {
    try {
      const about = await gapiFetch('/about?fields=storageQuota');
      return about.storageQuota || null;
    } catch { return null; }
  }
}
