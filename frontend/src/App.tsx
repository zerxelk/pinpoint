import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { motion, AnimatePresence } from "motion/react";
import { animate as animeAnimate, stagger as animeStagger } from "animejs";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const API = "http://127.0.0.1:8765";
const OSRM = "https://router.project-osrm.org";

interface NominatimResult { lat: string; lon: string; display_name: string; }
interface Place { id: number; name: string; lat: number; lon: number; }
interface AppStatus { tunnel_connected: boolean; device_connected: boolean; }
interface LatLon { lat: number; lon: number; }
type RouteSpeed = "walk" | "bike" | "drive";

const ROUTE_SPEEDS_MPS: Record<RouteSpeed, number> = { walk: 1.4, bike: 4.0, drive: 15.0 };

// Shared easing curve (easeOutQuint-ish) — typed as a 4-tuple so motion accepts it.
const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function haversineMeters(a: LatLon, b: LatLon): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const SearchIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
  </svg>
);

const TargetIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="10"/>
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>
  </svg>
);

// The Mirage mark: a location pin (with a punched hole) floating over three
// "shimmer" reflection bands — a nod to a desert mirage. Reused as the header
// logo (monochrome) and, animated, on the loading screen (gradient).
const MirageMark = ({ size = 22, gradient = false }: { size?: number; gradient?: boolean }) => (
  <svg
    width={size}
    height={size * (66 / 48)}
    viewBox="0 0 48 66"
    fill="none"
    className={gradient ? "mk mk-gradient" : "mk"}
  >
    {gradient && (
      <defs>
        <linearGradient id="mkGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#818cf8" />
          <stop offset="100%" stopColor="#c084fc" />
        </linearGradient>
      </defs>
    )}
    <g className="mk-pin" fill={gradient ? "url(#mkGrad)" : "currentColor"}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M24 4C15.7 4 9 10.7 9 19c0 10.5 15 30 15 30s15-19.5 15-30C39 10.7 32.3 4 24 4Zm0 9a6 6 0 1 0 0 12 6 6 0 0 0 0-12Z"
      />
    </g>
    <g className="mk-shimmer" fill={gradient ? "url(#mkGrad)" : "currentColor"}>
      <rect className="mk-band" x="12" y="53" width="24" height="3" rx="1.5" opacity="0.55" />
      <rect className="mk-band" x="16" y="58.5" width="16" height="2.8" rx="1.4" opacity="0.38" />
      <rect className="mk-band" x="19.5" y="63" width="9" height="2.5" rx="1.25" opacity="0.24" />
    </g>
  </svg>
);

function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);
  const bootMarkRef = useRef<HTMLDivElement>(null);

  const [coords, setCoords] = useState({ lat: 28.6139, lon: 77.209 });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
  const [backendReady, setBackendReady] = useState(false);
  const [backendProgress, setBackendProgress] = useState(0);
  const [backendFailed, setBackendFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [spoofingAt, setSpoofingAt] = useState<string | null>(null);
  const [tunnelStarting, setTunnelStarting] = useState(false);
  const [tunnelStopping, setTunnelStopping] = useState(false);
  const [tunnelWaiting, setTunnelWaiting] = useState(false);
  const placesLoadedRef = useRef(false);
  const tunnelWaitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);

  const [routeMode, setRouteMode] = useState(false);
  const [routePoints, setRoutePoints] = useState<LatLon[]>([]);
  const [routeGeometry, setRouteGeometry] = useState<LatLon[] | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeSpeed, setRouteSpeed] = useState<RouteSpeed>("walk");
  const [routeStarting, setRouteStarting] = useState(false);
  const routeModeRef = useRef(false);
  const routeLayerRef = useRef<L.LayerGroup | null>(null);
  const routeMarkerRef = useRef<L.Marker | null>(null);
  const routeAnimRef = useRef<number | null>(null);

  useEffect(() => {
    if (!mapDiv.current) return;
    const map = L.map(mapDiv.current).setView([28.6139, 77.209], 11);
    mapRef.current = map;
    L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a>',
      maxZoom: 17,
    }).addTo(map);
    const marker = L.marker([28.6139, 77.209], { draggable: true }).addTo(map);
    markerRef.current = marker;
    map.on("click", (e) => {
      if (routeModeRef.current) {
        setRoutePoints((prev) => [...prev, { lat: e.latlng.lat, lon: e.latlng.lng }]);
        return;
      }
      marker.setLatLng(e.latlng);
      setCoords({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
    fetchPlaces();
    return () => {
      if (routeAnimRef.current !== null) cancelAnimationFrame(routeAnimRef.current);
      map.remove();
    };
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setResults([]);
        setSearchError(null);
      }
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, []);

  useEffect(() => {
    // getCurrentWindow() reads Tauri's injected window internals, which don't
    // exist when this is just loaded in a plain browser tab (e.g. `npm run dev`
    // opened directly) — without this guard it throws synchronously here and
    // React unmounts the whole <App>, rendering a blank page.
    if (!isTauri()) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        // Guard synchronously so this only runs once per quit, even if the
        // event fires again (e.g. from our own close() call below) before
        // the async cleanup below has finished.
        if (closingRef.current) return;
        closingRef.current = true;
        event.preventDefault();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        try {
          await fetch(`${API}/reset`, { method: "POST", signal: controller.signal });
        } catch {}
        clearTimeout(timeout);
        getCurrentWindow().close();
      })
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, []);

  useEffect(() => { routeModeRef.current = routeMode; }, [routeMode]);

  // Draw the clicked waypoints and, once available, the road-snapped path over them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    routeLayerRef.current?.remove();
    routeLayerRef.current = null;
    if (routePoints.length === 0) return;

    const layer = L.layerGroup();
    routePoints.forEach((p) => {
      L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color: "#818cf8",
        weight: 2,
        fillColor: "#818cf8",
        fillOpacity: 1,
      }).addTo(layer);
    });
    const path = routeGeometry ?? routePoints;
    if (path.length > 1) {
      L.polyline(
        path.map((p) => [p.lat, p.lon] as [number, number]),
        {
          color: "#818cf8",
          weight: routeGeometry ? 4 : 2,
          opacity: routeGeometry ? 0.85 : 0.45,
          dashArray: routeGeometry ? undefined : "6 6",
        }
      ).addTo(layer);
    }
    layer.addTo(map);
    routeLayerRef.current = layer;
  }, [routePoints, routeGeometry]);

  // Snap the clicked waypoints to roads via OSRM whenever they change.
  useEffect(() => {
    if (routePoints.length < 2) {
      setRouteGeometry(null);
      setRouteError(null);
      return;
    }
    let cancelled = false;
    setRouteLoading(true);
    setRouteError(null);
    const coordsParam = routePoints.map((p) => `${p.lon},${p.lat}`).join(";");
    fetch(`${OSRM}/route/v1/driving/${coordsParam}?overview=full&geometries=geojson`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.code !== "Ok" || !data.routes?.length) {
          setRouteError("No road route found between those points.");
          setRouteGeometry(null);
          return;
        }
        const coords: [number, number][] = data.routes[0].geometry.coordinates;
        setRouteGeometry(coords.map(([lon, lat]) => ({ lat, lon })));
      })
      .catch(() => {
        if (!cancelled) {
          setRouteError("Routing service unavailable.");
          setRouteGeometry(null);
        }
      })
      .finally(() => { if (!cancelled) setRouteLoading(false); });
    return () => { cancelled = true; };
  }, [routePoints]);

  async function refreshStatus() {
    try {
      const data: AppStatus = await fetch(`${API}/status`).then(r => r.json());
      setAppStatus(data);
      if (data.device_connected && tunnelWaitTimerRef.current) {
        clearTimeout(tunnelWaitTimerRef.current);
        tunnelWaitTimerRef.current = null;
        setTunnelWaiting(false);
      }
      if (!placesLoadedRef.current) fetchPlaces();
    } catch {
      setAppStatus(null);
    }
  }

  // Poll /health until the backend sidecar is up, driving a progress bar in the
  // meantime. The bundled PyInstaller binary takes ~6s to boot on a warm launch
  // and up to ~20s on the very first launch after install (Gatekeeper scan +
  // cold disk cache). Without this, every /status and /places call fails silently
  // during that window and the app just looks dead — so we gate the UI on it.
  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();
    const TAU = 3000; // shapes how fast the bar creeps up
    const FAIL_AFTER = 45000; // give up and offer a retry past this

    // Asymptotic creep toward 99% — honest about not being done, and it never
    // stalls at a fixed ceiling even if boot runs long. It snaps to 100% only
    // when /health actually answers.
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setBackendProgress(Math.min(99, 100 * (1 - Math.exp(-elapsed / TAU))));
    }, 100);

    async function poll() {
      while (!cancelled) {
        try {
          const r = await fetch(`${API}/health`);
          if (r.ok) {
            if (cancelled) return;
            clearInterval(progressTimer);
            setBackendProgress(100);
            setBackendReady(true);
            return;
          }
        } catch {}
        if (Date.now() - startedAt > FAIL_AFTER) {
          clearInterval(progressTimer);
          if (!cancelled) setBackendFailed(true);
          return;
        }
        await new Promise((res) => setTimeout(res, 300));
      }
    }
    poll();
    return () => { cancelled = true; clearInterval(progressTimer); };
  }, [retryKey]);

  function retryBackend() {
    setBackendFailed(false);
    setBackendProgress(0);
    setRetryKey((k) => k + 1);
  }

  // Animate the loading-screen mark with anime.js: the pin gently bobs while the
  // shimmer bands ripple in sequence, evoking a mirage. Runs only while the boot
  // overlay is on screen.
  useEffect(() => {
    if (backendReady || backendFailed) return;
    const root = bootMarkRef.current;
    if (!root) return;
    const pin = root.querySelector<SVGGElement>(".mk-pin");
    const bands = root.querySelectorAll<SVGRectElement>(".mk-band");
    const anims: Array<{ pause: () => void }> = [];
    if (pin) {
      anims.push(
        animeAnimate(pin, {
          translateY: [0, -7, 0],
          duration: 2200,
          ease: "inOutSine",
          loop: true,
        }) as unknown as { pause: () => void }
      );
    }
    if (bands.length) {
      anims.push(
        animeAnimate(bands, {
          opacity: [0.2, 0.8, 0.2],
          scaleX: [0.82, 1.06, 0.82],
          delay: animeStagger(190),
          duration: 2200,
          ease: "inOutSine",
          loop: true,
        }) as unknown as { pause: () => void }
      );
    }
    return () => anims.forEach((a) => a.pause?.());
  }, [backendReady, backendFailed, retryKey]);

  useEffect(() => {
    if (!backendReady) return;
    refreshStatus();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, [backendReady]);

  async function fetchPlaces() {
    try {
      const data = await fetch(`${API}/places`).then(r => r.json());
      if (Array.isArray(data)) {
        setPlaces(data);
        placesLoadedRef.current = true;
      }
    } catch {}
  }

  async function savePlace() {
    if (!saveName.trim()) return;
    await fetch(`${API}/places`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: saveName, lat: coords.lat, lon: coords.lon }),
    });
    setSaveName("");
    setShowSaveInput(false);
    fetchPlaces();
  }

  async function deletePlace(id: number) {
    await fetch(`${API}/places/${id}`, { method: "DELETE" });
    fetchPlaces();
  }

  function goToPlace(place: Place) {
    const latlng: [number, number] = [place.lat, place.lon];
    mapRef.current?.setView(latlng, 13);
    markerRef.current?.setLatLng(latlng);
    setCoords({ lat: latlng[0], lon: latlng[1] });
  }

  async function geocode(q: string) {
    const trimmed = q.trim();
    if (!trimmed) { setResults([]); setSearchError(null); return; }
    setSearchError(null);
    const data: NominatimResult[] = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=5`
    ).then(r => r.json());
    if (!data.length) { setSearchError("No results found."); setResults([]); return; }
    setResults(data);
  }

  function handleQueryChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    setQuery(val);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => geocode(val), 300);
  }

  function triggerSearch() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    geocode(query);
  }

  function selectResult(result: NominatimResult) {
    const latlng: [number, number] = [parseFloat(result.lat), parseFloat(result.lon)];
    mapRef.current?.setView(latlng, 13);
    markerRef.current?.setLatLng(latlng);
    setCoords({ lat: latlng[0], lon: latlng[1] });
    setResults([]);
    setSearchError(null);
  }

  function clearTunnelWait() {
    if (tunnelWaitTimerRef.current) {
      clearTimeout(tunnelWaitTimerRef.current);
      tunnelWaitTimerRef.current = null;
    }
    setTunnelWaiting(false);
  }

  async function resetAll() {
    clearTunnelWait();
    stopRouteAnimation();
    try { await fetch(`${API}/reset`, { method: "POST" }); } catch {}
    setSpoofingAt(null);
  }

  async function stopTunnel() {
    clearTunnelWait();
    setTunnelStopping(true);
    try { await fetch(`${API}/tunnel/stop`, { method: "POST" }); } catch {}
    setTunnelStopping(false);
    refreshStatus();
  }

  async function startTunnel() {
    setTunnelStarting(true);
    try {
      const data: { ok: boolean } = await fetch(`${API}/tunnel/start`, { method: "POST" }).then(r => r.json());
      if (data.ok) {
        setTunnelWaiting(true);
        // Auto-clear if tunnel never comes up within 15s
        tunnelWaitTimerRef.current = setTimeout(() => setTunnelWaiting(false), 15000);
      }
    } catch {}
    setTunnelStarting(false);
    refreshStatus();
  }

  async function spoof(lat = coords.lat, lon = coords.lon, name?: string) {
    stopRouteAnimation();
    await fetch(`${API}/spoof`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lon }),
    });
    setSpoofingAt(name ?? `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  }

  async function unspoof() {
    stopRouteAnimation();
    await fetch(`${API}/unspoof`, { method: "POST" });
    setSpoofingAt(null);
  }

  function ensureRouteMarker(pos: LatLon) {
    const map = mapRef.current;
    if (!map) return;
    if (!routeMarkerRef.current) {
      const icon = L.divIcon({
        className: "route-marker-icon",
        html: '<div class="route-marker-dot"></div>',
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
      routeMarkerRef.current = L.marker([pos.lat, pos.lon], { icon, interactive: false }).addTo(map);
    } else {
      routeMarkerRef.current.setLatLng([pos.lat, pos.lon]);
    }
  }

  function stopRouteAnimation() {
    if (routeAnimRef.current !== null) {
      cancelAnimationFrame(routeAnimRef.current);
      routeAnimRef.current = null;
    }
    routeMarkerRef.current?.remove();
    routeMarkerRef.current = null;
  }

  // Replays the route locally in the UI, in step with the timing the backend
  // baked into the GPX file it's feeding the device — same speed, same path.
  function animateRoute(points: LatLon[], speedMps: number) {
    const cumSeconds: number[] = [0];
    for (let i = 1; i < points.length; i++) {
      cumSeconds.push(cumSeconds[i - 1] + haversineMeters(points[i - 1], points[i]) / speedMps);
    }
    const total = cumSeconds[cumSeconds.length - 1];
    const startedAt = Date.now();

    function tick() {
      const elapsed = (Date.now() - startedAt) / 1000;
      if (elapsed >= total) {
        ensureRouteMarker(points[points.length - 1]);
        routeAnimRef.current = null;
        return;
      }
      let i = 0;
      while (i < cumSeconds.length - 1 && cumSeconds[i + 1] < elapsed) i++;
      const segStart = cumSeconds[i];
      const segEnd = cumSeconds[i + 1] ?? segStart;
      const t = segEnd > segStart ? (elapsed - segStart) / (segEnd - segStart) : 0;
      const a = points[i];
      const b = points[i + 1] ?? a;
      ensureRouteMarker({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
      routeAnimRef.current = requestAnimationFrame(tick);
    }
    tick();
  }

  function toggleRouteMode() {
    setRouteMode((m) => !m);
  }

  function undoRoutePoint() {
    setRoutePoints((prev) => prev.slice(0, -1));
  }

  function clearRoute() {
    setRoutePoints([]);
    setRouteGeometry(null);
    setRouteError(null);
  }

  async function startRoute() {
    if (!routeGeometry || routeGeometry.length < 2) return;
    setRouteStarting(true);
    try {
      const res = await fetch(`${API}/spoof/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: routeGeometry, speed: routeSpeed }),
      });
      if (res.ok) {
        setSpoofingAt(`Route (${routeSpeed})`);
        stopRouteAnimation();
        animateRoute(routeGeometry, ROUTE_SPEEDS_MPS[routeSpeed]);
      } else {
        const body = await res.json().catch(() => null);
        setRouteError(body?.detail ?? "Failed to start route.");
      }
    } catch {
      setRouteError("Failed to start route.");
    }
    setRouteStarting(false);
  }

  const tunnelDot = appStatus?.device_connected ? "dot green pulse" : "dot";
  const sectionMotion = (i: number) => ({
    initial: { opacity: 0, y: 12 },
    animate: { opacity: 1, y: 0 },
    transition: { delay: 0.06 + i * 0.07, duration: 0.45, ease: EASE },
  });

  return (
    <div className="app">
      <AnimatePresence>
        {!backendReady && (
          <motion.div
            className="boot-overlay"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeInOut" }}
          >
            <div className="boot-glow" />
            <motion.div
              className="boot-card"
              initial={{ opacity: 0, scale: 0.92, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.55, ease: EASE }}
            >
              <div className="boot-mark" ref={bootMarkRef}>
                <MirageMark size={72} gradient />
              </div>
              <h2 className="boot-title">Mirage</h2>
              {backendFailed ? (
                <>
                  <p className="boot-error">
                    The engine didn’t start in time. It may have failed to launch —
                    try again, or restart the app.
                  </p>
                  <motion.button
                    className="btn btn-primary boot-retry"
                    onClick={retryBackend}
                    whileTap={{ scale: 0.96 }}
                  >
                    Retry
                  </motion.button>
                </>
              ) : (
                <>
                  <p className="boot-status">Starting engine…</p>
                  <div className="boot-bar">
                    <motion.div
                      className="boot-bar-fill"
                      animate={{ width: `${backendProgress}%` }}
                      transition={{ ease: "easeOut", duration: 0.25 }}
                    />
                  </div>
                  <span className="boot-pct">{Math.round(backendProgress)}%</span>
                </>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <aside className="sidebar">
        <div className="sidebar-glow" />

        {/* Header */}
        <motion.header
          className="sidebar-header"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: "easeOut" }}
        >
          <span className="logo"><MirageMark size={20} /></span>
          <h1>Mirage</h1>
        </motion.header>

        {/* Status */}
        <motion.section className="status-section" {...sectionMotion(0)}>
          <div className="status-row">
            <span className={tunnelDot} />
            <span className="status-label">Tunnel</span>
            {appStatus?.tunnel_connected ? (
              <motion.button
                className="tunnel-start-btn"
                onClick={stopTunnel}
                disabled={tunnelStopping}
                whileTap={{ scale: 0.95 }}
              >
                {tunnelStopping ? "Stopping…" : "Stop"}
              </motion.button>
            ) : (
              <motion.button
                className="tunnel-start-btn"
                onClick={startTunnel}
                disabled={tunnelStarting || tunnelWaiting}
                whileTap={{ scale: 0.95 }}
              >
                {tunnelStarting ? "Starting…" : tunnelWaiting ? "Connecting…" : "Start"}
              </motion.button>
            )}
          </div>
          <div className="status-row">
            <span className={spoofingAt ? "dot green pulse" : "dot"} />
            <span className="status-label">
              {spoofingAt ? `Spoofing: ${spoofingAt}` : "Real GPS"}
            </span>
          </div>
        </motion.section>

        {/* Search */}
        <motion.section className="search-section" ref={searchRef} {...sectionMotion(1)}>
          <div className="search-wrap">
            <span className="search-icon"><SearchIcon /></span>
            <input
              className="search-input"
              type="text"
              value={query}
              onChange={handleQueryChange}
              onKeyDown={(e) => e.key === "Enter" && triggerSearch()}
              placeholder="Search place…"
            />
          </div>
          {results.length > 0 && (
            <div className="dropdown">
              {results.map((r, i) => (
                <div key={i} className="dropdown-item" onMouseDown={() => selectResult(r)}>
                  {r.display_name}
                </div>
              ))}
            </div>
          )}
          {searchError && <p className="search-error">{searchError}</p>}
        </motion.section>

        {/* Actions */}
        <motion.section className="actions-section" {...sectionMotion(2)}>
          <div className="coords-display">
            <span className="coords-dot" />
            {coords.lat.toFixed(5)}, {coords.lon.toFixed(5)}
          </div>
          <div className="btn-row">
            <motion.button
              className="btn btn-primary"
              onClick={() => spoof()}
              whileTap={{ scale: 0.96 }}
              whileHover={{ y: -1 }}
            >
              Beam here
            </motion.button>
            <motion.button className="btn btn-ghost" onClick={unspoof} whileTap={{ scale: 0.96 }}>
              Stop
            </motion.button>
          </div>
          <AnimatePresence mode="wait" initial={false}>
            {!showSaveInput ? (
              <motion.button
                key="savebtn"
                className="btn btn-outline"
                onClick={() => { setShowSaveInput(true); setSaveName(""); }}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                whileTap={{ scale: 0.98 }}
              >
                Save pin…
              </motion.button>
            ) : (
              <motion.div
                key="saveform"
                className="save-form"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.2 }}
              >
                <input
                  className="save-input"
                  value={saveName}
                  onChange={(e) => setSaveName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && savePlace()}
                  placeholder="Place name"
                  autoFocus
                />
                <div className="save-form-btns">
                  <motion.button className="btn btn-primary btn-sm" onClick={savePlace} whileTap={{ scale: 0.95 }}>Save</motion.button>
                  <motion.button className="btn btn-ghost btn-sm" onClick={() => setShowSaveInput(false)} whileTap={{ scale: 0.95 }}>Cancel</motion.button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
          <div className="reset-row">
            <motion.button className="btn-reset" onClick={resetAll} whileTap={{ scale: 0.98 }}>Stop Everything</motion.button>
          </div>
        </motion.section>

        {/* Route */}
        <motion.section className="route-section" {...sectionMotion(3)}>
          <div className="route-header">
            <span>Route</span>
            <motion.button
              className={routeMode ? "route-draw-btn active" : "route-draw-btn"}
              onClick={toggleRouteMode}
              whileTap={{ scale: 0.95 }}
            >
              {routeMode ? "Drawing…" : "Draw"}
            </motion.button>
          </div>

          {routePoints.length === 0 ? (
            <p className="route-hint">
              {routeMode ? "Click the map to drop waypoints." : "Click Draw, then click the map to plot a route."}
            </p>
          ) : (
            <>
              <div className="route-status">
                {routeLoading
                  ? "Routing…"
                  : routeGeometry
                    ? `${routePoints.length} waypoint${routePoints.length > 1 ? "s" : ""} · road-snapped`
                    : `${routePoints.length} waypoint${routePoints.length > 1 ? "s" : ""}`}
              </div>
              {routeError && <p className="search-error">{routeError}</p>}
              <div className="btn-row">
                <motion.button className="btn btn-ghost btn-sm" onClick={undoRoutePoint} whileTap={{ scale: 0.95 }}>Undo</motion.button>
                <motion.button className="btn btn-ghost btn-sm" onClick={clearRoute} whileTap={{ scale: 0.95 }}>Clear</motion.button>
              </div>
              <div className="speed-row">
                {(["walk", "bike", "drive"] as const).map((s) => (
                  <button
                    key={s}
                    className={routeSpeed === s ? "speed-btn active" : "speed-btn"}
                    onClick={() => setRouteSpeed(s)}
                  >
                    {routeSpeed === s && (
                      <motion.span
                        layoutId="speedPill"
                        className="speed-pill"
                        transition={{ type: "spring", stiffness: 420, damping: 34 }}
                      />
                    )}
                    <span className="speed-label">{s[0].toUpperCase() + s.slice(1)}</span>
                  </button>
                ))}
              </div>
              <motion.button
                className="btn btn-primary"
                disabled={!routeGeometry || routeGeometry.length < 2 || routeStarting}
                onClick={startRoute}
                whileTap={{ scale: 0.96 }}
              >
                {routeStarting ? "Starting…" : "Start Route"}
              </motion.button>
            </>
          )}
        </motion.section>

        {/* Saved places */}
        <motion.section className="places-section" {...sectionMotion(4)}>
          <div className="places-header">
            <span>Saved Places</span>
            {places.length > 0 && <span className="places-count">{places.length}</span>}
          </div>
          {places.length === 0 ? (
            <p className="places-empty">No saved places yet.</p>
          ) : (
            <ul className="places-list">
              <AnimatePresence initial={false}>
                {places.map((p, i) => (
                  <motion.li
                    key={p.id}
                    className="place-item"
                    layout
                    initial={{ opacity: 0, x: -12 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: 12, height: 0 }}
                    transition={{ delay: i * 0.035, duration: 0.3, ease: EASE }}
                  >
                    <div className="place-info" onClick={() => goToPlace(p)}>
                      <span className="place-name">{p.name}</span>
                      <span className="place-coords">
                        {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                      </span>
                    </div>
                    <motion.button
                      className="icon-btn beam"
                      title="Beam here"
                      onClick={() => { goToPlace(p); spoof(p.lat, p.lon, p.name); }}
                      whileTap={{ scale: 0.88 }}
                    >
                      <TargetIcon />
                    </motion.button>
                    <motion.button
                      className="icon-btn delete"
                      title="Delete"
                      onClick={() => deletePlace(p.id)}
                      whileTap={{ scale: 0.88 }}
                    >
                      <TrashIcon />
                    </motion.button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </motion.section>

      </aside>

      <div ref={mapDiv} className="map-container" />
    </div>
  );
}

export default App;
