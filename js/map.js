/* ALERTES — carte réelle (tuiles Esri World Imagery + OSM, sans clé) */
(function (global) {
  const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ESRI_ATTR = "Tuiles © Esri — Source : Esri, Maxar, Earthstar Geographics et la communauté SIG";
  const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTR = "© OpenStreetMap contributors";

  const COL = { info: "#3cff7a", watch: "#ffc14a", danger: "#ff4d5e", cyan: "#3ff0ff" };

  let map = null;
  let ready = false;
  let pending = null;
  let markers = [];
  let base = "sat";
  let visible = false;

  function styleFor(which) {
    return {
      version: 8,
      name: "ALERTES",
      sources: {
        esri: { type: "raster", tiles: [ESRI_TILES], tileSize: 256, attribution: ESRI_ATTR, maxzoom: 19 },
        osm: { type: "raster", tiles: [OSM_TILES], tileSize: 256, attribution: OSM_ATTR, maxzoom: 19 }
      },
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      layers: [
        { id: "esri", type: "raster", source: "esri", layout: { visibility: which === "osm" ? "none" : "visible" } },
        { id: "osm", type: "raster", source: "osm", layout: { visibility: which === "osm" ? "visible" : "none" } }
      ]
    };
  }

  function cityPoly(lon, lat, half) {
    return [[
      [lon - half, lat - half],
      [lon + half, lat - half],
      [lon + half, lat + half],
      [lon - half, lat + half],
      [lon - half, lat - half]
    ]];
  }

  function citiesCollection(cities) {
    const feats = [];
    (cities || []).forEach((c) => {
      if (!isFinite(c.lon) || !isFinite(c.lat)) return;
      const pop = Math.max(1, c.pop || 1);
      const half = 0.012 + Math.min(0.035, Math.log10(pop) * 0.004);
      const h = 80 + Math.log10(pop) * 380;
      feats.push({
        type: "Feature",
        properties: { n: c.n, pop: pop, cap: c.cap ? 1 : 0, h: h, alert: c.alert ? 1 : 0 },
        geometry: { type: "Polygon", coordinates: cityPoly(c.lon, c.lat, half) }
      });
    });
    return { type: "FeatureCollection", features: feats };
  }

  function cityPoints(cities) {
    return {
      type: "FeatureCollection",
      features: (cities || []).filter((c) => isFinite(c.lon) && isFinite(c.lat)).map((c) => ({
        type: "Feature",
        properties: { n: c.n, cap: c.cap ? 1 : 0, pop: c.pop || 0 },
        geometry: { type: "Point", coordinates: [c.lon, c.lat] }
      }))
    };
  }

  function ensureLayers() {
    if (!map.getSource("cities-3d")) {
      map.addSource("cities-3d", { type: "geojson", data: citiesCollection([]) });
      map.addLayer({
        id: "cities-extrusion",
        type: "fill-extrusion",
        source: "cities-3d",
        minzoom: 4,
        paint: {
          "fill-extrusion-color": [
            "case",
            ["==", ["get", "cap"], 1], "#3ff0ff",
            ["==", ["get", "alert"], 1], "#ffc14a",
            "#e8f4ff"
          ],
          "fill-extrusion-height": ["get", "h"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.82
        }
      });
    }
    if (!map.getSource("city-pts")) {
      map.addSource("city-pts", { type: "geojson", data: cityPoints([]) });
      map.addLayer({
        id: "city-labels",
        type: "symbol",
        source: "city-pts",
        minzoom: 5,
        layout: {
          "text-field": ["get", "n"],
          "text-size": ["case", ["==", ["get", "cap"], 1], 13, 11],
          "text-offset": [0, 1.3],
          "text-anchor": "top",
          "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          "text-allow-overlap": false,
          "text-padding": 4
        },
        paint: {
          "text-color": ["case", ["==", ["get", "cap"], 1], "#3ff0ff", "#f2f7fb"],
          "text-halo-color": "rgba(0,0,0,0.75)",
          "text-halo-width": 1.2
        }
      });
    }
  }

  function clearMarkers() {
    markers.forEach((m) => m.remove());
    markers = [];
  }

  function pulseEl(alert) {
    const col = COL[alert.severity] || COL.info;
    const el = document.createElement("div");
    el.className = "map-pulse sev-" + (alert.severity || "info");
    el.style.setProperty("--pulse", col);
    el.title = alert.title || "";
    el.innerHTML = '<span class="map-pulse-core"></span><span class="map-pulse-ring"></span><span class="map-pulse-ring r2"></span>';
    return el;
  }

  function placeCityLabels(cities) {
    const ranked = (cities || []).filter((c) => isFinite(c.lon) && isFinite(c.lat))
      .sort((a, b) => (b.cap || 0) - (a.cap || 0) || (b.pop || 0) - (a.pop || 0))
      .slice(0, 12);
    ranked.forEach((c) => {
      const el = document.createElement("div");
      el.className = "map-city-lab" + (c.cap ? " is-cap" : "");
      el.textContent = c.n;
      const m = new maplibregl.Marker({ element: el, anchor: "top", offset: [0, 8] })
        .setLngLat([c.lon, c.lat])
        .addTo(map);
      markers.push(m);
    });
  }

  function placeAlerts(alerts) {
    clearMarkers();
    (alerts || []).forEach((a) => {
      if (!isFinite(a.lon) || !isFinite(a.lat)) return;
      const m = new maplibregl.Marker({ element: pulseEl(a), anchor: "center" })
        .setLngLat([a.lon, a.lat])
        .setPopup(new maplibregl.Popup({ offset: 18, closeButton: true, className: "map-pop" })
          .setHTML(
            "<strong>" + escapeHtml(a.title || a.typeLabel) + "</strong>" +
            "<p>" + escapeHtml((a.typeLabel || "") + (a.extra ? " · " + a.extra : "")) + "</p>" +
            '<a href="' + mapsUrl(a.lat, a.lon) + '" target="_blank" rel="noopener noreferrer">Ouvrir dans Google Maps</a>'
          ))
        .addTo(map);
      markers.push(m);
    });
  }

  function mapsUrl(lat, lon) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lat + "," + lon);
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function padding() {
    const mobile = window.innerWidth < 860;
    return mobile
      ? { top: 90, bottom: 180, left: 16, right: 16 }
      : { top: 90, bottom: 120, left: 310, right: 310 };
  }

  function frameView(alerts, reduced) {
    const pts = (alerts || []).filter((a) => isFinite(a.lon) && isFinite(a.lat));
    if (!pts.length) return;
    const dur = reduced ? 0 : 900;
    if (pts.length === 1) {
      map.easeTo({ center: [pts[0].lon, pts[0].lat], zoom: 9, pitch: 52, bearing: -12, duration: dur, padding: padding() });
      return;
    }
    const b = new maplibregl.LngLatBounds();
    pts.forEach((a) => b.extend([a.lon, a.lat]));
    map.fitBounds(b, { padding: padding(), pitch: 48, bearing: -8, duration: dur, maxZoom: 9.5, minZoom: 5 });
  }

  function applyPayload(payload) {
    if (!payload) return;
    ensureLayers();
    const cities = payload.cities || [];
    if (map.getSource("cities-3d")) map.getSource("cities-3d").setData(citiesCollection(cities));
    if (map.getSource("city-pts")) map.getSource("city-pts").setData(cityPoints(cities));
    placeAlerts(payload.alerts || []);
    placeCityLabels(payload.cities || []);
    frameView(payload.alerts, payload.reduced);
  }

  function bindTools() {
    const sat = document.getElementById("basemap-sat");
    const osm = document.getElementById("basemap-osm");
    if (!sat || sat.dataset.bound) return;
    sat.dataset.bound = "1";
    osm.dataset.bound = "1";
    const set = (which) => {
      base = which;
      if (map.getLayer("esri")) map.setLayoutProperty("esri", "visibility", which === "sat" ? "visible" : "none");
      if (map.getLayer("osm")) map.setLayoutProperty("osm", "visibility", which === "osm" ? "visible" : "none");
      sat.classList.toggle("is-on", which === "sat");
      osm.classList.toggle("is-on", which === "osm");
    };
    sat.addEventListener("click", (e) => { e.stopPropagation(); set("sat"); });
    osm.addEventListener("click", (e) => { e.stopPropagation(); set("osm"); });
  }

  function init() {
    const el = document.getElementById("realmap-canvas");
    if (!el || map) return map;
    if (typeof maplibregl === "undefined") return null;
    map = new maplibregl.Map({
      container: el,
      style: styleFor(base),
      center: [0, 10],
      zoom: 2,
      pitch: 45,
      attributionControl: { compact: true },
      fadeDuration: 0
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100 }), "bottom-left");
    map.on("load", () => {
      ready = true;
      bindTools();
      if (pending) { applyPayload(pending); pending = null; }
    });
    return map;
  }

  function show(payload) {
    const root = document.getElementById("realmap");
    if (!root) return;
    if (!map) init();
    if (!map) return;
    root.classList.add("is-on");
    root.setAttribute("aria-hidden", "false");
    visible = true;
    map.resize();
    if (ready) applyPayload(payload);
    else pending = payload;
    const labs = document.getElementById("city-labels");
    if (labs) labs.style.display = "none";
  }

  function hide() {
    const root = document.getElementById("realmap");
    if (root) {
      root.classList.remove("is-on");
      root.setAttribute("aria-hidden", "true");
    }
    visible = false;
    clearMarkers();
    const labs = document.getElementById("city-labels");
    if (labs) labs.style.display = "";
  }

  function setBase(which) {
    base = which === "osm" ? "osm" : "sat";
    if (map && ready) {
      if (map.getLayer("esri")) map.setLayoutProperty("esri", "visibility", base === "sat" ? "visible" : "none");
      if (map.getLayer("osm")) map.setLayoutProperty("osm", "visibility", base === "osm" ? "visible" : "none");
    }
  }

  global.ALERTES = global.ALERTES || {};
  global.ALERTES.mapview = { init, show, hide, setBase, isVisible: () => visible, mapsUrl };
})(window);
