/* ALERTES — sources publiques, normalisation, cache local */
(function (global) {
  const CACHE_KEY = "alertes.v1.cache";
  const CACHE_MAX_MS = 6 * 60 * 60 * 1000;

  const TYPES = {
    seisme: { label: "Séisme", icon: "◎" },
    inondation: { label: "Inondation", icon: "≋" },
    cyclone: { label: "Cyclone", icon: "⊗" },
    tempete: { label: "Tempête", icon: "ϟ" },
    volcan: { label: "Volcan", icon: "▲" },
    secheresse: { label: "Sécheresse", icon: "◇" },
    feu: { label: "Feu", icon: "▣" },
    glace: { label: "Glace", icon: "✱" },
    tsunami: { label: "Tsunami", icon: "≈" },
    autre: { label: "Autre", icon: "•" }
  };

  const GDACS_TYPE = { EQ: "seisme", FL: "inondation", TC: "cyclone", VO: "volcan", DR: "secheresse", WF: "feu" };
  const EONET_TYPE = {
    wildfires: "feu", severeStorms: "tempete", volcanoes: "volcan",
    seaLakeIce: "glace", drought: "secheresse", floods: "inondation",
    earthquakes: "seisme", dustHaze: "autre", landslides: "autre",
    snow: "autre", tempExtremes: "autre", waterColor: "autre"
  };

  function isoDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function addDays(d, n) {
    const x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  }

  function timeoutFetch(url, ms, headers) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms || 12000);
    return fetch(url, { signal: ctrl.signal, headers: headers || { Accept: "application/json" } })
      .finally(() => clearTimeout(t));
  }

  function severityRank(s) {
    return s === "danger" ? 2 : s === "watch" ? 1 : 0;
  }

  function usgsSeverity(p) {
    const mag = Number(p.mag) || 0;
    const alert = (p.alert || "").toLowerCase();
    if (alert === "red" || mag >= 6.5 || (p.tsunami && mag >= 6)) return "danger";
    if (alert === "orange" || alert === "yellow" || mag >= 5.5 || p.tsunami) return "watch";
    return "info";
  }

  function gdacsSeverity(level) {
    const l = (level || "").toLowerCase();
    if (l === "red") return "danger";
    if (l === "orange") return "watch";
    return "info";
  }

  function parseWhen(v) {
    if (v == null || v === "") return null;
    if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }

  function resolveCountry(lon, lat, iso3, iso2hint, nameHint) {
    const geo = global.ALERTES.geo;
    let iso2 = iso2hint || (iso3 ? geo.iso2OfAlpha3(iso3) : null);
    const loc = (isFinite(lon) && isFinite(lat)) ? geo.locate(lon, lat) : null;
    // Les codes officiels (GDACS) priment : les polygones près du 180e méridien
    // (Fidji, Russie…) peuvent englober un autre pays par erreur.
    if (!iso2 && loc && loc.iso2) iso2 = loc.iso2;
    if (!iso2) iso2 = "XX";
    const name = geo.countryName(iso2, nameHint || (loc && loc.name) || "En mer");
    return { iso2, name, lon: lon, lat: lat };
  }

  function parseUsgs(json) {
    const out = [];
    const feats = (json && json.features) || [];
    for (const f of feats) {
      const p = f.properties || {};
      const c = (f.geometry && f.geometry.coordinates) || [];
      const lon = c[0], lat = c[1], depth = c[2];
      const type = p.tsunami ? "tsunami" : "seisme";
      const country = resolveCountry(lon, lat, null, null, p.place);
      const mag = p.mag != null ? Number(p.mag) : null;
      out.push({
        id: "usgs:" + (p.code || p.ids || Math.random().toString(36).slice(2)),
        source: "usgs",
        sourceLabel: "USGS",
        type,
        typeLabel: TYPES[type].label,
        icon: TYPES[type].icon,
        severity: usgsSeverity(p),
        title: p.title || ("M " + mag + " — " + (p.place || "")),
        place: p.place || "",
        extra: (mag != null ? "M " + mag.toFixed(1) : "") + (depth != null ? " · " + Math.round(depth) + " km" : ""),
        time: parseWhen(p.time),
        url: p.url || "",
        lon, lat,
        iso2: country.iso2,
        countryName: country.name,
        countries: [country.iso2]
      });
    }
    return out;
  }

  function isActiveGdacs(p, now) {
    const cur = String(p.iscurrent).toLowerCase() === "true";
    const from = parseWhen(p.fromdate);
    const to = parseWhen(p.todate);
    const dayMs = 24 * 60 * 60 * 1000;
    if (cur) return true;
    // Encore en cours, ou achevé il y a moins de 12 h (fuseau d'arrivée des bulletins)
    if (from != null && to != null && from <= now && to >= now - 12 * 60 * 60 * 1000) return true;
    if (to == null && from != null && now - from <= 7 * dayMs) return true;
    return false;
  }

  function parseGdacs(json, now) {
    const out = [];
    const feats = (json && json.features) || [];
    for (const f of feats) {
      const p = f.properties || {};
      if (!isActiveGdacs(p, now)) continue;
      const c = (f.geometry && f.geometry.coordinates) || [];
      const lon = c[0], lat = c[1];
      const type = GDACS_TYPE[p.eventtype] || "autre";
      const affected = Array.isArray(p.affectedcountries) ? p.affectedcountries : [];
      const isoList = [];
      for (const a of affected) {
        const i = global.ALERTES.geo.iso2OfAlpha3(a.iso3) || a.iso2 || null;
        if (i && isoList.indexOf(i) === -1) isoList.push(i);
      }
      const primary = resolveCountry(lon, lat, p.iso3, isoList[0], p.country);
      if (isoList.indexOf(primary.iso2) === -1 && primary.iso2 !== "XX") isoList.unshift(primary.iso2);
      if (!isoList.length) isoList.push(primary.iso2);
      const title = p.name || p.description || (TYPES[type].label + " — " + primary.name);
      out.push({
        id: "gdacs:" + p.eventtype + ":" + p.eventid,
        source: "gdacs",
        sourceLabel: "GDACS",
        type,
        typeLabel: TYPES[type].label,
        icon: TYPES[type].icon,
        severity: gdacsSeverity(p.alertlevel),
        title,
        place: p.country || primary.name,
        extra: (p.alertlevel ? "Niveau " + p.alertlevel : "") + (p.severitydata && p.severitydata.severitytext ? " · " + p.severitydata.severitytext : ""),
        time: parseWhen(p.datemodified) || parseWhen(p.fromdate),
        start: parseWhen(p.fromdate),
        end: parseWhen(p.todate),
        url: (p.url && (p.url.report || p.url.details)) || "",
        lon, lat,
        iso2: primary.iso2,
        countryName: primary.name,
        countries: isoList
      });
    }
    return out;
  }

  function parseEonet(json, now) {
    const out = [];
    const events = (json && json.events) || [];
    const week = 7 * 24 * 60 * 60 * 1000;
    for (const ev of events) {
      const geoms = ev.geometry || [];
      if (!geoms.length) continue;
      const last = geoms[geoms.length - 1];
      const t = parseWhen(last.date);
      if (t == null || now - t > week) continue;
      const coords = last.coordinates || [];
      // Point is [lon,lat]; polygons are ignored — use first pair
      let lon, lat;
      if (typeof coords[0] === "number") { lon = coords[0]; lat = coords[1]; }
      else if (coords[0] && typeof coords[0][0] === "number") { lon = coords[0][0]; lat = coords[0][1]; }
      const cat = (ev.categories && ev.categories[0] && ev.categories[0].id) || "autre";
      let type = EONET_TYPE[cat] || "autre";
      const title = ev.title || type;
      if (/tropical cyclone|ouragan|typhon|hurricane/i.test(title)) type = "cyclone";
      let severity = "info";
      if (type === "cyclone" || type === "volcan" || type === "tempete") severity = "watch";
      const country = resolveCountry(lon, lat, null, null, title);
      const srcUrl = (ev.sources && ev.sources[0] && ev.sources[0].url) || ev.link || "";
      out.push({
        id: "eonet:" + ev.id,
        source: "eonet",
        sourceLabel: "NASA EONET",
        type,
        typeLabel: TYPES[type] ? TYPES[type].label : TYPES.autre.label,
        icon: (TYPES[type] || TYPES.autre).icon,
        severity,
        title,
        place: country.name,
        extra: ev.categories && ev.categories[0] ? ev.categories[0].title : "",
        time: t,
        url: srcUrl,
        lon, lat,
        iso2: country.iso2,
        countryName: country.name,
        countries: [country.iso2]
      });
    }
    return out;
  }

  function dedup(alerts) {
    const keep = [];
    for (const a of alerts) {
      let twin = -1;
      if (a.type === "seisme" || a.type === "tsunami") {
        for (let i = 0; i < keep.length; i++) {
          const b = keep[i];
          if (b.type !== "seisme" && b.type !== "tsunami") continue;
          if (Math.abs((a.lat || 0) - (b.lat || 0)) < 1.2 && Math.abs((a.lon || 0) - (b.lon || 0)) < 1.2) {
            const dt = Math.abs((a.time || 0) - (b.time || 0));
            if (dt < 3 * 60 * 60 * 1000) { twin = i; break; }
          }
        }
      }
      if (twin >= 0) {
        const b = keep[twin];
        const aBetter = severityRank(a.severity) > severityRank(b.severity) || (a.source === "usgs" && b.source !== "usgs");
        const primary = aBetter ? a : b;
        const other = aBetter ? b : a;
        const srcs = [];
        [primary.sourceLabel, other.sourceLabel].forEach((s) => { if (s && srcs.indexOf(s) === -1) srcs.push(s); });
        const extraCore = (primary.extra || "").replace(/\s*·\s*(aussi[^·]+)/g, "").trim();
        primary.extra = [extraCore, srcs.length > 1 ? srcs.join(" + ") : ""].filter(Boolean).join(" · ");
        keep[twin] = primary;
      } else {
        keep.push(a);
      }
    }
    return keep;
  }

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const c = JSON.parse(raw);
      if (!c || !c.at || !Array.isArray(c.alerts)) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache(payload) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(payload)); } catch (e) { /* quota */ }
  }

  async function fetchSource(name, label, url) {
    try {
      const res = await timeoutFetch(url, 12000);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const json = await res.json();
      return { name, label, ok: true, json, error: null };
    } catch (err) {
      return { name, label, ok: false, json: null, error: err && err.message ? err.message : "indisponible" };
    }
  }

  async function loadAll() {
    const geo = global.ALERTES.geo;
    const now = Date.now();
    const today = new Date(now);
    const from7 = isoDate(addDays(today, -7));
    const from30 = isoDate(addDays(today, -30));
    const to = isoDate(today);

    const jobs = [
      fetchSource("usgs", "USGS", "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson"),
      fetchSource("gdacs", "GDACS", "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=" + from7 + "&toDate=" + to + "&alertlevel=Green;Orange;Red"),
      fetchSource("gdacsHot", "GDACS (niveaux élevés)", "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH?fromDate=" + from30 + "&toDate=" + to + "&alertlevel=Orange;Red"),
      fetchSource("eonet", "NASA EONET", "https://eonet.gsfc.nasa.gov/api/v3/events?days=7&status=open")
    ];

    const results = await Promise.all(jobs);
    const byName = {};
    results.forEach((r) => { byName[r.name] = r; });

    // Merge two GDACS queries into one source status
    const gdacsOk = byName.gdacs.ok || byName.gdacsHot.ok;
    const sources = [
      { name: "usgs", label: "USGS", ok: byName.usgs.ok, error: byName.usgs.error, detail: "Séismes (M ≥ 4,5, 24 h)" },
      { name: "gdacs", label: "GDACS", ok: gdacsOk, error: gdacsOk ? null : (byName.gdacs.error || byName.gdacsHot.error), detail: "Catastrophes en cours" },
      { name: "eonet", label: "NASA EONET", ok: byName.eonet.ok, error: byName.eonet.error, detail: "Événements naturels (7 j)" }
    ];

    let alerts = [];
    if (byName.usgs.ok) alerts = alerts.concat(parseUsgs(byName.usgs.json));
    if (byName.gdacs.ok) alerts = alerts.concat(parseGdacs(byName.gdacs.json, now));
    if (byName.gdacsHot.ok) alerts = alerts.concat(parseGdacs(byName.gdacsHot.json, now));
    if (byName.eonet.ok) alerts = alerts.concat(parseEonet(byName.eonet.json, now));

    // unique by id
    const seen = Object.create(null);
    alerts = alerts.filter((a) => { if (seen[a.id]) return false; seen[a.id] = 1; return true; });
    alerts = dedup(alerts);
    alerts.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.time || 0) - (a.time || 0));

    const anyOk = sources.some((s) => s.ok);
    const cache = readCache();
    let fromCache = false;
    if (!anyOk && cache && cache.alerts && cache.alerts.length) {
      alerts = cache.alerts;
      fromCache = true;
      sources.forEach((s) => {
        if (!s.ok) { s.cache = true; }
      });
    } else if (anyOk) {
      writeCache({ at: now, alerts: alerts, sources: sources.map((s) => ({ name: s.name, ok: s.ok })) });
    }

    return { alerts, sources, at: now, fromCache, cacheAt: fromCache ? cache.at : now };
  }

  function byCountry(alerts) {
    const map = Object.create(null);
    for (const a of alerts) {
      const ids = a.countries && a.countries.length ? a.countries : [a.iso2 || "XX"];
      for (const id of ids) {
        if (!map[id]) map[id] = { iso2: id, name: global.ALERTES.geo.countryName(id, a.countryName), alerts: [], max: "info" };
        map[id].alerts.push(a);
        if (severityRank(a.severity) > severityRank(map[id].max)) map[id].max = a.severity;
      }
    }
    return map;
  }

  global.ALERTES = global.ALERTES || {};
  global.ALERTES.data = { loadAll, byCountry, TYPES, severityRank, readCache };
})(window);
