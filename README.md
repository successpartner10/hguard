# AI Home Guard

Turn any spare phone, tablet, or laptop webcam into a smart, AI-powered security camera.
A second device (or web browser) becomes the **Viewer/Monitor**. Footage and events are
stored in **your own Google Drive** — no vendor lock-in, no unknown third-party cloud, no
subscription to keep old clips.

> **Current build status (2026-08-10):** everything works on two backends.
> 1. **Local Node server** (`server/`) — zero-cloud, runs anywhere with Node 18+.
> 2. **Cloudflare Workers + Durable Objects** (`worker/`) — Phase 6 code complete and
>    validated against the local Cloudflare emulator (`wrangler dev`): all 28 protocol
>    checks + 24 browser E2E checks pass, DO persistence confirmed across restarts.
>    Deployment to production is one command (see Part 2, Step 1c).

---

## Part 1 — Product & Technical Requirements

### 1. Product Vision

Any device with a browser can be a Camera. Any other device can be the Monitor.
Two roles, one app:

1. **Camera Mode** — turns a device into a streaming security camera.
2. **Monitor Mode** — turns a device into the dashboard to watch, review, and manage all cameras.

### 2. Core Feature Set

Legend: ✅ built · 🟡 in progress · 🔲 planned

#### 2.1 Camera Mode

| Feature | Status | Notes |
|---|---|---|
| Live capture (front/back camera, mic) | ✅ | `getUserMedia`; falls back to a synthetic **Demo source** when no camera/permission (great for testing) |
| Continuous local preview | ✅ | Plus a processing canvas for detection overlays |
| On-demand remote streaming (WebRTC) | ✅ | Device-to-device; the server only relays signaling, never video |
| Person detection (on-device AI) | ✅ | TensorFlow.js + COCO-SSD in the browser tab; nothing leaves the device for inference. Model downloads from CDN on first use; **gracefully degrades to motion-only when offline** |
| Package/parcel detection | ✅ | COCO classes suitcase/backpack/handbag/cell phone/… used as a doorstep proxy |
| Detection zones (draw a box) | ✅ | Draw rectangles on the preview; only motion inside them triggers events |
| Sensitivity slider + live preview | ✅ | 1–100; live motion meter shows what will/won't trigger |
| Night mode | ✅ | Low-light enhancement (brightness/contrast on preview + clips) |
| Two-way audio (walkie-talkie) | ✅ | Hold **Talk** on the monitor; monitor's mic plays through the camera's speaker (use headphones when testing on one machine) |
| Scheduling (arm/disarm by time / Wi-Fi) | 🔲 | Manual arm/disarm today |
| Auto-upload of AI event clips | ✅ | Short clips with pre-roll (~6 s) + AI metadata sidecar |
| Continuous local rolling recording | 🔲 | Independent of cloud upload |
| Battery/thermal awareness | ✅ | Battery level + charging shown and warned when low (thermal 🔲) |
| Arm/disarm | ✅ | Big switch; disarmed = no detection |

#### 2.2 Monitor Mode

| Feature | Status | Notes |
|---|---|---|
| Dashboard grid of cameras | ✅ | Live status: online/armed/offline, battery, signal, viewer count, last-event flash |
| Live view: pan/zoom (digital), talk, snapshot | ✅ | Talk = hold-to-talk; snapshot saves a JPEG from the camera; fullscreen available |
| Event timeline per camera | ✅ | Tagged clips, filter by camera/type/date |
| Push notifications | ✅ | Browser notifications (desktop) with thumbnail; Web Push 🔲 |
| Multi-user access ("Trust Circle") | 🟡 | v1 = pairing code (anyone with the code can watch). Email-based invites 🔲 |
| Network diagnostics | ✅ | Ping to server, bandwidth test, live bitrate/FPS/resolution/jitter from WebRTC stats, camera signal info |

#### 2.3 AI Layer

| Feature | Status | Notes |
|---|---|---|
| Smart activity summaries (digest) | ✅ | "Front Door: 3 person events (8:12am, 5:40pm, 6:02pm) · 1 package event." |
| Natural-language clip search | ✅ | "person near garage after 10pm", "motion today", "Front Door yesterday"… |
| False-alarm learning | ✅ | Thumbs-down on an alert records a signature (tag+zone+time+energy); similar events are quietly suppressed thereafter; thumbs-up clears signatures. All learning stays on the camera device |
| Familiar face grouping | 🔲 | Opt-in, on-device; needs an embedding model (planned, Phase 4) |
| Anomaly flagging (routine vs unusual) | 🔲 | Planned on top of the digest engine |

#### 2.4 Storage — Google Drive

- ✅ Google Sign-In via OAuth 2.0, **`drive.file` scope only** — the app can never see other Drive files.
- ✅ Dedicated folder `AI Home Guard/<CameraName>/YYYY-MM-DD/HH-MM-SS_tag.webm` + JSON sidecar (tag, confidence, zone, duration, timestamp).
- ✅ Retention: keep forever / 7 days / 30 days, with automatic cleanup.
- 🟡 Storage-usage indicator (works when the token allows it; `drive.file` may hide quota — shown gracefully).
- ✅ Everything in transit is TLS; client-side clip encryption 🔲 (opt-in, planned).
- ⚠️ **To enable Drive you must create your own Google OAuth Client ID** (free, ~5 min): Google Cloud Console → Credentials → OAuth client ID (Web application) → add `http://localhost:3000` (+ your LAN address) to *Authorized JavaScript origins* → paste the ID into **Settings → Storage**. See Part 2.

### 3. UI/UX

- Flat, generous white space, one accent color, system fonts, no ads, no dark patterns.
- Two primary screens: **Cameras** (grid) and **Timeline** (events); everything else is one tap deeper.
- QR-code pairing, under a minute, **no IP addresses, no port forwarding**.
- Zero jargon on main screens ("signal", "viewers" only; bitrate/FPS live in the Stats panel).
- Status via color: green dot = online & armed, gray = offline, amber = event just now.
- Friendly empty states, large tap targets, works one-handed.

### 4. System Architecture (current)

```
[Camera Device (browser)] --WebRTC live stream (device-to-device)--> [Monitor Device (browser)]
        |                                                                    |
        | on-device AI (TF.js in the tab)                                   | Dashboard / Timeline UI
        v                                                                    v
  Event clip + AI metadata                                            Notifications (browser)
        |
        v
  [Local Node.js signaling server]   ← Phase 6: replaced by Cloudflare Workers + Durable Objects
        |          (pairing codes, WebSocket signaling, presence,
        |           event/clip metadata store, feedback relay — NEVER video)
        v
  [Google Drive (user's own account, drive.file)]   +   local data/ (clips, thumbs, db.json)
```

- **Client:** web app (no build step, vanilla ES modules) — every phone/tablet/laptop with a browser can be a camera or monitor.
- **Streaming:** WebRTC with public STUN; media is device-to-device (or tab-to-tab on one machine).
- **AI:** on-device in the browser (COCO-SSD); only real event clips are uploaded, never raw 24/7 footage.
- **Backend (current):** `server/` — Node.js + `ws`: QR pairing, WebRTC signaling relay, presence/heartbeats, event metadata, clip/thumb storage, feedback relay, bandwidth probe.
- **Auth:** Google Sign-In only (via the GIS client library in Settings → Storage). No app passwords.

> **Cloudflare (Phase 6):** `worker/` implements the *same* message protocol
> (`hello`, `camera.register`, `monitor.pair`, `monitor.watch`, `signal`,
> `camera.event`, `feedback`, `ping`, …) on Workers + Durable Objects:
> - `Registry` DO (singleton) — durable state (camera directory, pairing codes,
>   event log, feedback) + message routing between sessions. Replaces `data/db.json`.
> - `Session` DO (one per WebSocket connection) — owns the socket, authenticates,
>   handles signaling/pairing/presence; stateless so reconnects land on fresh instances.
> - R2 bucket — event clips + thumbnails (the user's long-term storage stays Google Drive).
> - Workers Static Assets — serves the whole `web/` app from the same deployment.
> - QR codes render as SVG (no native PNG dependency needed in the runtime).
> Cloudflare remains the control/signaling layer only — never a video proxy or store.
> Validated with `BASE_URL=http://localhost:8787 npm run test:e2e` against `wrangler dev`.

### 5. Non-Functional Requirements

- ✅ Privacy-first: no third-party video cloud; video never touches the signaling server; AI runs in the browser.
- ✅ Low false-positive rate: AI filtering + sensitivity + zones + false-alarm learning.
- ✅ Resilience: auto-reconnect after Wi-Fi drop; clips queue in IndexedDB and upload when connectivity returns; camera state survives reloads.
- ✅ Battery/data efficiency: motion analysis on a low-res canvas; clips are short; camera heartbeats are tiny.
- ✅ Cross-platform: any modern browser (Chrome/Edge/Safari/Firefox) on Android, iOS, desktop. No app-store install needed.
- ✅ No paid infrastructure: runs on one Node process (or free Cloudflare tier in Phase 6); storage is the user's own Drive quota.

### 6. Build Phases — status

| Phase | Scope | Status |
|---|---|---|
| 1 | Core streaming: Camera + Monitor, QR pairing, live WebRTC | ✅ done |
| 2 | Motion + storage: event clips, timeline, retention | ✅ done |
| 3 | AI layer: person/package detection, zones, sensitivity, notifications | ✅ done |
| 4 | Smart layer: digest, NL search, false-alarm learning (face grouping 🔲) | ✅ done* |
| 5 | Polish: empty states, onboarding, accessibility, diagnostics | ✅ done |
| 6 | Cloudflare Workers + Durable Objects — implemented & locally validated | ✅ code, 🔲 live deploy |

### 7. Living Documentation Policy

This file is the single source of truth. Every change to code updates this file in the
same commit: Section 2 (features), Section 4 (architecture), Section 8 (map),
Section 9 (changelog), Section 10 (hosting) — always.

### 8. Codebase Map

```
ai-home-guard/
├── README.md                 # this file — always up to date
├── package.json              # scripts: start, test, test:e2e, test:controls
├── LICENSE                   # MIT
├── .gitignore                # node_modules/, data/
├── server/                   # LOCAL signaling server (same protocol as the Worker)
│   ├── index.js              # HTTP (static + API) + WebSocket signaling + presence + events
│   └── db.js                 # JSON persistence (data/db.json), clip/thumb storage paths
├── worker/                   # CLOUDFLARE WORKERS backend (Phase 6) — deploy to production
│   ├── wrangler.toml         # config: assets, DO bindings (Registry/Session), R2 bucket
│   ├── src/index.ts          # Worker entry: REST API + WS upgrade + static assets + R2
│   ├── src/registry.ts       # Registry DO: durable state, pairing, routing, events
│   ├── src/session.ts        # Session DO per connection: sockets, auth, signaling
│   ├── package.json          # scripts: dev / deploy / r2:create
│   └── tsconfig.json
├── web/                      # the whole app — no build step, vanilla ES modules
│   ├── index.html            # app shell (onboarding, camera view, monitor view, modals)
│   ├── css/app.css           # design system (one accent color, flat, responsive)
│   ├── js/
│   │   ├── app.js            # bootstrap, mode routing, modals, toasts, settings
│   │   ├── camera.js         # Camera Mode: stream, motion loop, events, WebRTC server side
│   │   ├── monitor.js        # Monitor Mode: dashboard, live view, timeline, digest, search
│   │   ├── motion.js         # frame-differencing engine + zones + sensitivity
│   │   ├── ai.js             # TensorFlow.js COCO-SSD person/package detector (lazy CDN load)
│   │   ├── recorder.js       # pre-roll clip recording + IndexedDB offline queue
│   │   ├── drive.js          # Google Drive: OAuth, folders, upload, retention, quota
│   │   ├── learn.js          # false-alarm signatures (suppression learning)
│   │   ├── net.js            # WebSocket client (reconnect, request/response, pub/sub)
│   │   ├── settings.js       # persisted preferences
│   │   └── utils.js          # DOM helpers, formatting, storage
│   ├── vendor/jsqr.js        # vendored QR scanner (works offline)
│   └── .nojekyll             # tells Pages to serve files as-is
├── .github/workflows/pages.yml  # auto-deploys web/ to GitHub Pages on push
├── test/
│   ├── integration.test.js   # server protocol test — 28 checks (node, no browser)
│   ├── e2e.browser.test.js   # two-tab browser E2E — 24 checks (Playwright)
│   ├── extra.browser.test.js # controls/settings checks (Playwright)
│   ├── pages.browser.test.js # github.io simulation — static origin + remote backend — 12 checks
│   └── serve-static.js       # Pages-like static server for test:pages
└── data/                     # runtime only (gitignored): db.json, clips/, thumbs/
```

### 9. Changelog

Newest first. One entry per meaningful change.

| Date | Change | Files/Modules touched |
|---|---|---|
| 2026-08-10 | **Phase 6 — Cloudflare Workers + Durable Objects implemented and validated.** `worker/` replaces the Node server 1:1 (same WS/REST protocol): Registry DO (durable state, pairing, routing, event log, feedback), Session DO per connection (sockets, auth, signaling, presence), R2 for clips/thumbs, Workers Static Assets for the web app, SVG QR codes. All 28 protocol + 24 browser E2E checks pass against `wrangler dev`; DO storage survives restarts. Tests parametrized via `BASE_URL` so the same suites run against either backend. | `worker/`, `test/{integration,e2e}.browser.test.js`, `README.md` |
| 2026-08-10 | **Deployed to https://successpartner10.github.io/hguard/ and validated live** over a public https tunnel (localtunnel) against the local backend: camera+monitor on the github.io origin, QR pairing, live WebRTC, events and clips cross-origin. Fixes found by live testing: (1) detection loop switched from rAF to setInterval so a backgrounded camera tab keeps detecting; (2) event collectors now receive chunks for the whole event duration (long events produced empty blobs before) and the `tailing` flag re-arms after motion resumes (events could never finalize once the tail was cancelled); (3) the offline clip queue now drains periodically, not only on reconnect; (4) server CORS allows the `bypass-tunnel-reminder` header used by tunnel tooling. | `web/js/{camera,recorder,net}.js`, `server/index.js`, `test/live.browser.test.js`, `README.md` |
| 2026-08-10 | **GitHub Pages support.** App made deployable as a static site under a repo subpath: relative asset paths, `apiUrl()` server-URL resolution for all REST/WS/QR/clip/thumb calls, CORS on the server, Pages deploy workflow, `.nojekyll`, and a "no backend connected" banner on static hosts. Fixed latent bug where `net.js` read settings under the wrong localStorage key (invisible until cross-origin use). Added `test:pages` — a two-browser E2E simulating the github.io origin + remote backend (12 checks). | `web/index.html`, `web/js/{net,camera,monitor,recorder,app}.js`, `server/index.js`, `.github/workflows/pages.yml`, `web/.nojekyll`, `test/{serve-static,pages.browser.test}.js`, `README.md` |
| 2026-08-10 | **Pivot to local-first per user directive ("skip Cloudflare until everything works").** Cloudflare Workers + Durable Objects moved from required backend to Phase 6. Built the full Phase 1–5 app against a local Node signaling server with the same message protocol the Cloudflare layer will implement later. | `server/`, `web/`, `test/`, `README.md` |
| 2026-08-10 | Phase 1 — Camera + Monitor modes, QR pairing (`/api/qr`, code entry + jsQR scan), WebRTC live view with signaling relay, presence/heartbeats, dashboard grid. | `server/index.js`, `web/js/{app,camera,monitor,net}.js` |
| 2026-08-10 | Phase 2 — Motion engine (frame diff, zones, sensitivity, live meter), event clips with ~6 s pre-roll, thumbnails, offline IndexedDB queue, clip/thumb storage endpoints, timeline with filters. | `web/js/{motion,recorder}.js`, `server/index.js` |
| 2026-08-10 | Phase 3 — On-device AI (TF.js COCO-SSD person/package, graceful offline degrade), hold-to-talk two-way audio, snapshots, browser notifications, diagnostics (ping, bandwidth probe, WebRTC stats). | `web/js/{ai,camera,monitor}.js`, `server/index.js` |
| 2026-08-10 | Phase 4 — Daily digest, natural-language clip search, false-alarm learning (thumbs feedback → suppression signatures, synced when the camera reconnects). | `web/js/{monitor,learn}.js`, `server/index.js` |
| 2026-08-10 | Phase 5 — Design system pass, empty states, onboarding, zone editor fix, settings modal, demo source, mobile layout. | `web/index.html`, `web/css/app.css`, `web/js/{app,camera}.js` |
| 2026-08-10 | Google Drive integration — `drive.file` OAuth, `AI Home Guard/` folder structure, clip + metadata sidecar upload, retention cleanup, quota indicator. Requires the user's own OAuth Client ID (see Part 2). | `web/js/drive.js`, `web/js/settings.js` (via app), `web/js/camera.js` |
| 2026-08-10 | Test suites: protocol integration (28 checks) + browser E2E (24 checks) + controls (7 checks). All green. | `test/*` |
| 2026-08-10 | Initial requirements & repo scaffold (from requirements PDF). | `README.md` |

### 10. Hosting Stack — current and target

**Current (Phase 1–5): local-first, zero cloud.**
- Code: GitHub (when you push it).
- App + API + signaling: **one Node.js process** (`node server/index.js`) on any machine on your LAN (or a $5 VPS / free-tier host if you want remote access).
- Storage: the user's own **Google Drive** + local `data/` for clips/metadata while the camera and monitor are on the same network.

**Also supported today: static GitHub Pages front end + remote backend.**
The `web/` app is a pure static site (no build step) and is fully GitHub Pages–ready:

- Relative asset paths → works under `https://successpartner10.github.io/hguard/`.
- The included workflow (`.github/workflows/pages.yml`) auto-deploys `web/` to Pages on every push to `main`.
- The app can point at any backend via **Settings → Server URL**. All REST calls (CORS-enabled), WebSocket signaling, QR images, thumbnails and clips then flow to that server cross-origin.
- When the app is opened on a static host with no backend configured, a friendly banner explains what to do instead of failing silently.
- ⚠️ GitHub Pages is **https**; browsers block mixed content, so the backend must also be https (e.g. a `localtunnel`/`ngrok` tunnel or a host like Render), or open the app directly from the backend origin.
- Verified by `npm run test:pages` — a full two-browser E2E that simulates the Pages origin + remote backend.

**Target (Phase 6, deferred until everything works):**

| Piece | Where it lives | Why |
|---|---|---|
| Source + docs | GitHub | version control, CI/CD |
| Landing page / web viewer | Cloudflare Workers Static Assets | same deployment as backend |
| API + Google OAuth | Cloudflare Workers | serverless API/auth |
| Signaling / pairing / presence | Cloudflare Durable Objects | coordinated WebSockets, per-camera state |
| Video/event storage | Google Drive (user's account) | no vendor video storage |

The Phase 6 swap keeps the client untouched: point Settings → Server URL at the Worker
and the same protocol runs over Cloudflare. Durable Objects coordinate signaling,
pairing, presence and connection state only — they must never persist or proxy video.

---

## Part 2 — Beginner's Guide (install & use)

### What you need
- Any device with a modern browser (phone, tablet, laptop) — one for the camera, one for the monitor.
- Node.js 18+ on one computer on your home Wi-Fi (that computer can also be the camera or monitor).
- (Optional, 5 minutes) a free Google OAuth Client ID for Drive storage.

### Step 1 — Start the server (one time)
```bash
git clone https://github.com/successpartner10/hguard.git
cd ai-home-guard
npm install
npm start
```
You'll see `Open http://localhost:3000`. Leave that terminal open.

### Step 1b (optional) — Test it on a GitHub.io URL

Get the app live at `https://successpartner10.github.io/hguard/`:

```bash
cd ai-home-guard
git init
git add -A && git commit -m "AI Home Guard — local-first build (Phases 1-5)"
# already done for you — repo lives at https://github.com/successpartner10/hguard
```

Then on github.com: **repo → Settings → Pages → Source: “GitHub Actions”**. The included
workflow deploys `web/` automatically. After ~1 minute the app is live.

The app on github.io is the **viewer shell only** — it needs a signaling backend:

1. On any computer, run the backend: `npm start` (see Step 1).
2. Give it a public https address for testing: `npx localtunnel --port 3000` → you get a `https://xxx.loca.lt` URL. (First visitors see a one-time "tunnel ahead" page — click through. If you prefer no interstitial, `ssh -R 80:localhost:3000 nokey@localhost.run` gives a `https://xxx.lhr.life` URL.)
3. Open the github.io app → **Settings** → paste the tunnel URL into **Server URL** → Save.
4. Now every device can open the github.io URL: one picks **Camera**, another **Monitor** → pair with the QR code.

> If you skip step 2–3, the github.io app shows a friendly “no backend connected” banner — that's expected; the full app runs at `http://<ip>:3000` directly from your server.

### Step 1c (optional) — Deploy the Cloudflare backend (free tier)

```bash
cd ai-home-guard/worker
npx wrangler login              # opens your browser, logs into Cloudflare
npm run r2:create               # once: creates the ai-home-guard-clips R2 bucket
npm run deploy                  # deploys Worker + DOs + static assets
```
After ~30 seconds the whole app (site + API + signaling) runs at
`https://ai-home-guard.<subdomain>.workers.dev` — open it from any device, no Node
server needed. Pair with QR codes exactly like before; events, clips and thumbnails
live in the Worker's Durable Object storage + R2, and long-term storage can still be
your Google Drive. A custom domain can be attached later in the Cloudflare dashboard.

### Step 2 — Open the app on your devices
- On the server computer: http://localhost:3000
- On your phone/tablet (same Wi-Fi): `http://<server-ip>:3000` — e.g. `http://192.168.1.20:3000`.
  (Find the IP: on the server computer run `ipconfig` on Windows or `ip addr` on Mac/Linux.
  If the phone can't connect, allow Node through your firewall.)

### Step 3 — Make a camera
1. On the spare phone, open the app → **Turn this device into a camera**.
2. Name it (e.g. "Front Door") → **Start camera**.
3. Tap **Pair a monitor** → a QR code + 8-character code appear. Leave it on.

No account, no IP typing, no port forwarding. Done in under a minute.

### Step 4 — Watch from the monitor
1. On the other device, open the app → **Monitor my cameras** → **Add a camera**.
2. Type the 8-character code (or scan the QR with the camera icon).
3. Tap the camera card for live view: **Talk** (hold), **Snapshot**, **Stats**, **Fullscreen**.
4. The **Timeline** tab shows every event: AI-tagged, filterable, searchable ("person after 10pm").
5. 👍/👎 on any event trains the false-alarm learning.

### Step 5 — Store clips in your own Google Drive (optional but recommended)
1. Go to https://console.cloud.google.com → create a project (or pick one).
2. **APIs & Services → Enable APIs** → enable **Google Drive API**.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID** → Application type: **Web application**.
4. Under *Authorized JavaScript origins* add:
   - `http://localhost:3000`
   - `http://<your-server-ip>:3000` (the same LAN address from Step 2)
   - (if you later deploy) your Cloudflare URL
5. Copy the **Client ID** (ends in `.apps.googleusercontent.com`).
6. In the app: **Settings → Storage** → paste the Client ID → **Sign in with Google**.
7. Clips now upload to `AI Home Guard/<CameraName>/<date>/…` in *your* Drive, with a JSON
   metadata sidecar next to every clip. Choose **Retention** (7/30 days/forever) in Settings.

> The app only requests the `drive.file` scope — it can see and touch only the files it
> creates itself. Nothing else in your Drive is ever exposed.

### Testing tips
- **No camera handy?** Settings → **Demo source** (or just deny camera permission) — the
  camera uses a synthetic moving scene so pairing, streaming, detection and clips all work.
- **Two tabs on one laptop** are enough to try everything (use headphones for Talk).
- **Tests:** `npm test` (server protocol), `npm run test:e2e` (full two-browser E2E —
  needs `npx playwright install chromium` once), `npm run test:controls`.

### Troubleshooting
- **"Camera permission denied"** → allow camera access in the browser, or use Demo source.
- **Phone can't open the app** → same Wi-Fi? Firewall blocking port 3000? Try `http://<ip>:3000` in the phone browser directly.
- **Camera shows offline on the monitor** → it reconnects automatically within ~15 s; check the camera device's tab is open and awake (phones: keep the screen on / disable battery optimization for the browser).
- **"AI unavailable"** → the model needs internet on first use; motion detection still works.
- **Drive says error** → check the Client ID, that the Drive API is enabled, and that your origin is in *Authorized JavaScript origins*.

---

**License:** MIT. No telemetry, no ads, no tracking — the code is the whole story.
