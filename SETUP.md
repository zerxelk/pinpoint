# Setup

macOS only. Requires a USB-connected iOS device to actually spoof anything.

## Prerequisites

- macOS (uses `osascript` for the admin-privilege prompt)
- Node.js + npm
- Rust toolchain (for Tauri) — `rustup`
- Python 3 with a `venv`
- Xcode Command Line Tools (`xcode-select --install`) — needed for Tauri's native build

## Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`backend/main.py` hardcodes the path to the `pymobiledevice3` binary:

```python
PMD3 = "/Users/daniel/pinpoint-tunnel/bin/pymobiledevice3"
```

Update this to point at your own venv's `pymobiledevice3` (e.g. `backend/venv/bin/pymobiledevice3`) if it differs, or create a venv at that exact path.

Run the backend standalone for development:

```bash
uvicorn main:app --host 127.0.0.1 --port 8765
```

Check it's alive: `curl http://127.0.0.1:8765/health`

## Frontend

```bash
cd frontend
npm install
```

Run just the web UI (no Tauri shell, no backend sidecar):

```bash
npm run dev   # http://localhost:5173
```

Run the full desktop app (spawns the backend sidecar automatically — requires the PyInstaller binary to already exist, see below):

```bash
npm run tauri dev
```

## Building the backend sidecar binary

The Tauri app doesn't run the Python source directly — it spawns a compiled binary. After any backend change:

```bash
cd backend
source venv/bin/activate
pyinstaller mirage-backend.spec
cp dist/mirage-backend frontend/src-tauri/binaries/mirage-backend-aarch64-apple-darwin
```

(Confirm the exact `dist/` output name/path matches your `mirage-backend.spec` — adjust the `cp` if it differs.)

## Production build

```bash
cd frontend
npm run tauri build
```

Produces a `.app` bundle with the frontend, Tauri shell, and backend sidecar all packaged together.

## Device connection

USB is only required for the first connection (to pair/trust the device). `remote tunneld` monitors both USB and WiFi by default, so once a device has been paired it can be rediscovered and tunneled over WiFi on subsequent runs, as long as it's on the same network as the Mac — no cable needed after that.

1. Connect the iOS device via USB and trust the Mac if prompted (first time only).
2. Start the tunnel — either:
   - Click the tunnel-start action in the app (triggers a native macOS admin-password prompt), or
   - Run `./Start\ Tunnel.command` from the repo root (also prompts for `sudo`).
3. `GET /status` (or the app's status indicator) should report `tunnel_connected: true` once `remote tunneld` is up on port 49151.
4. Pick a location on the map and spoof — `/devices` should list the connected phone first if things aren't working.

## Gotchas

- The `PMD3` path in `backend/main.py` is hardcoded — see above.
- Forgetting to rebuild + copy the PyInstaller binary after a backend change means `tauri dev`/`tauri build` will run stale backend code.
- `backend/places.db` is gitignored and created on first run next to the binary — don't expect it to exist in a fresh checkout.
- Per the latest commit message, app-quit cleanup currently has a bug causing an infinite reset loop — worth watching for during dev.
