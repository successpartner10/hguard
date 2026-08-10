// Monitor Mode — dashboard, live view, timeline, digests, diagnostics.
import { $, $$, el, store, fmtTime, fmtDateTime, timeAgo, niceBytes, dayKey, downloadDataUrl } from './utils.js';
import { net, apiUrl } from './net.js';
import { getSettings } from './settings.js';

const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

export class MonitorMode {
  constructor() {
    this.paired = store.get('ahg.paired', []);   // [{code, id, name}]
    this.camStates = new Map();                    // id -> status from server
    this.events = [];                              // master event list
    this.live = null;                              // {sessId, cameraId, pc, video, micStream, statsTimer}
    this._listeners = [];
  }

  // ------------------------------------------------------------- init
  async init() {
    $('#btn-add-camera').addEventListener('click', () => this.showPairModal());
    for (const t of $$('.sub-tab')) t.addEventListener('click', () => this.switchTab(t.dataset.tab));
    $('#filter-camera').addEventListener('change', () => this.renderTimeline());
    $('#filter-tag').addEventListener('change', () => this.renderTimeline());
    $('#filter-range').addEventListener('change', () => this.renderTimeline());
    $('#nl-search').addEventListener('input', () => this.renderTimeline());

    this._listeners.push(net.on('camera.status', (m) => {
      this.camStates.set(m.camera.id, m.camera);
      this.renderDashboard();
      this.renderTimeline();
    }));
    this._listeners.push(net.on('event.new', (m) => {
      if (!this.events.find(e => e.id === m.event.id)) {
        this.events.unshift(m.event);
        this.events.sort((a, b) => b.at - a.at);
        this.renderTimeline();
        this.onNewEvent(m.event);
      }
    }));

    // restore pairings on connect
    this._listeners.push(net.on('open', async () => {
      await net.call('monitor.hello').catch(() => {});
      for (const p of this.paired) {
        try {
          const { camera } = await net.call('monitor.pair', { code: p.code });
          p.id = camera.id; p.name = camera.name;
          this.camStates.set(camera.id, camera);
        } catch { /* camera gone — keep card but offline */ }
      }
      store.set('ahg.paired', this.paired);
      this.renderDashboard();
      this.refreshEvents();
    }));

    // initial data
    try {
      const res = await fetch(apiUrl('/api/state?events=300')).then(r => r.json());
      this.events = res.events || [];
      for (const c of res.cameras || []) this.camStates.set(c.id, c);
    } catch { /* server still starting */ }
    this.renderDashboard();
    this.renderTimeline();
    this.renderFilters();

    // if already connected when initialized, run the reconnect logic now
    if (net.connected) {
      await net.call('monitor.hello').catch(() => {});
      for (const p of this.paired) {
        try {
          const { camera } = await net.call('monitor.pair', { code: p.code });
          p.id = camera.id; p.name = camera.name;
          this.camStates.set(camera.id, camera);
        } catch { /* camera gone — keep card but offline */ }
      }
      store.set('ahg.paired', this.paired);
      this.renderDashboard();
    }
  }

  switchTab(tab) {
    $$('.sub-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
    $('#tab-dashboard').classList.toggle('hidden', tab !== 'dashboard');
    $('#tab-timeline').classList.toggle('hidden', tab !== 'timeline');
    if (tab === 'timeline') { this.refreshEvents(); this.renderTimeline(); }
  }

  async refreshEvents() {
    try {
      const res = await fetch(apiUrl('/api/events?limit=300')).then(r => r.json());
      if (res.events) {
        const seen = new Set(this.events.map(e => e.id));
        for (const e of res.events) if (!seen.has(e.id)) this.events.push(e);
        this.events.sort((a, b) => b.at - a.at);
        this.renderTimeline();
      }
    } catch { /* noop */ }
  }

  // ------------------------------------------------------------- pairing
  showPairModal() {
    const codeInput = el('input', { class: 'pair-code-input', placeholder: 'XXXX-XXXX', maxlength: 9, autocapitalize: 'characters', spellcheck: 'false' });
    let scanBox = null, scanStream = null, scanRaf = null;

    const tryPair = async (rawCode) => {
      const code = String(rawCode || '').replace(/\s/g, '').toUpperCase();
      if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) { toast('Enter the 8-character code shown on the camera (e.g. 8K2M-Q5XA).', 'warn'); return; }
      try {
        const { camera } = await net.call('monitor.pair', { code });
        if (!this.paired.find(p => p.code === code)) {
          this.paired.push({ code, id: camera.id, name: camera.name });
          store.set('ahg.paired', this.paired);
        }
        this.camStates.set(camera.id, camera);
        stopScan();
        closeModal();
        this.renderDashboard();
        toast(`Camera “${camera.name}” paired 🎉`, 'success');
      } catch (e) {
        toast(e.message, 'error');
      }
    };

    const startScan = () => {
      const box = $('#scan-video');
      if (!box) return;
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then((s) => {
          scanStream = s;
          box.srcObject = s;
          $('#scan-box').classList.remove('hidden');
          box.play().catch(() => {});
          const tick = () => {
            scanRaf = requestAnimationFrame(tick);
            if (box.readyState < 2) return;
            const c = document.createElement('canvas');
            c.width = box.videoWidth || 320; c.height = box.videoHeight || 240;
            c.getContext('2d').drawImage(box, 0, 0);
            const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
            const res = window.jsQR ? jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' }) : null;
            if (res && res.data) {
              const m = res.data.match(/aihguard:\/\/pair\/([A-Z0-9-]+)/i) || res.data.match(/([A-Z0-9]{4}-[A-Z0-9]{4})/);
              if (m) { stopScan(); tryPair(m[1]); }
            }
          };
          tick();
        })
        .catch(() => toast('Camera access needed to scan QR codes — or just type the code.', 'warn'));
    };
    const stopScan = () => {
      cancelAnimationFrame(scanRaf);
      if (scanStream) scanStream.getTracks().forEach(t => t.stop());
      scanStream = null;
    };

    const body = el('div', {},
      el('p', { class: 'muted small', text: 'On the camera device, tap “Pair a monitor”. Then scan its QR code — or type the 8-character code shown there.' }),
      el('div', { class: 'field' }, codeInput),
      el('div', { style: 'text-align:center;margin:4px 0 12px' },
        el('button', { class: 'btn btn-secondary btn-small', text: '📷 Scan QR code', onclick: startScan }),
      ),
      el('div', { id: 'scan-box', class: 'scan-box hidden' },
        el('video', { id: 'scan-video', autoplay: '', playsinline: '', muted: '' }),
        el('div', { class: 'scan-frame' }),
        el('div', { class: 'scan-hint', text: 'Point at the QR code on the camera device' }),
      ),
    );
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') tryPair(codeInput.value);
      if (e.key.length === 1 && codeInput.value.length === 4 && codeInput.value[3] !== '-') {
        codeInput.value += '-';
      }
    });
    openModal('Add a camera', body, [
      el('button', { class: 'btn btn-primary', text: 'Pair', onclick: () => tryPair(codeInput.value) }),
    ], () => stopScan());
  }

  // ------------------------------------------------------------- dashboard
  renderDashboard() {
    const grid = $('#camera-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (!this.paired.length) {
      grid.appendChild(el('div', { class: 'empty-state', style: 'grid-column:1/-1' },
        el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
          el('path', { d: 'M23 7l-7 5 7 5V7z' }),
          el('rect', { x: '1', y: '5', width: '15', height: '14', rx: '2' })),
        el('h3', { text: 'No cameras yet' }),
        el('p', { text: 'Grab the spare phone, open this app on it, and pick Camera mode. Then scan its QR code here — done in under a minute.' }),
        el('div', { style: 'margin-top:16px' },
          el('button', { class: 'btn btn-primary', text: 'Add your first camera', onclick: () => this.showPairModal() })),
      ));
      return;
    }

    // recent thumb per camera from events
    const lastThumb = (cameraId) => {
      const ev = this.events.find(e => e.cameraId === cameraId && e.thumb);
      return ev ? apiUrl(ev.thumb) : null;
    };

    for (const p of this.paired) {
      const st = this.camStates.get(p.id) || { online: false, armed: false, lastSeen: null, battery: null, viewers: 0 };
      const thumb = lastThumb(p.id);
      const justEvent = this.events.some(e => e.cameraId === p.id && Date.now() - e.at < 8000);
      const dotClass = !st.online ? 'offline' : justEvent ? 'event' : st.armed ? 'armed' : 'online';
      const card = el('div', { class: `cam-card ${st.armed && st.online ? 'armed-c' : ''}`, role: 'button', tabindex: '0', onclick: () => this.openLive(p), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.openLive(p); } } },
        el('div', { class: 'cam-thumb' },
          el('span', { class: `status-dot ${dotClass}` }),
          st.viewers > 0 && el('span', { class: 'viewers-badge', text: `👁 ${st.viewers}` }),
          thumb
            ? el('img', { src: thumb, alt: '' })
            : el('div', { class: 'ph' },
                el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.5' },
                  el('path', { d: 'M23 7l-7 5 7 5V7z' }),
                  el('rect', { x: '1', y: '5', width: '15', height: '14', rx: '2' }))),
        ),
        el('div', { class: 'cam-card-body' },
          el('div', {},
            el('div', { class: 'cam-card-name', text: p.name || 'Camera' }),
            el('div', { class: 'cam-card-meta', text: this.cardMeta(st) }),
          ),
          el('div', { class: 'cam-card-btns' },
            el('button', {
              class: 'mini-btn', title: 'Diagnostics',
              onclick: (e) => { e.stopPropagation(); this.showDiagnostics(p, st); },
            }, el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round' },
              el('path', { d: 'M12 20h.01M8.5 16.4a4 4 0 0 1 7 0M5 12.6a8 8 0 0 1 14 0' }))),
          ),
        ),
      );
      grid.appendChild(card);
    }
  }

  cardMeta(st) {
    if (!st.online) return 'Offline · ' + (st.lastSeen ? timeAgo(st.lastSeen) : 'never seen');
    const parts = [st.armed ? 'Armed' : 'Disarmed'];
    if (st.battery != null) parts.push(`🔋 ${st.battery}%`);
    if (st.signal != null) parts.push(`📶 ${st.signal} Mbps`);
    return parts.join(' · ');
  }

  // ------------------------------------------------------------- live view
  async openLive(pair) {
    const st = this.camStates.get(pair.id) || {};
    if (!st.online) {
      toast(`“${pair.name || 'Camera'}” is offline. It reconnects automatically when its Wi-Fi returns.`, 'warn');
      return;
    }
    if (this.live) this.closeLive();

    const video = el('video', { autoplay: '', playsinline: '', muted: '' });
    const live = {
      pair, video, pc: null, sessId: 'sess-' + Math.random().toString(36).slice(2, 10),
      micStream: null, micTrack: null, talking: false, statsTimer: null, connState: 'connecting',
    };
    this.live = live;

    const statBox = el('div', { class: 'live-stats hidden' });
    const btnTalk = el('button', { class: 'live-btn', title: 'Hold to talk through the camera' },
      el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
        el('path', { d: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z' }),
        el('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2' }),
        el('line', { x1: '12', y1: '19', x2: '12', y2: '22' })),
      el('span', { text: 'Talk' }),
    );
    const btnSnap = el('button', { class: 'live-btn', title: 'Save a snapshot' },
      el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
        el('path', { d: 'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z' }),
        el('circle', { cx: '12', cy: '13', r: '4' })),
      el('span', { text: 'Snapshot' }),
    );
    const btnMute = el('button', { class: 'live-btn', text: '🔇 Mute camera audio' });
    const btnStats = el('button', { class: 'live-btn', text: '📊 Stats' });
    const btnFull = el('button', { class: 'live-btn', text: '⛶ Fullscreen' });

    const body = el('div', {},
      el('div', { class: 'live-video-wrap' },
        video,
        el('div', { id: 'live-connecting', class: 'no-signal',
          }, el('div', { class: 'small', text: 'Connecting to camera…' })),
      ),
      el('div', { class: 'live-controls' }, btnTalk, btnSnap, btnMute, btnStats, btnFull),
      statBox,
    );

    const header = el('div', { class: 'live-head' },
      el('span', { class: 'live-dot' }),
      el('span', { class: 'name', text: pair.name || 'Camera' }),
    );
    openModal('', body, [], () => this.closeLive(), { header, className: 'live-modal' });

    // --- WebRTC
    live.pc = new RTCPeerConnection(ICE);
    live.pc.ontrack = (e) => {
      if (e.track.kind === 'video' && e.streams[0]) {
        video.srcObject = e.streams[0];
        video.play().catch(() => {});
        const c = $('#live-connecting'); if (c) c.classList.add('hidden');
        live.connState = 'connected';
      }
    };
    live.pc.onicecandidate = (e) => {
      if (e.candidate && live.sessId) net.send({ type: 'monitor.signal', cameraId: pair.id, sessId: live.sessId, data: { ice: e.candidate } });
    };
    live.pc.onconnectionstatechange = () => {
      live.connState = live.pc.connectionState;
      if (live.pc.connectionState === 'failed' || live.pc.connectionState === 'disconnected') {
        const c = $('#live-connecting');
        if (c) { c.innerHTML = '<p>Connection lost — camera may be offline. It reconnects automatically.</p>'; c.classList.remove('hidden'); }
      }
    };

    try {
      const { sessId } = await net.call('monitor.watch', { cameraId: pair.id, sessId: live.sessId });
      live.sessId = sessId;
    } catch (e) {
      toast(e.message, 'error');
      this.closeLive();
      return;
    }

    // signals from camera (offer) and renegotiation answers
    this._liveUnsub = net.on('signal', async (m) => {
      if (m.sessId !== live.sessId) return;
      try {
        if (m.data && m.data.offer) {
          await live.pc.setRemoteDescription(m.data.offer);
          const answer = await live.pc.createAnswer();
          await live.pc.setLocalDescription(answer);
          net.send({ type: 'monitor.signal', cameraId: pair.id, sessId: live.sessId, data: { answer: live.pc.localDescription } });
        } else if (m.data && m.data.answer) {
          await live.pc.setRemoteDescription(m.data.answer);
        } else if (m.data && m.data.ice) {
          await live.pc.addIceCandidate(m.data.ice);
        }
      } catch (e) { console.warn('signal error:', e); }
    });
    this._snapUnsub = net.on('snapshot', (m) => {
      if (m.sessId !== live.sessId || !m.dataUrl) return;
      const name = `snapshot_${pair.name.replace(/\W+/g, '_')}_${Date.now()}.jpg`;
      downloadDataUrl(name, m.dataUrl);
      toast('Snapshot saved', 'success');
    });

    // --- controls
    btnTalk.addEventListener('pointerdown', () => this.setTalking(live, true));
    btnTalk.addEventListener('pointerup', () => this.setTalking(live, false));
    btnTalk.addEventListener('pointerleave', () => this.setTalking(live, false));
    btnTalk.addEventListener('pointercancel', () => this.setTalking(live, false));

    btnSnap.addEventListener('click', () => net.send({ type: 'monitor.snapshot', cameraId: pair.id, sessId: live.sessId }));
    btnMute.addEventListener('click', () => {
      video.muted = !video.muted;
      btnMute.textContent = video.muted ? '🔊 Unmute camera audio' : '🔇 Mute camera audio';
    });
    btnStats.addEventListener('click', () => statBox.classList.toggle('hidden'));
    btnFull.addEventListener('click', () => {
      const wrap = $('.live-video-wrap');
      if (wrap) wrap.requestFullscreen ? wrap.requestFullscreen() : toast('Fullscreen not supported here', 'warn');
    });

    // --- stats
    live.statsTimer = setInterval(() => this.updateStats(live, statBox), 2000);
  }

  async setTalking(live, on) {
    if (on && !live.micTrack) {
      try {
        live.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        live.micTrack = live.micStream.getAudioTracks()[0];
        live.pc.addTrack(live.micTrack, live.micStream);
        live.talking = true;
        this.renegotiate(live);
      } catch {
        toast('Microphone access denied — Talk needs the mic.', 'warn');
        return;
      }
    } else if (!on && live.micTrack) {
      live.talking = false;
      try { live.pc.removeTrack(live.pc.getSenders().find(s => s.track === live.micTrack)); } catch { /* noop */ }
      this.renegotiate(live);
    }
  }

  async renegotiate(live) {
    try {
      const offer = await live.pc.createOffer();
      await live.pc.setLocalDescription(offer);
      net.send({ type: 'monitor.signal', cameraId: live.pair.id, sessId: live.sessId, data: { offer: live.pc.localDescription } });
    } catch (e) { console.warn('renegotiate failed:', e); }
  }

  async updateStats(live, box) {
    if (!live.pc || !box) return;
    let stats;
    try { stats = await live.pc.getStats(); } catch { return; }
    let inbound = null;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') inbound = r;
    });
    if (!inbound) return;
    const now = performance.now();
    const dt = (now - (live._lastT || now)) / 1000;
    const prevBytes = live._lastBytes || inbound.bytesReceived;
    const bitrate = dt > 0 ? Math.round((inbound.bytesReceived - prevBytes) * 8 / dt / 1000) : 0;
    live._lastT = now; live._lastBytes = inbound.bytesReceived;
    const res = inbound.frameWidth && inbound.frameHeight ? `${inbound.frameWidth}×${inbound.frameHeight}` : '—';
    let latency = live._latency;
    net.ping().then(ms => { live._latency = ms; }).catch(() => {});
    latency = live._latency || '—';
    box.innerHTML = [
      stat('Resolution', res),
      stat('FPS', inbound.framesPerSecond != null ? Math.round(inbound.framesPerSecond) : '—'),
      stat('Bitrate', bitrate ? `${bitrate} kbps` : '—'),
      stat('Jitter', inbound.jitter != null ? `${(inbound.jitter * 1000).toFixed(1)} ms` : '—'),
      stat('Packets lost', inbound.packetsLost != null ? `${inbound.packetsLost}` : '—'),
      stat('Latency', typeof latency === 'number' ? `${latency} ms` : latency),
      stat('Peer state', live.connState),
    ].join('');
    function stat(k, v) { return `<div class="stat-cell"><div class="k">${k}</div><div class="v">${v}</div></div>`; }
  }

  closeLive() {
    if (this._liveUnsub) { this._liveUnsub(); this._liveUnsub = null; }
    if (this._snapUnsub) { this._snapUnsub(); this._snapUnsub = null; }
    const live = this.live;
    if (!live) return;
    clearInterval(live.statsTimer);
    if (live.pc) { try { live.pc.close(); } catch { /* noop */ } }
    if (live.micStream) live.micStream.getTracks().forEach(t => t.stop());
    if (live.sessId) net.send({ type: 'monitor.unwatch', sessId: live.sessId });
    this.live = null;
    this.renderDashboard();
  }

  // ------------------------------------------------------------- diagnostics
  async showDiagnostics(pair, st) {
    let latency = '—';
    try { latency = (await net.ping()) + ' ms'; } catch { /* offline */ }
    const rows = [
      ['Camera', pair.name || '—'],
      ['Status', st.online ? (st.armed ? 'Online · armed' : 'Online · disarmed') : 'Offline'],
      ['Last seen', st.lastSeen ? timeAgo(st.lastSeen) : '—'],
      ['Battery', st.battery != null ? `${st.battery}%` : 'not reported'],
      ['Signal (camera)', st.signal != null ? `${st.signal} Mbps downlink` : 'not reported'],
      ['Live viewers', String(st.viewers || 0)],
      ['Server latency', latency],
    ];
    const list = el('div', { class: 'diag-grid' },
      ...rows.map(([k, v]) => el('div', { class: 'stat-cell', style: 'background:var(--surface-2)' },
        el('div', { class: 'k', text: k }), el('div', { class: 'v', text: v }))),
    );
    const probeBtn = el('button', { class: 'btn btn-secondary btn-small', text: 'Run bandwidth test' });
    const probeResult = el('div', { class: 'small muted', style: 'margin-top:10px' });
    probeBtn.addEventListener('click', async () => {
      probeBtn.disabled = true;
      probeResult.textContent = 'Testing (1 MB download)…';
      try {
        const t0 = performance.now();
        const res = await fetch(apiUrl('/api/probe?kb=1024'));
        const buf = await res.arrayBuffer();
        const secs = (performance.now() - t0) / 1000;
        const mbps = (buf.byteLength * 8 / 1e6 / secs).toFixed(1);
        probeResult.textContent = `Downloaded 1 MB in ${secs.toFixed(2)}s → ≈ ${mbps} Mbps (network to this server).`;
      } catch {
        probeResult.textContent = 'Test failed — server unreachable?';
      }
      probeBtn.disabled = false;
    });
    const body = el('div', {},
      el('p', { class: 'muted small', text: 'Network & connection insight for this camera. Live-view stats (bitrate, FPS) appear in the Stats panel while watching.' }),
      list, el('div', { style: 'margin-top:14px' }, probeBtn), probeResult);
    openModal(`Diagnostics · ${pair.name || 'Camera'}`, body, []);
  }

  // ------------------------------------------------------------- timeline
  renderFilters() {
    const sel = $('#filter-camera');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All cameras</option>' +
      this.paired.map(p => `<option value="${p.id}">${p.name || 'Camera'}</option>`).join('');
    if (cur) sel.value = cur;
  }

  filteredEvents() {
    const camSel = $('#filter-camera')?.value;
    const tag = $('#filter-tag')?.value;
    const range = $('#filter-range')?.value;
    const query = ($('#nl-search')?.value || '').trim().toLowerCase();

    let out = this.events.slice();
    if (camSel) out = out.filter(e => e.cameraId === camSel);
    if (tag) out = out.filter(e => e.tag === tag);
    if (range === 'today') out = out.filter(e => e.at >= startOfDay(Date.now()));
    else if (range === '7') out = out.filter(e => e.at >= Date.now() - 7 * 86400_000);
    else if (range === '30') out = out.filter(e => e.at >= Date.now() - 30 * 86400_000);

    if (query) out = applyNLQuery(out, query, this.paired);
    return out;
  }

  renderTimeline() {
    const list = $('#timeline-list');
    const empty = $('#timeline-empty');
    const digest = $('#digest-card');
    if (!list) return;

    const filtered = this.filteredEvents();

    // digest
    const todayStart = startOfDay(Date.now());
    const todays = filtered.filter(e => e.at >= todayStart);
    const digestText = buildDigest(todays);
    digest.classList.toggle('hidden', !digestText);
    if (digestText) $('#digest-text').textContent = digestText;

    // empty state
    if (!filtered.length) {
      list.innerHTML = '';
      empty.classList.remove('hidden');
      $('#timeline-empty-title').textContent = this.events.length ? 'Nothing matches' : 'No events yet';
      $('#timeline-empty-sub').textContent = this.events.length
        ? 'Try clearing the search or picking a wider date range.'
        : 'When a camera detects motion, clips show up here — searchable and tagged.';
      return;
    }
    empty.classList.add('hidden');

    // group by day
    const groups = new Map();
    for (const e of filtered) {
      const k = dayKey(e.at);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(e);
    }

    list.innerHTML = '';
    for (const [day, evs] of [...groups.entries()].sort((a, b) => b[0] < a[0] ? -1 : 1)) {
      list.appendChild(el('div', { class: 'tl-day', text: day === dayKey(Date.now()) ? 'Today' : fmtDay(day) }));
      for (const e of evs) list.appendChild(this.eventRow(e));
    }
  }

  eventRow(e) {
    const tagLabel = e.tag === 'person' ? '👤 Person' : e.tag === 'package' ? '📦 Package' : 'Motion';
    const camName = (this.paired.find(p => p.id === e.cameraId) || {}).name || e.cameraName || 'Camera';
    const row = el('div', { class: 'tl-row' },
      el('div', { class: 'tl-thumb', onclick: () => e.clip && this.playClip(e) },
        e.thumb ? el('img', { src: apiUrl(e.thumb), alt: '', loading: 'lazy' }) : el('img', { alt: '', src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==' }),
        el('div', { class: 'play-overlay' },
          el('svg', { viewBox: '0 0 24 24', fill: 'currentColor' }, el('path', { d: 'M8 5v14l11-7z' }))),
      ),
      el('div', { class: 'tl-body' },
        el('div', { class: 'tl-title' },
          el('span', { class: `tag ${e.suppressed ? 'suppressed' : e.tag}` , text: tagLabel }),
          e.zone && el('span', { class: 'muted small', text: e.zone }),
          e.conf != null && el('span', { class: 'muted small', text: `${Math.round(e.conf * 100)}% confidence` }),
        ),
        el('div', { class: 'tl-time', text: `${camName} · ${fmtDateTime(e.at)}${e.dur ? ` · ${Math.round(e.dur)}s clip` : ''}` }),
        e.suppressed && el('div', { class: 'tl-meta', text: 'Suppressed by false-alarm learning (no notification was sent)' }),
      ),
      el('div', { class: 'tl-actions' },
        e.clip && el('button', { class: 'play-btn', onclick: () => this.playClip(e) },
          el('svg', { viewBox: '0 0 24 24', fill: 'currentColor' }, el('path', { d: 'M8 5v14l11-7z' })), 'Play'),
        el('button', {
          class: `fb-btn ${e.feedback === 'up' ? 'pressed-up' : ''}`, title: 'Good — I want more of these',
          onclick: () => this.sendFeedback(e, true),
        }, el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          el('path', { d: 'M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3' }))),
        el('button', {
          class: `fb-btn ${e.feedback === 'down' ? 'pressed-down' : ''}`, title: 'False alarm — stop these',
          onclick: () => this.sendFeedback(e, false),
        }, el('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' },
          el('path', { d: 'M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zM17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3' }))),
      ),
    );
    return row;
  }

  sendFeedback(e, value) {
    net.send({ type: 'feedback', eventId: e.id, value });
    e.feedback = value ? 'up' : 'down';
    this.renderTimeline();
  }

  playClip(e) {
    const video = el('video', { src: apiUrl(e.clip), controls: '', autoplay: '', playsinline: '' });
    video.style.width = '100%'; video.style.borderRadius = '12px'; video.style.background = '#000';
    video.style.aspectRatio = '16/9';
    openModal(`${e.tag === 'person' ? '👤 Person' : e.tag === 'package' ? '📦 Package' : 'Motion'} · ${fmtDateTime(e.at)}`, el('div', {}, video), []);
  }

  onNewEvent(ev) {
    // glanceable: amber flash on the card
    this.renderDashboard();
    // in-app + OS notification for AI events
    if (ev.tag !== 'motion' && !ev.suppressed) {
      const camName = (this.paired.find(p => p.id === ev.cameraId) || {}).name || ev.cameraName || 'Camera';
      const title = `${ev.tag === 'person' ? 'Person detected' : 'Package detected'} — ${camName}`;
      const body = `${fmtTime(ev.at)}${ev.zone ? ' · ' + ev.zone : ''}${ev.conf ? ` · ${Math.round(ev.conf * 100)}%` : ''}`;
      toast(`${title}${body ? ' — ' + body : ''}`, ev.tag === 'person' ? 'warn' : 'info');
      if (document.hidden) {
        notify(title, { body, icon: ev.thumb || undefined, tag: ev.id, renotify: false });
      }
    }
  }
}

// ------------------------------------------------------------- helpers
function startOfDay(ts) { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); }
function fmtDay(key) {
  const d = new Date(key + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

// Plain-language digest for a set of events
function buildDigest(events) {
  if (!events.length) return null;
  const byCam = new Map();
  for (const e of events) {
    const k = e.cameraName || 'Camera';
    if (!byCam.has(k)) byCam.set(k, []);
    byCam.get(k).push(e);
  }
  const sentences = [];
  for (const [cam, evs] of byCam) {
    const people = evs.filter(e => e.tag === 'person');
    const pkgs = evs.filter(e => e.tag === 'package');
    const motion = evs.filter(e => e.tag === 'motion');
    const bits = [];
    if (people.length) {
      const times = people.slice(0, 5).map(e => fmtTime(e.at)).join(', ');
      bits.push(`${people.length} person event${people.length > 1 ? 's' : ''} (${times}${people.length > 5 ? '…' : ''})`);
    }
    if (pkgs.length) bits.push(`${pkgs.length} package event${pkgs.length > 1 ? 's' : ''} (${fmtTime(pkgs[0].at)}${pkgs.length > 1 ? '…' : ''})`);
    if (motion.length) bits.push(`${motion.length} motion clip${motion.length > 1 ? 's' : ''}`);
    if (bits.length) sentences.push(`${cam}: ${bits.join(' · ')}.`);
  }
  return sentences.join(' ');
}

// Tiny natural-language search over event metadata
function applyNLQuery(events, q, paired) {
  const terms = q.split(/\s+/);
  let out = events.slice();
  const has = (re) => q.search(re) >= 0;

  // tags
  if (has(/person|people|someone|who|human/i)) out = out.filter(e => e.tag === 'person');
  if (has(/package|parcel|deliver|box/i)) out = out.filter(e => e.tag === 'package');
  if (has(/motion|movement|anything/i) && !has(/person|package|parcel/)) out = out.filter(e => e.tag === 'motion');

  // camera names
  for (const p of paired) {
    if (p.name && q.includes(p.name.toLowerCase())) {
      out = out.filter(e => e.cameraId === p.id);
    }
  }

  // zones (we keep zone names in event metadata)
  if (has(/door/i)) out = out.filter(e => /door/i.test(e.zone || ''));
  if (has(/garage/i)) out = out.filter(e => /garage/i.test(e.zone || ''));
  if (has(/driveway|drive way/i)) out = out.filter(e => /drive/i.test(e.zone || ''));

  // time ranges
  if (has(/yesterday/i)) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    const s = new Date(d); s.setHours(0, 0, 0, 0);
    const e2 = new Date(d); e2.setHours(23, 59, 59);
    out = out.filter(e => e.at >= s.getTime() && e.at <= e2.getTime());
  } else if (has(/this week|last 7 days|past week/i)) {
    out = out.filter(e => e.at >= Date.now() - 7 * 86400_000);
  } else if (has(/today/i)) {
    out = out.filter(e => e.at >= startOfDay(Date.now()));
  }

  const after = q.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const before = q.match(/before\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const between = q.match(/between\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:and|-|to)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  const hourOf = (m) => {
    let h = Number(m[1]); const min = Number(m[2] || 0);
    if (m[3]) { if (/pm/i.test(m[3]) && h < 12) h += 12; if (/am/i.test(m[3]) && h === 12) h = 0; }
    return h * 60 + min;
  };
  if (between) {
    const a = hourOf(between), b = hourOf([between[1], between[2], between[3], between[4], between[5], between[6]]);
    out = out.filter(e => { const m = new Date(e.at); const cur = m.getHours() * 60 + m.getMinutes(); return cur >= Math.min(a, b) && cur <= Math.max(a, b); });
  } else if (after) {
    const a = hourOf(after);
    out = out.filter(e => { const m = new Date(e.at); return m.getHours() * 60 + m.getMinutes() >= a; });
  } else if (before) {
    const b = hourOf(before);
    out = out.filter(e => { const m = new Date(e.at); return m.getHours() * 60 + m.getMinutes() <= b; });
  }

  // leftover keywords: fall back to substring over tag/zone/camera
  const leftover = terms.filter(t => !/^(a|an|the|at|on|in|after|before|between|and|to|near|by|of|for|with|show|me|anyone|who|did|come|came|this|last|past|what|all|any|today|yesterday|week|month|day|night|morning|evening|now)$/i.test(t));
  if (leftover.length) {
    for (const t of leftover) {
      if (/^\d{1,2}(:\d{2})?\s*(am|pm)?$/i.test(t)) continue; // handled above
      out = out.filter(e =>
        (e.tag || '').includes(t) || (e.zone || '').toLowerCase().includes(t) ||
        (e.cameraName || '').toLowerCase().includes(t));
    }
  }
  return out;
}

// wire helpers set by app.js
let openModal = null, closeModal = null, toast = null;
let notify = () => {};
export function _wireMonitorHelpers(_openModal, _closeModal, _toast, _notify) {
  openModal = _openModal; closeModal = _closeModal; toast = _toast; notify = _notify;
}
