/* ALERTES v2 — globe 3D rotatif, zoom pays et villes en relief */
(function () {
  const geo = window.ALERTES.geo;
  const data = window.ALERTES.data;
  const $ = (id) => document.getElementById(id);

  const TZ = "Europe/Paris";
  const COL = { info: 0x3cff7a, watch: 0xffc14a, danger: 0xff4d5e, cyan: 0x3ff0ff, line: 0xc8ebff };
  const TURN_SEC = 60;
  let DIST_HOME = 6.05;
  const DIST_MIN = 2.68;
  const DIST_MAX = 9.4;
  const params = new URLSearchParams(location.search);
  const SHOT = params.has("shot") || params.has("preview");
  const FOCUS_ISO = (params.get("focus") || params.get("pays") || params.get("iso") || "").toUpperCase();
  const reduced = SHOT || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const mobile = window.matchMedia("(max-width: 860px)").matches || ("ontouchstart" in window && innerWidth < 1100);
  if (mobile) DIST_HOME = 7.05;

  let state = {
    alerts: [],
    countries: {},
    sources: [],
    at: 0,
    fromCache: false,
    selected: null,
    selectedAlert: null,
    intro: reduced ? 1 : 0,
    introDone: reduced,
    lon: 15,
    lat: 16,
    dist: DIST_HOME,
    velLon: 0,
    velLat: 0,
    dragging: false,
    ready: false,
    webgl: true,
    pausedUntil: 0,
    fly: null
  };

  let renderer, scene, camera, canvas, earthHit, stars, lensGroup;
  let landPtsGeo, markerGroup, cityGroup, atmosphere;
  let ripples = [];
  let fallback2d = null;
  let animStart = 0;
  let lastTick = 0;
  let tmpV = null, tmpV2 = null, raycaster = null, pointerNdc = null;

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

  function wrapLon(lon) {
    return ((lon + 180) % 360 + 360) % 360 - 180;
  }

  function clampLat(lat) {
    return Math.max(-82, Math.min(82, lat));
  }

  function clampDist(d) {
    return Math.max(DIST_MIN, Math.min(DIST_MAX, d));
  }

  function lonLatFromVec(x, y, z) {
    const r = Math.sqrt(x * x + y * y + z * z) || 1;
    return { lon: Math.atan2(x, z) * 180 / Math.PI, lat: Math.asin(Math.max(-1, Math.min(1, y / r))) * 180 / Math.PI };
  }

  function zoomFactor() {
    return DIST_HOME / state.dist;
  }

  /* ---------- scene ---------- */
  function atmosphereMat() {
    return new THREE.ShaderMaterial({
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        color: { value: new THREE.Color(0x3ff0ff) }
      },
      vertexShader: [
        "varying vec3 vNormal;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  vNormal = normalize(mat3(modelMatrix) * normal);",
        "  vec4 wp = modelMatrix * vec4(position, 1.0);",
        "  vWorldPos = wp.xyz;",
        "  gl_Position = projectionMatrix * viewMatrix * wp;",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform vec3 color;",
        "varying vec3 vNormal;",
        "varying vec3 vWorldPos;",
        "void main() {",
        "  vec3 viewDir = normalize(cameraPosition - vWorldPos);",
        "  float f = pow(1.0 - abs(dot(viewDir, normalize(vNormal))), 2.15);",
        "  gl_FragColor = vec4(color, 1.0) * (0.18 + 1.15 * f);",
        "}"
      ].join("\n")
    });
  }

  function buildLens() {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.95, depthWrite: false });
    const dim = new THREE.MeshBasicMaterial({ color: COL.cyan, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
    g.add(new THREE.Mesh(new THREE.TorusGeometry(2.55, 0.018, 8, 96), mat));
    g.add(new THREE.Mesh(new THREE.TorusGeometry(2.78, 0.008, 8, 96), dim));
    const ticks = new THREE.Group();
    for (let i = 0; i < 72; i++) {
      const h = i % 6 === 0 ? 0.16 : 0.07;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.012, h, 0.012), i % 6 === 0 ? mat : dim);
      const a = (i / 72) * Math.PI * 2;
      m.position.set(Math.cos(a) * 2.66, Math.sin(a) * 2.66, 0);
      m.rotation.z = a + Math.PI / 2;
      ticks.add(m);
    }
    g.add(ticks);
    const arcGeo = new THREE.TorusGeometry(3.05, 0.01, 6, 64, Math.PI * 0.42);
    for (let i = 0; i < 3; i++) {
      const arc = new THREE.Mesh(arcGeo, mat);
      arc.rotation.z = i * (Math.PI * 2 / 3);
      arc.rotation.x = 0.18;
      g.add(arc);
    }
    g.add(new THREE.Mesh(new THREE.RingGeometry(2.35, 2.42, 80), dim));
    g.userData.spin = ticks;
    return g;
  }

  function sphereLineGeometry(coordsList) {
    const pos = [];
    for (const coords of coordsList) {
      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i], b = coords[i + 1];
        if (Math.abs(a[0] - b[0]) > 90) continue;
        const sa = geo.sph(a[0], a[1]), sb = geo.sph(b[0], b[1]);
        pos.push(sa[0], sa[1], sa[2], sb[0], sb[1], sb[2]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }

  function buildScene() {
    canvas = $("scene");
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: !mobile, alpha: false, powerPreference: "high-performance" });
    renderer.setClearColor(0x030508, 1);
    renderer.setPixelRatio(Math.min(mobile ? 1.5 : 2, window.devicePixelRatio || 1));
    renderer.setSize(innerWidth, innerHeight, false);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, 0.08, 80);
    tmpV = new THREE.Vector3();
    tmpV2 = new THREE.Vector3();
    raycaster = new THREE.Raycaster();
    pointerNdc = new THREE.Vector2();

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

    const R = geo.R_GLOBE;
    const ocean = new THREE.Mesh(
      new THREE.SphereGeometry(R * 0.995, 64, 48),
      new THREE.MeshBasicMaterial({ color: 0x071018 })
    );
    scene.add(ocean);
    earthHit = new THREE.Mesh(
      new THREE.SphereGeometry(R, 48, 32),
      new THREE.MeshBasicMaterial({ visible: false })
    );
    scene.add(earthHit);

    atmosphere = new THREE.Mesh(new THREE.SphereGeometry(R * 1.085, 48, 32), atmosphereMat());
    scene.add(atmosphere);

    // graticule
    const grat = [];
    for (let lat = -60; lat <= 60; lat += 30) {
      const c = [];
      for (let lon = -180; lon <= 180; lon += 5) c.push([lon, lat]);
      grat.push(c);
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const c = [];
      for (let lat = -80; lat <= 80; lat += 5) c.push([lon, lat]);
      grat.push(c);
    }
    scene.add(new THREE.LineSegments(sphereLineGeometry(grat), new THREE.LineBasicMaterial({
      color: 0x1b3a48, transparent: true, opacity: 0.45, depthWrite: false
    })));

    const rings = geo.borderRings();
    const borderGeo = sphereLineGeometry(rings.map((r) => r.coords));
    scene.add(new THREE.LineSegments(borderGeo, new THREE.LineBasicMaterial({
      color: COL.line, transparent: true, opacity: 0.82, depthWrite: false
    })));
    scene.add(new THREE.LineSegments(borderGeo.clone(), new THREE.LineBasicMaterial({
      color: COL.cyan, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending
    })));

    const dots = geo.sampleLandDots(mobile ? 3.1 : 2.15);
    const dS = [];
    for (const p of dots) {
      const s = geo.sph(p[0], p[1]);
      dS.push(s[0], s[1], s[2]);
    }
    landPtsGeo = new THREE.BufferGeometry();
    landPtsGeo.setAttribute("position", new THREE.Float32BufferAttribute(dS, 3));
    landPtsGeo.userData.ll = dots;
    scene.add(new THREE.Points(landPtsGeo, new THREE.PointsMaterial({
      color: 0x9ad6ea, size: mobile ? 0.03 : 0.028, sizeAttenuation: true,
      transparent: true, opacity: 0.55, depthWrite: false
    })));

    lensGroup = buildLens();
    scene.add(lensGroup);
    if (reduced) lensGroup.visible = false;

    markerGroup = new THREE.Group();
    scene.add(markerGroup);
    cityGroup = new THREE.Group();
    scene.add(cityGroup);

    applyCamera(true);
  }

  function applyCamera(immediate) {
    const introBoost = (1 - state.intro) * 1.35;
    const dist = state.dist + introBoost;
    const p = geo.sph(state.lon, state.lat, dist);
    camera.position.set(p[0], p[1], p[2]);
    camera.up.set(0, 1, 0);
    if (state.selected && state.look && state.intro >= 1) {
      camera.lookAt(state.look.x, state.look.y, state.look.z);
    } else {
      camera.lookAt(0, 0, 0);
    }
    if (immediate) camera.updateMatrixWorld();
  }

  function colorLandByAlerts() {
    if (!landPtsGeo || !landPtsGeo.userData.ll) return;
    const dots = landPtsGeo.userData.ll;
    const cols = new Float32Array(dots.length * 3);
    const base = new THREE.Color(0x7fb8c9);
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
    scene.traverse((obj) => {
      if (obj.geometry === landPtsGeo && obj.material) {
        obj.material.vertexColors = true;
        obj.material.needsUpdate = true;
      }
    });
  }

  function clearGroup(g) {
    while (g && g.children.length) {
      const o = g.children[0];
      g.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material.dispose();
      }
    }
  }

  function addMarkers() {
    clearGroup(markerGroup);
    ripples = [];
    const used = Object.create(null);
    const items = [];
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

    const R = geo.R_GLOBE;
    for (const it of items) {
      const color = COL[it.severity] || COL.info;
      const s = geo.sph(it.lon, it.lat, R * 1.01);

      if (it.kind === "country") {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(0.045, 0.062, 40),
          new THREE.MeshBasicMaterial({
            color: color, transparent: true, opacity: 0.9, side: THREE.DoubleSide,
            depthWrite: false, blending: THREE.AdditiveBlending
          })
        );
        ring.position.set(s[0], s[1], s[2]);
        ring.lookAt(0, 0, 0);
        ring.userData = { lon: it.lon, lat: it.lat, t0: Math.random() * 2, severity: it.severity };
        markerGroup.add(ring);
        ripples.push(ring);
      }

      const core = new THREE.Mesh(
        new THREE.SphereGeometry(it.kind === "country" ? 0.038 : 0.024, 12, 12),
        new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.95, depthWrite: false })
      );
      core.position.set(s[0], s[1], s[2]);
      core.userData = { lon: it.lon, lat: it.lat, core: true };
      markerGroup.add(core);
    }
    colorLandByAlerts();
  }

  function towerHeight(pop) {
    const p = Math.max(1, pop || 1);
    return 0.035 + 0.22 * (Math.log10(p) / 7);
  }

  function focusTarget(iso2, alertId) {
    const pack = state.countries[iso2];
    const feat = geo.findByIso2(iso2);
    const list = pack ? pack.alerts : [];
    const cities = geo.citiesFor(iso2);
    const chosen = (alertId && list.find((a) => a.id === alertId)) || list[0];
    let lon, lat;
    if (cities.length) {
      lon = cities.reduce((s, c) => s + c.lon, 0) / cities.length;
      lat = cities.reduce((s, c) => s + c.lat, 0) / cities.length;
    } else if (feat) {
      lon = feat.centroid[0]; lat = feat.centroid[1];
    } else if (chosen && isFinite(chosen.lon)) {
      lon = chosen.lon; lat = chosen.lat;
    } else return null;
    if (alertId && chosen && isFinite(chosen.lon)) {
      lon = lon * 0.6 + chosen.lon * 0.4;
      lat = lat * 0.6 + chosen.lat * 0.4;
    }

    let span = 10;
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180, nBox = 0;
    const bump = (lo, la) => {
      if (!isFinite(lo) || !isFinite(la)) return;
      if (la < minLa) minLa = la;
      if (la > maxLa) maxLa = la;
      if (lo < minLo) minLo = lo;
      if (lo > maxLo) maxLo = lo;
      nBox++;
    };
    list.forEach((a) => bump(a.lon, a.lat));
    cities.forEach((c) => bump(c.lon, c.lat));
    if (nBox) span = Math.max(6, Math.max(maxLa - minLa, maxLo - minLo));
    else if (feat && feat.bbox) {
      const b = feat.bbox;
      span = Math.max(6, Math.min(40, Math.max(b[3] - b[1], b[2] - b[0])));
    }
    const dist = clampDist(2.85 + span * 0.062);
    return { lon: wrapLon(lon), lat: clampLat(lat), dist, look: { x: 0, y: 0, z: 0 }, alert: chosen };
  }

  function startFly(target) {
    if (!target) return;
    if (reduced) {
      state.lon = target.lon;
      state.lat = target.lat;
      state.dist = target.dist;
      state.look = target.look;
      state.fly = null;
      return;
    }
    let dLon = wrapLon(target.lon - state.lon);
    state.fly = {
      t0: performance.now(),
      dur: 900,
      from: { lon: state.lon, lat: state.lat, dist: state.dist, look: state.look ? { ...state.look } : { x: 0, y: 0, z: 0 } },
      dLon,
      to: target
    };
  }

  function buildCities(iso2) {
    clearGroup(cityGroup);
    const host = $("city-labels");
    if (host) host.innerHTML = "";
    const cities = geo.citiesFor(iso2).slice();
    const pack = state.countries[iso2];
    const alerts = pack ? pack.alerts : [];
    // Always include alert locations as markers even if not in the city file
    alerts.forEach((a) => {
      if (!isFinite(a.lon)) return;
      const near = cities.some((c) => Math.abs(c.lat - a.lat) < 0.35 && Math.abs(c.lon - a.lon) < 0.35);
      if (near) {
        cities.forEach((c) => {
          if (Math.abs(c.lat - a.lat) < 0.35 && Math.abs(c.lon - a.lon) < 0.35) c.alert = true;
        });
      }
    });
    if (!cities.length) return;

    const R = geo.R_GLOBE;
    const maxPop = Math.max(1, ...cities.map((c) => c.pop || 0));
    const yUp = new THREE.Vector3(0, 1, 0);
    cities.forEach((c) => {
      const h = c.alert && !c.pop ? 0.09 : towerHeight(c.pop);
      const w = c.cap ? 0.028 : 0.02;
      const color = c.alert ? (COL[(pack && pack.max) || "watch"]) : (c.cap ? COL.cyan : 0xd8f4ff);
      const geom = new THREE.BoxGeometry(w, h, w);
      const mat = new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.92,
        depthWrite: false
      });
      const mesh = new THREE.Mesh(geom, mat);
      const n = new THREE.Vector3(...geo.sph(c.lon, c.lat, 1));
      mesh.position.copy(n).multiplyScalar(R + h / 2);
      mesh.quaternion.setFromUnitVectors(yUp, n);
      mesh.userData.city = c;
      cityGroup.add(mesh);

      // thin glow twin
      const glow = new THREE.Mesh(
        new THREE.BoxGeometry(w * 1.55, h * 1.04, w * 1.55),
        new THREE.MeshBasicMaterial({
          color, transparent: true, opacity: 0.22,
          depthWrite: false, blending: THREE.AdditiveBlending
        })
      );
      glow.position.copy(mesh.position);
      glow.quaternion.copy(mesh.quaternion);
      cityGroup.add(glow);
    });

    if (host) {
      // keep a reasonable number of labels
      const ranked = cities.slice().sort((a, b) => (b.cap - a.cap) || (b.alert ? 1 : 0) - (a.alert ? 1 : 0) || (b.pop || 0) - (a.pop || 0));
      const keep = ranked.slice(0, mobile ? 10 : 16);
      keep.forEach((c) => {
        const el = document.createElement("div");
        el.className = "city-lab" + (c.cap ? " is-cap" : "") + (c.alert ? " is-alert" : "");
        const pop = c.pop ? (c.pop >= 1e6 ? (c.pop / 1e6).toFixed(1).replace(".0", "") + " M" : (Math.round(c.pop / 1000) + " k")) : "";
        el.innerHTML = escapeHtml(c.n) + (pop ? "<small>" + pop + "</small>" : "");
        el.dataset.lon = c.lon;
        el.dataset.lat = c.lat;
        el.dataset.h = String(c.alert && !c.pop ? 0.09 : towerHeight(c.pop));
        host.appendChild(el);
      });
    }
  }

  function updateCityLabels() {
    const host = $("city-labels");
    if (!host || !camera) return;
    const w = innerWidth, h = innerHeight;
    const camDir = tmpV.copy(camera.position).normalize();
    const placed = [];
    host.querySelectorAll(".city-lab").forEach((el) => {
      const lon = Number(el.dataset.lon), lat = Number(el.dataset.lat), height = Number(el.dataset.h) || 0.05;
      const p = geo.sph(lon, lat, geo.R_GLOBE + height);
      tmpV2.set(p[0], p[1], p[2]);
      const nrm = tmpV2.clone().normalize();
      if (nrm.dot(camDir) < 0.12) { el.style.display = "none"; return; }
      tmpV2.project(camera);
      if (tmpV2.z > 1) { el.style.display = "none"; return; }
      const x = (tmpV2.x * 0.5 + 0.5) * w;
      const y = (-tmpV2.y * 0.5 + 0.5) * h;
      if (x < 8 || x > w - 8 || y < 8 || y > h - 8) { el.style.display = "none"; return; }
      // simple collision
      let clash = false;
      for (const q of placed) {
        if (Math.abs(q.x - x) < 70 && Math.abs(q.y - y) < 16) { clash = true; break; }
      }
      if (clash && !el.classList.contains("is-cap") && !el.classList.contains("is-alert")) {
        el.style.display = "none"; return;
      }
      placed.push({ x, y });
      el.style.display = "block";
      el.style.transform = "translate(" + Math.round(x) + "px, " + Math.round(y) + "px) translate(-50%, -120%)";
    });
  }

  function clearCities() {
    clearGroup(cityGroup);
    const host = $("city-labels");
    if (host) host.innerHTML = "";
    state.look = null;
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
    const day = fmt.format(now);
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
    if (stats) stats.innerHTML = $("panel-right").innerHTML;
    bindCardClicks(document);
  }

  function bindCardClicks(root) {
    root.querySelectorAll(".card[data-iso]").forEach((btn) => {
      btn.addEventListener("click", () => selectCountry(btn.getAttribute("data-iso"), btn.getAttribute("data-id")));
    });
  }

  function selectCountry(iso2, alertId) {
    if (!iso2 || iso2 === "XX") return;
    state.selected = iso2;
    state.selectedAlert = alertId || null;
    state.velLon = 0;
    state.velLat = 0;
    const pack = state.countries[iso2];
    const pop = $("country-pop");
    const body = $("country-pop-body");
    const name = (pack && pack.name) || geo.countryName(iso2);
    const list = pack ? pack.alerts : state.alerts.filter((a) => a.iso2 === iso2);
    const nCities = geo.citiesFor(iso2).length;
    body.innerHTML = "<h3>" + escapeHtml(name) + "</h3>" +
      (nCities ? "<p class='tiny'>" + nCities + " ville" + (nCities > 1 ? "s" : "") + " principales — hauteur selon la population</p>" : "") +
      (list.length ? "<div class='pop-feed'>" + list.map(cardHTML).join("") + "</div>"
        : "<p class='tiny'>Aucune alerte recensée pour ce pays aujourd'hui.</p>");
    pop.hidden = false;
    const back = $("back-globe");
    if (back) back.hidden = false;
    bindCardClicks(body);
    const target = focusTarget(iso2, alertId);
    if (state.webgl) {
      if (target) startFly(target);
      buildCities(iso2);
    } else {
      if (target) {
        state.lon = target.lon; state.lat = target.lat; state.dist = target.dist;
      }
    }
    if (fallback2d) { /* redraw in loop */ }
  }

  function clearSelection() {
    state.selected = null;
    state.selectedAlert = null;
    state.look = null;
    $("country-pop").hidden = true;
    const back = $("back-globe");
    if (back) back.hidden = true;
    clearCities();
    startFly({ lon: state.lon, lat: clampLat(Math.min(30, Math.max(-10, state.lat))), dist: DIST_HOME, look: { x: 0, y: 0, z: 0 } });
    state.pausedUntil = performance.now() + 1400;
  }

  function pickAt(clientX, clientY) {
    if (!state.introDone) return;
    if (state.webgl && camera && earthHit) {
      pointerNdc.set((clientX / innerWidth) * 2 - 1, -(clientY / innerHeight) * 2 + 1);
      raycaster.setFromCamera(pointerNdc, camera);
      const hits = raycaster.intersectObject(earthHit);
      if (hits.length) {
        const p = hits[0].point;
        const ll = lonLatFromVec(p.x, p.y, p.z);
        const loc = geo.locate(ll.lon, ll.lat);
        if (loc && loc.iso2 && loc.iso2 !== "XX") selectCountry(loc.iso2);
        else if (state.selected) clearSelection();
        return;
      }
    }
  }

  function pauseAuto(ms) {
    state.pausedUntil = Math.max(state.pausedUntil, performance.now() + ms);
  }

  function bindInteraction() {
    let lastX = 0, lastY = 0, moving = false, pointers = new Map();
    let lastMove = { t: 0, dx: 0, dy: 0 };

    function onDown(e) {
      if (e.target.closest && e.target.closest(".panel, .sheet, .country-pop, .skip, .back-globe, button, a")) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lastX = e.clientX; lastY = e.clientY; moving = false;
      state.dragging = true;
      state.velLon = 0; state.velLat = 0;
      pauseAuto(4000);
      if (canvas) try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    }
    function onMove(e) {
      if (!pointers.has(e.pointerId)) return;
      const dx = e.clientX - lastX, dy = e.clientY - lastY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moving = true;
      lastX = e.clientX; lastY = e.clientY;
      const now = performance.now();
      if (pointers.size === 1) {
        const k = 0.14 * (state.dist / DIST_HOME);
        state.lon = wrapLon(state.lon - dx * k);
        state.lat = clampLat(state.lat + dy * k);
        lastMove = { t: now, dx: -dx * k, dy: dy * k };
        pauseAuto(4000);
      }
      if (pointers.size === 2) {
        const arr = [...pointers.values()];
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const arr2 = [...pointers.values()];
        const d0 = Math.hypot(arr[0].x - arr[1].x, arr[0].y - arr[1].y);
        const d1 = Math.hypot(arr2[0].x - arr2[1].x, arr2[0].y - arr2[1].y);
        if (d0 > 0 && d1 > 0) state.dist = clampDist(state.dist * (d0 / d1));
        pauseAuto(4000);
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    function onUp(e) {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        state.dragging = false;
        const dt = performance.now() - lastMove.t;
        if (dt < 80 && moving) {
          state.velLon = lastMove.dx * 18;
          state.velLat = lastMove.dy * 18;
        }
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
      const d = Math.exp(e.deltaY * 0.0014);
      state.dist = clampDist(state.dist * d);
      pauseAuto(4000);
    }, { passive: false });

    $("pop-close").addEventListener("click", clearSelection);
    const back = $("back-globe");
    if (back) back.addEventListener("click", clearSelection);
    const skip = $("skip");
    skip.addEventListener("click", () => { state.intro = 1; state.introDone = true; skip.hidden = true; if (lensGroup) lensGroup.visible = false; });
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
    }
  }

  /* ---------- 2D orthographic globe fallback ---------- */
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
    c.addEventListener("click", (e) => {
      const r = c.getBoundingClientRect();
      const pr = project2d(e.clientX - r.left, true, r.width, r.height, /*invert*/ true, e.clientY - r.top);
      if (!pr || !pr.vis) { if (state.selected) clearSelection(); return; }
      const loc = geo.locate(pr.lon, pr.lat);
      if (loc && loc.iso2 && loc.iso2 !== "XX") selectCountry(loc.iso2);
      else if (state.selected) clearSelection();
    });
  }

  function project2dForward(lon, lat, W, H) {
    const k = Math.min(W, H) * (0.36 + 0.08 * (DIST_HOME / state.dist));
    const CX = W / 2, CY = H * 0.48;
    const lam = (lon - state.lon) * Math.PI / 180;
    const phi = lat * Math.PI / 180;
    const phi0 = state.lat * Math.PI / 180;
    const cosc = Math.sin(phi0) * Math.sin(phi) + Math.cos(phi0) * Math.cos(phi) * Math.cos(lam);
    const x = CX + k * Math.cos(phi) * Math.sin(lam);
    const y = CY - k * (Math.cos(phi0) * Math.sin(phi) - Math.sin(phi0) * Math.cos(phi) * Math.cos(lam));
    return { x, y, vis: cosc, k, CX, CY };
  }

  function project2d(x, invert, W, H, flag, y) {
    // invert screen point to lon/lat (approx)
    const k = Math.min(W, H) * (0.36 + 0.08 * (DIST_HOME / state.dist));
    const CX = W / 2, CY = H * 0.48;
    const X = (x - CX) / k, Y = (CY - y) / k;
    const rho = Math.sqrt(X * X + Y * Y);
    if (rho > 1) return { vis: false };
    const c = Math.asin(Math.min(1, rho));
    const phi0 = state.lat * Math.PI / 180;
    const phi = Math.asin(Math.cos(c) * Math.sin(phi0) + (Y * Math.sin(c) * Math.cos(phi0)) / (rho || 1e-9));
    const lam = Math.atan2(X * Math.sin(c), rho * Math.cos(phi0) * Math.cos(c) - Y * Math.sin(phi0) * Math.sin(c));
    return { lon: wrapLon(state.lon + lam * 180 / Math.PI), lat: phi * 180 / Math.PI, vis: true };
  }

  function draw2d() {
    const c = fallback2d;
    if (!c) return;
    const ctx = c.getContext("2d");
    const w = c.width, h = c.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#030508";
    ctx.fillRect(0, 0, w, h);
    const scale = w / innerWidth;
    const W = innerWidth, H = innerHeight;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);

    // atmosphere disc
    const sample = project2dForward(state.lon, state.lat, W, H);
    const k = sample.k, CX = sample.CX, CY = sample.CY;
    const glow = ctx.createRadialGradient(CX, CY, k * 0.7, CX, CY, k * 1.12);
    glow.addColorStop(0, "rgba(63,240,255,0)");
    glow.addColorStop(0.75, "rgba(63,240,255,0.08)");
    glow.addColorStop(1, "rgba(63,240,255,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(CX, CY, k * 1.12, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#071018";
    ctx.beginPath(); ctx.arc(CX, CY, k, 0, Math.PI * 2); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(CX, CY, k, 0, Math.PI * 2); ctx.clip();

    ctx.lineWidth = 0.8;
    ctx.strokeStyle = "rgba(200,235,255,0.75)";
    const rings = geo.borderRings();
    ctx.beginPath();
    for (const ring of rings) {
      const coords = ring.coords;
      let first = true, prevVis = false;
      for (let i = 0; i < coords.length; i++) {
        if (i && Math.abs(coords[i][0] - coords[i - 1][0]) > 90) { first = true; prevVis = false; }
        const p = project2dForward(coords[i][0], coords[i][1], W, H);
        if (p.vis < 0) { first = true; prevVis = false; continue; }
        if (first) { ctx.moveTo(p.x, p.y); first = false; }
        else ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();

    for (const a of state.alerts) {
      if (!isFinite(a.lon)) continue;
      const p = project2dForward(a.lon, a.lat, W, H);
      if (p.vis < 0.05) continue;
      const col = a.severity === "danger" ? "#ff4d5e" : a.severity === "watch" ? "#ffc14a" : "#3cff7a";
      ctx.beginPath();
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.65;
      ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    if (state.selected) {
      const cities = geo.citiesFor(state.selected);
      ctx.fillStyle = "#d8f4ff";
      ctx.font = "10px ui-monospace, monospace";
      ctx.textAlign = "center";
      cities.forEach((city) => {
        const p = project2dForward(city.lon, city.lat, W, H);
        if (p.vis < 0.15) return;
        const hh = 6 + 16 * (Math.log10(Math.max(10, city.pop)) / 7);
        ctx.fillStyle = city.cap ? "#3ff0ff" : "#d8f4ff";
        ctx.globalAlpha = 0.9;
        ctx.fillRect(p.x - 2, p.y - hh, 4, hh);
        ctx.globalAlpha = 1;
        ctx.fillText(city.n, p.x, p.y - hh - 4);
      });
    }
    ctx.restore();
    ctx.strokeStyle = "rgba(63,240,255,0.45)";
    ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(CX, CY, k, 0, Math.PI * 2); ctx.stroke();
  }

  /* ---------- animation ---------- */
  function stepFly(now) {
    const f = state.fly;
    if (!f) return;
    const t = Math.min(1, (now - f.t0) / f.dur);
    const e = easeInOut(t);
    state.lon = wrapLon(f.from.lon + f.dLon * e);
    state.lat = f.from.lat + (f.to.lat - f.from.lat) * e;
    state.dist = f.from.dist + (f.to.dist - f.from.dist) * e;
    const lk0 = f.from.look || { x: 0, y: 0, z: 0 };
    const lk1 = f.to.look || { x: 0, y: 0, z: 0 };
    state.look = {
      x: lk0.x + (lk1.x - lk0.x) * e,
      y: lk0.y + (lk1.y - lk0.y) * e,
      z: lk0.z + (lk1.z - lk0.z) * e
    };
    if (t >= 1) {
      state.lon = wrapLon(f.to.lon);
      state.lat = f.to.lat;
      state.dist = f.to.dist;
      state.look = f.to.look;
      state.fly = null;
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    if (!animStart) animStart = now;
    const elapsed = (now - animStart) / 1000;
    const dt = Math.min(0.05, (now - lastTick) / 1000 || 0.016);
    lastTick = now;
    tickClock();

    if (!state.introDone) {
      let t = 0;
      if (elapsed > 0.5) t = easeInOut(Math.min(1, (elapsed - 0.5) / 1.8));
      state.intro = t;
      if (lensGroup) {
        lensGroup.rotation.z += dt * 0.35;
        if (lensGroup.userData.spin) lensGroup.userData.spin.rotation.z -= dt * 0.15;
        lensGroup.lookAt(camera.position);
        const op = 1 - Math.max(0, (t - 0.55) / 0.45);
        lensGroup.traverse((o) => {
          if (o.material && o.material.opacity != null && o.userData._baseOp == null) o.userData._baseOp = o.material.opacity;
          if (o.material && o.userData._baseOp != null) o.material.opacity = o.userData._baseOp * op;
        });
        if (t >= 1) lensGroup.visible = false;
      }
      if (t >= 1) {
        state.introDone = true;
        $("skip").hidden = true;
        if (lensGroup) lensGroup.visible = false;
        if (FOCUS_ISO) selectCountry(FOCUS_ISO);
      }
    }

    if (state.fly) stepFly(now);

    if (!state.dragging && !state.fly && state.introDone) {
      // inertia
      if (state.velLon || state.velLat) {
        state.lon = wrapLon(state.lon + state.velLon * dt);
        state.lat = clampLat(state.lat + state.velLat * dt);
        state.velLon *= Math.pow(0.08, dt);
        state.velLat *= Math.pow(0.08, dt);
        if (Math.abs(state.velLon) < 0.2) state.velLon = 0;
        if (Math.abs(state.velLat) < 0.2) state.velLat = 0;
      }
      // auto-rotation (Cerveau : un tour en 60 s, plus lent une fois zoomé)
      if (!reduced && !state.selected && now > state.pausedUntil && !state.velLon) {
        const vl = (360 / TURN_SEC) / Math.sqrt(Math.max(0.8, zoomFactor()));
        state.lon = wrapLon(state.lon - vl * dt);
      }
    }

    if (state.webgl && renderer) {
      if (stars) stars.rotation.y += dt * 0.003;
      if (!reduced) {
        ripples.forEach((r) => {
          const phase = ((now / 1000 + r.userData.t0) % 2.4) / 2.4;
          const sc = 1 + phase * 3.4;
          r.scale.set(sc, sc, sc);
          r.material.opacity = 0.85 * (1 - phase);
        });
      }
      applyCamera();
      if (state.selected) updateCityLabels();
      renderer.render(scene, camera);
    } else if (fallback2d) {
      draw2d();
    }
  }

  /* ---------- boot ---------- */
  async function boot() {
    tickClock();
    setInterval(tickClock, 1000);
    bindInteraction();

    const status = $("load-status");
    try {
      const [iso, topo, cities] = await Promise.all([
        fetch("data/iso.json").then((r) => { if (!r.ok) throw new Error("iso"); return r.json(); }),
        fetch("data/countries-110m.json").then((r) => { if (!r.ok) throw new Error("carte"); return r.json(); }),
        fetch("data/cities.json").then((r) => r.ok ? r.json() : {}).catch(() => ({}))
      ]);
      geo.loadIso(iso);
      geo.loadTopology(topo);
      geo.loadCities(cities);
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
      const failed = pack.sources.filter((s) => !s.ok).length;
      if (pack.fromCache) status.textContent = "Sources injoignables — affichage du dernier cache.";
      else if (failed) status.textContent = failed + " source" + (failed > 1 ? "s" : "") + " indisponible" + (failed > 1 ? "s" : "") + " — le reste est à jour.";
      else status.textContent = pack.alerts.length + " alerte" + (pack.alerts.length > 1 ? "s" : "") + " synchronisée" + (pack.alerts.length > 1 ? "s" : "") + ".";
      setTimeout(() => { status.hidden = true; }, SHOT ? 200 : 4200);
      if (state.introDone && FOCUS_ISO) selectCountry(FOCUS_ISO);
    } catch (err) {
      status.textContent = "Échec du chargement des alertes.";
    }

    state.ready = true;
    window.__ALERTES_READY = true;
    window.__ALERTES_FOCUS = (iso) => selectCountry(String(iso || "").toUpperCase());
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
