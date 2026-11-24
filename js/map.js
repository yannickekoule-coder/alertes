/* ALERTES — carte réelle 3D (Esri + OSM, relief Terrarium, bâtiments OpenFreeMap) */
(function (global) {
  const ESRI_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const ESRI_ATTR = "Tuiles © Esri — Source : Esri, Maxar, Earthstar Geographics et la communauté SIG";
  const OSM_TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const OSM_ATTR = "© OpenStreetMap contributors";
  const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  const TERRAIN_ATTR = "Relief © Mapzen / AWS Terrain Tiles";
  const BUILDINGS_TILEJSON = "https://tiles.openfreemap.org/planet";
  const BUILDINGS_ATTR = "<a href=\"https://openfreemap.org\" target=\"_blank\" rel=\"noopener\">OpenFreeMap</a> © <a href=\"https://www.openmaptiles.org/\" target=\"_blank\" rel=\"noopener\">OpenMapTiles</a> © OpenStreetMap";

  /* Clé Google Maps Platform (tuiles 3D photoréalistes). Vide par défaut :
     ces tuiles exigent une facturation. Voir README. */
  const GOOGLE_3D_TILES_KEY = String(global.ALERTES_GOOGLE_3D_TILES_KEY || "").trim();

  const COL = { info: "#3cff7a", watch: "#ffc14a", danger: "#ff4d5e", cyan: "#3ff0ff" };
  const PITCH_3D = 60;
  const ZOOM_3D = 15.4;
  const ZOOM_2D = 14.2;
  const TERRAIN_EXAG = 1.35;
  const ORBIT_DEG_PER_SEC = 3.2;

  let map = null;
  let ready = false;
  let pending = null;
  let markers = [];
  let base = "sat";
  let viewMode = "3d";
  let visible = false;
  let orbitOn = false;
  let orbitRaf = 0;
  let resumeTimer = 0;
  let userInteracting = false;
  let lastPayload = null;

  function styleFor(which) {
    return {
      version: 8,
      name: "ALERTES",
      sources: {
        esri: { type: "raster", tiles: [ESRI_TILES], tileSize: 256, attribution: ESRI_ATTR, maxzoom: 19 },
        osm: { type: "raster", tiles: [OSM_TILES], tileSize: 256, attribution: OSM_ATTR, maxzoom: 19 },
        terrain: {
          type: "raster-dem",
          tiles: [TERRAIN_TILES],
          encoding: "terrarium",
          tileSize: 256,
          maxzoom: 15,
          attribution: TERRAIN_ATTR
        }
      },
      glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
      layers: [
        { id: "esri", type: "raster", source: "esri", layout: { visibility: which === "osm" ? "none" : "visible" } },
        { id: "osm", type: "raster", source: "osm", layout: { visibility: which === "osm" ? "visible" : "none" } },
        {
          id: "hillshade",
          type: "hillshade",
          source: "terrain",
          paint: {
            "hillshade-exaggeration": 0.4,
            "hillshade-shadow-color": "#0b1820",
            "hillshade-highlight-color": "#fff4d2",
            "hillshade-illumination-direction": 315,
            "hillshade-illumination-anchor": "viewport"
          }
        }
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
        maxzoom: 13,
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
    if (!map.getSource("openmaptiles")) {
      try {
        map.addSource("openmaptiles", {
          type: "vector",
          url: BUILDINGS_TILEJSON,
          attribution: BUILDINGS_ATTR
        });
      } catch (err) {
        console.warn("ALERTES: tuiles de bâtiments indisponibles", err);
      }
    }
    if (map.getSource("openmaptiles") && !map.getLayer("buildings-3d")) {
      map.addLayer({
        id: "buildings-3d",
        type: "fill-extrusion",
        source: "openmaptiles",
        "source-layer": "building",
        minzoom: 13,
        layout: { visibility: viewMode === "3d" ? "visible" : "none" },
        paint: {
          "fill-extrusion-color": [
            "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 0],
            0, "#d6cfc6",
            40, "#ebe4da",
            120, "#f6f1ea"
          ],
          "fill-extrusion-height": ["coalesce", ["get", "render_height"], 8],
          "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
          "fill-extrusion-opacity": 0.86,
          "fill-extrusion-vertical-gradient": true
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
    applyTerrain();
  }

  function applyTerrain() {
    if (!map || !ready) return;
    if (viewMode === "3d") {
      try { map.setTerrain({ source: "terrain", exaggeration: TERRAIN_EXAG }); } catch (err) { /* source pas encore prête */ }
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "visible");
      if (map.getLayer("buildings-3d")) map.setLayoutProperty("buildings-3d", "visibility", "visible");
    } else {
      try { map.setTerrain(null); } catch (err) { /* ignore */ }
      if (map.getLayer("hillshade")) map.setLayoutProperty("hillshade", "visibility", "none");
      if (map.getLayer("buildings-3d")) map.setLayoutProperty("buildings-3d", "visibility", "none");
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
      const m = new maplibregl.Marker({
        element: pulseEl(a),
        anchor: "center",
        pitchAlignment: "viewport",
        rotationAlignment: "viewport",
        opacity: "1",
        opacityWhenCovered: "1"
      })
        .setLngLat([a.lon, a.lat])
        .setPopup(new maplibregl.Popup({ offset: 18, closeButton: true, className: "map-pop" })
          .setHTML(
            "<strong>" + escapeHtml(a.title || a.typeLabel) + "</strong>" +
            "<p>" + escapeHtml((a.typeLabel || "") + (a.extra ? " · " + a.extra : "")) + "</p>" +
            '<p class="map-links">' +
              '<a href="' + mapsUrl(a.lat, a.lon) + '" target="_blank" rel="noopener noreferrer">Ouvrir dans Google Maps</a>' +
              '<a href="' + earthUrl(a.lat, a.lon) + '" target="_blank" rel="noopener noreferrer">Ouvrir dans Google Earth</a>' +
            "</p>"
          ))
        .addTo(map);
      markers.push(m);
    });
  }

  function mapsUrl(lat, lon) {
    return "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(lat + "," + lon);
  }

  function earthUrl(lat, lon) {
    return "https://earth.google.com/web/@" + lat + "," + lon + ",0a,800d,35y,0h,60t,0r";
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function padding() {
    const mobile = window.innerWidth < 860;
    return mobile
      ? { top: 100, bottom: 360, left: 16, right: 16 }
      : { top: 90, bottom: 280, left: 310, right: 310 };
  }

  function stopOrbit() {
    orbitOn = false;
    if (orbitRaf) {
      cancelAnimationFrame(orbitRaf);
      orbitRaf = 0;
    }
  }

  function startOrbit() {
    stopOrbit();
    if (viewMode !== "3d" || !visible || !map) return;
    if (lastPayload && lastPayload.reduced) return;
    orbitOn = true;
    let last = performance.now();
    function tick(now) {
      if (!orbitOn || viewMode !== "3d" || !visible) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      if (!userInteracting) {
        try { map.setBearing(map.getBearing() + ORBIT_DEG_PER_SEC * dt); } catch (err) { /* ignore */ }
      }
      orbitRaf = requestAnimationFrame(tick);
    }
    orbitRaf = requestAnimationFrame(tick);
  }

  function scheduleOrbit() {
    if (resumeTimer) clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (viewMode === "3d" && visible && !userInteracting && lastPayload && !lastPayload.reduced) startOrbit();
    }, 6000);
  }

  function frameView(alerts, reduced) {
    const pts = (alerts || []).filter((a) => isFinite(a.lon) && isFinite(a.lat));
    if (!pts.length) return;
    const dur = reduced ? 0 : 2200;
    const main = pts[0];
    const pitch = viewMode === "3d" ? PITCH_3D : 0;
    const bearing = viewMode === "3d" ? -18 : 0;
    const zoom = viewMode === "3d" ? ZOOM_3D : ZOOM_2D;
    stopOrbit();
    map.flyTo({
      center: [main.lon, main.lat],
      zoom: zoom,
      pitch: pitch,
      bearing: bearing,
      duration: dur,
      padding: padding(),
      essential: true,
      curve: 1.35
    });
    map.once("moveend", () => {
      if (viewMode === "3d" && visible && !reduced) startOrbit();
    });
  }

  function applyPayload(payload) {
    if (!payload) return;
    lastPayload = payload;
    ensureLayers();
    const cities = payload.cities || [];
    if (map.getSource("cities-3d")) map.getSource("cities-3d").setData(citiesCollection(cities));
    if (map.getSource("city-pts")) map.getSource("city-pts").setData(cityPoints(cities));
    placeAlerts(payload.alerts || []);
    placeCityLabels(payload.cities || []);
    frameView(payload.alerts, payload.reduced);
  }

  function setViewMode(mode) {
    viewMode = mode === "2d" ? "2d" : "3d";
    const btn2 = document.getElementById("view-2d");
    const btn3 = document.getElementById("view-3d");
    if (btn2) btn2.classList.toggle("is-on", viewMode === "2d");
    if (btn3) btn3.classList.toggle("is-on", viewMode === "3d");
    if (!map || !ready) return;
    applyTerrain();
    const reduced = !!(lastPayload && lastPayload.reduced);
    const dur = reduced ? 0 : 800;
    if (viewMode === "3d") {
      map.easeTo({ pitch: PITCH_3D, duration: dur, essential: true });
      map.once("moveend", () => { if (!reduced) startOrbit(); });
    } else {
      stopOrbit();
      if (resumeTimer) clearTimeout(resumeTimer);
      map.easeTo({ pitch: 0, bearing: 0, duration: dur, essential: true });
    }
  }

  function bindTools() {
    const sat = document.getElementById("basemap-sat");
    const osm = document.getElementById("basemap-osm");
    const v2 = document.getElementById("view-2d");
    const v3 = document.getElementById("view-3d");
    if (!sat || sat.dataset.bound) return;
    sat.dataset.bound = "1";
    if (osm) osm.dataset.bound = "1";
    const set = (which) => {
      base = which;
      if (map.getLayer("esri")) map.setLayoutProperty("esri", "visibility", which === "sat" ? "visible" : "none");
      if (map.getLayer("osm")) map.setLayoutProperty("osm", "visibility", which === "osm" ? "visible" : "none");
      sat.classList.toggle("is-on", which === "sat");
      if (osm) osm.classList.toggle("is-on", which === "osm");
    };
    sat.addEventListener("click", (e) => { e.stopPropagation(); set("sat"); });
    if (osm) osm.addEventListener("click", (e) => { e.stopPropagation(); set("osm"); });
    if (v2) {
      v2.dataset.bound = "1";
      v2.addEventListener("click", (e) => { e.stopPropagation(); setViewMode("2d"); });
    }
    if (v3) {
      v3.dataset.bound = "1";
      v3.addEventListener("click", (e) => { e.stopPropagation(); setViewMode("3d"); });
    }
  }

  function bindInteraction() {
    if (!map || map.__alertesInteract) return;
    map.__alertesInteract = true;
    const start = () => {
      userInteracting = true;
      stopOrbit();
      if (resumeTimer) clearTimeout(resumeTimer);
    };
    const end = () => {
      userInteracting = false;
      scheduleOrbit();
    };
    map.on("mousedown", start);
    map.on("touchstart", start);
    map.on("dragstart", start);
    map.on("wheel", start);
    map.on("mouseup", end);
    map.on("touchend", end);
    map.on("dragend", end);
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
      pitch: PITCH_3D,
      maxPitch: 80,
      attributionControl: { compact: true },
      fadeDuration: 0,
      touchPitch: true,
      dragRotate: true,
      pitchWithRotate: true
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100 }), "bottom-left");
    map.on("error", () => { /* tuile manquante : ne pas casser la vue */ });
    map.on("load", () => {
      ready = true;
      bindTools();
      bindInteraction();
      ensureLayers();
      if (pending) { applyPayload(pending); pending = null; }
    });
    return map;
  }

  function show(payload) {
    const root = document.getElementById("realmap");
    if (!root) return;
    if (!map) init();
    if (!map) return;
    viewMode = "3d";
    const v2 = document.getElementById("view-2d");
    const v3 = document.getElementById("view-3d");
    if (v2) v2.classList.toggle("is-on", false);
    if (v3) v3.classList.toggle("is-on", true);
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
    stopOrbit();
    if (resumeTimer) clearTimeout(resumeTimer);
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

  function buildingCount() {
    if (!map || !ready || !map.getLayer("buildings-3d")) return 0;
    try { return map.queryRenderedFeatures({ layers: ["buildings-3d"] }).length; }
    catch (err) { return 0; }
  }

  function isIdle() {
    return !!(map && ready && map.loaded() && !map.isMoving());
  }

  global.ALERTES = global.ALERTES || {};
  global.ALERTES.mapview = {
    init, show, hide, setBase, setViewMode,
    isVisible: () => visible,
    isIdle, buildingCount,
    mapsUrl, earthUrl,
    google3dKey: GOOGLE_3D_TILES_KEY
  };
})(window);
