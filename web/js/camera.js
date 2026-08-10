// Camera Mode — turns this device into a smart AI security camera.
//
// Pipeline: video → processing canvas → motion engine (+ optional on-device
// AI person/package detection) → event clips with pre-roll → server + Drive.
// Live streaming: WebRTC (device-to-device, never through the server).
import { $, el, store, uid, fmtTime, timeAgo, downloadDataUrl } from './utils.js';
import { net, apiUrl } from './net.js';
import { MotionEngine } from './motion.js';
import { AIDetector } from './ai.js';
import { Suppressor } from './learn.js';
import { ClipRecorder, saveClip, drainQueue, dataUrlToBlob } from './recorder.js';
import { DriveManager } from './drive.js';
import { getSettings, setSettings } from './settings.js';

const PROC_W = 640, PROC_H = 360;
const MIN_EVENT_GAP = 6000;      // min ms between events
const TAIL_MS = 2200;            // keep recording this long after motion stops
const MAX_EVENT_MS = 45000;      // hard cap per clip
const AI_SAMPLE_MS = 450;        // AI inference interval while motion is active

export class CameraMode {
  constructor() {
    this.settings = getSettings();
    this.identity = store.get('ahg.camera', null); // {id, token, name, createdAt}
    this.stream = null;
    this.procCanvas = document.createElement('canvas');
    this.procCanvas.width = PROC_W; this.procCanvas.height = PROC_H;
    this.procCtx = this.procCanvas.getContext('2d', { willReadFrequently: true });
    this.motion = new MotionEngine({ width: PROC_W, height: PROC_H, sensitivity: this.settings.sensitivity });
    this.ai = new AIDetector();
    this.suppressor = new Suppressor(this.identity?.id || 'camera');
    this.recorder = new ClipRecorder();
    this.drive = new DriveManager();
    this.pcs = new Map();            // sessId -> RTCPeerConnection
    this.armed = this.settings.armed;
    this.event = null;               // active event state
    this.lastEventAt = 0;
    this.viewers = 0;
    this.pendingEvents = [];         // offline queue (memory)
    this.localEvents = [];
    this.battery = null;
    this._loopTimer = null;
    this._aiTimer = null;
    this._tailTimer = null;
    this._demoT = 0;
    this._talking = false;
    this._listen = [];
  }

  // ------------------------------------------------------------- lifecycle
  async init() {
    const s = this.settings;
    this.suppressor.onChange = () => this.renderChips();

    // UI wiring
    $('#btn-camera-go').addEventListener('click', () => this.startSetup());
    $('#btn-camera-back').addEventListener('click', () => this.backToOnboarding());
    $('#btn-pair-monitor').addEventListener('click', () => this.showPairModal());
    $('#btn-cam-settings').addEventListener('click', () => this.showSettings());
    $('#armed-toggle').addEventListener('change', (e) => {
      this.setArmed(e.target.checked);
    });
    $('#sens-slider').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      setSettings({ sensitivity: v });
      this.settings = getSettings();
      this.motion.setSensitivity(v);
      $('#sens-value').textContent = v;
    });
    $('#btn-zones').addEventListener('click', () => this.toggleZoneEdit());
    $('#btn-night').addEventListener('click', () => {
      setSettings({ night: !this.settings.night });
      this.settings = getSettings();
      this.applyPreviewStyle();
      this.updateChipStates();
    });
    $('#btn-ai').addEventListener('click', () => {
      setSettings({ ai: !this.settings.ai });
      this.settings = getSettings();
      if (this.settings.ai) this.ensureAI();
      this.updateChipStates();
    });
    $('#btn-packages').addEventListener('click', () => {
      setSettings({ packages: !this.settings.packages });
      this.settings = getSettings();
      this.updateChipStates();
    });
    $('#btn-exit-zones').addEventListener('click', () => this.toggleZoneEdit(false));
    $('#btn-drive-connect').addEventListener('click', () => this.drive.signIn());
    window.addEventListener('beforeunload', () => {
      if (this.identity) net.send({ type: 'camera.bye', id: this.identity.id, token: this.identity.token });
    });

    // network events
    this._listen.push(net.on('open', () => this.onNetOpen()));
    // retry queued clip uploads periodically (not just on reconnect),
    // with exponential backoff so a flaky network doesn't cause a retry storm
    this._drainFailures = 0;
    const scheduleDrain = () => {
      const delay = Math.min(30000 * Math.pow(2, this._drainFailures), 300000);
      this._drainTimer = setTimeout(async () => {
        try {
          const left = await drainQueue(() => {});
          this._drainFailures = left > 0 ? this._drainFailures + 1 : 0;
        } catch { this._drainFailures++; }
        scheduleDrain();
      }, delay);
    };
    scheduleDrain();
    this._listen.push(net.on('signal', (m) => this.onSignal(m)));
    this._listen.push(net.on('monitor.watch', (m) => this.onWatch(m.sessId)));
    this._listen.push(net.on('monitor.unwatch', (m) => this.onUnwatch(m.sessId)));
    this._listen.push(net.on('monitor.snapshot', (m) => this.onSnapshotRequest(m.sessId)));
    this._listen.push(net.on('feedback', (m) => this.onFeedback(m)));
    this._listen.push(net.on('feedback.sync', (m) => {
      (m.items || []).forEach(fb => this.suppressor.applyFeedback(fb));
    }));
    this._listen.push(net.on('camera.status', (m) => {
      if (m.camera && m.camera.id === this.identity?.id) this.viewers = m.camera.viewers || 0;
      this.renderViewers();
    }));

    this.drive.onStatus = (st) => this.renderDriveStatus(st);
    this.ai.onStatus = () => this.renderChips();

    if (this.identity) this.enterDashboard();
    else $('#camera-setup').classList.remove('hidden');

    // if the socket is already open (init after connect), say hello now
    if (net.connected && this.identity) this.onNetOpen();

    // battery + network info
    this.monitorDevice();
  }

  startSetup() {
    const name = $('#camera-name-input').value.trim() || 'My Camera';
    net.call('camera.register', { name })
      .then(({ camera }) => {
        this.identity = { id: camera.id, token: camera.token, name: camera.name, code: camera.code, createdAt: Date.now() };
        store.set('ahg.camera', this.identity);
        this.suppressor = new Suppressor(this.identity.id);
        this.enterDashboard();
        toast('Camera registered. Pair a monitor to watch it.', 'success');
      })
      .catch(e => toast(e.message, 'error'));
  }

  backToOnboarding() {
    $('#camera-setup').classList.add('hidden');
    $('#view-camera').classList.add('hidden');
    $('#view-onboarding').classList.remove('hidden');
    app.mode = null;
  }

  async enterDashboard() {
    $('#camera-setup').classList.add('hidden');
    $('#camera-dash').classList.remove('hidden');
    $('#cam-title').textContent = this.identity.name;
    $('#camera-name-input') && ($('#camera-name-input').value = this.identity.name);
    this.armed = this.settings.armed;
    $('#armed-toggle').checked = this.armed;
    $('#armed-label').textContent = this.armed ? 'Armed' : 'Disarmed';
    $('#sens-slider').value = this.settings.sensitivity;
    $('#sens-value').textContent = this.settings.sensitivity;
    this.updateChipStates();
    await this.acquireStream();
    this.ensureAI();                 // non-blocking; degrades to motion-only if it fails
    this.suppressor.onChange = () => this.renderChips();
    this.recorder.setStream(this.makeRecordStream());
    this.recorder.start();
    this.startLoop();
  }

  // ------------------------------------------------------------- stream
  async acquireStream() {
    const s = this.settings;
    if (!s.demoSource) {
      try {
        const v = { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } };
        this.stream = await navigator.mediaDevices.getUserMedia({ video: v, audio: true });
        $('#cam-preview').srcObject = this.stream;
        $('#cam-no-signal').classList.add('hidden');
        await $('#cam-preview').play().catch(() => {});
        toast('Camera started');
        return;
      } catch (e) {
        console.warn('getUserMedia failed:', e);
        if (e && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')) {
          toast('Camera permission denied. Allow camera access, or use Demo mode in Settings.', 'warn');
        } else {
          toast('No camera found — using Demo mode (Settings → Demo source).', 'warn');
          setSettings({ demoSource: true });
          s.demoSource = true;
        }
      }
    }
    // demo mode: synthetic moving scene (perfect for testing pairing on one machine)
    this.demoCanvas = $('#demo-view');
    this.demoCanvas.classList.remove('hidden');
    $('#cam-preview').classList.add('hidden');
    const ctx = this.demoCanvas.getContext('2d');
    ctx.fillStyle = '#23272E'; ctx.fillRect(0, 0, PROC_W, PROC_H);
    $('#cam-no-signal').classList.add('hidden');
    this._demoCtx = ctx;
    // a real MediaStream (canvas capture) so WebRTC live view still works in demo mode
    this.stream = this.demoCanvas.captureStream(30);
    toast('Demo camera active — synthetic scene, no real camera.', 'info');
  }

  makeRecordStream() {
    const cstream = this.procCanvas.captureStream(30);
    // add mic audio if available
    const mic = this.stream && this.stream.getAudioTracks()[0];
    if (mic) cstream.addTrack(mic);
    return cstream;
  }

  applyPreviewStyle() {
    const style = this.settings.night
      ? 'brightness(.72) contrast(1.35) saturate(.85)'
      : '';
    $('#cam-preview').style.filter = style;
  }

  // ------------------------------------------------------------- main loop
  // Driven by setInterval, NOT requestAnimationFrame: browsers throttle rAF
  // in background tabs (a phone camera tab behind other apps would otherwise
  // stop detecting). Timers are only clamped to ~1s in the background, which
  // is plenty for motion analysis.
  startLoop() {
    if (this._loopTimer) clearInterval(this._loopTimer);
    this._loopTimer = setInterval(() => this.frame(), 80); // ~12 fps processing
  }

  frame() {
    const ctx = this.procCtx;
    if (this.demoCanvas) {
      this.stepDemo();
      ctx.drawImage(this.demoCanvas, 0, 0, PROC_W, PROC_H);
    } else if (this.stream && this.stream.getVideoTracks().length) {
      ctx.filter = this.settings.night ? 'brightness(.72) contrast(1.35) saturate(.85)' : 'none';
      ctx.drawImage($('#cam-preview'), 0, 0, PROC_W, PROC_H);
      ctx.filter = 'none';
    } else {
      return;
    }
    this.motion.zones = this.settings.zones;
    const r = this.motion.analyze(this.procCanvas);
    if (r) this.onMotionFrame(r);
    this.drawOverlay();
  }

  // Synthetic scene: a wandering "person" blob + occasional parcel + camera noise
  stepDemo() {
    const ctx = this._demoCtx;
    const t = performance.now();
    this._demoT = this._demoT || t;
    const dt = (t - this._demoT) / 1000; this._demoT = t;
    // slow time-of-day brightness drift so motion detection has contrast
    const base = 30 + 14 * Math.sin(t / 9000);
    ctx.fillStyle = `rgb(${base + 8},${base + 10},${base + 14})`;
    ctx.fillRect(0, 0, PROC_W, PROC_H);
    // floor line
    ctx.strokeStyle = `rgb(${base + 20},${base + 22},${base + 26})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, PROC_H * 0.72); ctx.lineTo(PROC_W, PROC_H * 0.72); ctx.stroke();

    const moving = (Math.floor(t / 8000) % 3) !== 2;   // pause every 3rd cycle
    if (moving) {
      const px = (t / 95) % (PROC_W + 160) - 80;
      const py = PROC_H * 0.50 + Math.sin(t / 300) * 8;
      // "person": head + body
      ctx.fillStyle = '#E8C39E';
      ctx.beginPath(); ctx.arc(px, py - 40, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3D4A5A';
      ctx.fillRect(px - 22, py - 22, 44, 62);
      // shadow
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.beginPath(); ctx.ellipse(px, py + 48, 26, 7, 0, 0, Math.PI * 2); ctx.fill();
      // occasionally a "package"
      if ((Math.floor(t / 12000) % 4) === 1) {
        ctx.fillStyle = '#8B5E34';
        ctx.fillRect(px + 70, py + 8, 44, 34);
        ctx.strokeStyle = '#5E3D1F'; ctx.lineWidth = 2;
        ctx.strokeRect(px + 70, py + 8, 44, 34);
      }
      // a small "pet" that darts around
      if ((Math.floor(t / 4000) % 5) !== 4) {
        const qx = (t / 55) % PROC_W, qy = PROC_H * 0.68 + Math.sin(t / 210) * 14;
        ctx.fillStyle = '#6B4F2E';
        ctx.beginPath(); ctx.ellipse(qx, qy, 20, 12, 0, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(qx - 16, qy - 12, 7, 0, Math.PI * 2); ctx.fill();
      }
      // a "car" drifting across the floor
      const cx = (t / 45) % (PROC_W + 140) - 70;
      ctx.fillStyle = '#B23A48';
      ctx.fillRect(cx, PROC_H * 0.74, 56, 22);
      ctx.fillStyle = '#8E2E3A';
      ctx.beginPath(); ctx.arc(cx + 12, PROC_H * 0.74 + 22, 7, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx + 44, PROC_H * 0.74 + 22, 7, 0, Math.PI * 2); ctx.fill();
    }
    // subtle noise so diff engine has texture
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = `rgba(255,255,255,${Math.random() * .035})`;
      ctx.fillRect(Math.random() * PROC_W, Math.random() * PROC_H, 3, 3);
    }
    // timestamp so video looks alive
    ctx.fillStyle = 'rgba(255,255,255,.75)';
    ctx.font = '13px monospace';
    ctx.fillText('DEMO ' + new Date().toLocaleTimeString(), 10, 20);
  }

  // ------------------------------------------------------------- motion/events
  onMotionFrame(r) {
    const meter = $('#motion-bar');
    if (meter) meter.style.width = Math.max(2, r.score) + '%';

    // hard cap: never let one event run forever (continuous motion)
    if (this.event && Date.now() - this.event.startedAt >= MAX_EVENT_MS) {
      this.finalizeEvent();
    }

    if (!this.armed || !r.active) {
      if (this.event && !this.event.tailing) this.scheduleTail();
      return;
    }
    if (!this.event && Date.now() - this.lastEventAt < MIN_EVENT_GAP) return;

    const zone = this.motion.boxInZone(r.box);
    if (!zone) return;

    const triggerLevel = Math.round(32 - this.settings.sensitivity * 0.26);
    if (r.score < triggerLevel) return;

    if (!this.event) {
      this.beginEvent(r, zone);
    } else {
      // update energy / box
      this.event.energy = Math.max(this.event.energy || 0, r.score);
      this.event.lastActive = Date.now();
      // motion resumed — cancel the pending tail and allow re-arming it
      if (this.event.tailTimer) { clearTimeout(this.event.tailTimer); this.event.tailTimer = null; }
      this.event.tailing = false;
    }
    if (r.active) this.flashOnce();
  }

  flashOnce() {
    const f = $('#motion-flash');
    if (!f) return;
    f.style.opacity = '1';
    clearTimeout(this._flashT);
    this._flashT = setTimeout(() => { f.style.opacity = '0'; }, 280);
  }

  scheduleTail() {
    if (!this.event || this.event.tailing) return;
    this.event.tailing = true;
    clearTimeout(this.event.tailTimer);
    this.event.tailTimer = setTimeout(() => this.finalizeEvent(), TAIL_MS);
  }

  beginEvent(r, zone) {
    const ev = {
      id: uid(),
      at: Date.now(),
      tag: null,
      zone,
      energy: r.score,
      box: r.box,
      collector: this.recorder.beginEvent(),
      startedAt: Date.now(),
      lastActive: Date.now(),
      tailing: false,
      conf: null,
      aiTagged: false,
    };
    this.event = ev;
    $('#rec-badge').classList.remove('hidden');
    this.showEventToast('Detecting…');
    if (this.settings.ai && this.ai.loaded) {
      clearInterval(this._aiTimer);
      this._aiTimer = setInterval(() => this.aiSample(), AI_SAMPLE_MS);
    }
    if (this.settings.ai && !this.ai.loaded && !this.ai.loading) this.ensureAI();
  }

  async aiSample() {
    if (!this.event || !this.settings.ai) return;
    if (this.event.aiTagged) return;
    const dets = await this.ai.detect(this.procCanvas);
    const { person, pkg } = this.ai.classify(dets, PROC_W, PROC_H);
    if (person) {
      this.event.tag = 'person';
      this.event.conf = person.score;
      this.event.aiTagged = true;
      this.event.box = person.box;
      this.drawOverlay();
      this.showEventToast('Person detected');
    } else if (pkg && this.settings.packages) {
      this.event.tag = 'package';
      this.event.conf = pkg.score;
      this.event.aiTagged = true;
      this.event.box = pkg.box;
      this.drawOverlay();
      this.showEventToast('Package detected');
    }
  }

  showEventToast(text) {
    const t = $('#event-toast');
    t.textContent = text;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 1800);
  }

  async finalizeEvent() {
    const ev = this.event;
    if (!ev) return;
    this.event = null;
    clearInterval(this._aiTimer);
    clearTimeout(ev.tailTimer);
    $('#rec-badge').classList.add('hidden');

    const dur = (Date.now() - ev.startedAt) / 1000;
    const tag = ev.tag || 'motion';
    const conf = ev.conf;
    // false-alarm learning: quietly drop recurring non-events
    if (this.suppressor.shouldSuppress({ tag, zone: ev.zone, at: ev.at, energy: ev.energy })) {
      this.suppressor.suppressedCount++;
      this.renderChips();
      toast('Suppressed a recurring false alarm 🙂', 'info');
      return;
    }

    // assemble clip
    let blob = null;
    try { blob = ev.collector.finish(); } catch (e) { console.warn('clip assembly failed:', e); }
    if (!blob || blob.size < 4096) { this.renderChips(); return; } // too short to matter

    // thumbnail
    let thumbDataUrl = null;
    try {
      const t = document.createElement('canvas');
      t.width = 320; t.height = 180;
      t.getContext('2d').drawImage(this.procCanvas, 0, 0, 320, 180);
      thumbDataUrl = t.toDataURL('image/jpeg', 0.6);
    } catch { /* noop */ }

    const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
    const name = `${new Date(ev.at).toTimeString().slice(0, 8).replace(/:/g, '-')}_${tag}.${ext}`;

    // persist (server with offline queue fallback; Drive if connected)
    const res = await saveClip({
      cameraId: this.identity.id, eventId: ev.id, name, blob, thumbDataUrl,
      tag, conf: conf || null, zone: ev.zone, dur, at: ev.at,
    });
    if (res.queued) toast('Offline — clip queued, will upload when connected', 'warn');

    if (this.drive.signedIn) {
      this.drive.uploadClip({
        cameraName: this.identity.name, tag, conf, zone: ev.zone, dur, at: ev.at,
        blob, fileName: name,
      }).then(() => {
        this.drive.runRetention(this.identity.name).catch(() => {});
        this.renderDriveStatus({ ok: true, lastUpload: Date.now() });
      }).catch((e) => {
        console.warn('drive upload failed:', e);
        this.renderDriveStatus({ ok: false, error: e.message });
      });
    }

    // broadcast event to monitors
    const evMsg = { id: ev.id, tag, at: ev.at, dur, conf, zone: ev.zone, suppressed: false };
    if (net.connected) net.send({ type: 'camera.event', id: this.identity.id, token: this.identity.token, event: evMsg });
    else this.pendingEvents.push(evMsg);

    this.localEvents.unshift({
      id: ev.id, tag, at: ev.at, dur, conf, zone: ev.zone, thumb: thumbDataUrl,
    });
    this.localEvents = this.localEvents.slice(0, 30);
    this.renderLocalEvents();
    this.renderChips();
    this.lastEventAt = Date.now();
  }

  // ------------------------------------------------------------- networking
  async onNetOpen() {
    if (!this.identity) return;
    try {
      await net.call('camera.hello', { id: this.identity.id, token: this.identity.token, armed: this.armed });
      // flush queued events
      while (this.pendingEvents.length) {
        net.send({ type: 'camera.event', id: this.identity.id, token: this.identity.token, event: this.pendingEvents.shift() });
      }
      // drain offline clip queue
      drainQueue(() => toast('Uploaded queued clips', 'success')).then((left) => {
        if (!left) toast('Back online — everything synced', 'success');
      }).catch(() => {});
    } catch (e) {
      console.warn('camera hello failed:', e.message);
    }
  }

  async onWatch(sessId) {
    if (this.pcs.has(sessId)) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    this.pcs.set(sessId, pc);
    if (this.stream) this.stream.getTracks().forEach(t => { try { pc.addTrack(t, this.stream); } catch { /* noop */ } });
    pc.onicecandidate = (e) => {
      if (e.candidate) net.send({ type: 'camera.signal', id: this.identity.id, token: this.identity.token, sessId, data: { ice: e.candidate } });
    };
    pc.ontrack = (e) => {
      // monitor's microphone (two-way audio / walkie-talkie)
      if (e.track.kind === 'audio' && e.streams[0]) {
        this._talking = true;
        this.renderChips();
        if (!this._talkAudio) {
          this._talkAudio = document.createElement('audio');
          this._talkAudio.autoplay = true;
          this._talkAudio.setAttribute('playsinline', '');
          document.body.appendChild(this._talkAudio);
        }
        this._talkAudio.srcObject = e.streams[0];
        this._talkAudio.muted = this.settings.talkMuted;
        this._talkAudio.play().catch(() => {});
        e.track.onended = () => { this._talking = false; this.renderChips(); };
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this.pcs.delete(sessId);
      }
    };
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      net.send({ type: 'camera.signal', id: this.identity.id, token: this.identity.token, sessId, data: { offer: pc.localDescription } });
    } catch (e) { console.warn('offer failed:', e); }
  }

  onUnwatch(sessId) {
    const pc = this.pcs.get(sessId);
    if (pc) { try { pc.close(); } catch { /* noop */ } this.pcs.delete(sessId); }
  }

  async onSignal(m) {
    const pc = this.pcs.get(m.sessId);
    if (!pc) return;
    try {
      if (m.data && m.data.offer) {
        // monitor-initiated renegotiation (e.g. Talk button)
        await pc.setRemoteDescription(m.data.offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        net.send({ type: 'camera.signal', id: this.identity.id, token: this.identity.token, sessId: m.sessId, data: { answer: pc.localDescription } });
      } else if (m.data && m.data.answer) {
        await pc.setRemoteDescription(m.data.answer);
      } else if (m.data && m.data.ice) {
        await pc.addIceCandidate(m.data.ice);
      }
    } catch (e) { console.warn('signal error:', e); }
  }

  onSnapshotRequest(sessId) {
    let dataUrl = null;
    try {
      const t = document.createElement('canvas');
      t.width = PROC_W; t.height = PROC_H;
      t.getContext('2d').drawImage(this.procCanvas, 0, 0, PROC_W, PROC_H);
      dataUrl = t.toDataURL('image/jpeg', 0.82);
    } catch { /* noop */ }
    if (dataUrl) net.send({ type: 'camera.snapshot', id: this.identity.id, token: this.identity.token, sessId, dataUrl });
  }

  onFeedback(m) {
    // find local event record to learn from
    const ev = this.localEvents.find(e => e.id === m.eventId);
    if (ev) {
      this.suppressor.applyFeedback({ eventId: m.eventId, value: m.value, at: ev.at, tag: ev.tag, zone: ev.zone, energy: ev.energy });
      if (m.value === 'down') toast('Thanks! Similar events will be suppressed from now on.', 'info');
    }
  }

  setArmed(v) {
    this.armed = v;
    setSettings({ armed: v });
    $('#armed-label').textContent = v ? 'Armed' : 'Disarmed';
    if (v) { this.recorder.start(); this.motion.clear(); }
    else { this.recorder.stop(); this.motion.clear(); }
    if (net.connected && this.identity) {
      net.send({ type: 'camera.heartbeat', id: this.identity.id, token: this.identity.token, armed: v });
    }
    this.renderChips();
  }

  monitorDevice() {
    if (navigator.getBattery) {
      navigator.getBattery().then((b) => {
        this.battery = b;
        const upd = () => this.renderChips();
        b.addEventListener('levelchange', upd);
        b.addEventListener('chargingchange', upd);
      }).catch(() => {});
    }
    setInterval(() => {
      if (!net.connected || !this.identity) return;
      net.send({
        type: 'camera.heartbeat',
        id: this.identity.id, token: this.identity.token, armed: this.armed,
        battery: this.battery ? Math.round(this.battery.level * 100) : null,
        charging: this.battery ? this.battery.charging : null,
        signal: (navigator.connection && navigator.connection.downlink) ? navigator.connection.downlink : null,
        device: `${navigator.platform || ''} ${navigator.userAgent.includes('Mobile') ? 'mobile' : 'desktop'}`.trim(),
      });
    }, 5000);
  }

  // ------------------------------------------------------------- AI
  async ensureAI() {
    if (!this.settings.ai) return;
    if (!this.ai.loaded && !this.ai.loading) {
      await this.ai.load();
      this.renderChips();
    }
  }

  // ------------------------------------------------------------- zones
  toggleZoneEdit(force) {
    const wrap = $('.preview-wrap');
    const editing = force !== undefined ? force : !wrap.classList.contains('zone-editing');
    wrap.classList.toggle('zone-editing', editing);
    $('#zone-hint').classList.toggle('hidden', !editing);
    $('#btn-exit-zones').classList.toggle('hidden', !editing);
    $('#btn-zones').classList.toggle('active', editing);
    if (editing) {
      const ov = $('#cam-overlay');
      const rect = ov.getBoundingClientRect();
      let start = null, cur = null;
      const down = (e) => {
        e.preventDefault();
        const p = e.touches ? e.touches[0] : e;
        start = { x: p.clientX - rect.left, y: p.clientY - rect.top };
        cur = { ...start };
        this._zoneDrag = { start, cur };
        this.drawOverlay();
      };
      const move = (e) => {
        if (!start) return;
        e.preventDefault();
        const p = e.touches ? e.touches[0] : e;
        cur = { x: p.clientX - rect.left, y: p.clientY - rect.top };
        this._zoneDrag = { start, cur };
        this.drawOverlay();
      };
      const up = () => {
        if (!start || !cur) return;
        const x1 = Math.min(start.x, cur.x) / rect.width;
        const y1 = Math.min(start.y, cur.y) / rect.height;
        const x2 = Math.max(start.x, cur.x) / rect.width;
        const y2 = Math.max(start.y, cur.y) / rect.height;
        if (x2 - x1 > 0.03 && y2 - y1 > 0.03) {
          const zones = this.settings.zones.slice();
          zones.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1, name: `zone ${zones.length + 1}` });
          setSettings({ zones });
          this.settings = getSettings();
          toast('Zone added. Only motion inside zones will trigger events.', 'success');
        }
        start = null; cur = null; this._zoneDrag = null;
        this.drawOverlay();
      };
      ov.addEventListener('pointerdown', down);
      ov.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      this._zoneHandlers = [ov, down, move, up];
    } else {
      const [ov, down, move, up] = this._zoneHandlers || [];
      if (ov) { ov.removeEventListener('pointerdown', down); ov.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
    }
    this.drawOverlay();
  }

  drawOverlay() {
    const ov = $('#cam-overlay');
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    // zones
    for (const z of this.settings.zones) {
      ctx.strokeStyle = 'rgba(14,159,140,.95)';
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.strokeRect(z.x * ov.width, z.y * ov.height, z.w * ov.width, z.h * ov.height);
      ctx.fillStyle = 'rgba(14,159,140,.12)';
      ctx.fillRect(z.x * ov.width, z.y * ov.height, z.w * ov.width, z.h * ov.height);
      ctx.setLineDash([]);
      ctx.fillStyle = '#0B7F70';
      ctx.font = 'bold 13px sans-serif';
      ctx.fillText(z.name || 'zone', z.x * ov.width + 6, z.y * ov.height + 16);
    }
    if (this._zoneDrag) {
      const { start, cur } = this._zoneDrag;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(Math.min(start.x, cur.x), Math.min(start.y, cur.y), Math.abs(cur.x - start.x), Math.abs(cur.y - start.y));
      ctx.setLineDash([]);
    }
    // live motion/AI box
    if (this.event && this.event.box) {
      const b = this.event.box;
      const kx = ov.width / PROC_W, ky = ov.height / PROC_H;
      ctx.strokeStyle = this.event.tag === 'person' ? '#FFB020' : this.event.tag === 'package' ? '#7C5CFF' : 'rgba(255,255,255,.8)';
      ctx.lineWidth = 2.5;
      ctx.strokeRect(b.x * kx, b.y * ky, b.w * kx, b.h * ky);
      if (this.event.tag) {
        ctx.fillStyle = ctx.strokeStyle;
        const label = this.event.tag === 'person' ? `PERSON ${Math.round((this.event.conf || 0) * 100)}%` : this.event.tag === 'package' ? `PACKAGE ${Math.round((this.event.conf || 0) * 100)}%` : 'MOTION';
        ctx.font = 'bold 12px sans-serif';
        const tw = ctx.measureText(label).width;
        ctx.fillRect(b.x * kx, Math.max(0, b.y * ky - 18), tw + 10, 18);
        ctx.fillStyle = '#0C0F13';
        ctx.fillText(label, b.x * kx + 5, Math.max(0, b.y * ky - 18) + 13);
      }
    }
    function startXOf(d) { return drag._sx; }
    function startYOf(d) { return drag._sy; }
  }

  // ------------------------------------------------------------- UI
  updateChipStates() {
    $('#btn-night').classList.toggle('active', !!this.settings.night);
    $('#btn-ai').classList.toggle('active', !!this.settings.ai);
    $('#btn-packages').classList.toggle('hidden', !this.settings.ai);
    $('#btn-packages').classList.toggle('active', !!this.settings.packages);
    this.applyPreviewStyle();
    this.renderChips();
  }

  renderChips() {
    const box = $('#cam-chips');
    if (!box) return;
    const chips = [];
    const armed = this.armed;
    chips.push(`<span class="chip ${armed ? 'armed' : 'offline'}"><span class="dot"></span>${armed ? 'Armed' : 'Disarmed'}</span>`);
    if (this.battery != null) {
      chips.push(`<span class="chip ${this.battery.level < 0.2 && !this.battery.charging ? 'battery-low' : ''}">🔋 ${Math.round(this.battery.level * 100)}%${this.battery.charging ? ' ⚡' : ''}</span>`);
      if (this.battery.level < 0.2 && !this.battery.charging) {
        toast('Camera battery is low — plug it in for continuous use.', 'warn');
      }
    }
    if (this.settings.demoSource) chips.push('<span class="chip">🧪 Demo source</span>');
    if (this.settings.ai) {
      chips.push(this.ai.loaded
        ? '<span class="chip online"><span class="dot"></span>AI on-device</span>'
        : this.ai.error
          ? `<span class="chip offline" title="${this.ai.error}">AI unavailable</span>`
          : '<span class="chip">AI loading…</span>');
    }
    if (this.settings.packages) chips.push('<span class="chip">📦 packages</span>');
    if (this.settings.zones.length) chips.push(`<span class="chip">▣ ${this.settings.zones.length} zone${this.settings.zones.length > 1 ? 's' : ''}</span>`);
    if (this.settings.night) chips.push('<span class="chip">🌙 night</span>');
    if (this._talking) chips.push('<span class="chip online"><span class="dot"></span>talk active</span>');
    if (this.suppressor.suppressedCount) chips.push(`<span class="chip offline">🤫 ${this.suppressor.suppressedCount} suppressed</span>`);
    if (this.viewers) chips.push(`<span class="chip online"><span class="dot"></span>${this.viewers} watching</span>`);
    box.innerHTML = chips.join('');
  }

  renderViewers() {
    const box = $('#viewers-list');
    if (box) box.textContent = this.viewers ? `${this.viewers} viewer${this.viewers > 1 ? 's' : ''} connected right now.` : 'No one is watching right now.';
  }

  renderLocalEvents() {
    const box = $('#cam-events');
    if (!box) return;
    if (!this.localEvents.length) {
      box.innerHTML = '<p class="muted small">Nothing yet. Detection events will appear here.</p>';
      return;
    }
    box.innerHTML = this.localEvents.map(e => `
      <div class="cam-event">
        <img src="${e.thumb || ''}" alt="">
        <div class="ev-body">
          <div class="ev-title">${e.tag === 'person' ? '👤 Person' : e.tag === 'package' ? '📦 Package' : 'Motion'} · ${e.zone || 'anywhere'}${e.conf ? ` · ${Math.round(e.conf * 100)}%` : ''}</div>
          <div class="ev-time">${fmtTime(e.at)} · ${Math.round(e.dur)}s</div>
        </div>
      </div>`).join('');
  }

  renderDriveStatus(st) {
    const box = $('#drive-status');
    const btn = $('#btn-drive-connect');
    const quota = $('#drive-quota');
    if (!box) return;
    if (st && st.signedOut) {
      box.textContent = 'Not connected. Sign in to store clips in your own Google Drive.';
      box.className = 'drive-status';
      btn.classList.remove('hidden');
      quota.hidden = true;
      return;
    }
    if (st && st.ok && st.user) {
      box.textContent = `Connected as ${st.user.emailAddress || st.user.displayName || 'you'}. Clips go to “AI Home Guard” in your Drive.`;
      box.className = 'drive-status connected';
      btn.classList.add('hidden');
      if (st.quota) {
        const used = st.quota.usage, lim = st.quota.limit;
        const pct = lim ? Math.min(100, used / lim * 100) : 0;
        quota.hidden = false;
        quota.innerHTML = `<b>${fmtBytes(used)}</b> of ${lim ? fmtBytes(lim) : '?'} used` +
          `<div class="quota-bar ${pct > 90 ? 'full' : pct > 70 ? 'warn' : ''}"><div class="quota-fill" style="width:${pct}%"></div></div>` +
          (pct > 85 ? '<p class="small" style="color:var(--warn)">Drive is nearly full — consider trimming retention.</p>' : '');
      }
      return;
    }
    if (st && st.ok && st.lastUpload) {
      box.textContent = 'Last clip uploaded to Drive ✓';
      box.className = 'drive-status connected';
      return;
    }
    if (st && !st.ok && st.error) {
      box.textContent = `Drive error: ${st.error}`;
      box.className = 'drive-status';
      return;
    }
    box.textContent = 'Not connected. Add your Google account in Settings to store clips in your own Drive.';
    box.className = 'drive-status';
    btn.classList.toggle('hidden', !this.drive.clientId);
    quota.hidden = true;
  }

  async showPairModal() {
    let cam = this.identity;
    if (!cam) return;
    // code may be missing on old installs — recover it from the server
    if (!cam.code) {
      try {
        const r = await fetch(apiUrl(`/api/code?id=${encodeURIComponent(cam.id)}&token=${encodeURIComponent(cam.token)}`)).then(x => x.json());
        if (r.code) { cam = { ...cam, code: r.code }; this.identity = cam; store.set('ahg.camera', cam); }
      } catch { /* offline */ }
    }
    if (!cam.code) { toast('Pairing code unavailable while offline.', 'warn'); return; }
    const body = el('div', {},
      el('p', { class: 'muted small', text: 'On the monitor device, open Monitor mode → “Add a camera” and scan this code (or type it). No IP addresses, no port forwarding — pairing happens over your Wi-Fi.' }),
      el('div', { class: 'pair-grid' },
        el('div', { class: 'pair-qr' },
          el('img', { src: apiUrl(`/api/qr?code=${encodeURIComponent(cam.code)}`), alt: 'Pairing QR code', width: 190, height: 190 }),
          el('div', { class: 'pair-code', text: cam.code }),
        ),
        el('div', { class: 'pair-info', style: 'display:flex;flex-direction:column;justify-content:center;gap:10px' },
          el('p', { class: 'small muted', text: 'This code expires when the app restarts. Anyone with the code can watch this camera.' }),
          el('button', {
            class: 'btn btn-secondary btn-small', text: 'Copy code',
            onclick: () => { navigator.clipboard && navigator.clipboard.writeText(cam.code).then(() => toast('Code copied', 'success')); },
          }),
        ),
      ),
    );
    openModal('Pair a monitor', body, []);
  }

  showSettings() {
    openSettingsModal({ save: (s) => {
      setSettings(s);
      this.settings = getSettings();
      this.applyPreviewStyle();
      this.updateChipStates();
      if (s.demoSource !== this.settings.demoSource || true) {
        // demo source changes require stream re-acquire; do it lazily on next start
      }
      toast('Settings saved', 'success');
    } });
  }
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

// ---------------------------------------------------------------------------
// modal + toast helpers live in app.js; import them lazily to avoid cycles.
let openModal = null, openSettingsModal = null, toast = null;
export function _wireUiHelpers(_openModal, _openSettingsModal, _toast) {
  openModal = _openModal; openSettingsModal = _openSettingsModal; toast = _toast;
}
