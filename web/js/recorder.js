// Clip recorder with pre-roll.
//
// While armed, a MediaRecorder runs on the *processing canvas stream* (so
// night mode and detection overlays are baked into clips) with 1.5s timeslices.
// A ring buffer keeps the last ~6s as pre-roll. When an event starts we keep
// the pre-roll chunks + everything recorded during the event; when it ends we
// assemble one Blob and upload it to the server (and optionally Drive).
//
// Offline resilience: if the server is unreachable, clips + thumbs are queued
// in IndexedDB and drained automatically when connectivity returns.
import { store, uid } from './utils.js';
import { apiUrl } from './net.js';

const DB_NAME = 'aihguard';
const DB_VER = 1;
let _dbPromise = null;

function idb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _dbPromise;
}

async function queuePut(item) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(item);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

async function queueList() {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readonly');
    const req = tx.objectStore('queue').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function queueDelete(id) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus',
    'video/webm', 'video/mp4',
  ];
  for (const c of candidates) if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
  return '';
}

export class ClipRecorder {
  constructor({ onChunk } = {}) {
    this.stream = null;           // MediaStream to record (processing canvas stream)
    this.recorder = null;
    this.chunks = [];             // current session chunks
    this.ring = [];               // pre-roll ring buffer
    this.ringMax = 5;             // ~7.5s of pre-roll
    this.recording = false;
    this.sessionStart = 0;
    this.onChunk = onChunk || null;
    this.onStatus = null;
  }

  setStream(stream) {
    this.stream = stream;
    if (this.recorder) this.stop();
  }

  // Start the always-on session recorder (when armed).
  start() {
    if (this.recorder || !this.stream) return;
    let mime = pickMime();
    try {
      this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime, videoBitsPerSecond: 2_000_000 } : { videoBitsPerSecond: 2_000_000 });
    } catch (e) {
      console.warn('MediaRecorder unavailable:', e);
      return;
    }
    this.chunks = [];
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
        // ring = chunks from the last ringMax slots (keep 2x to allow trimming)
        this.ring = this.chunks.slice(-this.ringMax * 2);
      }
    };
    this.recorder.onstop = () => {
      this.chunks = [];
      this.ring = [];
    };
    this.recorder.start(1500);
    this.sessionStart = Date.now();
  }

  stop() {
    if (this.recorder && this.recorder.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* noop */ }
    }
    this.recorder = null;
  }

  get hasPreRoll() { return this.ring.length > 0; }

  // Snapshot the pre-roll + return a collector for event chunks
  beginEvent() {
    const pre = this.ring.slice();
    const evChunks = [...pre];
    return {
      push: (blob) => { if (blob && blob.size > 0) evChunks.push(blob); },
      finish: () => new Blob(evChunks, { type: pre.length ? pre[0].type : 'video/webm' }),
    };
  }
}

// Upload helpers ------------------------------------------------------------

async function uploadRaw(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`upload failed (${res.status})`);
  return res.json();
}

// Save a clip + thumbnail: to the server, with IndexedDB queue as offline fallback.
export async function saveClip({ cameraId, eventId, name, blob, thumbDataUrl, tag, conf, zone, dur, at }) {
  const meta = { cameraId, eventId, name, tag, conf, zone, dur, at };
  const job = { id: uid(), kind: 'clip', meta, blob, thumbDataUrl };
  try {
    await uploadRaw(apiUrl(`/api/clips?camera=${encodeURIComponent(cameraId)}&event=${encodeURIComponent(eventId)}&name=${encodeURIComponent(name)}&tag=${encodeURIComponent(tag)}&conf=${conf}&zone=${encodeURIComponent(zone || '')}&dur=${Math.round(dur * 10) / 10}&at=${at}`), blob, { 'Content-Type': blob.type });
    if (thumbDataUrl) {
      await uploadRaw(apiUrl(`/api/thumbs?camera=${encodeURIComponent(cameraId)}&event=${encodeURIComponent(eventId)}`), dataUrlToBlob(thumbDataUrl), { 'Content-Type': 'image/jpeg' });
    }
    return { queued: false };
  } catch (e) {
    console.warn('server upload failed, queueing:', e.message);
    await queuePut(job);
    return { queued: true };
  }
}

export function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const mime = (head.match(/data:(.*?);/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// Try to drain the offline queue (call when connectivity returns)
export async function drainQueue(onProgress) {
  const items = await queueList();
  for (const item of items) {
    try {
      if (item.kind === 'clip') {
        await uploadRaw(apiUrl(`/api/clips?camera=${encodeURIComponent(item.meta.cameraId)}&event=${encodeURIComponent(item.meta.eventId)}&name=${encodeURIComponent(item.meta.name)}&tag=${encodeURIComponent(item.meta.tag)}&conf=${item.meta.conf}&zone=${encodeURIComponent(item.meta.zone || '')}&dur=${Math.round(item.meta.dur * 10) / 10}&at=${item.meta.at}`), item.blob, { 'Content-Type': item.blob.type });
        if (item.thumbDataUrl) {
          await uploadRaw(apiUrl(`/api/thumbs?camera=${encodeURIComponent(item.meta.cameraId)}&event=${encodeURIComponent(item.meta.eventId)}`), dataUrlToBlob(item.thumbDataUrl), { 'Content-Type': 'image/jpeg' });
        }
      }
      await queueDelete(item.id);
      onProgress && onProgress(item);
    } catch (e) {
      console.warn('queue drain item failed:', e.message);
      break; // still offline — stop and retry next time
    }
  }
  return (await queueList()).length;
}

export { store };
