import { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabase.js";

// ─── GPX parser ───────────────────────────────────────────────────────────────
function parseGPX(gpxText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(gpxText, "application/xml");
  const points = [];
  doc.querySelectorAll("trkpt").forEach((pt) => {
    const lat = parseFloat(pt.getAttribute("lat"));
    const lon = parseFloat(pt.getAttribute("lon"));
    if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon });
  });
  return points;
}

// ─── FIT binary parser ────────────────────────────────────────────────────────
function parseFIT(buffer) {
  if (!buffer || buffer.byteLength < 12) throw new Error("Bestand is leeg of te klein.");
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (magic !== ".FIT") throw new Error(`Geen geldig .FIT bestand (magic: "${magic}")`);
  const headerSize = bytes[0];
  const dataEnd = headerSize + view.getUint32(4, true);
  const end = Math.min(dataEnd, buffer.byteLength - 2);
  const definitions = {};
  const points = [];
  let pos = headerSize;
  while (pos < end) {
    const h = bytes[pos];
    if (h & 0x80) {
      const local = (h >> 5) & 0x03;
      const def = definitions[local];
      if (def) {
        if (def.globalMsgNum === 20) { const r = readRec(view, pos + 1, def); if (r) points.push(r); }
        pos += 1 + def.recordSize;
      } else pos += 1;
      continue;
    }
    const isDef = (h & 0x40) !== 0, hasDev = (h & 0x20) !== 0, local = h & 0x0F;
    if (isDef) {
      pos += 2;
      const le = bytes[pos] === 0; pos++;
      const global = le ? view.getUint16(pos, true) : view.getUint16(pos, false); pos += 2;
      const fc = bytes[pos++];
      const fields = []; let sz = 0;
      for (let i = 0; i < fc; i++) { const fn = bytes[pos++], fs = bytes[pos++]; pos++; fields.push({ fieldDefNum: fn, size: fs }); sz += fs; }
      if (hasDev) { const dc = bytes[pos++]; for (let i = 0; i < dc; i++) { sz += bytes[pos + 1]; pos += 3; } }
      definitions[local] = { globalMsgNum: global, fields, recordSize: sz, littleEndian: le };
    } else {
      pos++;
      const def = definitions[local];
      if (!def) { pos++; continue; }
      if (def.globalMsgNum === 20) { const r = readRec(view, pos, def); if (r) points.push(r); }
      pos += def.recordSize;
    }
  }
  return points;
}

function readRec(view, pos, def) {
  let lat = null, lon = null, off = pos;
  for (const f of def.fields) {
    if (f.size === 4) {
      const raw = view.getInt32(off, def.littleEndian);
      if (f.fieldDefNum === 0 && raw !== 0x7FFFFFFF) lat = raw * (180 / 2147483648);
      if (f.fieldDefNum === 1 && raw !== 0x7FFFFFFF) lon = raw * (180 / 2147483648);
    }
    off += f.size;
  }
  return lat !== null && lon !== null ? { lat, lon } : null;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function sampleRoute(points, maxPoints = 12) {
  if (points.length <= maxPoints) return points;
  const step = Math.floor(points.length / maxPoints);
  return points.filter((_, i) => i % step === 0).slice(0, maxPoints);
}

function haversine(a, b) {
  const R = 6371, dLat = (b.lat - a.lat) * Math.PI / 180, dLon = (b.lon - a.lon) * Math.PI / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function totalDistance(pts) {
  let d = 0; for (let i = 1; i < pts.length; i++) d += haversine(pts[i - 1], pts[i]); return d;
}

function thinRoute(points, maxPts = 300) {
  if (points.length <= maxPts) return points;
  const step = Math.ceil(points.length / maxPts);
  return points.filter((_, i) => i % step === 0);
}

// ─── Supabase query ───────────────────────────────────────────────────────────
async function findCafesAlongRoute(routePoints) {
  const lats = routePoints.map(p => p.lat);
  const lons = routePoints.map(p => p.lon);
  const buf = 0.015;
  const south = Math.min(...lats) - buf;
  const north = Math.max(...lats) + buf;
  const west = Math.min(...lons) - buf;
  const east = Math.max(...lons) + buf;

  const { data, error } = await supabase
    .from('cafes')
    .select('id, name, type, lat, lon, address, city, opening_hours, website, phone')
    .gte('lat', south)
    .lte('lat', north)
    .gte('lon', west)
    .lte('lon', east)
    .limit(500);

  if (error) throw new Error('Database fout: ' + error.message);
  return data || [];
}

// ─── Leaflet Map Component ────────────────────────────────────────────────────
function RouteMap({ routePoints, stops }) {
  const mapRef = useRef(null);
  const leafletRef = useRef(null);

  useEffect(() => {
    if (!routePoints || routePoints.length < 2) return;

    const loadLeaflet = () => new Promise((resolve) => {
      if (window.L) { resolve(window.L); return; }
      const css = document.createElement("link");
      css.rel = "stylesheet";
      css.href = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
      document.head.appendChild(css);
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
      script.onload = () => resolve(window.L);
      document.head.appendChild(script);
    });

    loadLeaflet().then((L) => {
      if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; }
      const map = L.map(mapRef.current, { zoomControl: true, scrollWheelZoom: true });
      leafletRef.current = map;

      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
      }).addTo(map);

      const thin = thinRoute(routePoints);
      const polyline = L.polyline(thin.map(p => [p.lat, p.lon]), {
        color: "#e85d2e", weight: 4, opacity: 0.85,
      }).addTo(map);

      const mkIcon = (color) => L.divIcon({
        html: `<div style="width:13px;height:13px;background:${color};border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 4px rgba(0,0,0,0.3)"></div>`,
        className: "", iconAnchor: [6, 6],
      });

      L.marker([routePoints[0].lat, routePoints[0].lon], { icon: mkIcon("#22c55e") })
        .bindPopup("<b>Start</b>").addTo(map);
      L.marker([routePoints[routePoints.length - 1].lat, routePoints[routePoints.length - 1].lon], { icon: mkIcon("#ef4444") })
        .bindPopup("<b>Finish</b>").addTo(map);

      stops.forEach((stop) => {
        const coffeeIcon = L.divIcon({
          html: `<div style="width:32px;height:32px;background:#fff;border:2px solid #e85d2e;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;box-shadow:0 2px 8px rgba(232,93,46,0.35)">☕</div>`,
          className: "", iconAnchor: [16, 16],
        });

        const adres = [stop.address, stop.city].filter(Boolean).join(', ') || '';
        const uren = stop.opening_hours ? `<div style="font-size:11px;color:#78716c;margin-top:4px">🕐 ${stop.opening_hours}</div>` : '';
        const site = stop.website ? `<a href="${stop.website}" target="_blank" style="font-size:11px;color:#e85d2e;display:block;margin-top:4px">🌐 Website</a>` : '';
        const mapsQuery = [stop.name, stop.address, stop.city].filter(Boolean).join(', ');
        const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;

        L.marker([stop.lat, stop.lon], { icon: coffeeIcon })
          .bindPopup(`
            <div style="font-family:Inter,sans-serif;min-width:190px;padding:4px 0">
              <div style="font-weight:800;font-size:14px;margin-bottom:2px">${stop.name}</div>
              <div style="font-size:11px;color:#a8a099;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">${stop.type} · ${stop.distKm} km</div>
              ${adres ? `<div style="font-size:12px;color:#78716c">📍 ${adres}</div>` : ''}
              ${uren}
              ${site}
              <a href="${mapsUrl}" target="_blank" style="display:inline-block;margin-top:10px;padding:6px 12px;background:#e85d2e;color:#fff;border-radius:7px;font-size:12px;text-decoration:none;font-weight:600">Open in Google Maps</a>
            </div>
          `).addTo(map);
      });

      map.fitBounds(polyline.getBounds(), { padding: [24, 24] });
    });

    return () => { if (leafletRef.current) { leafletRef.current.remove(); leafletRef.current = null; } };
  }, [routePoints, stops]);

  return <div ref={mapRef} style={{ width: "100%", height: "420px", borderRadius: "16px", overflow: "hidden", zIndex: 0 }} />;
}

// ─── Stop Card ────────────────────────────────────────────────────────────────
function StopCard({ stop, speed, departureTime }) {
  const [open, setOpen] = useState(false);
  const typeIcon = stop.type === 'bakkerij' ? '🥐' : '☕';
  const mapsQuery = [stop.name, stop.address, stop.city].filter(Boolean).join(', ');
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsQuery)}`;
  const streetViewUrl = `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${stop.lat},${stop.lon}`;

  // Bereken aankomsttijd op basis van vertrektijd + rijtijd
  const arrivalDate = (() => {
    const [h, m] = departureTime.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    const travelMins = Math.round((parseFloat(stop.distKm) / speed) * 60);
    d.setMinutes(d.getMinutes() + travelMins);
    return d;
  })();
  const arrivalStr = `${String(arrivalDate.getHours()).padStart(2,'0')}:${String(arrivalDate.getMinutes()).padStart(2,'0')}`;
  const openNow = isOpenAt(stop.opening_hours, arrivalDate);

  return (
    <div className="cafe-card" onClick={() => setOpen(!open)}>
      <div className="cafe-num">{typeIcon}</div>
      <div className="cafe-body">
        <div className="cafe-top">
          <span className="cafe-name">{stop.name}</span>
          <span className="cafe-type">{stop.type}</span>
          {openNow === true && <span className="open-badge open">Open om {arrivalStr}</span>}
          {openNow === false && <span className="open-badge closed">Gesloten om {arrivalStr}</span>}
        </div>
        <div className="cafe-sub">{stop.distKm} km · {fmtTime(parseFloat(stop.distKm), speed)} · {stop.routePct}% van route</div>

        {open && (
          <div className="cafe-details">
            {(stop.address || stop.city) && (
              <div className="detail-row">
                <span className="detail-icon">📍</span>
                <span>{[stop.address, stop.city].filter(Boolean).join(', ')}</span>
              </div>
            )}
            {stop.opening_hours && (
              <div className="detail-row">
                <span className="detail-icon">🕐</span>
                <span>{stop.opening_hours}</span>
              </div>
            )}
            {stop.website && (
              <div className="detail-row">
                <span className="detail-icon">🌐</span>
                <a href={stop.website} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>{stop.website.replace(/^https?:\/\//, '')}</a>
              </div>
            )}
            <div style={{display:'flex',gap:'8px',marginTop:'4px',flexWrap:'wrap'}}>
              <a className="maps-link" href={mapsUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                Open in Google Maps →
              </a>
              <a className="maps-link" href={streetViewUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}>
                Street View →
              </a>
            </div>
          </div>
        )}
      </div>
      <div className="cafe-right">
        <div className="dist-km">{stop.distKm}</div>
        <span className="dist-unit">km</span>
        <div className="chevron">{open ? '▲' : '▼'}</div>
      </div>
    </div>
  );
}

// ─── Tijd helper ──────────────────────────────────────────────────────────────
function fmtTime(km, speed) {
  const mins = Math.round((km / speed) * 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h}u` : `${h}u ${m}m`;
}

// ─── Opening hours helper ─────────────────────────────────────────────────────
function isOpenAt(ohStr, date) {
  if (!ohStr) return null;
  const day = date.getDay();
  const mins = date.getHours() * 60 + date.getMinutes();
  const dayMap = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 0 };
  const s = ohStr.toLowerCase();
  const m = s.match(/([a-z]{2})(?:-([a-z]{2}))?\s+(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const from = dayMap[m[1]], to = m[2] ? dayMap[m[2]] : from;
  const open = parseInt(m[3]) * 60 + parseInt(m[4]);
  const close = parseInt(m[5]) * 60 + parseInt(m[6]);
  const inDay = from <= to ? (day >= from && day <= to) : (day >= from || day <= to);
  if (!inDay) return false;
  return mins >= open && mins < close;
}

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("upload");
  const [status, setStatus] = useState("idle");
  const [routeInfo, setRouteInfo] = useState(null);
  const [routePoints, setRoutePoints] = useState(null);
  const [cafes, setCafes] = useState([]);
  const [errorMsg, setErrorMsg] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [filterType, setFilterType] = useState("all");
  const [maxDist, setMaxDist] = useState(1.5);
  const [numStops, setNumStops] = useState(3);
  const [stopPositions, setStopPositions] = useState([25, 50, 75]);
  const [showAllStops, setShowAllStops] = useState(false);
  const [speed, setSpeed] = useState(25); // km/u
  const [departureTime, setDepartureTime] = useState(() => {
    const now = new Date();
    return `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  });
  const [showSettings, setShowSettings] = useState(false);
  const [showStopEditor, setShowStopEditor] = useState(false);
  const pickedRef = useRef([]);
  const fileRef = useRef();

  const processRoute = useCallback(async (points) => {
    if (points.length < 2) { setStatus("error"); setErrorMsg("Geen geldige route gevonden."); return; }

    const dist = totalDistance(points);
    const sampled = sampleRoute(points, 12);
    setRouteInfo({ distKm: dist.toFixed(1), totalPoints: points.length });
    setRoutePoints(points);
    setStatus("searching");

    try {
      const dbCafes = await findCafesAlongRoute(sampled);

      if (dbCafes.length === 0) {
        const midLat = (Math.min(...points.map(p => p.lat)) + Math.max(...points.map(p => p.lat))) / 2;
        const midLon = (Math.min(...points.map(p => p.lon)) + Math.max(...points.map(p => p.lon))) / 2;
        dbCafes.push(
          { id: 'demo-1', name: 'Koffiehuis De Brug', type: 'koffiebar', lat: midLat + 0.01, lon: midLon + 0.005, address: 'Voorbeeldstraat 12', city: 'Demo', opening_hours: 'Ma-Za 08:00-17:00', website: null, phone: null },
          { id: 'demo-2', name: 'Bakkerij Van der Berg', type: 'bakkerij', lat: midLat - 0.008, lon: midLon + 0.012, address: 'Molenweg 3', city: 'Demo', opening_hours: 'Ma-Vr 07:00-18:00', website: null, phone: null },
        );
      }

      // Snap each cafe to nearest route point + bereken afstand tot route
      const withSnap = dbCafes.map(cafe => {
        let minDist = Infinity, snapIdx = 0;
        sampled.forEach((pt, i) => {
          const d = haversine(pt, { lat: cafe.lat, lon: cafe.lon });
          if (d < minDist) { minDist = d; snapIdx = i; }
        });
        const frac = snapIdx / Math.max(sampled.length - 1, 1);
        return { ...cafe, snapDist: minDist, snapIdx, frac };
      }).filter(c => c.snapDist < 1.5);

      // Sla alle cafés op voor later gebruik bij sliders
      const allStops = withSnap.map(c => ({
        ...c,
        routePct: Math.round(c.frac * 100),
        distKm: (c.frac * dist).toFixed(1),
      }));

      // Kies per gewenste positie de dichtstbijzijnde stop
      const currentPositions = stopPositions.slice(0, numStops);
      const picked = [];
      const seen = new Set();
      for (const pct of currentPositions) {
        const targetFrac = pct / 100;
        const candidates = allStops
          .filter(c => !seen.has(c.id))
          .sort((a, b) => Math.abs(a.frac - targetFrac) - Math.abs(b.frac - targetFrac));
        if (candidates.length > 0) {
          picked.push(candidates[0]);
          seen.add(candidates[0].id);
        }
      }
      const stops = picked;

      setCafes(allStops); // sla alle stops op
      setStatus("done");
      setScreen("results");
    } catch (e) {
      setStatus("error");
      setErrorMsg("Fout: " + e.message);
    }
  }, []);

  const handleFile = (file) => {
    if (!file) return;
    setStatus("parsing"); setCafes([]); setErrorMsg(""); setRoutePoints(null);
    const isFit = file.name.toLowerCase().endsWith(".fit");
    if (isFit) {
      const reader = new FileReader();
      reader.onerror = () => { setStatus("error"); setErrorMsg("Kon bestand niet lezen."); };
      reader.onload = (e) => { try { processRoute(parseFIT(e.target.result)); } catch (err) { setStatus("error"); setErrorMsg("FIT fout: " + err.message); } };
      reader.readAsArrayBuffer(file);
    } else {
      const reader = new FileReader();
      reader.onload = (e) => processRoute(parseGPX(e.target.result));
      reader.readAsText(file);
    }
  };

  const handleDrop = (e) => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #f7f5f2; }
        .app { min-height: 100vh; background: #f7f5f2; color: #1c1917; font-family: 'Inter', sans-serif; padding-bottom: 80px; }

        .header { padding: 18px 40px; background: #fff; border-bottom: 1px solid #e8e4df; display: flex; align-items: center; gap: 14px; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
        .logo { width: 38px; height: 38px; background: linear-gradient(135deg, #e85d2e, #f5974a); border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; box-shadow: 0 2px 8px rgba(232,93,46,0.3); }
        .header h1 { font-size: 1.2rem; font-weight: 800; letter-spacing: -0.03em; }
        .header p { font-size: 0.74rem; color: #a8a099; margin-top: 1px; font-weight: 500; }
        .back-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; background: #f7f5f2; border: 1px solid #e8e4df; border-radius: 8px; font-size: 0.78rem; font-weight: 600; color: #78716c; cursor: pointer; transition: all 0.15s; }
        .back-btn:hover { background: #ede9e4; color: #1c1917; }
        .settings-btn { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; background: #f7f5f2; border: 1px solid #e8e4df; border-radius: 8px; font-size: 0.78rem; font-weight: 600; color: #78716c; cursor: pointer; transition: all 0.15s; margin-left: auto; }
        .settings-btn:hover { background: #ede9e4; color: #1c1917; }
        .settings-panel { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; background: #fff; border-left: 1px solid #e8e4df; box-shadow: -4px 0 24px rgba(0,0,0,0.08); z-index: 200; padding: 28px 24px; display: flex; flex-direction: column; gap: 24px; }
        .settings-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.2); z-index: 199; }
        .settings-title { font-size: 1rem; font-weight: 800; color: #1c1917; letter-spacing: -0.02em; display: flex; align-items: center; justify-content: space-between; }
        .settings-close { cursor: pointer; color: #a8a099; font-size: 1.2rem; line-height: 1; }
        .settings-close:hover { color: #1c1917; }
        .settings-field { display: flex; flex-direction: column; gap: 8px; }
        .settings-label { font-size: 0.78rem; font-weight: 700; color: #1c1917; }
        .settings-sub { font-size: 0.72rem; color: #a8a099; font-weight: 500; }
        .speed-input-row { display: flex; align-items: center; gap: 10px; }
        .speed-input { width: 70px; padding: 8px 10px; border: 1px solid #e8e4df; border-radius: 8px; font-size: 1rem; font-weight: 700; color: #1c1917; text-align: center; font-family: inherit; }
        .speed-input:focus { outline: none; border-color: #e85d2e; }
        .speed-unit { font-size: 0.82rem; color: #78716c; font-weight: 600; }

        .upload-screen { min-height: calc(100vh - 75px); display: flex; align-items: center; justify-content: center; padding: 24px; }
        .upload-card { width: 100%; max-width: 520px; }
        .upload-heading { text-align: center; margin-bottom: 28px; }
        .upload-heading h2 { font-size: 1.9rem; font-weight: 800; letter-spacing: -0.04em; color: #1c1917; margin-bottom: 8px; }
        .upload-heading p { font-size: 0.88rem; color: #a8a099; font-weight: 500; line-height: 1.6; }

        .dropzone { border: 2px dashed #d6d0c9; border-radius: 20px; padding: 44px 28px; text-align: center; cursor: pointer; transition: all 0.2s; background: #fff; position: relative; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
        .dropzone::before { content: ''; position: absolute; inset: 0; background: radial-gradient(ellipse at 50% -10%, rgba(232,93,46,0.05) 0%, transparent 60%); pointer-events: none; }
        .dropzone.over { border-color: #e85d2e; background: #fff9f7; box-shadow: 0 0 0 4px rgba(232,93,46,0.08); }
        .dropzone:hover { border-color: #bfb8b0; }
        .drop-icon { font-size: 2.4rem; margin-bottom: 10px; display: block; }
        .drop-title { font-size: 1rem; font-weight: 700; color: #1c1917; margin-bottom: 4px; }
        .drop-sub { font-size: 0.78rem; color: #a8a099; font-weight: 500; }
        .badges { display: inline-flex; gap: 6px; margin-top: 10px; }
        .badge { padding: 2px 9px; border-radius: 20px; font-size: 0.65rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; }
        .badge-gpx { background: #f0faf0; color: #2d8f26; border: 1px solid #b8e8b5; }
        .badge-fit { background: #f0f4ff; color: #2d52c4; border: 1px solid #b8c8f5; }
        .drop-btn { display: inline-flex; align-items: center; gap: 6px; margin-top: 16px; padding: 10px 24px; background: #e85d2e; color: #fff; border-radius: 10px; font-weight: 700; font-size: 0.84rem; cursor: pointer; border: none; transition: all 0.2s; box-shadow: 0 2px 8px rgba(232,93,46,0.3); }
        .drop-btn:hover { background: #d44e21; transform: translateY(-1px); }
        input[type=file] { display: none; }

        .hint { margin-top: 12px; padding: 12px 16px; background: #faf8f6; border: 1px solid #ede9e4; border-radius: 11px; font-size: 0.75rem; color: #a8a099; line-height: 1.7; }
        .hint strong { color: #e85d2e; font-weight: 600; }

        .spinner-bar { margin-top: 16px; padding: 14px 18px; background: #fff; border: 1px solid #ede9e4; border-radius: 12px; display: flex; align-items: center; gap: 12px; }
        .spinner { width: 18px; height: 18px; border: 2.5px solid #ede9e4; border-top-color: #e85d2e; border-radius: 50%; animation: spin 0.75s linear infinite; flex-shrink: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner-text { font-size: 0.83rem; color: #78716c; font-weight: 500; }
        .spinner-text strong { color: #1c1917; font-weight: 700; }
        .error-box { margin-top: 14px; padding: 13px 16px; background: #fff8f7; border: 1px solid #fbd5cc; border-radius: 11px; color: #c0392b; font-size: 0.81rem; line-height: 1.6; font-weight: 500; }

        .confirm-box { margin-top: 16px; padding: 18px 20px; background: #fff; border: 1px solid #ede9e4; border-radius: 14px; display: flex; align-items: center; gap: 14px; box-shadow: 0 1px 4px rgba(0,0,0,0.04); }
        .confirm-icon { font-size: 1.6rem; flex-shrink: 0; }
        .confirm-info { flex: 1; min-width: 0; }
        .confirm-filename { font-size: 0.88rem; font-weight: 700; color: #1c1917; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .confirm-sub { font-size: 0.74rem; color: #a8a099; margin-top: 2px; }
        .confirm-btn { padding: 9px 20px; background: #e85d2e; color: #fff; border: none; border-radius: 9px; font-weight: 700; font-size: 0.84rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; box-shadow: 0 2px 8px rgba(232,93,46,0.3); }
        .confirm-btn:hover { background: #d44e21; transform: translateY(-1px); }
        .confirm-cancel { font-size: 0.74rem; color: #a8a099; cursor: pointer; margin-top: 6px; text-align: center; }
        .confirm-cancel:hover { color: #78716c; }

        .loading-screen { min-height: calc(100vh - 75px); display: flex; align-items: center; justify-content: center; padding: 24px; }
        .loading-card { text-align: center; }
        .loading-spinner { width: 52px; height: 52px; border: 4px solid #ede9e4; border-top-color: #e85d2e; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 20px; }
        .loading-title { font-size: 1.1rem; font-weight: 800; color: #1c1917; margin-bottom: 6px; letter-spacing: -0.02em; }
        .loading-sub { font-size: 0.82rem; color: #a8a099; font-weight: 500; }

        .main { max-width: 820px; margin: 0 auto; padding: 28px 24px 0; }
        .stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 16px; }
        .stat { background: #fff; border: 1px solid #ede9e4; border-radius: 14px; padding: 14px 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        .stat-label { font-size: 0.65rem; color: #a8a099; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }
        .stat-value { font-size: 1.5rem; font-weight: 800; color: #1c1917; margin-top: 2px; letter-spacing: -0.03em; }
        .stat-unit { font-size: 0.78rem; color: #c4bdb5; font-weight: 500; }

        .map-wrap { border-radius: 16px; overflow: hidden; border: 1px solid #ede9e4; box-shadow: 0 2px 12px rgba(0,0,0,0.07); margin-bottom: 8px; }

        .section-title { font-size: 0.72rem; font-weight: 700; color: #a8a099; margin: 24px 0 10px; display: flex; align-items: center; gap: 10px; text-transform: uppercase; letter-spacing: 0.08em; }
        .section-title::after { content: ''; flex: 1; height: 1px; background: #ede9e4; }

        .cafe-list { display: flex; flex-direction: column; gap: 8px; }
        .cafe-card { background: #fff; border: 1px solid #ede9e4; border-radius: 14px; padding: 16px 18px; display: grid; grid-template-columns: auto 1fr auto; gap: 0 14px; align-items: start; transition: all 0.18s; position: relative; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,0.04); cursor: pointer; }
        .cafe-card:hover { border-color: #d0c9c0; box-shadow: 0 4px 14px rgba(0,0,0,0.07); }
        .cafe-card::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: linear-gradient(180deg, #e85d2e, #f5a832); opacity: 0; transition: opacity 0.18s; }
        .cafe-card:hover::before { opacity: 1; }
        .cafe-num { width: 34px; height: 34px; background: #fff9f7; border: 1px solid #fbd5cc; border-radius: 9px; display: flex; align-items: center; justify-content: center; font-size: 1rem; flex-shrink: 0; margin-top: 1px; }
        .cafe-body { min-width: 0; }
        .cafe-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .cafe-name { font-size: 0.93rem; font-weight: 700; color: #1c1917; }
        .cafe-type { font-size: 0.63rem; padding: 2px 7px; background: #f5f3f0; border-radius: 20px; color: #a8a099; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .cafe-sub { font-size: 0.75rem; color: #c4bdb5; margin-top: 3px; font-weight: 500; }
        .cafe-details { margin-top: 12px; padding-top: 12px; border-top: 1px solid #f0ece8; display: flex; flex-direction: column; gap: 6px; }
        .detail-row { display: flex; align-items: flex-start; gap: 8px; font-size: 0.78rem; color: #78716c; }
        .detail-row a { color: #e85d2e; text-decoration: none; }
        .detail-row a:hover { text-decoration: underline; }
        .detail-icon { flex-shrink: 0; width: 16px; }
        .maps-link { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 0.75rem; color: #e85d2e; text-decoration: none; font-weight: 600; }
        .maps-link:hover { text-decoration: underline; }
        .cafe-right { text-align: right; flex-shrink: 0; padding-top: 2px; }
        .dist-km { font-size: 1.1rem; font-weight: 800; color: #e85d2e; letter-spacing: -0.03em; }
        .dist-unit { font-size: 0.65rem; color: #c4bdb5; font-weight: 600; display: block; }
        .chevron { font-size: 0.6rem; color: #c4bdb5; margin-top: 6px; }

        .open-badge { font-size: 0.6rem; padding: 2px 7px; border-radius: 20px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; }
        .open-badge.open { background: #f0faf0; color: #2d8f26; border: 1px solid #b8e8b5; }
        .open-badge.closed { background: #fff8f7; color: #c0392b; border: 1px solid #fbd5cc; }

        .stop-planner { background: #fff; border: 1px solid #ede9e4; border-radius: 14px; padding: 16px 18px; margin-bottom: 14px; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
        .stop-planner-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
        .stop-planner-label { font-size: 0.78rem; font-weight: 700; color: #1c1917; }
        .num-stops { display: flex; align-items: center; gap: 6px; }
        .num-btn { width: 28px; height: 28px; border-radius: 8px; border: 1px solid #e8e4df; background: #f7f5f2; font-size: 1rem; font-weight: 700; color: #78716c; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.15s; }
        .num-btn:hover:not(:disabled) { background: #ede9e4; color: #1c1917; }
        .num-btn:disabled { opacity: 0.35; cursor: default; }
        .num-val { font-size: 1rem; font-weight: 800; color: #e85d2e; min-width: 20px; text-align: center; }
        .stop-slider-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
        .stop-slider-row:last-child { margin-bottom: 0; }
        .stop-dot { width: 22px; height: 22px; border-radius: 6px; background: #fff9f7; border: 1px solid #fbd5cc; display: flex; align-items: center; justify-content: center; font-size: 0.7rem; flex-shrink: 0; font-weight: 700; color: #e85d2e; }
        .stop-slider-row input[type=range] { flex: 1; accent-color: #e85d2e; cursor: pointer; }
        .stop-km-label { font-size: 0.74rem; font-weight: 700; color: #78716c; min-width: 90px; text-align: right; white-space: nowrap; }

        .filters { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
        .filter-group { display: flex; gap: 6px; }
        .filter-btn { padding: 6px 14px; border-radius: 20px; font-size: 0.74rem; font-weight: 600; border: 1px solid #e8e4df; background: #fff; color: #78716c; cursor: pointer; transition: all 0.15s; }
        .filter-btn.active { background: #e85d2e; color: #fff; border-color: #e85d2e; }
        .filter-btn:hover:not(.active) { border-color: #c4bdb5; color: #1c1917; }
        .dist-filter { display: flex; align-items: center; gap: 8px; margin-left: auto; }
        .dist-filter label { font-size: 0.74rem; color: #78716c; font-weight: 600; white-space: nowrap; }
        .dist-filter input[type=range] { width: 80px; accent-color: #e85d2e; cursor: pointer; }
        .dist-filter span { font-size: 0.74rem; font-weight: 700; color: #e85d2e; min-width: 36px; }

        @media (max-width: 580px) {
          .header { padding: 14px 16px; }
          .main { padding: 18px 14px 0; }
          .stats { grid-template-columns: repeat(2, 1fr); }
        }
      `}</style>

      <div className="app">
        <header className="header">
          <div className="logo">☕</div>
          <div>
            <h1>CoffeeRoute</h1>
            <p>Vind koffiestops langs jouw fietsroute</p>
          </div>
          {screen === "results" && (
            <button className="back-btn" onClick={() => { setScreen("upload"); setStatus("idle"); setRoutePoints(null); setCafes([]); }}>
              ← Nieuwe route
            </button>
          )}
          <button className="settings-btn" style={{marginLeft: screen === "results" ? '8px' : 'auto'}} onClick={() => setShowSettings(true)}>⚙️ Instellingen</button>
        </header>

        {showSettings && (
          <>
            <div className="settings-overlay" onClick={() => setShowSettings(false)} />
            <div className="settings-panel">
              <div className="settings-title">
                Instellingen
                <span className="settings-close" onClick={() => setShowSettings(false)}>✕</span>
              </div>
              <div className="settings-field">
                <div className="settings-label">Fietssnelheid</div>
                <div className="settings-sub">Wordt gebruikt om rijtijden te berekenen bij koffiestops</div>
                <div className="speed-input-row">
                  <input
                    className="speed-input"
                    type="number"
                    min="5"
                    max="60"
                    value={speed}
                    onChange={e => setSpeed(Math.max(5, Math.min(60, parseInt(e.target.value) || 25)))}
                  />
                  <span className="speed-unit">km/u</span>
                </div>
              </div>
            </div>
          </>
        )}


        {screen === "upload" && (
          <div className="upload-screen">
            <div className="upload-card">
              <div className="upload-heading">
                <h2>Waar stop jij voor koffie?</h2>
                <p>Upload je fietsroute en ontdek koffiestops langs de weg</p>
              </div>
              <div
                className={`dropzone${dragOver ? " over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileRef.current?.click()}
              >
                <span className="drop-icon">🗺️</span>
                <div className="drop-title">Sleep je route hierheen</div>
                <div className="drop-sub">of klik om een bestand te kiezen</div>
                <div className="badges">
                  <span className="badge badge-gpx">GPX</span>
                  <span className="badge badge-fit">FIT</span>
                </div>
                <button className="drop-btn" onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
                  Bestand kiezen
                </button>
                <input ref={fileRef} type="file" accept=".gpx,.fit" onChange={(e) => handleFile(e.target.files[0])} />
              </div>
              <div className="hint">
                <strong>Strava:</strong> Activiteit → ••• → Exporteer GPX of Exporteer origineel (.fit) &nbsp;·&nbsp;
                <strong>Wahoo:</strong> Activiteit → Deel → Exporteer als .fit
              </div>
              {status === "error" && <div className="error-box">⚠️ {errorMsg}</div>}
            </div>
          </div>
        )}

        {(status === "parsing" || status === "searching") && (
          <div className="loading-screen">
            <div className="loading-card">
              <div className="loading-spinner" />
              <div className="loading-title">
                {status === "parsing" ? "Route inlezen…" : "Koffiestops zoeken…"}
              </div>
              <div className="loading-sub">
                {status === "parsing" ? "Bestand wordt verwerkt" : "Database wordt doorzocht"}
              </div>
            </div>
          </div>
        )}

        {screen === "results" && routeInfo && (() => {
          const dist = parseFloat(routeInfo.distKm);

          // Kies per gewenste positie de dichtstbijzijnde stop van het juiste type
          const [depH, depM] = departureTime.split(':').map(Number);
          const pool = cafes.filter(c => {
            if (filterType !== "all" && c.type !== filterType) return false;
            if (c.snapDist > maxDist) return false;
            // Check of stop open is bij aankomst
            if (c.opening_hours) {
              const arrival = new Date();
              arrival.setHours(depH, depM, 0, 0);
              const travelMins = Math.round((parseFloat(c.distKm) / speed) * 60);
              arrival.setMinutes(arrival.getMinutes() + travelMins);
              const openStatus = isOpenAt(c.opening_hours, arrival);
              if (openStatus === false) return false;
            }
            return true;
          });
          const picked = [];
          const seen = new Set();
          for (let i = 0; i < numStops; i++) {
            const targetFrac = (stopPositions[i] ?? (((i + 1) / (numStops + 1)) * 100)) / 100;
            const candidates = pool.filter(c => !seen.has(c.id)).sort((a, b) => Math.abs(a.frac - targetFrac) - Math.abs(b.frac - targetFrac));
            if (candidates.length > 0) { picked.push(candidates[0]); seen.add(candidates[0].id); }
          }
          pickedRef.current = picked;

          return (
            <main className="main">
              <div className="stats" style={{gridTemplateColumns:'repeat(3,1fr)'}}>
                <div className="stat">
                  <div className="stat-label">Afstand</div>
                  <div className="stat-value">{routeInfo.distKm} <span className="stat-unit">km</span></div>
                </div>
                <div className="stat">
                  <div className="stat-label">Koffiestops</div>
                  <div className="stat-value">{picked.length}</div>
                </div>
                <div className="stat">
                  <div className="stat-label">Vertrektijd</div>
                  <input
                    type="time"
                    value={departureTime}
                    onChange={e => setDepartureTime(e.target.value)}
                    style={{marginTop:'4px',padding:'0',border:'none',fontSize:'1.3rem',fontWeight:800,color:'#1c1917',fontFamily:'inherit',background:'transparent',width:'100%',letterSpacing:'-0.02em',cursor:'pointer'}}
                  />
                </div>
              </div>

              <div className="map-wrap">
                <RouteMap routePoints={routePoints} stops={picked} />
              </div>

              {/* Stop planner */}
              <div className="stop-planner">
                <div className="stop-planner-top">
                  <span className="stop-planner-label">Hoeveel stops wil je?</span>
                  <div className="num-stops">
                    <button className="num-btn" disabled={numStops <= 1} onClick={() => {
                      const n = numStops - 1;
                      setNumStops(n);
                      setStopPositions(Array.from({length: n}, (_, i) => Math.round(((i + 1) / (n + 1)) * 100)));
                    }}>−</button>
                    <span className="num-val">{numStops}</span>
                    <button className="num-btn" disabled={numStops >= 5} onClick={() => {
                      const n = numStops + 1;
                      setNumStops(n);
                      setStopPositions(Array.from({length: n}, (_, i) => Math.round(((i + 1) / (n + 1)) * 100)));
                    }}>+</button>
                  </div>
                </div>
                {Array.from({ length: numStops }, (_, i) => {
                  const pct = stopPositions[i] ?? Math.round(((i + 1) / (numStops + 1)) * 100);
                  const km = ((pct / 100) * dist).toFixed(1);
                  const match = picked[i];
                  const editing = showStopEditor === i;
                  return (
                    <div key={i} style={{marginBottom:'6px'}}>
                      <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                        <div className="stop-dot">{i + 1}</div>
                        <span style={{fontSize:'0.82rem',fontWeight:600,color:'#1c1917',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                          {match ? match.name : '—'}
                        </span>
                        <span style={{fontSize:'0.72rem',color:'#a8a099',whiteSpace:'nowrap'}}>
                          km {km} · {fmtTime(parseFloat(km), speed)}
                        </span>
                        <button style={{padding:'2px 8px',border:'1px solid #e8e4df',borderRadius:'6px',background: editing ? '#e85d2e' : '#f7f5f2',color: editing ? '#fff' : '#78716c',fontSize:'0.7rem',fontWeight:700,cursor:'pointer',flexShrink:0}}
                          onClick={() => setShowStopEditor(editing ? false : i)}>
                          {editing ? 'Klaar' : 'Aanpassen'}
                        </button>
                      </div>
                      {editing && (
                        <div style={{marginTop:'8px',paddingLeft:'30px'}}>
                          <input type="range" min="5" max="95" step="1" value={pct} style={{width:'100%',accentColor:'#e85d2e'}}
                            onChange={e => {
                              const next = [...stopPositions];
                              next[i] = parseInt(e.target.value);
                              setStopPositions(next);
                            }} />
                          <div style={{fontSize:'0.72rem',color:'#e85d2e',fontWeight:700,textAlign:'right',marginTop:'2px'}}>
                            km {km} · {fmtTime(parseFloat(km), speed)}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="filters">
                <div className="filter-group">
                  {[["all","Alles"],["koffiebar","☕ Koffiebar"],["bakkerij","🥐 Bakkerij"]].map(([val, label]) => (
                    <button key={val} className={`filter-btn${filterType === val ? " active" : ""}`} onClick={() => setFilterType(val)}>{label}</button>
                  ))}
                </div>
                <div className="dist-filter">
                  <label>Max afstand:</label>
                  <input type="range" min="0.2" max="2" step="0.1" value={maxDist} onChange={e => setMaxDist(parseFloat(e.target.value))} />
                  <span>{maxDist < 1 ? `${Math.round(maxDist * 1000)}m` : `${maxDist.toFixed(1)}km`}</span>
                </div>
              </div>

              <div className="section-title" style={{cursor:'pointer'}} onClick={() => setShowAllStops(v => !v)}>
                {showAllStops ? `Alle stops (${pool.length})` : `Geselecteerde stops (${picked.length})`}
                <span style={{marginLeft:'auto',fontSize:'0.7rem',color:'#e85d2e',fontWeight:700,textTransform:'none',letterSpacing:0}}>
                  {showAllStops ? '← Terug naar selectie' : 'Bekijk alle stops →'}
                </span>
              </div>
              <div className="cafe-list">
                {(showAllStops ? pool : picked).length === 0
                  ? <div style={{textAlign:'center',color:'#a8a099',fontSize:'0.84rem',padding:'24px 0'}}>Geen stops gevonden</div>
                  : (showAllStops ? pool : picked).map(c => <StopCard key={c.id} stop={c} speed={speed} departureTime={departureTime} />)}
              </div>
            </main>
          );
        })()}
      </div>
    </>
  );
}
