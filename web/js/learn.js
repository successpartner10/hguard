// False-alarm learning — the "quiet suppression" system.
//
// When a monitor thumbs-down an event, the camera records a *signature*:
//   { tag, zone, hour (2h bucket), energy bucket, weekday }
// Future events matching a signature are quietly suppressed: no event is
// created, no notification fires — just a suppressed counter. Thumbs-up
// clears matching signatures. All learning is local to the camera device.
import { store } from './utils.js';

const KEY = 'ahg.suppress';

export class Suppressor {
  constructor(cameraId) {
    this.cameraId = cameraId;
    this.signatures = store.get(KEY, []);
    this.suppressedCount = 0;
    this.onChange = null;
    this._pendingFeedback = [];
  }

  _save() { store.set(KEY, this.signatures.filter(s => s.cameraId === this.cameraId)); }

  // Decide if an event should be suppressed. `ev` = {tag, zone, at, energy}
  shouldSuppress(ev) {
    const hour = new Date(ev.at).getHours();
    const hb = Math.floor(hour / 2) * 2;
    const wd = new Date(ev.at).getDay();
    const eb = ev.energy != null ? Math.round(ev.energy / 20) * 20 : null;
    for (const s of this.signatures) {
      if (s.cameraId !== this.cameraId) continue;
      if (s.tag !== ev.tag) continue;
      if (s.zone !== ev.zone) continue;
      if (Math.abs(s.hour - hb) > 2) continue;   // within ±4h of learned time
      if (s.weekday !== null && s.weekday !== wd) continue;
      if (eb !== null && s.energy !== null && Math.abs(s.energy - eb) > 20) continue;
      return true;
    }
    return false;
  }

  // Called when the monitor thumbs-down an event (directly, or synced later
  // via feedback.sync from the server while we were offline).
  addNegative(event) {
    this.signatures.push({
      cameraId: this.cameraId,
      tag: event.tag,
      zone: event.zone,
      hour: Math.floor(new Date(event.at).getHours() / 2) * 2,
      weekday: new Date(event.at).getDay(),
      energy: event.energy != null ? Math.round(event.energy / 20) * 20 : null,
      at: Date.now(),
    });
    this._save();
    if (this.onChange) this.onChange();
  }

  addPositive(event) {
    const hour = Math.floor(new Date(event.at).getHours() / 2) * 2;
    const wd = new Date(event.at).getDay();
    this.signatures = this.signatures.filter(s =>
      !(s.cameraId === this.cameraId && s.tag === event.tag && s.zone === event.zone &&
        Math.abs(s.hour - hour) <= 2 && s.weekday === wd));
    this._save();
    if (this.onChange) this.onChange();
  }

  applyFeedback(fb) {
    // fb = {eventId, value, at, tag, zone, energy} — from server sync
    this._pendingFeedback = this._pendingFeedback.filter(f => f.eventId !== fb.eventId);
    const ev = { tag: fb.tag, zone: fb.zone, at: fb.at, energy: fb.energy };
    if (fb.value === 'down') this.addNegative(ev);
    else this.addPositive(ev);
  }

  reset() {
    this.signatures = this.signatures.filter(s => s.cameraId !== this.cameraId);
    this._save();
    if (this.onChange) this.onChange();
  }
}
