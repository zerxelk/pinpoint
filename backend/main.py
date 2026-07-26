import atexit
import os
import signal
import subprocess
import json
import sqlite3
import pathlib
import sys
import tempfile
import threading
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal
import gpxpy.gpx
from gpxpy.geo import haversine_distance
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

PMD3 = "/Users/daniel/pinpoint-tunnel/bin/pymobiledevice3"
LOG_DIR = pathlib.Path.home() / "Library" / "Logs" / "Mirage"
TUNNELD_PID_FILE = LOG_DIR / "tunneld.pid"

# Average human/vehicle speeds used to space out timestamps on a route's GPX
# points — pymobiledevice3's GPX player paces itself off these deltas.
ROUTE_SPEEDS_MPS = {"walk": 1.4, "bike": 4.0, "drive": 15.0}

if getattr(sys, 'frozen', False):
    _base = pathlib.Path(sys.executable).parent
else:
    _base = pathlib.Path(__file__).parent

DB = _base / "places.db"

def _init_db():
    with sqlite3.connect(DB) as con:
        con.execute("""
            CREATE TABLE IF NOT EXISTS places (
                id   INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                lat  REAL NOT NULL,
                lon  REAL NOT NULL
            )
        """)

_init_db()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    # tauri://localhost / http://tauri.localhost: the webview's origin in a
    # production build. http://localhost:5173: the webview's origin under
    # `tauri dev`, which loads devUrl (the live Vite server) directly instead.
    allow_origins=["tauri://localhost", "http://tauri.localhost", "http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(Exception)
async def unhandled_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Without this, unhandled exceptions escape to ServerErrorMiddleware (outermost),
    # which sends a plain-text 500 that never passes through CORSMiddleware.
    return JSONResponse(status_code=500, content={"detail": str(exc)})

#Module-level "memory": holds the running spoof process between requests. Starts as None=nothing is being spoofed right now.
current_spoof = None
current_spoof_gpx = None  # temp GPX file backing an active route spoof, if any
_spoof_lock = threading.Lock()

def _get_rsd_target(udid: str | None) -> tuple[str, str]:
    # Ask tunneld for the phone's current tunnel address + port.
    try:
        with urllib.request.urlopen("http://127.0.0.1:49151", timeout=3) as r:
            tunnels = json.loads(r.read())
    except Exception:
        raise HTTPException(status_code=503, detail="Tunnel not running — use Start Tunnel first")
    # tunnels = { "<UDID>": [ {"tunnel-address": "...", "tunnel-port": ...} ] }
    if not tunnels:
        raise HTTPException(status_code=503, detail="No device connected — plug in an iPhone and wait for it to pair")
    if udid is not None:
        if udid not in tunnels:
            raise HTTPException(status_code=404, detail=f"Device {udid} has no active tunnel")
        target = tunnels[udid][0]
    else:
        target = next(iter(tunnels.values()))[0]
    return target["tunnel-address"], str(target["tunnel-port"])

def _stop_current_spoof():
    # Caller must hold _spoof_lock.
    global current_spoof, current_spoof_gpx
    if current_spoof is not None:
        try:
            current_spoof.terminate()
        except Exception:
            pass
        current_spoof = None
    if current_spoof_gpx is not None:
        current_spoof_gpx.unlink(missing_ok=True)
        current_spoof_gpx = None

def _load_tunneld_pid():
    # Recover the PID of a tunneld that a previous instance of this backend started —
    # tunneld outlives the backend process (it's reparented to launchd), so a fresh
    # backend must not forget about it just because it just started up.
    try:
        pid = int(TUNNELD_PID_FILE.read_text().strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)  # existence/permission probe only, sends no actual signal
    except ProcessLookupError:
        return None
    except PermissionError:
        pass  # exists but owned by root (expected) — still a valid PID to track
    return pid

tunneld_pid = _load_tunneld_pid()

def _find_tunneld_pids():
    # The PID handoff in tunnel_start (writing $! from inside an elevated
    # `do shell script`) isn't reliable in practice — the file has been observed
    # missing after real, successful tunnel starts. Scanning for the process
    # directly means Stop still works even when that handoff didn't happen, or
    # when tunneld outlived an older version of this backend that predates it.
    result = subprocess.run(["pgrep", "-f", "remote tunneld"], capture_output=True, text=True)
    return {int(p) for p in result.stdout.split()}

def _kill_tunneld(privileged=False):
    global tunneld_pid
    pids = _find_tunneld_pids()
    if tunneld_pid is not None:
        pids.add(tunneld_pid)
    tunneld_pid = None
    if not pids:
        return
    # tunneld does not exit on SIGTERM (confirmed: it stays up indefinitely
    # even when SIGTERM'd as root), so SIGKILL is the only signal that
    # reliably stops it — there's no graceful-shutdown behavior to preserve.
    unkilled = []
    for pid in pids:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        except PermissionError:
            unkilled.append(pid)
    if not unkilled or not privileged:
        return
    # tunneld runs as root (started via administrator privileges) — a normal
    # kill from us is rejected, so escalate. Only do this for an explicit,
    # user-initiated stop; never from the quiet quit/cleanup path.
    cmds = " ; ".join(f"kill -9 {pid}" for pid in unkilled)
    script = f'do shell script "{cmds}" with administrator privileges'
    subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True)

def _cleanup():
    with _spoof_lock:
        _stop_current_spoof()
    _kill_tunneld()

atexit.register(_cleanup)
signal.signal(signal.SIGTERM, lambda *_: (_cleanup(), sys.exit(0)))

class Coords(BaseModel):
    lat: float
    lon: float
    udid: str | None = None

class Place(BaseModel):
    name: str
    lat: float
    lon: float

class RoutePoint(BaseModel):
    lat: float
    lon: float

class Route(BaseModel):
    points: list[RoutePoint]
    speed: Literal["walk", "bike", "drive"]
    udid: str | None = None

def _build_route_gpx(points: list[RoutePoint], speed_mps: float) -> pathlib.Path:
    gpx = gpxpy.gpx.GPX()
    track = gpxpy.gpx.GPXTrack()
    gpx.tracks.append(track)
    segment = gpxpy.gpx.GPXTrackSegment()
    track.segments.append(segment)

    # Only the deltas between consecutive points' timestamps matter to the GPX
    # player (it sleeps for each delta before moving on) — the base time is
    # arbitrary.
    t = datetime.now(timezone.utc)
    prev = None
    for p in points:
        if prev is not None:
            meters = haversine_distance(prev.lat, prev.lon, p.lat, p.lon)
            t += timedelta(seconds=meters / speed_mps)
        segment.points.append(gpxpy.gpx.GPXTrackPoint(p.lat, p.lon, time=t))
        prev = p

    LOG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, path = tempfile.mkstemp(suffix=".gpx", dir=LOG_DIR)
    with os.fdopen(fd, "w") as f:
        f.write(gpx.to_xml())
    return pathlib.Path(path)

@app.get("/health")
def health():
    return {"ok": True}

@app.get("/devices")
def devices():
    result = subprocess.run(
        [PMD3, "usbmux", "list"],
        capture_output=True,
        text=True,)
    phones=json.loads(result.stdout)
    return {"count": len(phones), "phones": phones}

@app.post("/spoof")
def spoof(coords: Coords):
    global current_spoof

    with _spoof_lock:
        # Resolve the tunnel target before touching whatever's currently running —
        # otherwise a failed lookup here (tunnel/device transiently unavailable)
        # kills a perfectly good existing spoof and replaces it with nothing.
        rsd_addr, rsd_port = _get_rsd_target(coords.udid)
        _stop_current_spoof()
        current_spoof = subprocess.Popen(
            [
                PMD3, "developer", "dvt", "simulate-location",
                "set", "--rsd", rsd_addr, rsd_port,
                "--", str(coords.lat), str(coords.lon),
            ]
        )
    return {"ok": True, "lat": coords.lat, "lon": coords.lon}

@app.post("/spoof/route")
def spoof_route(route: Route):
    global current_spoof, current_spoof_gpx

    if len(route.points) < 2:
        raise HTTPException(status_code=400, detail="A route needs at least two points")

    with _spoof_lock:
        # Same ordering as /spoof: don't tear down a working spoof until we know
        # we can actually replace it.
        rsd_addr, rsd_port = _get_rsd_target(route.udid)
        _stop_current_spoof()
        gpx_path = _build_route_gpx(route.points, ROUTE_SPEEDS_MPS[route.speed])
        current_spoof = subprocess.Popen(
            [
                PMD3, "developer", "dvt", "simulate-location",
                "play", "--rsd", rsd_addr, rsd_port,
                "--", str(gpx_path),
            ]
        )
        current_spoof_gpx = gpx_path
    return {"ok": True, "points": len(route.points)}

@app.post("/unspoof")
def unspoof():
    with _spoof_lock:
        if current_spoof is None:
            return {"ok": True, "detail": "Nothing was being spoofed."}
        _stop_current_spoof()   # terminate is your Ctrl+C — reverts the location
    return {"ok": True, "detail": "Back to real GPS."}

@app.get("/places")
def list_places():
    with sqlite3.connect(DB) as con:
        rows = con.execute("SELECT id, name, lat, lon FROM places ORDER BY id").fetchall()
    return [{"id": r[0], "name": r[1], "lat": r[2], "lon": r[3]} for r in rows]

@app.post("/places")
def add_place(place: Place):
    with sqlite3.connect(DB) as con:
        cur = con.execute(
            "INSERT INTO places (name, lat, lon) VALUES (?,?,?)",
            (place.name, place.lat, place.lon),
        )
    return {"id": cur.lastrowid, "name": place.name, "lat": place.lat, "lon": place.lon}

@app.delete("/places/{place_id}")
def delete_place(place_id: int):
    with sqlite3.connect(DB) as con:
        con.execute("DELETE FROM places WHERE id=?", (place_id,))
    return {"ok": True}

@app.get("/status")
def status():
    try:
        with urllib.request.urlopen("http://127.0.0.1:49151", timeout=1) as r:
            tunnels = json.loads(r.read())
        tunnel_connected = True
        device_connected = bool(tunnels)
    except Exception:
        tunnel_connected = False
        device_connected = False
    return {"tunnel_connected": tunnel_connected, "device_connected": device_connected}

@app.post("/reset")
def reset():
    _cleanup()
    return {"ok": True}

@app.post("/tunnel/stop")
def tunnel_stop():
    _kill_tunneld(privileged=True)
    return {"ok": True}

@app.post("/tunnel/start")
def tunnel_start():
    global tunneld_pid
    LOG_DIR.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(LOG_DIR, 0o700)
    log_path = LOG_DIR / f"tunneld-{uuid.uuid4().hex}.log"
    # & without nohup: do shell script's shell exits and launchd adopts the child.
    # `echo $!` captures the backgrounded tunneld's PID so we can target it directly later.
    cmd = f"{PMD3} remote tunneld > {log_path} 2>&1 & echo $! > {TUNNELD_PID_FILE}"
    script = f'do shell script "{cmd}" with administrator privileges'
    result = subprocess.run(["/usr/bin/osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        cancelled = "-128" in result.stderr or "cancel" in result.stderr.lower()
        return {"ok": False, "cancelled": cancelled}
    try:
        tunneld_pid = int(TUNNELD_PID_FILE.read_text().strip())
    except (OSError, ValueError):
        tunneld_pid = None
    return {"ok": True}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8765)
