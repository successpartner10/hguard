'use strict';
/**
 * Tiny JSON file persistence for the local dev server.
 * In the future (Phase 6) this whole server is replaced by Cloudflare
 * Workers + Durable Objects; until then everything lives in ./data
 * (gitignored, never contains credentials).
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CLIPS_DIR = path.join(DATA_DIR, 'clips');
const THUMBS_DIR = path.join(DATA_DIR, 'thumbs');

let state = { cameras: [], events: [], feedback: [] };
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(DB_FILE)) {
      state = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('db: failed to load, starting fresh:', e.message);
    state = { cameras: [], events: [], feedback: [] };
  }
  for (const dir of [DATA_DIR, CLIPS_DIR, THUMBS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function save(immediate) {
  if (saveTimer) clearTimeout(saveTimer);
  const write = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(state));
    } catch (e) {
      console.error('db: save failed:', e.message);
    }
  };
  if (immediate) { clearTimeout(saveTimer); saveTimer = null; write(); }
  else saveTimer = setTimeout(write, 400);
}

// ---- cameras ----
function getCamera(id) { return state.cameras.find(c => c.id === id); }
function getCameraByCode(code) {
  return state.cameras.find(c => c.code && c.code.replace(/\s/g, '').toUpperCase() === String(code).replace(/\s/g, '').toUpperCase());
}
function upsertCamera(cam) {
  const i = state.cameras.findIndex(c => c.id === cam.id);
  if (i >= 0) state.cameras[i] = { ...state.cameras[i], ...cam };
  else state.cameras.push(cam);
  save();
}
function listCameras() { return state.cameras.slice(); }

// ---- events ----
function addEvent(ev) {
  state.events.push(ev);
  // ring buffer: keep the most recent 1000 events
  if (state.events.length > 1000) state.events.splice(0, state.events.length - 1000);
  save();
  return ev;
}
function getEvents(opts = {}) {
  let out = state.events.slice();
  if (opts.cameraId) out = out.filter(e => e.cameraId === opts.cameraId);
  if (opts.since) out = out.filter(e => e.at >= opts.since);
  if (opts.tag) out = out.filter(e => e.tag === opts.tag);
  out.sort((a, b) => b.at - a.at);
  if (opts.limit) out = out.slice(0, opts.limit);
  return out;
}

// ---- feedback (thumbs up/down, used for false-alarm learning) ----
function addFeedback(fb) {
  state.feedback.push(fb);
  if (state.feedback.length > 2000) state.feedback.splice(0, state.feedback.length - 2000);
  save();
}
function getFeedbackForCamera(cameraId, since) {
  return state.feedback.filter(f => f.cameraId === cameraId && (!since || f.at > since));
}

// ---- paths ----
function clipPath(cameraId, name) {
  const d = new Date().toISOString().slice(0, 10);
  const dir = path.join(CLIPS_DIR, cameraId, d);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function thumbPath(cameraId, name) {
  const dir = path.join(THUMBS_DIR, cameraId);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}
function publicDir() { return { clips: CLIPS_DIR, thumbs: THUMBS_DIR }; }

load();

module.exports = {
  getCamera, getCameraByCode, upsertCamera, listCameras,
  addEvent, getEvents, addFeedback, getFeedbackForCamera,
  clipPath, thumbPath, publicDir, load,
};
