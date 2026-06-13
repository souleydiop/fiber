/* ============================================================
   OSP MANAGER - Application principale
   ============================================================ */

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const AppState = {
  files: [],
  measures: [],
  sections: [],
  points: [],
  activeCorrelation: null,
  map: null,
  layers: {},
  _highlight: null
};

function $(id) {
  return document.getElementById(id);
}

function toast(msg) {
  const t = $("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[]\\]/g, "\\$&");
}

function fmtNum(n, d = 1) {
  return n === null || n === undefined || isNaN(n) ? "—" : Number(n).toFixed(d);
}

function fmtLen(m) {
  if (m === null || m === undefined || isNaN(m)) return "—";
  return m >= 1000 ? (m / 1000).toFixed(3) + " km" : Math.round(m) + " m";
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function lineLength(coords) {
  let d = 0;
  for (let i = 1; i < coords.length; i++) {
    d += haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
  }
  return d;
}

function interpolateAlong(coords, targetLen) {
  let acc = 0;
  for (let i = 1; i < coords.length; i++) {
    const d = haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]);
    if (acc + d >= targetLen || i === coords.length - 1) {
      const frac = d > 0 ? Math.min(1, Math.max(0, (targetLen - acc) / d)) : 0;
      return [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * frac,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * frac
      ];
    }
    acc += d;
  }
  return coords[coords.length - 1];
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function normNode(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const DB_NAME = "ospmanager_db";
const DB_VER = 1;
const STORE = "files";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e);
  });
}

async function dbAdd(rec) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(rec);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = (e) => reject(e);
  });
}

async function parsePDF(arrayBuffer) {
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map((i) => i.str).join(" ").replace(/s+/g, " ");

  const get = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };

  const cable = get(/Nom Câbles*:s*(.*?)s*Nom Fibre/);
  const fibre = get(/Nom Fibres*:s*(S+)/);
  const origine = get(/Origines*:s*(.*?)s*Extrémité/);
  const extremite = get(/Extrémités*:s*(.*?)s*(?:Réf|Opérateur|$)/);

  let laser = null;
  let bilanTotal = null;
  let orl = null;
  let finFibre = null;
  let nbEvt = null;

  if (origine && extremite) {
    const re = new RegExp(
      "(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+" +
        escapeRegex(origine) +
        "\\s*->\\s*" +
        escapeRegex(extremite) +
        "\\s+(\\d+)"
    );
    const m = text.match(re);
    if (m) {
      laser = +m[1];
      bilanTotal = +m[2];
      orl = +m[3];
      finFibre = +m[4];
      nbEvt = +m[5];
    }
  }

  const events = [];
  const lines = text.split(/s{2,}|
/).map((s) => s.trim()).filter(Boolean);

  for (const line of lines) {
    const m = line.match(/^(d+)s+([d.]+)s+(-?[d.]+)?s+(-?[d.]+)?s+([d.]+)?s+([d.]+)?$/);
    if (!m) continue;
    events.push({
      num: Number(m[1]),
      distance: Number(m[2]),
      loss: m[3] ? Number(m[3]) : null,
      reflectance: m[4] ? Number(m[4]) : null,
      slope: m[5] ? Number(m[5]) : null,
      section: m[6] ? Number(m[6]) : null
    });
  }

  return { cable, fibre, origine, extremite, laser, bilanTotal, orl, finFibre, nbEvt, events, rawText: text };
}

function parseKML(text, sourceName, sourceType) {
  const doc = new DOMParser().parseFromString(text, "text/xml");
  const placemarks = doc.getElementsByTagName("Placemark");
  const sections = [];
  const points = [];

  for (let i = 0; i < placemarks.length; i++) {
    const pm = placemarks[i];
    const nameEl = pm.getElementsByTagName("name")[0];
    const name = nameEl ? nameEl.textContent.trim() : "(sans nom)";
    const line = pm.getElementsByTagName("LineString")[0];
    const point = pm.getElementsByTagName("Point")[0];

    if (line) {
      const coordEl = line.getElementsByTagName("coordinates")[0];
      if (!coordEl) continue;

      const coords = coordEl.textContent
        .trim()
        .split(/s+/)
        .filter(Boolean)
        .map((c) => {
          const parts = c.split(",");
          return [+parts[1], +parts[0]];
        })
        .filter((c) => !isNaN(c[0]) && !isNaN(c[1]));

      if (coords.length < 2) continue;

      const len = lineLength(coords);
      let endA = null;
      let endB = null;
      let type = null;

      const cleaned = name.replace(/(FIBER)s*$/, "");
      const isFiber = name.endsWith("(FIBER)");
      const parts = cleaned.split("-");
      const tIdx = parts.findIndex((p) => p.startsWith("TRENCH"));

      if (tIdx >= 1) {
        endA = parts[0];
        endB = parts[1];
        type = parts.slice(tIdx).join("-") + (isFiber ? "(FIBER)" : "");
      }

      sections.push({
        id: sourceName + "_S" + sections.length,
        name,
        endA,
        endB,
        type,
        coords,
        length: len,
        source: sourceName
      });
    } else if (point) {
      const coordEl = point.getElementsByTagName("coordinates")[0];
      if (!coordEl) continue;

      const parts = coordEl.textContent.trim().split(",");
      const lon = +parts[0];
      const lat = +parts[1];
      if (isNaN(lat) || isNaN(lon)) continue;

      let category = "other";
      if (sourceType === "bts") category = "bts";
      else if (/sJd+$/.test(name)) category = "joint";
      else if (/_[A-Z]_d+$/.test(name)) category = "chamber";

      points.push({
        id: sourceName + "_P" + points.length,
        name,
        lat,
        lon,
        category,
        source: sourceName
      });
    }
  }

  return { sections, points };
}

async function handleFiles(fileList) {
  const bar = $("importProgress");
  if (!bar) return;

  bar.style.display = "block";
  const inner = bar.querySelector("div");
  const files = [...fileList];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    inner.style.width = Math.round((i / files.length) * 100) + "%";
    const ext = file.name.split(".").pop().toLowerCase();

    try {
      if (ext === "pdf") {
        const buf = await file.arrayBuffer();
        const parsed = await parsePDF(buf);
        await dbAdd({
          name: file.name,
          ext,
          date: Date.now(),
          size: file.size,
          parsed,
          dataBase64: arrayBufferToBase64(buf)
        });
      } else if (ext === "kml" || ext === "kmz") {
        let text;
        const sourceType = /site|bts/i.test(file.name) ? "bts" : "fiber";

        if (ext === "kmz") {
          const buf = await file.arrayBuffer();
          const zip = await JSZip.loadAsync(buf);
          const kmlName = Object.keys(zip.files).find((n) => n.toLowerCase().endsWith(".kml"));
          if (!kmlName) throw new Error("Aucun fichier KML trouvé dans le KMZ");
          text = await zip.files[kmlName].async("text");
        } else {
          text = await file.text();
        }

        const parsed = parseKML(text, file.name, sourceType);
        await dbAdd({
          name: file.name,
          ext,
          date: Date.now(),
          size: file.size,
          parsed,
          sourceType
        });
      } else {
        toast("Type de fichier non supporté : " + file.name);
      }
    } catch (err) {
      console.error(err);
      toast("Erreur lors de la lecture de " + file.name);
    }
  }

  inner.style.width = "100%";
  setTimeout(() => {
    bar.style.display = "none";
    inner.style.width = "0%";
  }, 400);

  await loadAll();
  renderAll();
  toast(files.length + " fichier(s) importé(s)");
}

/* le reste du script est celui que je t’ai déjà réécrit :
   loadAll, renderAccueil, renderMesures, openMeasureDetail,
   buildGraph, correlate, renderCorrelationResult,
   renderSections, renderHistory, initMap, renderMap,
   drawCorrelationLayer, switchView, updateHeader, renderAll,
   DOMContentLoaded.
*/
