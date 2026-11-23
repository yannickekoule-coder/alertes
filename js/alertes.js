/* ALERTES — scène 3D, intro lentille, HUD, repli 2D */
(function () {
  const geo = window.ALERTES.geo;
  const data = window.ALERTES.data;
  const $ = (id) => document.getElementById(id);

  const TZ = "Europe/Paris";
  const COL = { info: 0x3cff7a, watch: 0xffc14a, danger: 0xff4d5e, cyan: 0x3ff0ff, line: 0xc8ebff };
  const params = new URLSearchParams(location.search);
  const SHOT = params.has("shot") || params.has("preview");
  const reduced = SHOT || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = window.matchMedia("(max-width: 860px)").matches || ("ontouchstart" in window && innerWidth < 1100);

  let state = {
    alerts: [],
    countries: {},
    sources: [],
    at: 0,
    fromCache: false,
    selected: null,
    morph: reduced ? 1 : 0,
    introDone: reduced,
    userOrbit: 0,
    userZoom: 1,
    dragging: false,
    ready: false,
    webgl: true
  };

  let renderer, scene, camera, canvas;
  let landPtsGeo, borderGeo, morphables = [];
  let lensGroup, ripples = [], markerGroup;
  let stars;
  let fallback2d = null;
  let animStart = 0;
  let lastTick = 0;
  let driftT = 0;
  let interactUntil = 0;

  function hasWebGL() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }

  function fmtClock(now) {
    const date = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
    const time = new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(now);
    return { date, time };
  }

  function fmtWhen(ts) {
    if (!ts) return "";
    return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short" }).format(new Date(ts));
  }

  function tickClock() {
    const { date, time } = fmtClock(new Date());
    const d = $("clock-date"), t = $("clock-time");
    if (d) d.textContent = date;
    if (t) t.textContent = time;
  }

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  }

  function setMorphAttributes(geometry, sphereArr, planeArr) {
    geometry.setAttribute("sphere", new THREE.Float32BufferAttribute(sphereArr, 3));
    geometry.setAttribute("plane", new THREE.Float32BufferAttribute(planeArr, 3));
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(planeArr.slice(), 3));
    morphables.push(geometry);
  }

  function applyMorph(t) {
    for (const g of morphables) {
      const s = g.getAttribute("sphere");
      const p = g.getAttribute("plane");
      const pos = g.getAttribute("position");
      const n = pos.count;
      for (let i = 0; i < n; i++) {
        pos.setXYZ(
          i,
          s.getX(i) + (p.getX(i) - s.getX(i)) * t,
          s.getY(i) + (p.getY(i) - s.getY(i)) * t,
          s.getZ(i) + (p.getZ(i) - s.getZ(i)) * t
        );
      }
      pos.needsUpdate = true;
    }
  }

  function buildLens() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.95, depthWrite: false });
    const dim = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });

    const ring = new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.018, 8, 96), mat);
    g.add(ring);
    const ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.78, 0.008, 8, 96), dim);
    g.add(ring2);

    const ticks = new THREE.Group();
    for (let i = 0; i < 72; i++) {
      const h = i % 6 === 0 ? 0.16 : 0.07;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, h, 0.012), i % 6 === 0 ? mat : dim);
      const a = (i / 72) * Math.PI * 2;
      const r = 2.66;
      m.position.set(Math.cos(a) * r, Math.sin(a) * r, 0);
      m.rotation.z = a + Math.PI / 2;
      ticks.add(m);
    }
    g.add(ticks);

    // outer arcs
    const arcGeo = new THREE.TorusGeometry(3.05, 0.01, 6, 64, Math.PI * 0.42);
    for (let i = 0; i < 3; i++) {
      const arc = new THREE.Mesh(arcGeo, mat);
      arc.rotation.z = i * (Math.PI * 2 / 3);
      arc.rotation.x = 0.18;
      g.add(arc);
    }

    const inner = new THREE.Mesh(new THREE.RingGeometry(2.35, 2.42, 80), dim);
    g.add(inner);
    g.userData.spin = ticks;
    return g;
  }

  function buildScene() {
    canvas = $("scene");
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !mobile, alpha: false, powerPreference: "high-performance" });
    renderer.setClearColor(0x030508, 1);
    renderer.setPixelRatio(Math.min(mobile ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(innerWidth, innerHeight, false);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.1, 80);
    camera.position.set(0, 0, 6.4);
    camera.lookAt(0, 0, 0);

    // faint star field
    const starN = mobile ? 350 : 700;
    const starPos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 16 + Math.random() * 18;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      starPos[i * 3 + 1] = r * Math.cos(ph);
      starPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
    stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x6aa0b8, size: 0.035, transparent: true, opacity: 0.55, depthWrite: false }));
    scene.add(stars);

    // graticule (lat/lon) as faint lines — plane + sphere morph
    const gratS = [], gratP = [];
    function pushLine(coords) {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        const sa = geo.sph(a[0], a[1]), sb = geo.sph(b[0], b[1]);
        const pa = geo.pla(a[0], a[1]), pb = geo.pla(b[0], b[1]);
        gratS.push(sa[0], sa[1], sa[2], sb[0], sb[1], sb[2]);
        gratP.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
      }
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const c = [];
      for (let lon = -180; lon <= 180; lon += 5) c.push([lon, lat]);
      pushLine(c);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const c = [];
      for (let lat = -80; lat <= 80; lat += 5) c.push([lon, lat]);
      pushLine(c);
    }
    const gratGeo = new THREE.BufferGeometry();
    setMorphAttributes(gratGeo, gratS, gratP);
    scene.add(new THREE.LineSegments(gratGeo, new THREE.LineBasicMaterial({ color: 0x1b3a48, transparent: true, opacity: 0.45, depthWrite: false })));

    // country borders
    const rings = geo.borderRings();
    const bS = [], bP = [];
    for (const ring of rings) {
      const c = ring.coords;
      for (let i = 0; i < c.length - 1; i++) {
        const a = c[i], b = c[i + 1];
        if (Math.abs(a[0] - b[0]) > 90) continue; // antimeridian jump
        const sa = geo.sph(a[0], a[1]), sb = geo.sph(b[0], b[1]);
        const pa = geo.pla(a[0], a[1]), pb = geo.pla(b[0], b[1]);
        bS.push(sa[0], sa[1], sa[2], sb[0], sb[1], sb[2]);
        bP.push(pa[0], pa[1], pa[2], pb[0], pb[1], pb[2]);
      }
    }
    borderGeo = new THREE.BufferGeometry();
    setMorphAttributes(borderGeo, bS, bP);
    scene.add(new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({
      color: COL.line, transparent: true, opacity: 0.82, depthWrite: false
    })));
    // glow pass (same lines, slightly dimmer additive)
    const glowGeo = borderGeo.clone();
    // clone does not copy our morph list — add it
    morphables.push(glowGeo);
    scene.add(new THREE.LineSegments(glowGeo, new THREE.LineBasicMaterial({
      color: COL.cyan, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending
    })));

    // dotted land
    const dots = geo.sampleLandDots(mobile ? 3.1 : 2.15);
    const dS = [], dP = [];
    for (const p of dots) {
      const s = geo.sph(p[0], p[1]);
      const q = geo.pla(p[0], p[1]);
      dS.push(s[0], s[1], s[2]);
      dP.push(q[0], q[1], q[2]);
    }
    landPtsGeo = new THREE.BufferGeometry();
    setMorphAttributes(landPtsGeo, dS, dP);
    landPtsGeo.userData.ll = dots;
    scene.add(new THREE.Points(landPtsGeo, new THREE.PointsMaterial({
      color: 0x9ad6ea, size: mobile ? 0.03 : 0.028, sizeAttenuation: true,
      transparent: true, opacity: 0.55, depthWrite: false
    })));

    lensGroup = buildLens();
    scene.add(lensGroup);

    markerGroup = new THREE.Group();
    scene.add(markerGroup);

    if (reduced) {
      applyMorph(1);
      lensGroup.visible = false;
    }
  }

  function colorLandByAlerts() {
    if (!landPtsGeo || !landPtsGeo.userData.ll) return;
    const dots = landPtsGeo.userData.ll;
    const cols = new Float32Array(dots.length * 3);
    const base = new THREE.Color(0x7fb8c9);
    const map = state.countries;
    // precompute country of each dot? too heavy at runtime if done naively.
    // Instead color dots near an alert (within ~4°) with severity color.
    const events = state.alerts;
    for (let i = 0; i < dots.length; i++) {
      let r = base.r, g = base.g, b = base.b, tint = 0;
      const lon = dots[i][0], lat = dots[i][1];
      for (let k = 0; k < events.length; k++) {
        const a = events[k];
        if (!isFinite(a.lon) || !isFinite(a.lat)) continue;
        const dx = lon - a.lon, dy = lat - a.lat;
        const d2 = dx * dx + dy * dy;
        const rad = a.severity === "danger" ? 16 : a.severity === "watch" ? 10 : 6;
        if (d2 < rad) {
          const t = 1 - d2 / rad;
          const c = new THREE.Color(COL[a.severity]);
          if (t > tint) { tint = t; r = c.r; g = c.g; b = c.b; }
        }
      }
      if (tint > 0) {
        r = base.r + (r - base.r) * Math.min(1, tint * 1.2);
        g = base.g + (g - base.g) * Math.min(1, tint * 1.2);
        b = base.b + (b - base.b) * Math.min(1, tint * 1.2);
      }
      cols[i * 3] = r; cols[i * 3 + 1] = g; cols[i * 3 + 2] = b;
    }
    landPtsGeo.setAttribute("color", new THREE.BufferAttribute(cols, 3));
    if (landPtsGeo.userData.pointsMat) { /* set later */ }
    // update points material to use vertex colors
    scene.traverse((obj) => {
      if (obj.geometry === landPtsGeo && obj.material) {
        obj.material.vertexColors = true;
        obj.material.needsUpdate = true;
      }
    });
  }

  function clearMarkers() {
    while (markerGroup.children.length) {
      const o = markerGroup.children[0];
      markerGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    ripples = [];
  }

  function addMarkers() {
    clearMarkers();
    const used = Object.create(null);
    const items = [];
    // one pulse per country (max severity), plus a marker at each alert position
    const byC = state.countries;
    for (const id of Object.keys(byC)) {
      const pack = byC[id];
      const main = pack.alerts[0];
      if (!main || !isFinite(main.lon)) continue;
      items.push({ lon: main.lon, lat: main.lat, severity: pack.max, country: id, kind: "country" });
    }
    for (const a of state.alerts) {
      if (!isFinite(a.lon) || !isFinite(a.lat)) continue;
      const key = a.lon.toFixed(1) + "," + a.lat.toFixed(1);
      if (used[key]) continue;
      used[key] = 1;
      items.push({ lon: a.lon, lat: a.lat, severity: a.severity, country: a.iso2, kind: "event", alert: a });
    }

    for (const it of items) {
      const color = COL[it.severity] || COL.info;
      const s = geo.sph(it.lon, it.lat);
      const p = geo.pla(it.lon, it.lat);
      const pos = state.morph < 1 ? geo.mix(s, p, state.morph) : p;

      if (it.kind === "country") {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.08, 0.11, 40),
          new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
            depthWrite: false, blending: THREE.AdditiveBlending
          })
        );
        ring.position.set(pos[0], pos[1], pos[2]);
        ring.userData = { lon: it.lon, lat: it.lat, t0: Math.random() * 2, color, severity: it.severity };
        markerGroup.add(ring);
        ripples.push(ring);
      }

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(it.kind === "country" ? 0.045 : 0.03, 12, 12),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95, depthWrite: false })
      );
      core.position.set(pos[0], pos[1], pos[2]);
      core.userData = { lon: it.lon, lat: it.lat, core: true };
      markerGroup.add(core);
    }
    colorLandByAlerts();
  }

  function updateMarkerPositions(tMorph) {
    markerGroup.children.forEach((o) => {
      if (o.userData.lon == null) return;
      const s = geo.sph(o.userData.lon, o.userData.lat);
      const p = geo.pla(o.userData.lon, o.userData.lat);
      const m = geo.mix(s, p, tMorph);
      o.position.set(m[0], m[1], m[2]);
      if (!o.userData.core) {
        // align ring to surface
        if (tMorph < 0.85) {
          o.lookAt(0, 0, 0);
        } else {
          o.rotation.set(-Math.PI / 2, 0, 0);
        }
      }
    });
  }

  function camForMorph(t, extraYaw, zoom, focus) {
    const globePos = new THREE.Vector3(0, 0.15, 6.35);
    const mapPos = mobile ? new THREE.Vector3(0.15, 9.4, 12.4) : new THREE.Vector3(0.4, 6.6, 8.4);
    if (focus) {
      mapPos.set(focus.x + 0.15, 2.8 / zoom + 1.2, focus.z + 3.4 / zoom);
    } else {
      mapPos.x += Math.sin(extraYaw) * 0.8;
      mapPos.z += (zoom - 1) * -2.2;
      mapPos.y += (zoom - 1) * -1.4;
    }
    const pos = globePos.clone().lerp(mapPos, t);
    camera.position.copy(pos);
    const look = new THREE.Vector3(0, (1 - t) * 0.05, 0);
    if (focus) look.set(focus.x, 0, focus.z);
    camera.lookAt(look);
  }

  function currentFocus() {
    if (!state.selected) return null;
    const pack = state.countries[state.selected];
    if (!pack || !pack.alerts.length) {
      const f = geo.findByIso2(state.selected);
      if (!f) return null;
      const p = geo.pla(f.centroid[0], f.centroid[1]);
      return { x: p[0], y: p[1], z: p[2] };
    }
    // center on alerts of this country
    let sx = 0, sz = 0, n = 0;
    for (const a of pack.alerts) {
      if (!isFinite(a.lon)) continue;
      const p = geo.pla(a.lon, a.lat);
      sx += p[0]; sz += p[2]; n++;
    }
    if (!n) return null;
    return { x: sx / n, y: 0, z: sz / n };
  }

  /* ---------- HUD ---------- */
  function cardHTML(a) {
    const sev = a.severity || "info";
    return (
      '<button type="button" class="card sev-' + sev + '" data-id="' + a.id + '" data-iso="' + a.iso2 + '" role="listitem">' +
        '<span class="card-icon" aria-hidden="true">' + (a.icon || "•") + "</span>" +
        "<div>" +
          '<p class="card-kicker">' + (a.typeLabel || "") + " · " + (sev === "danger" ? "Danger" : sev === "watch" ? "Vigilance" : "Info") + "</p>" +
          '<p class="card-title">' + escapeHtml(a.title) + "</p>" +
          '<p class="card-meta">' + escapeHtml(a.countryName || "") + (a.extra ? " · " + escapeHtml(a.extra) : "") + (a.time ? " · " + fmtWhen(a.time) : "") + "</p>" +
        "</div>" +
      "</button>"
    );
  }

  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function renderFeed(into, list) {
    if (!into) return;
    if (!list.length) {
      into.innerHTML = '<p class="card-meta">Aucune alerte transmise par les sources pour le moment.</p>';
      return;
    }
    into.innerHTML = list.map(cardHTML).join("");
  }

  function renderSources() {
    const ul = $("sources");
    if (!ul) return;
    ul.innerHTML = state.sources.map((s) => {
      const cls = s.ok ? "ok" : (state.fromCache ? "cache" : "ko");
      const st = s.ok ? "en ligne" : (state.fromCache ? "cache" : "indisponible");
      return "<li><span>" + escapeHtml(s.label) + "<br><span class='tiny'>" + escapeHtml(s.detail || "") + "</span></span><span class='" + cls + "'>" + st + "</span></li>";
    }).join("");
  }

  function renderCats() {
    const box = $("cats");
    if (!box) return;
    const counts = {};
    let max = 1;
    for (const a of state.alerts) {
      const k = a.type || "autre";
      counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > max) max = counts[k];
    }
    const keys = Object.keys(data.TYPES);
    box.innerHTML = keys.filter((k) => counts[k]).map((k) => {
      const n = counts[k];
      const w = Math.max(8, Math.round(100 * n / max));
      return '<div class="cat"><span>' + data.TYPES[k].label + "</span><div class='bar'><span style='width:" + w + "%'></span></div><span>" + n + "</span></div>";
    }).join("") || "<p class='tiny'>Pas encore de catégories.</p>";
  }

  function renderTimeline() {
    const box = $("timeline");
    if (!box) return;
    // 8 bins of 3 hours in Europe/Paris current day
    const now = new Date();
    const start = startOfParisDay(now);
    const bins = new Array(8).fill(0);
    for (const a of state.alerts) {
      if (!a.time) continue;
      const idx = Math.floor((a.time - start) / (3 * 60 * 60 * 1000));
      if (idx >= 0 && idx < 8) bins[idx]++;
    }
    const max = Math.max(1, ...bins);
    box.innerHTML = bins.map((n, i) => {
      const h = 8 + Math.round(56 * n / max);
      const label = String(i * 3).padStart(2, "0");
      return '<div class="tl-col" title="' + n + '"><div class="bar" style="height:' + (n ? h : 2) + 'px;opacity:' + (n ? 1 : 0.25) + '"></div><span>' + label + "</span></div>";
    }).join("");
  }

  function startOfParisDay(now) {
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
    const day = fmt.format(now); // YYYY-MM-DD
    // Find UTC timestamp for 00:00 in Paris by probing
    let t = Date.parse(day + "T00:00:00Z") - 2 * 3600 * 1000;
    const fmtH = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" });
    for (let i = 0; i < 8; i++) {
      const parts = fmtH.formatToParts(new Date(t));
      const val = (n) => parts.find((p) => p.type === n).value;
      const d = val("year") + "-" + val("month") + "-" + val("day");
      const hm = val("hour") + ":" + val("minute");
      if (d === day && hm === "00:00") return t;
      if (d < day) t += 30 * 60 * 1000;
      else t -= 30 * 60 * 1000;
    }
    return Date.parse(day + "T00:00:00+01:00");
  }

  function renderCounters() {
    const alerts = state.alerts;
    const danger = alerts.filter((a) => a.severity === "danger").length;
    const watch = alerts.filter((a) => a.severity === "watch").length;
    const countries = Object.keys(state.countries).filter((k) => k !== "XX").length;
    $("count-total").textContent = String(alerts.length);
    $("count-countries").textContent = String(countries);
    $("count-danger").textContent = String(danger);
    $("count-watch").textContent = String(watch);
  }

  function renderAllHUD() {
    renderCounters();
    renderFeed($("feed"), state.alerts);
    renderSources();
    renderCats();
    renderTimeline();
    renderFeed($("sheet-feed"), state.alerts);
    const stats = $("sheet-stats");
    if (stats) {
      stats.innerHTML = $("panel-right").innerHTML;
    }
    bindCardClicks(document);
  }

  function bindCardClicks(root) {
    root.querySelectorAll(".card[data-iso]").forEach((btn) => {
      btn.addEventListener("click", () => selectCountry(btn.getAttribute("data-iso"), btn.getAttribute("data-id")));
    });
  }

  function selectCountry(iso2, alertId) {
    if (!iso2) return;
    state.selected = iso2;
    interactUntil = performance.now() + 20000;
    state.userZoom = Math.max(state.userZoom, 1.6);
    const pack = state.countries[iso2];
    const pop = $("country-pop");
    const body = $("country-pop-body");
    const name = (pack && pack.name) || geo.countryName(iso2);
    const list = pack ? pack.alerts : state.alerts.filter((a) => a.iso2 === iso2);
    body.innerHTML = "<h3>" + escapeHtml(name) + "</h3>" +
      (list.length ? "<div class='pop-feed'>" + list.map(cardHTML).join("") + "</div>"
        : "<p class='tiny'>Aucune alerte recensée pour ce pays aujourd'hui.</p>");
    pop.hidden = false;
    bindCardClicks(body);
    if (fallback2d) draw2d();
  }

  function clearSelection() {
    state.selected = null;
    $("country-pop").hidden = true;
    if (fallback2d) draw2d();
  }

  /* ---------- picking ---------- */
  function pickAt(clientX, clientY) {
    if (state.morph < 0.7 && state.webgl) return;
    // Project click onto the map plane y=0
    if (state.webgl && camera) {
      const ndc = new THREE.Vector2((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const hit = new THREE.Vector3();
      if (ray.ray.intersectPlane(plane, hit)) {
        const lon = hit.x / geo.PLAN;
        const lat = -hit.z / geo.PLAN;
        if (lon >= -180 && lon <= 180 && lat >= -85 && lat <= 85) {
          const loc = geo.locate(lon, lat);
          if (loc && loc.iso2 && loc.iso2 !== "XX") selectCountry(loc.iso2);
          else clearSelection();
          return;
        }
      }
    }
  }

  function bindInteraction() {
    let lastX = 0, lastY = 0, moving = false, pointers = new Map();

    function onDown(e) {
      if (e.target.closest && e.target.closest(".panel, .sheet, .country-pop, .skip, button, a")) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lastX = e.clientX; lastY = e.clientY; moving = false;
      state.dragging = true;
      interactUntil = performance.now() + 12000;
      if (canvas) canvas.setPointerCapture(e.pointerId);
    }
    function onMove(e) {
      if (!pointers.has(e.pointerId)) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moving = true;
      lastX = e.clientX; lastY = e.clientY;
      if (pointers.size === 1 && state.morph > 0.5) {
        state.userOrbit += dx * 0.004;
      }
      if (pointers.size === 2) {
        const arr = [...pointers.values()];
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const arr2 = [...pointers.values()];
        const d0 = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
        const d1 = Math.hypot(arr2[0].x - arr2[1].x, arr2[0].y - arr2[1].y);
        if (d0 > 0 && d1 > 0) {
          state.userZoom = Math.min(3.2, Math.max(0.7, state.userZoom * (d1 / d0)));
        }
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        state.dragging = false;
        if (!moving) pickAt(e.clientX, e.clientY);
      }
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("wheel", (e) => {
      if (e.target.closest && e.target.closest(".panel, .sheet, .country-pop")) return;
      e.preventDefault();
      const d = e.deltaY > 0 ? 0.92 : 1.08;
      state.userZoom = Math.min(3.2, Math.max(0.7, state.userZoom * d));
      interactUntil = performance.now() + 12000;
    }, { passive: false });

    $("pop-close").addEventListener("click", clearSelection);
    const skip = $("skip");
    skip.addEventListener("click", () => { state.morph = 1; state.introDone = true; skip.hidden = true; });
    if (reduced) skip.hidden = true;

    const sheet = $("sheet");
    $("sheet-handle").addEventListener("click", () => {
      const open = sheet.classList.toggle("is-open");
      $("sheet-handle").setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.querySelectorAll(".sheet-tabs .tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".sheet-tabs .tab").forEach((t) => t.classList.toggle("is-on", t === tab));
        document.querySelectorAll(".sheet-panel").forEach((p) => p.classList.toggle("is-on", p.getAttribute("data-panel") === tab.getAttribute("data-tab")));
      });
    });

    window.addEventListener("resize", onResize);
  }

  function onResize() {
    if (renderer && camera) {
      renderer.setSize(innerWidth, innerHeight, false);
      camera.aspect = innerWidth / innerHeight;
      camera.updateProjectionMatrix();
    }
    if (fallback2d) {
      const c = fallback2d;
      const r = Math.min(2, window.devicePixelRatio || 1);
      c.width = innerWidth * r;
      c.height = innerHeight * r;
      draw2d();
    }
  }

  /* ---------- 2D fallback ---------- */
  function start2d() {
    state.webgl = false;
    $("scene").style.display = "none";
    const host = $("map2d");
    host.hidden = false;
    const c = document.createElement("canvas");
    host.appendChild(c);
    fallback2d = c;
    onResize();
    $("skip").hidden = true;
    $("legend").querySelector(".hint").textContent = "Carte 2D — WebGL indisponible";
    c.addEventListener("click", (e) => {
      const r = c.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const lon = x * 360 - 180;
      const lat = 90 - y * 180;
      const loc = geo.locate(lon, lat);
      if (loc && loc.iso2 && loc.iso2 !== "XX") selectCountry(loc.iso2);
      else clearSelection();
    });
    draw2d();
  }

  function draw2d() {
    const c = fallback2d;
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    ctx.fillStyle = "#030508";
    ctx.fillRect(0, 0, w, h);
    const proj = (lon, lat) => [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
    ctx.lineWidth = Math.max(1, w / 1400);
    ctx.strokeStyle = "rgba(200,235,255,0.75)";
    const rings = geo.borderRings();
    ctx.beginPath();
    for (const ring of rings) {
      const coords = ring.coords;
      let first = true, prev;
      for (let i = 0; i < coords.length; i++) {
        if (prev && Math.abs(coords[i][0] - prev[0]) > 90) { first = true; }
        const p = proj(coords[i][0], coords[i][1]);
        if (first) { ctx.moveTo(p[0], p[1]); first = false; }
        else ctx.lineTo(p[0], p[1]);
        prev = coords[i];
      }
    }
    ctx.stroke();
    for (const a of state.alerts) {
      if (!isFinite(a.lon)) continue;
      const p = proj(a.lon, a.lat);
      const col = a.severity === "danger" ? "#ff4d5e" : a.severity === "watch" ? "#ffc14a" : "#3cff7a";
      ctx.beginPath();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.6;
      ctx.arc(p[0], p[1], Math.max(10, w * 0.012), 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p[0], p[1], Math.max(3, w * 0.003), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------- animation loop ---------- */
  function frame(now) {
    requestAnimationFrame(frame);
    if (!animStart) animStart = now;
    const elapsed = (now - animStart) / 1000;
    const dt = Math.min(0.05, (now - lastTick) / 1000 || 0.016);
    lastTick = now;

    tickClock();

    if (state.webgl && renderer) {
      if (!state.introDone) {
        // 0-0.8 hold globe, 0.8-2.8 morph
        let t = 0;
        if (elapsed > 0.7) t = easeInOut(Math.min(1, (elapsed - 0.7) / 2.1));
        state.morph = t;
        applyMorph(t);
        if (lensGroup) {
          lensGroup.rotation.z += dt * 0.35;
          if (lensGroup.userData.spin) lensGroup.userData.spin.rotation.z -= dt * 0.15;
          const sc = 1 + t * 1.8;
          lensGroup.scale.setScalar(1 + t * 0.15);
          lensGroup.children.forEach(() => {});
          const op = 1 - Math.max(0, (t - 0.55) / 0.45);
          lensGroup.traverse((o) => {
            if (o.material && o.material.opacity != null && o.userData._baseOp == null) o.userData._baseOp = o.material.opacity;
            if (o.material && o.userData._baseOp != null) o.material.opacity = o.userData._baseOp * op;
          });
          if (t >= 1) { lensGroup.visible = false; }
        }
        if (t >= 1) {
          state.introDone = true;
          $("skip").hidden = true;
          if (lensGroup) lensGroup.visible = false;
        }
      }

      if (stars) stars.rotation.y += dt * 0.003;
      updateMarkerPositions(state.morph);

      if (!reduced) {
        ripples.forEach((r) => {
          const phase = ((now / 1000 + r.userData.t0) % 2.4) / 2.4;
          const sc = 1 + phase * 3.4;
          r.scale.set(sc, sc, sc);
          r.material.opacity = 0.85 * (1 - phase);
        });
      }

      const focus = state.morph > 0.75 ? currentFocus() : null;
      let yaw = state.userOrbit;
      if (state.introDone && !state.selected && !state.dragging && now > interactUntil && !reduced) {
        driftT += dt;
        yaw += Math.sin(driftT * 0.18) * 0.22;
      }
      camForMorph(state.morph, yaw, state.userZoom, focus);
      renderer.render(scene, camera);
    } else if (fallback2d && !reduced) {
      // occasional redraw not needed; static 2d
    }
  }

  /* ---------- boot ---------- */
  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    bindInteraction();

    const status = $("load-status");
    try {
      const [iso, topo] = await Promise.all([
        fetch("data/iso.json").then((r) => { if (!r.ok) throw new Error("iso"); return r.json(); }),
        fetch("data/countries-110m.json").then((r) => { if (!r.ok) throw new Error("carte"); return r.json(); })
      ]);
      geo.loadIso(iso);
      geo.loadTopology(topo);
    } catch (err) {
      status.textContent = "Impossible de charger la carte de base.";
      return;
    }

    if (hasWebGL() && window.THREE) {
      try { buildScene(); }
      catch (err) { console.warn(err); start2d(); }
    } else {
      start2d();
    }

    requestAnimationFrame(frame);

    try {
      const pack = await data.loadAll();
      state.alerts = pack.alerts;
      state.sources = pack.sources;
      state.at = pack.at;
      state.fromCache = pack.fromCache;
      state.countries = data.byCountry(pack.alerts);
      renderAllHUD();
      if (state.webgl) addMarkers();
      else draw2d();
      const failed = pack.sources.filter((s) => !s.ok).length;
      if (pack.fromCache) status.textContent = "Sources injoignables — affichage du dernier cache.";
      else if (failed) status.textContent = failed + " source" + (failed > 1 ? "s" : "") + " indisponible" + (failed > 1 ? "s" : "") + " — le reste est à jour.";
      else status.textContent = pack.alerts.length + " alerte" + (pack.alerts.length > 1 ? "s" : "") + " synchronisée" + (pack.alerts.length > 1 ? "s" : "") + ".";
      setTimeout(() => { status.hidden = true; }, SHOT ? 200 : 4200);
    } catch (err) {
      status.textContent = "Échec du chargement des alertes.";
    }

    state.ready = true;
    window.__ALERTES_READY = true;
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
