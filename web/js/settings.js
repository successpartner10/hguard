// Settings store (single source of truth for persisted preferences)
import { store } from './utils.js';

export const DEFAULTS = {
  sensitivity: 60,      // 1..100
  zones: [],            // [{x,y,w,h,name}] normalized
  night: false,
  ai: true,             // AI person detection
  packages: false,      // also detect packages
  driveClientId: '',    // Google OAuth web client ID
  retention: 0,         // 0 = keep forever, else days
  serverUrl: '',        // '' = same origin
  demoSource: false,    // synthetic camera for testing without hardware
  armed: true,
};

export function getSettings() {
  return { ...DEFAULTS, ...store.get('ahg.settings', {}) };
}

export function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  store.set('ahg.settings', s);
  return s;
}
