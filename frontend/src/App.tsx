import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

const PinIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
    <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
  </svg>
);

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

function App() {
  const mapDiv = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const [coords, setCoords] = useState({ lat: 28.6139, lon: 77.209 });
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [places, setPlaces] = useState<Place[]>([]);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [appStatus, setAppStatus] = useState<AppStatus | null>(null);
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

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 3000);
    return () => clearInterval(id);
  }, []);

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

  const tunnelDot = appStatus?.device_connected ? "dot green" : "dot";

  return (
    <div className="app">
      <aside className="sidebar">

        {/* Header */}
        <header className="sidebar-header">
          <span className="logo"><PinIcon /></span>
          <h1>Pinpoint</h1>
        </header>

        {/* Status */}
        <section className="status-section">
          <div className="status-row">
            <span className={tunnelDot} />
            <span className="status-label">Tunnel</span>
            {appStatus?.tunnel_connected ? (
              <button className="tunnel-start-btn" onClick={stopTunnel} disabled={tunnelStopping}>
                {tunnelStopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button
                className="tunnel-start-btn"
                onClick={startTunnel}
                disabled={tunnelStarting || tunnelWaiting}
              >
                {tunnelStarting ? "Starting…" : tunnelWaiting ? "Connecting…" : "Start"}
              </button>
            )}
          </div>
          <div className="status-row">
            <span className={spoofingAt ? "dot green" : "dot"} />
            <span className="status-label">
              {spoofingAt ? `Spoofing: ${spoofingAt}` : "Real GPS"}
            </span>
          </div>
        </section>

        {/* Search */}
        <section className="search-section" ref={searchRef}>
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
        </section>

        {/* Actions */}
        <section className="actions-section">
          <div className="coords-display">
            {coords.lat.toFixed(5)}, {coords.lon.toFixed(5)}
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => spoof()}>Beam here</button>
            <button className="btn btn-ghost" onClick={unspoof}>Stop</button>
          </div>
          {!showSaveInput ? (
            <button
              className="btn btn-outline"
              onClick={() => { setShowSaveInput(true); setSaveName(""); }}
            >
              Save pin…
            </button>
          ) : (
            <div className="save-form">
              <input
                className="save-input"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && savePlace()}
                placeholder="Place name"
                autoFocus
              />
              <div className="save-form-btns">
                <button className="btn btn-primary btn-sm" onClick={savePlace}>Save</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setShowSaveInput(false)}>Cancel</button>
              </div>
            </div>
          )}
          <div className="reset-row">
            <button className="btn-reset" onClick={resetAll}>Stop Everything</button>
          </div>
        </section>

        {/* Route */}
        <section className="route-section">
          <div className="route-header">
            <span>Route</span>
            <button
              className={routeMode ? "route-draw-btn active" : "route-draw-btn"}
              onClick={toggleRouteMode}
            >
              {routeMode ? "Drawing…" : "Draw"}
            </button>
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
                <button className="btn btn-ghost btn-sm" onClick={undoRoutePoint}>Undo</button>
                <button className="btn btn-ghost btn-sm" onClick={clearRoute}>Clear</button>
              </div>
              <div className="speed-row">
                {(["walk", "bike", "drive"] as const).map((s) => (
                  <button
                    key={s}
                    className={routeSpeed === s ? "speed-btn active" : "speed-btn"}
                    onClick={() => setRouteSpeed(s)}
                  >
                    {s[0].toUpperCase() + s.slice(1)}
                  </button>
                ))}
              </div>
              <button
                className="btn btn-primary"
                disabled={!routeGeometry || routeGeometry.length < 2 || routeStarting}
                onClick={startRoute}
              >
                {routeStarting ? "Starting…" : "Start Route"}
              </button>
            </>
          )}
        </section>

        {/* Saved places */}
        <section className="places-section">
          <div className="places-header">
            <span>Saved Places</span>
            {places.length > 0 && <span className="places-count">{places.length}</span>}
          </div>
          {places.length === 0 ? (
            <p className="places-empty">No saved places yet.</p>
          ) : (
            <ul className="places-list">
              {places.map((p) => (
                <li key={p.id} className="place-item">
                  <div className="place-info" onClick={() => goToPlace(p)}>
                    <span className="place-name">{p.name}</span>
                    <span className="place-coords">
                      {p.lat.toFixed(4)}, {p.lon.toFixed(4)}
                    </span>
                  </div>
                  <button
                    className="icon-btn beam"
                    title="Beam here"
                    onClick={() => { goToPlace(p); spoof(p.lat, p.lon, p.name); }}
                  >
                    <TargetIcon />
                  </button>
                  <button
                    className="icon-btn delete"
                    title="Delete"
                    onClick={() => deletePlace(p.id)}
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

      </aside>

      <div ref={mapDiv} className="map-container" />
    </div>
  );
}

export default App;
