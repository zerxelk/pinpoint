# Pinpoint

A macOS desktop app for spoofing the GPS location of a USB-connected iOS device.
Click anywhere on a map to beam your iPhone there, save favourite spots, or draw a
route and have the device "walk", "bike", or "drive" it in real time.

> [!WARNING]
> Pinpoint is for development, testing, and personal use on devices you own.
> Spoofing location to deceive apps, services, or people may violate their terms of
> service or local law. Use responsibly.

## Features

- **Beam to any point** — click the map (or search a place) and set the device's GPS instantly.
- **Saved places** — store and re-beam to named locations, persisted locally in SQLite.
- **Route playback** — draw waypoints, snap them to real roads, and simulate travel at walking, cycling, or driving speed with a live marker.
- **One-click tunnel** — start the privileged `pymobiledevice3` tunnel from the UI (triggers the native macOS password prompt).
- **Live status** — see at a glance whether the tunnel and device are connected and whether a spoof is active.

## How it works

Pinpoint is three layers glued together by a Tauri shell:

```
frontend/src/          React + TypeScript UI (Leaflet / OpenStreetMap)
       ↕ HTTP REST (127.0.0.1:8765)
backend/main.py        Python FastAPI server — GPS spoofing endpoints
       ↕ subprocess
pymobiledevice3        iOS USB communication (RSD + DVT simulate-location)
```

The Tauri Rust shell (`frontend/src-tauri/src/lib.rs`) launches the FastAPI backend as a
bundled **sidecar process** at startup and reaps it on quit. The frontend talks to that
backend over local HTTP; the backend shells out to `pymobiledevice3` to reach the phone
over USB. A separate, privileged `remote tunneld` process (started on demand from the UI)
provides the tunnel the backend needs to actually reach the device.

## Requirements

- macOS on Apple Silicon (`aarch64`)
- [Node.js](https://nodejs.org/) 18+
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain)
- Python 3.11+
- [`pymobiledevice3`](https://github.com/doronz88/pymobiledevice3) installed in a virtualenv
- An iOS device connected over USB with Developer Mode enabled

## Getting started

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# Run standalone for development:
uvicorn main:app --host 127.0.0.1 --port 8765
```

The path to the `pymobiledevice3` binary is configured at the top of `backend/main.py` —
update it to match your environment.

### Frontend / app

```bash
cd frontend
npm install

npm run dev          # Vite dev server (UI only, no device)
npm run tauri dev    # Full app with hot reload — spawns the backend sidecar
```

### Production build

The backend is bundled as a PyInstaller binary that the Tauri app ships as a sidecar.
This binary is **not committed to the repo** — build it locally before your first
`tauri build` (and again after any backend change), then copy it into place:

```bash
cd backend
source venv/bin/activate
pyinstaller pinpoint-backend.spec
cp dist/pinpoint-backend \
  ../frontend/src-tauri/binaries/pinpoint-backend-aarch64-apple-darwin
```

Then build the app bundle:

```bash
cd frontend
npm run tauri build
```

The finished `.app` and `.dmg` land in
`frontend/src-tauri/target/release/bundle/`.

## Project structure

```
backend/               FastAPI server, GPS spoofing + route logic
frontend/src/          React UI (App.tsx is the whole frontend)
frontend/src-tauri/    Tauri Rust shell + bundled backend binary
```

## Tech stack

- **Frontend:** React, TypeScript, Vite, Leaflet, Oxlint
- **Backend:** Python, FastAPI, Uvicorn, pymobiledevice3, gpxpy, SQLite
- **Shell:** Tauri 2 (Rust)

## License

Released under the [MIT License](LICENSE).
