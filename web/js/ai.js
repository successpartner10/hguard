// AI person/package detection (on-device, in the browser).
//
// Uses TensorFlow.js + COCO-SSD (MobileNet), loaded lazily from a CDN.
// If the model can't load (offline / blocked), the camera keeps working with
// plain motion detection and the UI says AI is unavailable — graceful degrade.
//
// Privacy: everything runs in the browser tab; no video ever leaves the device
// for inference. COCO classes we care about:
//   person -> "person" events
//   suitcase / backpack / handbag / cell phone -> "package" events (doorstep proxy)
import { notify } from './utils.js';

const PACKAGE_CLASSES = new Set(['suitcase', 'backpack', 'handbag', 'cell phone', 'book', 'tv']);

let tfPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('failed to load ' + src));
    document.head.appendChild(s);
  });
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout loading ' + what)), ms)),
  ]);
}

async function ensureTf() {
  if (tfPromise) return tfPromise;
  tfPromise = (async () => {
    await withTimeout(loadScript('https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js'), 20000, 'TensorFlow.js');
    await withTimeout(loadScript('https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js'), 20000, 'COCO-SSD');
    const model = await withTimeout(window.cocoSsd.load({ base: 'mobilenet_v2' }), 30000, 'COCO-SSD model weights');
    return model;
  })();
  return tfPromise;
}

export class AIDetector {
  constructor({ personConfidence = 0.55, packageConfidence = 0.5 } = {}) {
    this.model = null;
    this.loading = false;
    this.loaded = false;
    this.error = null;
    this.personConfidence = personConfidence;
    this.packageConfidence = packageConfidence;
    this.onStatus = null;
  }

  async load() {
    if (this.loaded) return this.model;
    if (this.loading) { while (this.loading) await new Promise(r => setTimeout(r, 150)); return this.model; }
    this.loading = true;
    try {
      this.model = await ensureTf();
      this.loaded = true;
      this.error = null;
    } catch (e) {
      console.warn('AI model failed to load:', e);
      this.error = 'AI model could not be downloaded. Check your internet connection. Motion detection still works.';
    } finally {
      this.loading = false;
      if (this.onStatus) this.onStatus(this.error ? 'error' : 'ready');
    }
    return this.model;
  }

  // Run detection on the processing canvas; returns [{class, score, box:[x,y,w,h] in canvas px}]
  async detect(canvas) {
    if (!this.model) return [];
    try {
      const preds = await this.model.detect(canvas);
      return preds.map(p => ({
        cls: p.class,
        score: p.score,
        box: p.bbox, // [x, y, w, h]
      }));
    } catch (e) {
      console.warn('detect failed:', e);
      return [];
    }
  }

  classify(detections, canvasW, canvasH) {
    let person = null, pkg = null;
    for (const d of detections) {
      if (d.cls === 'person') {
        if (d.score >= this.personConfidence && (!person || d.score > person.score)) person = d;
      } else if (PACKAGE_CLASSES.has(d.cls)) {
        if (d.score >= this.packageConfidence && (!pkg || d.score > pkg.score)) pkg = d;
      }
    }
    return { person, pkg };
  }
}

export { notify };
