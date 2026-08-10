// Frame-differencing motion engine.
// Works on a low-res processing canvas; reports a 0-100 activity score,
// a bounding box of the largest changed region, and zone hit-testing.
//
// Sensitivity maps to a pixel-diff threshold:
//   sensitivity 100 (max) -> threshold ~6   (catches almost everything)
//   sensitivity 1   (min) -> threshold ~34  (only big obvious changes)
export class MotionEngine {
  constructor({ width = 320, height = 180, sensitivity = 60 } = {}) {
    this.w = width; this.h = height;
    this.sensitivity = sensitivity;
    this.zones = [];               // normalized {x,y,w,h} (0..1)
    this.last = null;
    this.score = 0;                // 0..100 activity
    this.active = false;
    this.box = null;               // {x,y,w,h} in processing-canvas pixels
    this.sampleEvery = 2;          // process every Nth frame
    this._frame = 0;
    this.onFrame = null;           // called each analyzed frame with {score, active, box}
    this._ctx = null;
    if (typeof document !== 'undefined') {
      this.canvas = document.createElement('canvas');
      this.canvas.width = width; this.canvas.height = height;
      this._ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }
  }

  get threshold() {
    return Math.round(30 - (this.sensitivity / 100) * 24); // 30..6
  }

  setSensitivity(v) { this.sensitivity = v; }

  clear() { this.last = null; this.score = 0; this.active = false; this.box = null; }

  // Analyze one video frame. Pass the video element (or canvas).
  analyze(source) {
    this._frame++;
    if (this._frame % this.sampleEvery !== 0) return null;
    const ctx = this._ctx;
    ctx.drawImage(source, 0, 0, this.w, this.h);
    const cur = ctx.getImageData(0, 0, this.w, this.h).data;
    const prev = this.last;
    this.last = cur;

    if (!prev) { this.score = 0; return { score: 0, active: false }; }

    const th = this.threshold;
    const step = 8;                       // sample every 8th pixel for speed
    let diffCount = 0, total = 0;
    let minX = this.w, minY = this.h, maxX = 0, maxY = 0;

    for (let y = 0; y < this.h; y += step) {
      for (let x = 0; x < this.w; x += step) {
        const i = (y * this.w + x) * 4;
        const d = Math.abs(cur[i] - prev[i]) + Math.abs(cur[i + 1] - prev[i + 1]) + Math.abs(cur[i + 2] - prev[i + 2]);
        total++;
        if (d > th * 3) {  // per-pixel diff (sum of 3 channels)
          diffCount++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }

    const ratio = diffCount / total;
    this.score = Math.min(100, Math.round(ratio * 650));
    this.active = ratio > 0.010;

    if (this.active) {
      const pad = 8;
      this.box = {
        x: Math.max(0, minX - pad), y: Math.max(0, minY - pad),
        w: Math.min(this.w, maxX - minX + pad * 2), h: Math.min(this.h, maxY - minY + pad * 2),
      };
    } else {
      this.box = null;
    }

    if (this.onFrame) this.onFrame({ score: this.score, active: this.active, box: this.box });
    return { score: this.score, active: this.active, box: this.box };
  }

  // Is a point (normalized 0..1) inside any zone? Empty zones = anywhere.
  inZone(nx, ny) {
    if (!this.zones.length) return 'anywhere';
    for (const z of this.zones) {
      if (nx >= z.x && nx <= z.x + z.w && ny >= z.y && ny <= z.y + z.h) return z.name || 'zone';
    }
    return null;
  }

  // Box center test
  boxInZone(box) {
    if (!box) return null;
    const cx = (box.x + box.w / 2) / this.w;
    const cy = (box.y + box.h / 2) / this.h;
    return this.inZone(cx, cy);
  }
}
