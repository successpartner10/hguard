// AI Home Guard — app bootstrap, routing, modals, toasts, settings.
import { $, el, store } from './utils.js';
import { net } from './net.js';
import { CameraMode, _wireUiHelpers as _wireCameraHelpers } from './camera.js';
import { MonitorMode, _wireMonitorHelpers } from './monitor.js';
import { getSettings, setSettings, DEFAULTS } from './settings.js';

export const app = {
  mode: null,          // 'camera' | 'monitor' | null
  camera: null,
  monitor: null,
};
window.__app = app; // dev/debug hook
// ---------------------------------------------------------------- toast
export function toast(message, kind = 'info', ms = 4200) {
  const box = $('#toasts');
  const t = el('div', { class: `toast ${kind}`, text: message });
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

// ---------------------------------------------------------------- modals
let _modalOnClose = null;
export function openModal(title, body, foot = [], onClose = null, opts = {}) {
  closeModal();
  _modalOnClose = onClose;
  const backdrop = el('div', { class: 'modal-backdrop' });
  const head = el('div', { class: 'modal-head' },
    opts.header || el('h3', { text: title }),
    el('button', { class: 'modal-close', 'aria-label': 'Close', text: '✕', onclick: closeModal }),
  );
  const modal = el('div', { class: `modal ${opts.className || ''}` },
    head,
    el('div', { class: 'modal-body' }, body),
    foot.length ? el('div', { class: 'modal-foot' }, ...foot) : null,
  );
  backdrop.appendChild(modal);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) closeModal(); });
  document.addEventListener('keydown', _escHandler = (e) => { if (e.key === 'Escape') closeModal(); });
  $('#modal-root').appendChild(backdrop);
  return modal;
}
let _escHandler = null;

export function closeModal() {
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
  if (_escHandler) { document.removeEventListener('keydown', _escHandler); _escHandler = null; }
  if (_modalOnClose) { const f = _modalOnClose; _modalOnClose = null; try { f(); } catch (e) { console.warn(e); } }
}

// ---------------------------------------------------------------- settings
export function openSettingsModal({ save = null, drive = null } = {}) {
  const s = getSettings();
  const serverUrl = el('input', { type: 'text', value: s.serverUrl, placeholder: 'http://localhost:3000 (blank = this page)' });
  const demo = el('input', { type: 'checkbox', checked: !!s.demoSource });
  const driveId = el('input', { type: 'text', value: s.driveClientId, placeholder: 'xxxx.apps.googleusercontent.com' });
  const retention = el('select', {},
    el('option', { value: '0', text: 'Keep forever' }),
    el('option', { value: '7', text: 'Keep 7 days' }),
    el('option', { value: '30', text: 'Keep 30 days' }),
  );
  retention.value = String(s.retention || 0);

  const driveState = el('div', { class: 'muted small', text: drive ? 'Not signed in.' : 'Camera not running — open Camera mode to connect Drive.' });
  const quotaBox = el('div', {});
  const btnDrive = el('button', { class: 'btn btn-secondary btn-small', text: 'Sign in with Google' });
  const btnSignOut = el('button', { class: 'btn btn-ghost btn-small hidden', text: 'Sign out' });
  const driveWrap = el('div', {});

  if (drive) {
    btnDrive.addEventListener('click', () => drive.signIn());
    btnSignOut.addEventListener('click', () => { drive.signOut(); closeModal(); });
    drive.onStatus = (st) => {
      if (st && st.ok && st.user) {
        driveState.textContent = `Signed in as ${st.user.emailAddress || st.user.displayName || 'you'} ✓`;
        driveState.className = 'small';
        btnDrive.classList.add('hidden');
        btnSignOut.classList.remove('hidden');
        if (st.quota) {
          const pct = st.quota.limit ? Math.min(100, st.quota.usage / st.quota.limit * 100) : 0;
          quotaBox.innerHTML = `<div class="mini-stat"><b>${fmtBytes(st.quota.usage)}</b> of ${st.quota.limit ? fmtBytes(st.quota.limit) : '?'} used</div>
            <div class="quota-bar ${pct > 90 ? 'full' : pct > 70 ? 'warn' : ''}"><div class="quota-fill" style="width:${pct}%"></div></div>`;
        }
      } else if (st && !st.ok && st.error) {
        driveState.textContent = 'Error: ' + st.error;
        driveState.className = 'small';
      }
    };
    driveWrap.append(driveState, quotaBox, el('div', { style: 'display:flex;gap:8px;margin-top:10px' }, btnDrive, btnSignOut));
    // restore session silently
    drive.restore().then(ok => { if (ok) driveState.textContent = 'Signed in ✓'; });
  } else {
    driveWrap.append(driveState);
  }

  const body = el('div', {},
    el('div', { class: 'set-group' },
      el('h4', { text: 'Connection' }),
      el('div', { class: 'set-row' },
        el('div', {}, el('label', { text: 'Server URL' }), el('div', { class: 'hint', text: 'Blank = this page. Point phones at your LAN server (e.g. http://192.168.1.20:3000) — or a hosted one later.' })),
        serverUrl),
      el('div', { class: 'set-row' },
        el('div', {}, el('label', { text: 'Demo source (no camera needed)' }), el('div', { class: 'hint', text: 'Synthetic scene for testing pairing/streaming. Applies after reload.' })),
        demo),
    ),
    el('div', { class: 'set-group' },
      el('h4', { text: 'Storage · Google Drive' }),
      el('div', { class: 'set-row' },
        el('div', {}, el('label', { text: 'OAuth Client ID' }), el('div', { class: 'hint', text: 'From Google Cloud Console → APIs & Services → Credentials → OAuth client (Web). Scope: drive.file only.' })),
        driveId),
      el('div', { class: 'set-row' },
        el('div', {}, el('label', { text: 'Retention' }), el('div', { class: 'hint', text: 'Old clips are auto-deleted from Drive.' })),
        retention),
      driveWrap,
    ),
    el('div', { class: 'set-group' },
      el('h4', { text: 'About' }),
      el('div', { class: 'set-row' },
        el('div', {}, el('label', { text: 'Version' }), el('div', { class: 'hint', text: 'Local dev build — Cloudflare deployment is Phase 6.' })),
        el('code', { text: '0.1.0-dev' })),
      el('div', { class: 'set-row' },
        el('button', {
          class: 'btn btn-danger btn-small', text: 'Reset app data',
          onclick: () => {
            if (confirm('Remove paired cameras, settings and local history from this device?')) {
              Object.keys(localStorage).filter(k => k.startsWith('ahg.')).forEach(k => localStorage.removeItem(k));
              location.reload();
            }
          },
        })),
    ),
  );

  openModal('Settings', body, [
    el('button', {
      class: 'btn btn-primary', text: 'Save',
      onclick: () => {
        const patch = {
          serverUrl: serverUrl.value.trim(),
          demoSource: demo.checked,
          driveClientId: driveId.value.trim(),
          retention: Number(retention.value),
        };
        const changed = JSON.stringify(patch) !== JSON.stringify({
          serverUrl: s.serverUrl || '', demoSource: !!s.demoSource,
          driveClientId: s.driveClientId || '', retention: Number(s.retention || 0),
        });
        setSettings(patch);
        if (save) save(patch);
        closeModal();
        if (changed && (patch.demoSource !== !!s.demoSource || patch.serverUrl !== (s.serverUrl || ''))) {
          setTimeout(() => {
            toast(patch.demoSource !== !!s.demoSource ? 'Demo source changed — reloading…' : 'Server URL changed — reconnecting…', 'info');
            setTimeout(() => location.reload(), 900);
          }, 300);
        } else {
          toast('Settings saved', 'success');
        }
      },
    }),
  ]);
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------- mode routing
function setMode(mode) {
  if (app.mode === mode && mode !== null) return;
  app.mode = mode;
  store.set('ahg.mode', mode);
  $('#mode-camera').setAttribute('aria-selected', mode === 'camera');
  $('#mode-monitor').setAttribute('aria-selected', mode === 'monitor');
  $('#view-onboarding').classList.toggle('hidden', mode !== null);
  $('#view-camera').classList.toggle('hidden', mode !== 'camera');
  $('#view-monitor').classList.toggle('hidden', mode !== 'monitor');
  if (mode === 'camera' && !app.camera) { app.camera = new CameraMode(); app.camera.init(); }
  if (mode === 'monitor' && !app.monitor) { app.monitor = new MonitorMode(); app.monitor.init(); }
}

// ---------------------------------------------------------------- server presence banner
// On a static host (GitHub Pages) with no Server URL configured, the app shell
// still loads — show a friendly hint instead of failing silently.
async function checkServerPresence() {
  if (getSettings().serverUrl) return; // explicitly pointed at a backend
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const r = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(t);
    if (r.ok) return; // served from the server itself — all good
  } catch { /* fall through */ }
  $('#server-hint').classList.remove('hidden');
}

function updateServerHint() {
  const visible = !getSettings().serverUrl && !net.connected;
  $('#server-hint').classList.toggle('hidden', !visible);
}

// ---------------------------------------------------------------- boot
function boot() {
  _wireCameraHelpers(openModal, openSettingsModal, toast);
  _wireMonitorHelpers(openModal, closeModal, toast, (t, o) => {
    try { if ('Notification' in window && Notification.permission === 'granted') new Notification(t, o); } catch { /* noop */ }
  });

  $('#mode-camera').addEventListener('click', () => setMode('camera'));
  $('#mode-monitor').addEventListener('click', () => setMode('monitor'));
  $('#btn-settings').addEventListener('click', () => openSettingsModal({
    save: (s) => {
      app.camera && app.camera.settings && Object.assign(app.camera.settings, s);
      updateServerHint();
    },
    drive: app.camera ? app.camera.drive : null,
  }));
  $('#btn-start-camera').addEventListener('click', () => setMode('camera'));
  $('#btn-start-monitor').addEventListener('click', () => setMode('monitor'));
  $('#btn-hint-settings').addEventListener('click', () => openSettingsModal({}));

  // connection indicator
  const dot = $('#conn-dot');
  net.onStatus = (state) => {
    dot.className = 'conn-dot ' + state;
    if (state === 'on') dot.title = 'Connected to server';
    else if (state === 'off') dot.title = 'Reconnecting…';
    else dot.title = 'Connection lost — retrying';
    updateServerHint();
  };

  // request notification permission early (user gesture independent, harmless)
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* noop */ }

  net.connect();
  checkServerPresence();

  // restore last mode for convenience; otherwise show onboarding
  const last = store.get('ahg.mode', null);
  if (store.get('ahg.camera', null)) setMode('camera');
  else if (last) setMode(last);
  else setMode(null); // reveals onboarding
}
document.addEventListener('DOMContentLoaded', boot);
