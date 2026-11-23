/* ALERTES — carte, projections, résolution de pays */
(function (global) {
  const DEG = Math.PI / 180;
  const R_GLOBE = 2.18;
  const PLAN = 0.034;

  const NAMES_FR = {
    XK: "Kosovo",
    XS: "Somaliland",
    XC: "Chypre du Nord",
    XX: "En mer",
    AQ: "Antarctique",
    TW: "Taïwan",
    RU: "Russie",
    US: "États-Unis",
    GB: "Royaume-Uni",
    CD: "République démocratique du Congo",
    CG: "Congo",
    CI: "Côte d'Ivoire",
    BO: "Bolivie",
    IR: "Iran",
    LA: "Laos",
    MD: "Moldavie",
    PS: "Palestine",
    SY: "Syrie",
    VE: "Venezuela",
    FM: "Micronésie",
    KR: "Corée du Sud",
    KP: "Corée du Nord"
  };

  let iso = { num: {}, a3: {}, names: {} };
  let features = [];
  let landFeature = null;
  let display; // Intl.DisplayNames

  function sph(lon, lat, r) {
    const lam = lon * DEG;
    const ph = lat * DEG;
    const rr = r == null ? R_GLOBE : r;
    return [
      rr * Math.cos(ph) * Math.sin(lam),
      rr * Math.sin(ph),
      rr * Math.cos(ph) * Math.cos(lam)
    ];
  }

  function pla(lon, lat) {
    return [lon * PLAN, 0, -lat * PLAN];
  }

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }

  function iso2OfNumeric(id) {
    if (id == null || id === "") return null;
    const n = String(parseInt(id, 10));
    return iso.num[n] || iso.num[String(id)] || null;
  }

  function iso2OfAlpha3(a3) {
    if (!a3) return null;
    return iso.a3[String(a3).toUpperCase()] || null;
  }

  function countryName(iso2, fallback) {
    if (!iso2 || iso2 === "XX") return fallback || "En mer";
    if (NAMES_FR[iso2]) return NAMES_FR[iso2];
    try {
      if (!display) display = new Intl.DisplayNames(["fr"], { type: "region" });
      const n = display.of(iso2);
      if (n) return n;
    } catch (e) { /* ignore */ }
    return fallback || iso2;
  }

  function ringContains(ring, lon, lat) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  function featureContains(feat, lon, lat) {
    const g = feat.geometry;
    if (!g) return false;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (let p = 0; p < polys.length; p++) {
      const poly = polys[p];
      if (!poly || !poly[0] || !ringContains(poly[0], lon, lat)) continue;
      let hole = false;
      for (let k = 1; k < poly.length; k++) {
        if (ringContains(poly[k], lon, lat)) { hole = true; break; }
      }
      if (!hole) return true;
    }
    return false;
  }

  function bboxOf(feat) {
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    const g = feat.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) {
      const ring = poly[0];
      for (let i = 0; i < ring.length; i++) {
        const x = ring[i][0], y = ring[i][1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return [minX, minY, maxX, maxY];
  }

  function centroidOf(feat) {
    const b = feat.bbox || bboxOf(feat);
    // For countries crossing the antimeridian, use a vertex-mean on a split
    if (b[2] - b[0] > 180) {
      let sx = 0, sy = 0, n = 0;
      const g = feat.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) {
        const ring = poly[0];
        for (let i = 0; i < ring.length; i += 8) {
          sx += ring[i][0];
          sy += ring[i][1];
          n++;
        }
      }
      return n ? [sx / n, sy / n] : [0, 0];
    }
    return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  }

  function loadIso(data) {
    iso = data || iso;
  }

  function loadTopology(topo) {
    if (!global.topojson) throw new Error("topojson-client manquant");
    const obj = topo.objects.countries;
    const fc = topojson.feature(topo, obj);
    features = fc.features.map((f) => {
      const nameEn = (f.properties && f.properties.name) || "";
      let iso2 = iso2OfNumeric(f.id);
      if (!iso2 && iso.names && iso.names[nameEn]) iso2 = iso.names[nameEn];
      if (!iso2 && nameEn === "N. Cyprus") iso2 = "XC";
      if (!iso2 && nameEn === "Somaliland") iso2 = "XS";
      if (!iso2 && nameEn === "Kosovo") iso2 = "XK";
      f.iso2 = iso2 || ("ID" + String(f.id || nameEn));
      f.nameEn = nameEn;
      f.nameFr = countryName(iso2, nameEn);
      f.bbox = bboxOf(f);
      f.centroid = centroidOf(f);
      return f;
    });
    if (topo.objects.land) {
      const lf = topojson.feature(topo, topo.objects.land);
      if (lf && lf.type === "FeatureCollection") {
        landFeature = {
          type: "Feature",
          geometry: {
            type: "MultiPolygon",
            coordinates: lf.features.flatMap((f) => {
              const g = f.geometry;
              if (!g) return [];
              if (g.type === "Polygon") return [g.coordinates];
              if (g.type === "MultiPolygon") return g.coordinates;
              return [];
            })
          }
        };
      } else {
        landFeature = lf;
      }
    }
    return features;
  }

  function locate(lon, lat) {
    if (!isFinite(lon) || !isFinite(lat)) return { iso2: "XX", name: "En mer", feature: null };
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const b = f.bbox;
      const pad = 0.4;
      const wrap = b[2] - b[0] > 180;
      const inBox = wrap
        ? (lat >= b[1] - pad && lat <= b[3] + pad)
        : (lon >= b[0] - pad && lon <= b[2] + pad && lat >= b[1] - pad && lat <= b[3] + pad);
      if (!inBox) continue;
      if (featureContains(f, lon, lat)) {
        return { iso2: f.iso2, name: f.nameFr, feature: f };
      }
    }
    // Nearest centroid within ~8°
    let best = null, bestD = 64;
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const dx = lon - f.centroid[0];
      const dy = lat - f.centroid[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best && bestD < 64) return { iso2: best.iso2, name: best.nameFr, feature: best };
    return { iso2: "XX", name: "En mer", feature: null };
  }

  function findByIso2(iso2) {
    return features.find((f) => f.iso2 === iso2) || null;
  }

  function sampleLandDots(step) {
    const s = step || 2.2;
    const pts = [];
    let src = landFeature;
    if (!src || !src.geometry) {
      src = {
        geometry: {
          type: "MultiPolygon",
          coordinates: features.flatMap((f) => {
            const g = f.geometry;
            if (!g) return [];
            if (g.type === "Polygon") return [g.coordinates];
            if (g.type === "MultiPolygon") return g.coordinates;
            return [];
          })
        }
      };
    }
    const polys = src.geometry.type === "Polygon" ? [src.geometry.coordinates] : (src.geometry.coordinates || []);
    function inLand(lon, lat) {
      for (let p = 0; p < polys.length; p++) {
        const poly = polys[p];
        if (ringContains(poly[0], lon, lat)) {
          let hole = false;
          for (let k = 1; k < poly.length; k++) if (ringContains(poly[k], lon, lat)) hole = true;
          if (!hole) return true;
        }
      }
      return false;
    }
    // hex-ish offset grid
    let row = 0;
    for (let lat = -80; lat <= 80; lat += s * 0.86) {
      const off = (row % 2) * (s * 0.5);
      row++;
      for (let lon = -180 + off; lon < 180; lon += s) {
        if (inLand(lon, lat)) pts.push([lon, lat]);
      }
    }
    return pts;
  }

  function borderRings() {
    const rings = [];
    for (const f of features) {
      const g = f.geometry;
      const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
      for (const poly of polys) {
        for (const ring of poly) {
          rings.push({ iso2: f.iso2, coords: ring });
        }
      }
    }
    return rings;
  }

  global.ALERTES = global.ALERTES || {};
  global.ALERTES.geo = {
    R_GLOBE, PLAN, sph, pla, mix,
    loadIso, loadTopology, locate, findByIso2,
    countryName, iso2OfAlpha3, iso2OfNumeric,
    sampleLandDots, borderRings,
    features: () => features,
    getFeature: (i) => features[i]
  };
})(window);
