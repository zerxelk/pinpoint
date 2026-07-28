# Setup

macOS only. Requires a USB-connected iOS device to actually spoof anything.

## Prerequisites

- macOS (uses `osascript` for the admin-privilege prompt)
- Node.js + npm
- Rust toolchain (for Tauri) — `rustup`
- Python 3.10 specifically — `backend/requirements.txt` pins exact package versions frozen
  against 3.10, so creating the venv with a different minor version (e.g. Homebrew's default
  `python3`, which may point at 3.13/3.14) can fail to resolve them. Use `python3.10`
  explicitly, or check `which -a python3` first to confirm it resolves to 3.10.
- Xcode Command Line Tools (`xcode-select --install`) — needed for Tauri's native build

## Backend

```bash
cd backend
python3.10 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

`backend/main.py` hardcodes the path to the `pymobiledevice3` binary:

```python
PMD3 = "/Users/daniel/Developer/Mirage/backend/venv/bin/pymobiledevice3"
```

Update this to point at your own venv's `pymobiledevice3` if your checkout lives somewhere else.

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
pip install pyinstaller   # not in requirements.txt — it's a build tool, not a runtime dep
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

## Permissions

`remote tunneld` runs elevated (via `osascript ... with administrator privileges`). macOS's
TCC privacy protection blocks *any* elevated process — regardless of app — from reading files
under `~/Desktop`, `~/Documents`, `~/Downloads`, or iCloud Drive, even as root. If your checkout
(or your `pymobiledevice3` venv) lives under one of those folders, tunnel start will fail with
a `PermissionError` reading a file inside it, even though the path is otherwise correct.

Two ways to fix it:

- **Move the checkout** somewhere outside those folders (e.g. `~/Developer/Mirage`) — no
  permission grant needed, works for anyone.
- **Grant Full Disk Access** instead, if you want to keep it where it is: System Settings →
  Privacy & Security → Full Disk Access → add the app that spawns the elevated process
  (`Mirage.app` for the built app; `Terminal.app` or your terminal emulator if you're running
  via `npm run tauri dev`) and enable it.

## Gotchas

- The `PMD3` path in `backend/main.py` is hardcoded — see above.
- Forgetting to rebuild + copy the PyInstaller binary after a backend change means `tauri dev`/`tauri build` will run stale backend code.
- `backend/places.db` is gitignored and created on first run next to the binary — don't expect it to exist in a fresh checkout.
- **If you move or rename the project folder**, `frontend/src-tauri/target` keeps cached build
  scripts with the old absolute path baked in, which breaks the next `tauri build` with a
  confusing `failed to read plugin permissions ... No such file or directory` error pointing at
  the old location. Fix: `rm -rf frontend/src-tauri/target/release/build` (or wipe the whole
  `target/` dir for a fully clean rebuild) before building again.
