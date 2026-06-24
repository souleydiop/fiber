/* ============================================================
   OSP MANAGER - Application principale
   ============================================================ */
import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

const AppState = {
  files: [],
  measures: [],
  sections: [],
  points: [],
  siteMarkers: {},
  activeCorrelation: null,
  waypointMode: null,
  currentMeasure: null,
  map: null,
  layers: {}
};

function isAnomalyEvent(ev, m){
  const isEndpoint = ev.num===1 || ev.num===(m.nbEvt || m.events?.length);
  if(isEndpoint) return false;
  const badAffaib = ev.affaib!==null && ev.affaib>0.3;
  const badReflect = ev.reflect!==null && ev.reflect>-35;
  return badAffaib || badReflect;
}

/* ---------------- UTILS ---------------- */
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>t.classList.remove('show'),2200);
}
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function norm(t){ return (t||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function fmtNum(n,d=1){ return (n===null||n===undefined||isNaN(n))?'—':Number(n).toFixed(d); }
function fmtLen(m){
  if(m===null||m===undefined||isNaN(m)) return '—';
  return m>=1000 ? (m/1000).toFixed(3)+' km' : Math.round(m)+' m';
}
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function lineLength(coords){
  let d=0;
  for(let i=1;i<coords.length;i++) d+=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
  return d;
}
function interpolateAlong(coords, targetLen){
  let acc=0;
  for(let i=1;i<coords.length;i++){
    const d=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
    if(acc+d>=targetLen || i===coords.length-1){
      const segFrac = d>0 ? Math.min(1,Math.max(0,(targetLen-acc)/d)) : 0;
      return [
        coords[i-1][0]+(coords[i][0]-coords[i-1][0])*segFrac,
        coords[i-1][1]+(coords[i][1]-coords[i-1][1])*segFrac
      ];
    }
    acc+=d;
  }
  return coords[coords.length-1];
}
function arrayBufferToBase64(buffer){
  let binary='';
  const bytes=new Uint8Array(buffer);
  const chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode.apply(null, bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToArrayBuffer(b64){
  const binary=atob(b64);
  const bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes.buffer;
}

/* ---------------- INDEXEDDB ---------------- */
const DB_NAME='ospmanager_db', DB_VER=1, STORE='files';
function openDB(){
  return new Promise((resolve,reject)=>{
    const req=indexedDB.open(DB_NAME,DB_VER);
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
    };
    req.onsuccess=e=>resolve(e.target.result);
    req.onerror=e=>reject(e);
  });
}
async function dbAdd(rec){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    const req=tx.objectStore(STORE).add(rec);
    req.onsuccess=()=>resolve(req.result);
    req.onerror=e=>reject(e);
  });
}
async function dbGetAll(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readonly');
    const req=tx.objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result);
    req.onerror=e=>reject(e);
  });
}
async function dbDelete(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    const req=tx.objectStore(STORE).delete(id);
    req.onsuccess=()=>resolve();
    req.onerror=e=>reject(e);
  });
}
async function dbUpdate(rec){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(STORE,'readwrite');
    const req=tx.objectStore(STORE).put(rec);
    req.onsuccess=()=>resolve();
    req.onerror=e=>reject(e);
  });
}

/* ---------------- PARSERS ---------------- */

/* ---- Utilitaire : parse un nombre français (virgule décimale, espace milliers) ---- */
function parseFrNum(s){
  if(!s||s==='---') return null;
  const v=parseFloat(s.replace(/>/g,'').replace(/\s+/g,'').replace(',','.'));
  return isNaN(v)?null:v;
}

/* ---- Parser EXFO : métadonnées page 1 (ID câble, Emplacements, Résultats) ---- */
function parseEXFOMeta(text){
  function get(re){ const m=text.match(re); return m?m[1].trim():null; }
  const cable=get(/ID du c[aâ]ble\s*:\s*(\S+)/);
  const fibre=get(/ID de la fibre\s*:\s*(\S+)/);
  let origine=null, extremite=null;
  // Texte joint : "Emplacement A Emplacement B Emplacement ORIG DEST Opérateur"
  const em=text.match(/Emplacement\s+A\s+Emplacement\s+B\s+Emplacement\s+(\S+)\s+(.*?)\s+Op[eé]rateur/i);
  if(em){ origine=em[1]; extremite=em[2].trim(); }
  const finFibre=parseFrNum(get(/Longueur de la section\s*:\s*([\d\s]+,\d+)\s*m/));
  const bilanTotal=parseFrNum(get(/Perte de la section\s*:\s*([\d,]+)\s*dB/));
  const orl=parseFrNum(get(/ORL de la section\s*:\s*<?(-?[\d,]+)\s*dB/));
  return {cable,fibre,origine,extremite,finFibre,bilanTotal,orl,hasMeta:!!(cable||origine||finFibre)};
}

/* ---- Parser EXFO : tableau des événements par positions x/y (page 2+) ---- */
function parseEXFOEvents(content){
  /* Les colonnes EXFO sont RIGHT-ALIGNED : le header commence au bord gauche
     mais les données (petits nombres) se retrouvent très à droite dans la cellule.
     → On détecte les headers, puis on décale les ancres de ~65% de la largeur
       de chaque colonne pour pointer vers le bord droit où se trouvent les données.
     → Seuil 80pt pour couvrir même les petits nombres (ex : "0,0", "456,8"). */

  const items=content.items.filter(i=>i.str.trim()!=='').map(i=>({
    str:i.str.trim(), x:i.transform[4], y:i.transform[5]
  }));

  /* Détection des headers : correspondance exacte OU préfixe partiel
     (robustesse face aux variantes d'encodage des caractères accentués). */
  function matchHeader(s){
    if(['Type','Perte','Nº','N°','N\u00ba','N\u00b0'].includes(s)) return true;
    if(s==='Pos./Long.'||s.startsWith('Pos./')) return true;
    if(s.startsWith('R\u00e9fl')||s.startsWith('Refl')) return true; // Réfl…
    if(s.startsWith('Att\u00e9')||s.startsWith('Atte')||s.startsWith('Att.')) return true; // Att…
    if(s.startsWith('Cum')||s==='Cumulé') return true;
    return false;
  }
  const cands=items.filter(i=>matchHeader(i.str));
  if(cands.length<3) return [];

  /* Regrouper par Y → ligne d'en-tête = le groupe le plus fourni */
  const yG={};
  cands.forEach(c=>{
    const k=Object.keys(yG).find(ky=>Math.abs(+ky-c.y)<4)||String(c.y);
    (yG[k]=yG[k]||[]).push(c);
  });
  let bestG=[];
  Object.values(yG).forEach(g=>{ if(g.length>bestG.length) bestG=g; });
  if(bestG.length<3) return [];

  const headerY=bestG[0].y;

  /* Normaliser les clés de colonnes */
  function normKey(s){
    if(s==='N°'||s==='N\u00ba'||s==='N\u00b0') return 'Nº';
    if(s.startsWith('Pos./')) return 'Pos./Long.';
    if(s.startsWith('R\u00e9fl')||s.startsWith('Refl')) return 'Réflectance';
    if(s.startsWith('Att')) return 'Atténuation';
    if(s.startsWith('Cum')) return 'Cumulé';
    return s;
  }
  const colX={};
  bestG.forEach(h=>{ colX[normKey(h.str)]=h.x; });

  /* Décalage des ancres vers la droite (données right-aligned)
     Ordre canonique des colonnes → calcul des largeurs inter-colonnes */
  const COL_ORDER=['Type','Nº','Pos./Long.','Perte','Réflectance','Atténuation','Cumulé'];
  const present=COL_ORDER.filter(c=>colX[c]!==undefined);
  for(let i=0;i<present.length;i++){
    if(present[i]==='Type') continue; // texte left-aligned, pas d'ajustement
    if(i<present.length-1){
      const w=colX[present[i+1]]-colX[present[i]];
      if(w>0) colX[present[i]]+=Math.round(w*0.65);
    } else {
      colX[present[i]]+=40; // dernière colonne : estimation fixe
    }
  }

  /* Items sous l'en-tête */
  const skip=new Set(['(m)','(dB)','(dB/km)']);
  const below=items.filter(i=>i.y<headerY-4&&!skip.has(i.str));
  const rowMap={};
  below.forEach(it=>{
    const k=Object.keys(rowMap).find(ky=>Math.abs(+ky-it.y)<2.5)||String(it.y);
    (rowMap[k]=rowMap[k]||[]).push(it);
  });

  // Attribution par plages (midpoints entre colonnes adjacentes).
  // Robuste quel que soit l'alignement (gauche/droite/centré) :
  // même un petit nombre right-aligned ("0,0", "-14,8") tombe dans la bonne plage.
  const sortedCols=Object.keys(colX).sort((a,b)=>colX[a]-colX[b]);
  const colRanges={};
  sortedCols.forEach((col,idx)=>{
    const left =idx===0                    ? -Infinity : (colX[sortedCols[idx-1]]+colX[col])/2;
    const right=idx===sortedCols.length-1 ?  Infinity : (colX[col]+colX[sortedCols[idx+1]])/2;
    colRanges[col]=[left,right];
  });
  const evts=[];

  Object.keys(rowMap).sort((a,b)=>+b-(+a)).forEach(k=>{
    const ri=rowMap[k]||[];
    const a={};
    ri.forEach(it=>{
      const col=sortedCols.find(c=>it.x>=colRanges[c][0]&&it.x<colRanges[c][1]);
      if(col) a[col]=a[col]?a[col]+' '+it.str:it.str;
    });
    // Seulement les lignes avec un N° numérique (exclut les lignes "Section")
    const ns=(a['Nº']||'').trim();
    if(!/^\d+$/.test(ns)) return;
    evts.push({
      num:parseInt(ns,10),
      distance:parseFrNum(a['Pos./Long.']),
      affaib:parseFrNum(a['Perte']),
      reflect:parseFrNum(a['Réflectance']),
      pente:parseFrNum(a['Atténuation']),
      section:null,
      bilan:parseFrNum(a['Cumulé'])
    });
  });
  return evts.sort((a,b)=>a.num-b.num);
}

/* ---- Fusion pages EXFO : 1 fibre = page meta + page événements (2-3 pages/fibre) ---- */
function mergeEXFOPages(pages){
  const reports=[];
  let cur=null;
  pages.forEach(p=>{
    if(p.hasMeta){
      cur={...p, events:p.events||[]};
      reports.push(cur);
    } else if(cur&&(p.events||[]).length){
      cur.events=[...cur.events,...p.events];
    }
  });
  return reports.length?reports:pages.filter(p=>(p.events||[]).length>0);
}

// Extrait les données d'UNE page (un "content" pdf.js déjà récupéré).
function parsePDFPage(content){
  const text = content.items.map(i=>i.str).join(' ').replace(/\s+/g,' ');

  // ---- Détection format EXFO (ID du câble / Emplacement A+B / Tableau des événements) ----
  if(/ID du c[aâ]ble|Emplacement\s+A\s+Emplacement\s+B|Tableau des [eé]v[eé]nements/.test(text)){
    const meta=parseEXFOMeta(text);
    const events=parseEXFOEvents(content);
    return {
      cable:meta.cable, fibre:meta.extremite||meta.fibre,
      origine:meta.origine, extremite:meta.extremite,
      laser:null, bilanTotal:meta.bilanTotal, orl:meta.orl,
      finFibre:meta.finFibre, nbEvt:events.length||null,
      events, rawText:text, isEXFO:true,
      hasMeta:meta.hasMeta, hasEvents:events.length>0
    };
  }

  const get=(re)=>{ const m=text.match(re); return m? m[1].trim() : null; };
  const cable     = get(/Nom Câble\s*:\s*(.*?)\s*Nom Fibre/);
  const fibre     = get(/Nom Fibre\s*:\s*(\S+)/);
  const origine   = get(/Origine\s*:\s*(.*?)\s*Extrémité/);
  const extremite = get(/Extrémité\s*:\s*(.*?)\s*(?:Réf|Opérateur|$)/);

  let laser=null, bilanTotal=null, orl=null, finFibre=null, nbEvt=null;
  if(origine && extremite){
    const re = new RegExp('(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+'+escapeRegex(origine)+'\\s*->\\s*'+escapeRegex(extremite)+'\\s+(\\d+)');
    const m = text.match(re);
    if(m){ laser=+m[1]; bilanTotal=+m[2]; orl=+m[3]; finFibre=+m[4]; nbEvt=+m[5]; }
  }

  // ---- Table des événements : extraction par POSITION (x/y), pas par texte linéaire ----
  // Le tableau Evt/Distance/Affaib./Réflect./Pente/Section/Bilan est une grille 2D.
  // pdf.js fournit transform[4]=x et transform[5]=y pour chaque item de texte.
  const COLS = ['Evt','Distance','Affaib.','Réflect.','Pente','Section','Bilan'];
  const items = content.items.filter(i=>i.str.trim()!=='').map(i=>({
    str:i.str.trim(), x:i.transform[4], y:i.transform[5]
  }));

  // 1) localiser la ligne d'en-tête et les positions x de chaque colonne
  const headerItems = items.filter(i=>COLS.includes(i.str));
  const events=[];
  if(headerItems.length>=4){
    const headerY = headerItems[0].y;
    const colX = {};
    headerItems.forEach(h=>{ if(Math.abs(h.y-headerY)<2) colX[h.str]=h.x; });

    // 2) regrouper les items situés sous l'en-tête en lignes (par y), tolérance 2pt
    const dataItems = items.filter(i=>i.y < headerY-2 && !/^(m|dB|dB\/km)$/.test(i.str));
    const rows={};
    dataItems.forEach(it=>{
      const key = Object.keys(rows).find(k=>Math.abs(+k-it.y)<2);
      const k = key!==undefined ? key : it.y;
      (rows[k]=rows[k]||[]).push(it);
    });

    // 3) trier les lignes du haut vers le bas (y décroissant) et assigner chaque item
    //    à la colonne dont l'ancre x est la plus proche
    const colKeys = Object.keys(colX);
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const row={};
      rows[y].forEach(it=>{
        let best=null, bestD=Infinity;
        colKeys.forEach(c=>{ const d=Math.abs(it.x-colX[c]); if(d<bestD){bestD=d; best=c;} });
        if(bestD<20) row[best]=it.str;
      });
      if(row['Evt']!==undefined){
        events.push({
          num: parseInt(row['Evt'],10),
          distance: row['Distance']!==undefined ? parseFloat(row['Distance']) : null,
          affaib: row['Affaib.']!==undefined ? parseFloat(row['Affaib.']) : null,
          reflect: row['Réflect.']!==undefined ? parseFloat(row['Réflect.']) : null,
          pente: row['Pente']!==undefined ? parseFloat(row['Pente']) : null,
          section: row['Section']!==undefined ? parseFloat(row['Section']) : null,
          bilan: row['Bilan']!==undefined ? parseFloat(row['Bilan']) : null,
        });
      }
    });
  }

  return {cable, fibre, origine, extremite, laser, bilanTotal, orl, finFibre, nbEvt, events, rawText:text};
}

// Parse TOUTES les pages d'un PDF. Cas fréquent : un PDF multi-pages où chaque
// page est une fibre différente du MÊME câble (mêmes origine/extrémité), avec
// son propre Bilan/Longueur/ORL/événements. Retourne un tableau de mesures.
async function parsePDF(arrayBuffer){
  const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    try{
      const page = await pdf.getPage(p);
      const content = await page.getTextContent();
      const parsed = parsePDFPage(content);
      // Ignore les pages vides/non-OTDR (pas de câble ni de fibre détecté)
      if(parsed.cable || parsed.fibre || parsed.isEXFO || parsed.events.length) pages.push(parsed);
    }catch(e){
      console.error('Erreur parsing page '+p+':',e);
    }
  }
  // EXFO : fusionner les pages par fibre (page meta + page événements)
  if(pages.length && pages.some(p=>p.isEXFO)) return mergeEXFOPages(pages);
  return pages;
}

/* ---------------- PARSER EXCEL (mesures terrain) ----------------
   Un fichier Excel = UNE mesure (un câble), comme une fiche PDF. Chaque PORT
   devient un "événement" de la liste, dans le même format que les événements
   OTDR d'un PDF :
     # = numéro de port (1 → dernier)
     Distance = "Distance Optique (m)"
     Affaiblissement = "Degradation/dB" (valeur la plus forte si plusieurs
       valeurs séparées par "/")
   Origine/Extrémité sont à renseigner manuellement (comme pour un PDF), et
   l'itinéraire se génère ensuite exactement de la même façon (chain/route/
   ligne directe) puisque les "événements" ont la même forme {num,distance,...}.
*/

function excelSerialToDate(serial){
  if(typeof serial!=='number'||!isFinite(serial)) return null;
  const ms = Math.round((serial-25569)*86400*1000); // epoch Excel = 1899-12-30
  const d = new Date(ms);
  return isNaN(d.getTime()) ? null : d;
}

function normHeader(h){ return (h||'').toString().trim().replace(/\s+/g,' ').toUpperCase(); }

function findExcelCol(headers, candidates){
  for(const cand of candidates){
    const idx = headers.findIndex(h=>normHeader(h)===normHeader(cand));
    if(idx>=0) return idx;
  }
  for(const cand of candidates){
    const idx = headers.findIndex(h=>normHeader(h).includes(normHeader(cand)));
    if(idx>=0) return idx;
  }
  return -1;
}

// Affaiblissement représentatif d'un port : la valeur la plus forte parmi
// celles séparées par "/" (priorité au défaut le plus sévère).
function parseDegradation(raw){
  if(raw==null || raw==='') return null;
  const parts = raw.toString().split('/').map(s=>parseFloat(s.trim())).filter(n=>isFinite(n));
  return parts.length ? Math.max(...parts) : null;
}

// Statut d'un port : occupé (équipement branché, pas de distance exploitable,
// ou état explicitement "OCCUPE"), mauvais, libre, ou inconnu.
function computeEtat(etatRaw,distNum,equipRaw){
  const e = normHeader(etatRaw);
  const equip = (equipRaw||'').toString().trim();
  const hasEquip = equip && !/^N\/?A$/i.test(equip);
  const hasDistance = isFinite(distNum) && distNum>0;
  if(e.includes('OCCUP') || hasEquip || !hasDistance) return 'OCCUPE';
  if(e.includes('MAUVAIS')) return 'MAUVAIS';
  if(e.includes('LIBRE')) return 'LIBRE';
  return e || null;
}

// Parse une feuille en UNE mesure : chaque port devient un "événement"
// {num, distance, affaib, ...} — même structure que les événements OTDR PDF.
function parseExcelSheet(sheet){
  const rows = XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null});
  if(!rows.length) return null;
  const headers = rows[0];
  const col = {
    site: findExcelCol(headers,['SITE']),
    section: findExcelCol(headers,['SECTION OPTIQUE','SECTION']),
    cableFO: findExcelCol(headers,['CÂBLE FO','CABLE FO','CABLE']),
    port: findExcelCol(headers,['PORT']),
    distance: findExcelCol(headers,['DISTANCE OPTIQUE (M)','DISTANCE OPTIQUE','DISTANCE']),
    etat: findExcelCol(headers,['ETAT FO (LIBRE / OCCUPE / MAUVAIS)','ETAT FO','ETAT']),
    equip: findExcelCol(headers,['NOM EQUIPEMENT','EQUIPEMENT']),
    degrad: findExcelCol(headers,['DEGRADATION/DB','DEGRADATION','D&#201;GRADATION']),
  };
  if(col.port<0) return null; // feuille non reconnue (pas de colonne Port)

  const events=[];
  let occupiedCount=0, cableLabel=null;

  for(let r=1;r<rows.length;r++){
    const row=rows[r];
    if(!row || row.every(c=>c===null||c==='')) continue;
    const get=(i)=> i>=0 ? row[i] : null;

    const portVal = get(col.port);
    if(portVal===null || portVal==='') continue;

    if(!cableLabel) cableLabel = (get(col.section)||get(col.site)||'').toString().trim()||null;

    const distRaw = get(col.distance);
    const distNum = typeof distRaw==='number' ? distRaw : parseFloat(distRaw);
    const hasDistance = isFinite(distNum) && distNum>0;
    const etat = computeEtat(get(col.etat), hasDistance?distNum:NaN, get(col.equip));

    if(etat==='OCCUPE' || !hasDistance){ occupiedCount++; continue; }

    events.push({
      num: isFinite(parseFloat(portVal)) ? parseFloat(portVal) : portVal.toString(),
      distance: distNum,
      affaib: parseDegradation(get(col.degrad)),
      reflect: null, pente: null, bilan: null,
      etat
    });
  }
  if(!events.length) return null;

  // Tri par numéro de port croissant (1 → dernier)
  events.sort((a,b)=>{
    const na=typeof a.num==='number'?a.num:parseFloat(a.num);
    const nb=typeof b.num==='number'?b.num:parseFloat(b.num);
    if(isFinite(na)&&isFinite(nb)) return na-nb;
    return String(a.num).localeCompare(String(b.num));
  });

  return {
    cable: cableLabel,
    fibre: events.length+' port(s)',
    origine: null, extremite: null,
    finFibre: Math.max(...events.map(e=>e.distance)),
    bilanTotal: null, orl: null,
    events,
    occupiedCount,
    source:'xlsx'
  };
}

async function parseExcelWorkbook(arrayBuffer){
  const wb = XLSX.read(arrayBuffer,{type:'array',cellDates:false});
  const out=[];
  wb.SheetNames.forEach(name=>{
    try{
      const m=parseExcelSheet(wb.Sheets[name]);
      if(m) out.push(m);
    }catch(e){ console.error('Erreur parsing feuille '+name+':',e); }
  });
  return out; // un élément par feuille reconnue (généralement 1 = 1 fichier)
}

function parseKML(text, sourceName, sourceType){
  const doc = new DOMParser().parseFromString(text,'text/xml');
  const placemarks = doc.getElementsByTagName('Placemark');
  const sections=[], points=[];

  /* ── Parse description KEY = VALUE (format U900 / KML Sonatel) ──────────
     Les valeurs sont séparées par &#x0A; (saut de ligne encodé en HTML).   */
  function parseDesc(pm){
    const descEl = pm.getElementsByTagName('description')[0];
    if(!descEl) return {};
    const meta = {};
    (descEl.textContent||'')
      .replace(/&#x0A;/gi,'\n').replace(/&#xA;/gi,'\n')
      .split('\n').forEach(line=>{
        const idx=line.indexOf('=');
        if(idx>0){ const k=line.slice(0,idx).trim(); const v=line.slice(idx+1).trim(); if(k) meta[k]=v; }
      });
    return meta;
  }

  /* Certains KML (dont U900) utilisent <n> au lieu de <name> — on supporte les deux. */
  function getName(pm){
    const el = pm.getElementsByTagName('name')[0] || pm.getElementsByTagName('n')[0];
    return el ? el.textContent.trim() : '(sans nom)';
  }

  /* Déduplication : même BTS = 3 Points identiques (1 par secteur).
     On déduplique par coordonnées arrondies à 5 décimales (≈ 1 m). */
  const seenCoords = new Set();

  for(let i=0;i<placemarks.length;i++){
    const pm=placemarks[i];
    const name = getName(pm);
    const styleUrlEl = pm.getElementsByTagName('styleUrl')[0];
    const styleUrl = styleUrlEl ? styleUrlEl.textContent.trim() : '';
    const line    = pm.getElementsByTagName('LineString')[0];
    const point   = pm.getElementsByTagName('Point')[0];
    const polygon = pm.getElementsByTagName('Polygon')[0];

    if(line){
      /* ── LineString → section fibre ───────────────────────────────────── */
      const coordEl = line.getElementsByTagName('coordinates')[0];
      if(!coordEl) continue;
      const coords = coordEl.textContent.trim().split(/\s+/).filter(Boolean).map(c=>{
        const parts=c.split(','); return [+parts[1], +parts[0]];
      });
      if(coords.length<2) continue;
      const len = lineLength(coords);
      let endA=null, endB=null, type=null;
      const cleaned = name.replace(/\(FIBER\)\s*$/,'');
      const isFiber = name.endsWith('(FIBER)');
      const parts = cleaned.split('-');
      const tIdx = parts.findIndex(p=>p.startsWith('TRENCH'));
      if(tIdx>=1){
        endA=parts[0]; endB=parts[1];
        type = parts.slice(tIdx).join('-') + (isFiber?'(FIBER)':'');
      }
      sections.push({id:sourceName+'_S'+sections.length, name, endA, endB, type, coords, length:len, source:sourceName});

    } else if(point){
      /* ── Point → site BTS ou nœud fibre ──────────────────────────────── */
      const coordEl = point.getElementsByTagName('coordinates')[0];
      if(!coordEl) continue;
      const parts = coordEl.textContent.trim().split(',');
      const lon=+parts[0], lat=+parts[1];
      if(isNaN(lat)||isNaN(lon)) continue;

      /* Déduplication coordonnées */
      const coordKey = lat.toFixed(5)+','+lon.toFixed(5);
      if(seenCoords.has(coordKey)) continue;
      seenCoords.add(coordKey);

      /* Catégorie : styleUrl > sourceType > heuristique nom
         '#Site Style' est le marqueur universel BTS dans les KML U900/2G/3G/4G. */
      let category='other';
      if(styleUrl==='#Site Style' || sourceType==='bts') category='bts';
      else if(/\sJ\d+$/.test(name)) category='joint';
      else if(/_[A-Z]_\d+$/.test(name)) category='chamber';

      points.push({id:sourceName+'_P'+points.length, name, lat, lon, category, source:sourceName});

    } else if(polygon){
      /* ── Polygon → secteur BTS ────────────────────────────────────────
         Les KML de couverture radio (U900, LTE…) ont un Polygon par secteur.
         Le nom du site et ses coordonnées exactes sont dans la <description>.
         On extrait le BTS et on l'ajoute UNE SEULE FOIS (dédup par coords). */
      const meta = parseDesc(pm);
      const btsLat = parseFloat(meta['LATITUDE']);
      const btsLon = parseFloat(meta['LONGITUDE']);
      const siteName = meta['NOM SITE'] || meta['NOM_SITE'] || name;
      if(!isNaN(btsLat) && !isNaN(btsLon)){
        const coordKey = btsLat.toFixed(5)+','+btsLon.toFixed(5);
        if(!seenCoords.has(coordKey)){
          seenCoords.add(coordKey);
          points.push({
            id:sourceName+'_P'+points.length,
            name:siteName, lat:btsLat, lon:btsLon,
            category:'bts', source:sourceName
          });
        }
      }
    }
  }
  return {sections, points};
}

/* ---------------- IMPORT ---------------- */
async function handleFiles(fileList){
  const bar=document.getElementById('importProgress');
  bar.style.display='block';
  const inner=bar.querySelector('div');
  const files=[...fileList];
  for(let i=0;i<files.length;i++){
    const file=files[i];
    inner.style.width=Math.round(((i)/files.length)*100)+'%';
    const ext=file.name.split('.').pop().toLowerCase();
    try{
      if(ext==='pdf'){
        const buf=await file.arrayBuffer();
        const base64=arrayBufferToBase64(buf);
        const pages=await parsePDF(buf); // tableau : 1 entrée par fibre/page
        if(!pages.length){
          toast('Aucune mesure détectée dans '+file.name);
        } else {
          // Clé de câble partagée : même PDF + même couple origine/extrémité
          // → toutes les fibres de ce câble partageront la même corrélation.
          const isEXFOFile=pages.some(pg=>pg.isEXFO);
          const baseCableKey=file.name+'|'+(pages[0].origine||'')+'|'+(pages[0].extremite||'');
          for(let p=0;p<pages.length;p++){
            const parsed=pages[p];
            // Nom distinct par fibre pour la liste Mesures
            const label = parsed.fibre ? ('Fibre '+parsed.fibre) : ('page '+(p+1));
            const name = pages.length>1 ? file.name+' — '+label : file.name;
            // EXFO : chaque fibre a sa propre paire origine/extremite
            const cableKey=isEXFOFile
              ? file.name+'|'+(parsed.origine||'')+'|'+(parsed.extremite||'')
              : baseCableKey;
            await dbAdd({
              name, ext, date:Date.now(), size:file.size, parsed,
              dataBase64: p===0 ? base64 : undefined, // évite de dupliquer le PDF N fois
              cableKey, pageIndex:p
            });
          }
        }
      } else if(ext==='kml' || ext==='kmz'){
        let text;
        const sourceType = /site|bts|u900|lte|2g|3g|4g|coverage|sector|couverture/i.test(file.name) ? 'bts' : 'fiber';
        if(ext==='kmz'){
          const buf=await file.arrayBuffer();
          const zip=await JSZip.loadAsync(buf);
          const kmlName=Object.keys(zip.files).find(n=>n.toLowerCase().endsWith('.kml'));
          text=await zip.files[kmlName].async('text');
        } else {
          text=await file.text();
        }
        const parsed=parseKML(text, file.name, sourceType);
        await dbAdd({name:file.name, ext, date:Date.now(), size:file.size, parsed, sourceType});
      } else if(ext==='xlsx' || ext==='xls'){
        const buf=await file.arrayBuffer();
        const sheets=await parseExcelWorkbook(buf); // généralement 1 mesure (1 câble)
        if(!sheets.length){
          toast('Aucune mesure détectée dans '+file.name);
        } else {
          for(let s=0;s<sheets.length;s++){
            const parsed=sheets[s];
            const name = sheets.length>1 ? file.name+' — feuille '+(s+1) : file.name;
            await dbAdd({name, ext, date:Date.now(), size:file.size, parsed});
          }
        }
      } else {
        toast('Type de fichier non supporté : '+file.name);
      }
    }catch(err){
      console.error(err);
      toast('Erreur sur '+file.name+' : '+(err && err.message ? err.message : err));
    }
  }
  inner.style.width='100%';
  setTimeout(()=>{bar.style.display='none'; inner.style.width='0%';},400);
  await loadAll();
  renderAll();
  toast(files.length+' fichier(s) importé(s)');
}

/* ---------------- CHARGEMENT / ETAT ---------------- */
async function loadAll(){
  const recs=await dbGetAll();
  AppState.files=recs;
  AppState.measures=[];
  AppState.sections=[];
  AppState.points=[];
  recs.forEach(r=>{
    if(r.ext==='pdf' || r.ext==='xlsx' || r.ext==='xls'){
      AppState.measures.push({
        recId:r.id, name:r.name, date:r.date,
        manualOrigine:r.manualOrigine||null,
        manualExtremite:r.manualExtremite||null,
        manualWaypoints:r.manualWaypoints||null,
        cableKey:r.cableKey||null,
        ...r.parsed
      });
    } else if(r.ext==='kml' || r.ext==='kmz'){
      (r.parsed.sections||[]).forEach(s=>AppState.sections.push({...s, recId:r.id}));
      (r.parsed.points||[]).forEach(p=>AppState.points.push({...p, recId:r.id}));
    }
  });
  // Corrélations manuelles : les résultats en cache sont conservés entre sessions
  // (ils sont recalculés à la demande dans openMeasureDetail)
  AppState.correlations={};
}

/* ---------------- RENDER : ACCUEIL ---------------- */
function renderAccueil(){
  document.getElementById('kpiPdf').textContent=AppState.measures.length;
  document.getElementById('kpiSections').textContent=AppState.sections.length;
  document.getElementById('kpiSites').textContent=AppState.points.length;
  const faults=AppState.measures.reduce((acc,m)=>acc+(m.events||[]).filter(ev=>isAnomalyEvent(ev,m)).length,0);
  document.getElementById('kpiFaults').textContent=faults;

  const list=document.getElementById('recentMeasures');
  if(!AppState.measures.length){
    list.innerHTML='<div class="empty">Aucune mesure importée pour l\'instant.</div>';
    return;
  }
  const recent=[...AppState.measures].sort((a,b)=>b.date-a.date).slice(0,5);
  list.innerHTML=recent.map(m=>measureCardHTML(m)).join('');
  list.querySelectorAll('.card').forEach((el,idx)=>{
    el.addEventListener('click',()=>{ switchView('mesures'); openMeasureDetail(recent[idx]); });
  });
}

function measureCardHTML(m){
  const nAnom=(m.events||[]).filter(ev=>isAnomalyEvent(ev,m)).length;
  return `<div class="card tap">
    <div class="row">
      <strong style="font-size:13px;">${m.cable||m.name}</strong>
      <span class="badge ${nAnom>0?'fault':'ok'}">${nAnom>0?nAnom+' évt(s)':'OK'}</span>
    </div>
    <div class="row"><span class="sub">Fibre ${m.fibre||'—'} · ${m.manualOrigine||m.origine||'?'} → ${m.manualExtremite||m.extremite||'?'}${m.manualOrigine?'<span style="font-size:9px;color:var(--fiber);margin-left:4px;">● manuel</span>':''}</span></div>
    <div class="row"><span class="sub">Bilan ${fmtNum(m.bilanTotal,3)} dB · Longueur ${fmtLen(m.finFibre)}</span></div>
  </div>`;
}

/* ---------------- RENDER : MESURES ---------------- */
function renderMesures(){
  const list=document.getElementById('measuresList');
  if(!AppState.measures.length){
    list.innerHTML='<div class="empty">Aucun fichier PDF importé.</div>';
    return;
  }
  const sorted=[...AppState.measures].sort((a,b)=>b.date-a.date);
  list.innerHTML=sorted.map(m=>measureCardHTML(m)).join('');
  list.querySelectorAll('.card').forEach((el,idx)=>{
    el.addEventListener('click',()=>openMeasureDetail(sorted[idx]));
  });
}

function openMeasureDetail(m){
  AppState.currentMeasure=m;

  function esc(v){
    if(v==null) return '&#8212;';
    try{ return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    catch(e){ return '&#8212;'; }
  }

  var siteNames=[];
  try{
    siteNames=[...new Set(AppState.points.filter(function(p){return p.category==='bts';}).map(function(p){return p.name;}))].sort();
  }catch(e){ console.error('siteNames error',e); }

  function best(term){
    if(!term) return '';
    try{
      var t=norm(term);
      return siteNames.find(function(n){return norm(n)===t;})
        ||siteNames.find(function(n){return norm(n).includes(t)||t.includes(norm(n));})||'';
    }catch(e){ return ''; }
  }
  var vA=m.manualOrigine||best(m.origine)||'';
  var vB=m.manualExtremite||best(m.extremite)||'';

  function badge(val){
    if(!val) return '';
    return siteNames.indexOf(val)>=0
      ?'<span style="color:var(--fiber);font-size:10px;">&#10003; site trouv&#233;</span>'
      :'<span style="color:var(--fault);font-size:10px;">&#10007; non trouv&#233;</span>';
  }
  function chipPDF(raw,fnName,ref){
    if(!raw||raw===ref) return '';
    var safe=esc(raw).replace(/'/g,'&#39;');
    return '<div style="font-size:11px;color:var(--muted);margin-bottom:4px;">'
      +'&#128196; PDF : <b>'+safe+'</b>'
      +' <button class="btn small secondary" style="padding:3px 8px;" onclick="'+fnName+'(\''+safe+'\')">&#8592; utiliser</button>'
      +'</div>';
  }

  var opts='';
  try{
    opts=siteNames.map(function(n){return '<option value="'+esc(n)+'">';}).join('');
  }catch(e){ console.error('opts error',e); }

  // --- BLOC 1 : ITINÉRAIRE — toujours construit et affiché en priorité ---
  var itinHtml='';
  try{
    itinHtml=''
      +'<h2>Itin&#233;raire</h2>'
      +'<datalist id="slCorr">'+opts+'</datalist>'
      +'<div class="card">'
        +'<div style="margin-bottom:10px;">'
          +'<div style="display:flex;justify-content:space-between;margin-bottom:4px;">'
            +'<label style="font-size:11px;color:var(--muted);text-transform:uppercase;">Origine</label>'
            +'<span id="stA">'+badge(vA)+'</span>'
          +'</div>'
          +chipPDF(m.origine,'setOrigine',vA)
          +'<input id="inpOrigine" list="slCorr" value="'+esc(vA)+'" autocomplete="off" oninput="updSt(\'inpOrigine\',\'stA\')"'
          +' style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px;font-size:13px;">'
        +'</div>'
        +'<div style="margin-bottom:12px;">'
          +'<div style="display:flex;justify-content:space-between;margin-bottom:4px;">'
            +'<label style="font-size:11px;color:var(--muted);text-transform:uppercase;">Extr&#233;mit&#233;</label>'
            +'<span id="stB">'+badge(vB)+'</span>'
          +'</div>'
          +chipPDF(m.extremite,'setExtremite',vB)
          +'<input id="inpExtremite" list="slCorr" value="'+esc(vB)+'" autocomplete="off" oninput="updSt(\'inpExtremite\',\'stB\')"'
          +' style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px;font-size:13px;">'
        +'</div>'
        +'<div style="margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;">'
          +'<span class="sub">'+(m.manualWaypoints&&m.manualWaypoints.length ? '📍 '+m.manualWaypoints.length+' point(s) de passage' : 'Aucun point de passage')+'</span>'
          +'<button class="btn small secondary" onclick="openWaypointEditor()">📍 Ajuster sur la carte</button>'
        +'</div>'
        +'<div style="display:flex;gap:8px;align-items:center;">'
          +'<button class="btn" style="flex:1;" onclick="applyCorrelation()">&#128506; Tracer l\'itin&#233;raire</button>'
          +'<button class="btn secondary" style="width:36px;height:36px;padding:0;font-size:16px;" onclick="saveEndpoints()">&#128190;</button>'
        +'</div>'
      +'</div>'
      +'<div id="corrResult"></div>';
  }catch(e){
    console.error('itinHtml error',e);
    itinHtml='<h2>Itin&#233;raire</h2><div class="card"><p class="sub" style="color:var(--fault);">Erreur d\'affichage. Recharge la page.</p></div>';
  }

  // --- BLOC 2 : HEADER + KPI ---
  var headerHtml='';
  try{
    headerHtml=''
      +'<h1>'+esc(m.cable||m.name||'&#8212;')+'</h1>'
      +'<p class="sub">'+esc(m.name||'')+'</p>'
      +'<div class="kpi-grid">'
        +'<div class="kpi"><div class="v">'+esc(m.fibre||'&#8212;')+'</div><div class="l">Fibre</div></div>'
        +'<div class="kpi"><div class="v">'+esc(fmtLen(m.finFibre))+'</div><div class="l">Longueur</div></div>'
        +'<div class="kpi"><div class="v">'+esc(fmtNum(m.bilanTotal,3))+'</div><div class="l">Bilan dB</div></div>'
        +'<div class="kpi"><div class="v">'+esc(fmtNum(m.orl,2))+'</div><div class="l">ORL dB</div></div>'
      +'</div>';
  }catch(e){
    console.error('headerHtml error',e);
    headerHtml='<h1>'+esc(m.name||'Mesure')+'</h1>';
  }

  // --- BLOC 3 : TABLEAU ÉVÉNEMENTS — le plus à risque, isolé en dernier ---
  var eventsHtml='';
  try{
    var evRows='';
    (m.events||[]).forEach(function(ev){
      var anom=false;
      try{ anom=isAnomalyEvent(ev,m); }catch(e2){}
      var cls=anom?'fault':'';
      evRows+='<tr class="event-row '+cls+'">'
        +'<td>'+esc(ev.num)+'</td>'
        +'<td>'+esc(fmtNum(ev.distance,1))+' m</td>'
        +'<td>'+(ev.affaib!=null?esc(fmtNum(ev.affaib,3)):'&#8212;')+'</td>'
        +'<td>'+(ev.reflect!=null?esc(fmtNum(ev.reflect,2)):'&#8212;')+'</td>'
        +'<td>'+(ev.pente!=null?esc(fmtNum(ev.pente,3)):'&#8212;')+'</td>'
        +'<td>'+(ev.bilan!=null?esc(fmtNum(ev.bilan,3)):'&#8212;')+'</td>'
        +'</tr>';
    });
    eventsHtml=''
      +'<h2>&#201;v&#233;nements OTDR</h2>'
      +'<div class="tablewrap"><table><thead>'
      +'<tr><th>#</th><th>Distance</th><th>Aff.</th><th>R&#233;fl.</th><th>Pente</th><th>Bilan</th></tr>'
      +'</thead><tbody>'+evRows+'</tbody></table></div>';
  }catch(e){
    console.error('eventsHtml error',e);
    eventsHtml='<h2>&#201;v&#233;nements OTDR</h2><p class="sub" style="color:var(--fault);">Erreur d\'affichage du tableau ('+esc(e.message)+').</p>';
  }

  // --- Assemblage final : header, tableau, puis itinéraire (toujours présent) ---
  document.getElementById('detailContent').innerHTML = headerHtml + eventsHtml + itinHtml;
  document.getElementById('detailOverlay').classList.add('active');

  try{
    var cached=AppState.correlations[m.recId];
    if(cached) renderCorrelationResult(cached,m);
  }catch(e){ console.error('renderCorrelationResult error',e); }
}

function setOrigine(v){ const e=document.getElementById('inpOrigine'); if(e){e.value=v;updSt('inpOrigine','stA');}}
function setExtremite(v){ const e=document.getElementById('inpExtremite'); if(e){e.value=v;updSt('inpExtremite','stB');}}
function updSt(inputId,statusId){
  const e=document.getElementById(inputId), s=document.getElementById(statusId);
  if(!e||!s) return;
  const v=e.value.trim();
  const sn=[...new Set(AppState.points.filter(p=>p.category==='bts').map(p=>p.name))];
  s.innerHTML=v?(sn.includes(v)
    ?'<span style="color:var(--fiber);font-size:10px;">✓ site trouvé</span>'
    :'<span style="color:var(--fault);font-size:10px;">✗ non trouvé</span>'):'';
}

/* ================================================================
   CORRÉLATION : GPS-chaining (tracé KML) + fallback linéaire
   ================================================================ */

function sitePair(name){
  if(!name) return null;
  const t=norm(name);
  const s=AppState.points.find(p=>p.category==='bts'&&norm(p.name)===t)
       ||AppState.points.find(p=>p.category==='bts'&&(norm(p.name).includes(t)||t.includes(norm(p.name))));
  return s?[s.lat,s.lon]:null;
}

// Chaîne une liste générique de sections {id, coords:[[lat,lon],...]} par
// proximité GPS, depuis originCoord vers destCoord (algorithme glouton :
// à chaque étape, on rattache la section non utilisée la plus proche du
// dernier point atteint). Réutilisé à la fois pour les sections KML du
// tracé fibre ET pour les tronçons de route nationale OSM (Overpass).
function chainSectionsByGPS(sections,originCoord,destCoord,maxGapM){
  if(!sections.length) return null;
  const secs=sections.map(s=>({s,A:s.coords[0],B:s.coords[s.coords.length-1]}));
  let bestD=Infinity,startSec=null,startRev=false;
  secs.forEach(({s,A,B})=>{
    const dA=haversine(originCoord[0],originCoord[1],A[0],A[1]);
    const dB=haversine(originCoord[0],originCoord[1],B[0],B[1]);
    if(dA<bestD){bestD=dA;startSec=s;startRev=false;}
    if(dB<bestD){bestD=dB;startSec=s;startRev=true;}
  });
  if(!startSec||bestD>maxGapM*3) return null;
  const used=new Set(); const chain=[];
  let cur=startSec,rev=startRev;
  for(let i=0;i<=sections.length;i++){
    used.add(cur.id); chain.push({section:cur,reversed:rev});
    const tip=rev?cur.coords[0]:cur.coords[cur.coords.length-1];
    if(haversine(tip[0],tip[1],destCoord[0],destCoord[1])<maxGapM) break;
    let nSec=null,nRev=false,nD=Infinity;
    secs.forEach(({s,A,B})=>{
      if(used.has(s.id)) return;
      const dA=haversine(tip[0],tip[1],A[0],A[1]);
      const dB=haversine(tip[0],tip[1],B[0],B[1]);
      if(dA<nD){nD=dA;nSec=s;nRev=false;}
      if(dB<nD){nD=dB;nSec=s;nRev=true;}
    });
    if(!nSec||nD>maxGapM) break;
    cur=nSec; rev=nRev;
  }
  return chain.length?chain:null;
}
function buildPathByGPS(originCoord,destCoord,maxGapM=600){
  return chainSectionsByGPS(AppState.sections,originCoord,destCoord,maxGapM);
}

// Place chaque événement à SA distance mesurée (OTDR), brute, sans rééchelonnage.
// L'origine = début du chaînage (distance 0). On marche le long des sections
// dans l'ordre jusqu'à atteindre la distance de l'événement.
function placeEventsOnChain(chain,events){
  return (events||[]).map(ev=>{
    let acc=0,pos=null,secName=null;
    for(const {section,reversed} of chain){
      const isLast=chain[chain.length-1].section===section;
      if(ev.distance<=acc+section.length+0.001||isLast){
        const coords=reversed?[...section.coords].reverse():section.coords;
        pos=interpolateAlong(coords,Math.min(section.length,Math.max(0,ev.distance-acc)));
        secName=section.name; break;
      }
      acc+=section.length;
    }
    return {...ev,pos,secName};
  });
}

// Itinéraire routier (OSRM, service public gratuit, profil "driving").
// fetchRoadRouteOnce accepte maintenant une LISTE de points [lat,lon] (pas
// seulement origine+destination) pour pouvoir forcer le passage par des
// points intermédiaires (waypoints) — utilisé pour imposer le tracé réel
// d'une route nationale plutôt que de se fier aux tags motorway/trunk
// (peu fiables au Sénégal : certains tronçons d'autoroute à péage sont
// tagués différemment selon le contributeur OSM).
async function fetchRoadRouteOnce(coordsList,excludeParam,timeoutMs){
  const coordsStr=coordsList.map(c=>c[1]+','+c[0]).join(';'); // [lat,lon]→"lon,lat"
  const url='https://router.project-osrm.org/route/v1/driving/'+coordsStr
    +'?overview=full&geometries=geojson'+(excludeParam?'&exclude='+excludeParam:'');
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const res=await fetch(url,{signal:ctrl.signal});
    clearTimeout(timer);
    if(!res.ok) return null;
    const data=await res.json();
    if(data.code!=='Ok'||!data.routes||!data.routes.length) return null;
    const route=data.routes[0];
    const coords=route.geometry.coordinates.map(c=>[c[1],c[0]]);
    return {coords, distance:route.distance, excludeUsed:excludeParam||'aucun'};
  }catch(e){
    clearTimeout(timer);
    console.error('fetchRoadRoute(exclude='+(excludeParam||'aucun')+') a échoué:',e);
    return null;
  }
}

// Récupère le tracé réel des routes nationales sénégalaises (N1 à N15) via
// Overpass (données OpenStreetMap), dans une zone bornée autour du trajet,
// pour les utiliser comme waypoints forcés et garantir le passage par la
// route nationale plutôt que par une autoroute à péage mal taguée.
const NATIONAL_ROAD_REFS=['N1','N2','N3','N4','N5','N6','N7','N8','N9','N10','N11','N12','N13','N14','N15'];

async function fetchNationalRoadSections(oGPS,dGPS,timeoutMs=15000){
  const south=Math.min(oGPS[0],dGPS[0])-0.4, north=Math.max(oGPS[0],dGPS[0])+0.4;
  const west =Math.min(oGPS[1],dGPS[1])-0.4, east =Math.max(oGPS[1],dGPS[1])+0.4;
  const refPattern='^(N1|N2|N3|N4|N5|N6|N7|N8|N9|N10|N11|N12|N13|N14|N15)$';
  const query='[out:json][timeout:20];'
    +'rel["route"="road"]["ref"~"'+refPattern+'"]('+south+','+west+','+north+','+east+');'
    +'out geom;';
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const res=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'data='+encodeURIComponent(query),
      signal:ctrl.signal
    });
    clearTimeout(timer);
    if(!res.ok) return [];
    const data=await res.json();
    const sections=[];
    (data.elements||[]).forEach(el=>{
      if(el.type!=='relation'||!el.members) return;
      const ref=(el.tags&&el.tags.ref)||'?';
      el.members.forEach((mem,idx)=>{
        if(mem.type==='way' && mem.geometry && mem.geometry.length>=2){
          sections.push({
            id:ref+'_'+(mem.ref||idx),
            coords:mem.geometry.map(g=>[g.lat,g.lon])
          });
        }
      });
    });
    return sections;
  }catch(e){
    clearTimeout(timer);
    console.error('fetchNationalRoadSections a échoué:',e);
    return [];
  }
}

// Échantillonne un chaînage de sections en une liste de waypoints espacés
// d'environ stepM mètres, pour ne pas dépasser une URL OSRM raisonnable.
function sampleChainWaypoints(chain,stepM=8000,maxPoints=40){
  const pts=[];
  let accSinceLastPt=Infinity;
  chain.forEach(({section,reversed})=>{
    const coords=reversed?[...section.coords].reverse():section.coords;
    for(let i=0;i<coords.length;i++){
      if(i>0){
        accSinceLastPt+=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
      }
      if(accSinceLastPt>=stepM || (pts.length===0)){
        pts.push(coords[i]);
        accSinceLastPt=0;
      }
    }
  });
  // Sous-échantillonnage si trop de points (limite raisonnable d'URL)
  if(pts.length>maxPoints){
    const out=[pts[0]];
    const step=(pts.length-1)/(maxPoints-1);
    for(let i=1;i<maxPoints-1;i++) out.push(pts[Math.round(i*step)]);
    out.push(pts[pts.length-1]);
    return out;
  }
  return pts;
}

// Tente de forcer l'itinéraire OSRM à suivre le tracé réel d'une route
// nationale (N1-N15) entre origine et extrémité, via des waypoints imposés.
// Retourne null si aucune route nationale proche n'est trouvée (ou en cas
// d'échec réseau) — le code appelant retombe alors sur la cascade exclude=.
async function fetchNationalRoadRoute(oGPS,dGPS,timeoutMs=9000){
  const sections=await fetchNationalRoadSections(oGPS,dGPS,15000);
  if(!sections.length) return null;
  const chain=chainSectionsByGPS(sections,oGPS,dGPS,3000); // tolérance plus large (segments OSM disjoints)
  if(!chain||chain.length<1) return null;

  // Vérifie que le chaînage couvre bien le trajet (1er et dernier point proches
  // de l'origine/extrémité réelles) — sinon ce n'est pas la bonne route.
  const firstPt=chain[0].reversed?chain[0].section.coords[chain[0].section.coords.length-1]:chain[0].section.coords[0];
  const lastSeg=chain[chain.length-1];
  const lastPt=lastSeg.reversed?lastSeg.section.coords[0]:lastSeg.section.coords[lastSeg.section.coords.length-1];
  if(haversine(firstPt[0],firstPt[1],oGPS[0],oGPS[1])>15000) return null;
  if(haversine(lastPt[0],lastPt[1],dGPS[0],dGPS[1])>15000) return null;

  const waypoints=sampleChainWaypoints(chain);
  if(waypoints.length<2) return null;
  const coordsList=[oGPS,...waypoints,dGPS];

  // exclude=motorway en sécurité supplémentaire (au cas où OSRM raccourcit
  // entre deux waypoints forcés via un tronçon d'autoroute parallèle)
  let r=await fetchRoadRouteOnce(coordsList,'motorway',timeoutMs);
  if(!r) r=await fetchRoadRouteOnce(coordsList,'',timeoutMs);
  if(r) r.excludeUsed='route_nationale';
  return r;
}

async function fetchRoadRoute(oGPS,dGPS,timeoutMs=9000){
  // 1) Priorité : forcer le passage par la route nationale réelle (OSM N1-N15)
  try{
    const national=await fetchNationalRoadRoute(oGPS,dGPS,timeoutMs);
    if(national) return national;
  }catch(e){ console.error('fetchNationalRoadRoute a échoué:',e); }

  // 2) Repli : cascade d'exclusion par classe de route (motorway/trunk)
  const tiers=['motorway,trunk','motorway',''];
  for(let i=0;i<tiers.length;i++){
    const r=await fetchRoadRouteOnce([oGPS,dGPS],tiers[i],timeoutMs);
    if(r){
      if(i>0) console.error('Niveau d\'évitement réduit à "'+(tiers[i]||'aucun')+'" (niveau précédent indisponible pour ce trajet).');
      return r;
    }
  }
  return null;
}

// Itinéraire OSRM (voiture, sans péage) pris comme tracé global depuis l'origine.
// Chaque événement est placé à SA distance mesurée (OTDR), brute, en marchant
// le long de cet itinéraire — exactement comme pour un tracé KML.
function placeEventsOnRoute(routeCoords,events){
  return (events||[]).map(ev=>({...ev,pos:interpolateAlong(routeCoords,ev.distance)}));
}

async function correlateLinear(measure){
  try{
    const oName=measure.manualOrigine||measure.origine;
    const dName=measure.manualExtremite||measure.extremite;
    const oGPS=sitePair(oName);
    const dGPS=sitePair(dName);
    if(!oGPS) return {error:`Site introuvable : "${oName}"\n→ Charge base_site.kmz et vérifie le nom.`};
    if(!dGPS) return {error:`Site introuvable : "${dName}"\n→ Charge base_site.kmz et vérifie le nom.`};

    // 0) Points de passage placés manuellement sur la carte → priorité absolue
    //    (l'utilisateur sait exactement par où passer, on ne devine plus rien)
    if(measure.manualWaypoints && measure.manualWaypoints.length){
      try{
        const coordsList=[oGPS, ...measure.manualWaypoints, dGPS];
        let r=await fetchRoadRouteOnce(coordsList,'motorway',9000);
        if(!r) r=await fetchRoadRouteOnce(coordsList,'',9000);
        if(r && r.coords && r.coords.length>1 && r.distance>0){
          const events=placeEventsOnRoute(r.coords,measure.events);
          return {routeCoords:r.coords,events,originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,total:r.distance,measureLen:measure.finFibre,excludeUsed:'waypoints_manuels',mode:'road'};
        }
      }catch(e){ console.error('Itinéraire par waypoints manuels a échoué:',e); }
      // Si même les waypoints manuels échouent, on continue vers les méthodes automatiques ci-dessous
    }

    // 1) Tracé fibre réel (sections KML chaînées par GPS)
    let chain=null;
    try{ chain=buildPathByGPS(oGPS,dGPS); }
    catch(e){ console.error('buildPathByGPS a échoué:',e); chain=null; }

    if(chain && chain.length){
      const total=chain.reduce((s,{section})=>s+(section.length||0),0);
      if(total>0 && isFinite(total)){
        const events=placeEventsOnChain(chain,measure.events);
        const gapPct=measure.finFibre?Math.abs(total-measure.finFibre)/measure.finFibre*100:null;
        return {chain,events,originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,total,measureLen:measure.finFibre,gapPct,mode:'chain'};
      }
    }

    // 2) Pas de tracé KML : itinéraire OSRM (voiture, péages exclus)
    // Chaque événement est placé à sa distance mesurée brute, en marchant
    // le long de cet itinéraire depuis l'origine.
    const road=await fetchRoadRoute(oGPS,dGPS);
    if(road && road.coords && road.coords.length>1 && road.distance>0){
      const events=placeEventsOnRoute(road.coords,measure.events);
      return {routeCoords:road.coords,events,originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,total:road.distance,measureLen:measure.finFibre,excludeUsed:road.excludeUsed,mode:'road'};
    }

    // 3) Dernier repli : ligne droite (pas d'internet ou route introuvable)
    // Ici uniquement, on utilise un ratio car il n'y a pas de géométrie réelle à parcourir.
    const total=measure.finFibre||haversine(oGPS[0],oGPS[1],dGPS[0],dGPS[1]);
    const events=(measure.events||[]).map(ev=>{
      const r=total>0?Math.min(1,Math.max(0,ev.distance/total)):0;
      return {...ev,pos:[oGPS[0]+(dGPS[0]-oGPS[0])*r,oGPS[1]+(dGPS[1]-oGPS[1])*r]};
    });
    return {events,originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,total,measureLen:measure.finFibre,mode:'linear'};
  }catch(e){
    console.error('correlateLinear a échoué:',e);
    return {error:'Erreur de calcul : '+e.message};
  }
}

async function applyCorrelation(){
  try{
    const m=AppState.currentMeasure;
    if(!m){toast('Aucune mesure ouverte');return;}
    const inpA=document.getElementById('inpOrigine');
    const inpB=document.getElementById('inpExtremite');
    if(!inpA||!inpB){toast('Erreur : champs introuvables');console.error('inpOrigine/inpExtremite manquants dans le DOM');return;}
    const a=inpA.value.trim();
    const b=inpB.value.trim();
    if(!a||!b){toast('Renseigne les deux sites');return;}

    toast('Calcul de l\'itinéraire…');
    const mEff={...m,manualOrigine:a,manualExtremite:b};
    const result=await correlateLinear(mEff);
    AppState.correlations[m.recId]=result;
    AppState.activeCorrelation={result,measure:mEff};
    renderCorrelationResult(result,mEff);

    if(result.error){
      toast('Erreur : '+result.error.split('\n')[0]);
      return;
    }
    if(result.mode==='road') toast('Itinéraire routier trouvé 🚗');
    else if(result.mode==='linear') toast('Pas de route trouvée — ligne directe affichée');

    setTimeout(function(){
      try{
        document.getElementById('detailOverlay').classList.remove('active');
        switchView('carte');
        setTimeout(function(){
          try{
            if(AppState.map) AppState.map.invalidateSize();
            drawCorrelationLayer();
          }catch(e2){
            console.error('Erreur affichage carte (2):',e2);
            toast('Erreur affichage carte : '+e2.message);
          }
        },120);
      }catch(e){
        console.error('Erreur affichage carte:',e);
        toast('Erreur affichage carte : '+e.message);
      }
    },300);
  }catch(e){
    console.error('applyCorrelation a échoué:',e);
    toast('Erreur : '+e.message);
  }
}

async function saveEndpoints(){
  const m=AppState.currentMeasure;
  if(!m) return;
  const a=(document.getElementById('inpOrigine')||{value:''}).value.trim();
  const b=(document.getElementById('inpExtremite')||{value:''}).value.trim();
  const recs=await dbGetAll();
  const rec=recs.find(r=>r.id===m.recId);
  if(!rec) return;

  rec.manualOrigine=a||null; rec.manualExtremite=b||null;
  await dbUpdate(rec);

  // Partage automatique : même câble (même PDF, même origine/extrémité d'origine)
  // → toutes les autres fibres de ce câble reçoivent la même corrélation,
  // évitant de ressaisir Origine/Extrémité pour chaque fibre.
  let sharedCount=0;
  if(m.cableKey){
    const siblings=recs.filter(r=>r.id!==m.recId && r.cableKey===m.cableKey);
    for(const sib of siblings){
      sib.manualOrigine=a||null; sib.manualExtremite=b||null;
      await dbUpdate(sib);
      sharedCount++;
    }
  }

  AppState.currentMeasure={...m,manualOrigine:a||null,manualExtremite:b||null};
  await loadAll();
  toast(sharedCount>0 ? `Sauvegardé ✓ (partagé sur ${sharedCount} autre(s) fibre(s))` : 'Sauvegardé ✓');
}

/* ---------------- ÉDITEUR DE WAYPOINTS (sur la carte) ----------------
   Permet de forcer manuellement l'itinéraire à passer par des points tapés
   sur la carte (utile quand la détection automatique de route nationale
   échoue ou choisit le mauvais chemin). Les points sont sauvegardés sur la
   mesure (manualWaypoints) et réutilisés à chaque "Tracer l'itinéraire".
*/
function openWaypointEditor(){
  const m=AppState.currentMeasure;
  if(!m){ toast('Aucune mesure ouverte'); return; }
  const oName=m.manualOrigine||m.origine, dName=m.manualExtremite||m.extremite;
  const oGPS=sitePair(oName), dGPS=sitePair(dName);
  if(!oGPS||!dGPS){
    toast('Renseigne d\'abord Origine et Extrémité (sites trouvés)');
    return;
  }

  AppState.waypointMode={
    recId:m.recId, oGPS, dGPS,
    points:(m.manualWaypoints||[]).map(p=>[p[0],p[1]])
  };

  document.getElementById('detailOverlay').classList.remove('active');
  switchView('carte');
  setTimeout(()=>{
    try{
      if(!AppState.map) initMap();
      if(AppState.map) AppState.map.invalidateSize();
      document.getElementById('waypointBanner').style.display='flex';
      document.getElementById('waypointCrosshair').style.display='block';
      document.getElementById('btnWaypointAdd').style.display='flex';
      attachWaypointMapClick();
      redrawWaypointEdit();
      toast('Vise un endroit puis appuie sur "+ Ajouter ici" (ou touche directement la carte)');
    }catch(e){
      console.error('openWaypointEditor error',e);
      toast('Erreur ouverture éditeur : '+e.message);
    }
  },350);
}

function attachWaypointMapClick(){
  if(!AppState.map || AppState.map._waypointClickAttached) return;
  AppState.map.on('click', onWaypointMapClick);
  AppState.map._waypointClickAttached=true;
}
function detachWaypointMapClick(){
  if(!AppState.map) return;
  AppState.map.off('click', onWaypointMapClick);
  AppState.map._waypointClickAttached=false;
}
function addWaypointPoint(lat,lng){
  if(!AppState.waypointMode) return;
  AppState.waypointMode.points.push([lat,lng]);
  redrawWaypointEdit();
}
function addWaypointAtCenter(){
  if(!AppState.map || !AppState.waypointMode) return;
  const c=AppState.map.getCenter();
  addWaypointPoint(c.lat,c.lng);
  toast('Point ajouté');
}
function onWaypointMapClick(e){
  addWaypointPoint(e.latlng.lat, e.latlng.lng);
}
function removeWaypointAt(idx){
  if(!AppState.waypointMode) return;
  AppState.waypointMode.points.splice(idx,1);
  redrawWaypointEdit();
  toast('Point retiré');
}
function undoLastWaypoint(){
  if(!AppState.waypointMode || !AppState.waypointMode.points.length) return;
  AppState.waypointMode.points.pop();
  redrawWaypointEdit();
}
function redrawWaypointEdit(){
  if(!AppState.map || !AppState.waypointMode) return;
  const wm=AppState.waypointMode;
  AppState.layers.waypointEdit.clearLayers();
  if(!AppState.layers.waypointEdit._map) AppState.layers.waypointEdit.addTo(AppState.map);

  const allPts=[wm.oGPS, ...wm.points, wm.dGPS];
  L.polyline(allPts,{color:'#ffd454',weight:3,opacity:.85,dashArray:'6,6'}).addTo(AppState.layers.waypointEdit);

  L.circleMarker(wm.oGPS,{radius:8,color:'#4f9eff',fillColor:'#4f9eff',fillOpacity:1,weight:2})
    .bindPopup('Origine').addTo(AppState.layers.waypointEdit);
  L.circleMarker(wm.dGPS,{radius:8,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2})
    .bindPopup('Extrémité').addTo(AppState.layers.waypointEdit);

  wm.points.forEach((p,idx)=>{
    L.marker(p,{icon:L.divIcon({
      className:'',
      html:'<div style="background:#ffd454;color:#1a1408;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #1a1408;">'+(idx+1)+'</div>',
      iconSize:[24,24], iconAnchor:[12,12]
    })})
      .bindPopup('Point '+(idx+1)+'<br><button class="btn small secondary" onclick="removeWaypointAt('+idx+')">🗑 Retirer</button>')
      .addTo(AppState.layers.waypointEdit);
  });

  const countEl=document.getElementById('waypointCount');
  if(countEl) countEl.textContent = wm.points.length
    ? '📍 '+wm.points.length+' point(s)'
    : '📍 Aucun point — vise et appuie sur "+"';
}

function exitWaypointEditor(){
  detachWaypointMapClick();
  if(AppState.layers.waypointEdit) AppState.layers.waypointEdit.clearLayers();
  document.getElementById('waypointBanner').style.display='none';
  document.getElementById('waypointCrosshair').style.display='none';
  document.getElementById('btnWaypointAdd').style.display='none';
  AppState.waypointMode=null;
}

function cancelWaypointEdit(){
  exitWaypointEditor();
  toast('Modifications annulées');
}

async function finishWaypointEdit(){
  const wm=AppState.waypointMode;
  if(!wm) return;
  try{
    const recs=await dbGetAll();
    const rec=recs.find(r=>r.id===wm.recId);
    if(rec){
      rec.manualWaypoints = wm.points.length ? wm.points : null;
      await dbUpdate(rec);
    }
    const pointsSnapshot=wm.points.slice();
    exitWaypointEditor();
    await loadAll();
    toast(pointsSnapshot.length ? 'Points enregistrés ✓ — recalcul…' : 'Points effacés ✓ — recalcul…');

    // Relance immédiatement la corrélation avec ces points pour montrer le résultat
    const m=AppState.measures.find(x=>x.recId===wm.recId);
    if(m){
      AppState.currentMeasure=m;
      const result=await correlateLinear(m);
      AppState.correlations[m.recId]=result;
      AppState.activeCorrelation={result, measure:m};
      if(!result.error) drawCorrelationLayer();
      else toast('Erreur itinéraire : '+result.error.split('\n')[0]);
    }
  }catch(e){
    console.error('finishWaypointEdit error',e);
    toast('Erreur : '+e.message);
  }
}

function renderCorrelationResult(result,measure){
  const div=document.getElementById('corrResult');
  if(!div) return;
  if(result.error){
    div.innerHTML=`<div class="card" style="border-color:var(--fault);white-space:pre-line;margin-top:8px;"><span class="sub" style="color:var(--fault);">${result.error}</span></div>`;
    return;
  }
  function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  const exclLabel = {
    'waypoints_manuels':'📍 points de passage manuels appliqués',
    'route_nationale':'✓ tracé réel de la route nationale (OSM) imposé',
    'motorway,trunk':'autoroute + nationale rapide évitées',
    'motorway':'autoroute évitée (national rapide possible)',
    'aucun':'⚠ tous axes autorisés (autoroute possible)'
  }[result.excludeUsed] || '';
  const modeLabel = result.mode==='chain' ? '🟢 Tracé fibre (KML)'
    : result.mode==='road' ? '🔵 Itinéraire routier'
    : '⚪ Ligne directe (approximation)';
  const roadNote = result.mode==='road'
    ? `<p class="sub" style="margin-top:4px;">Itinéraire calculé par OSRM (voiture). ${exclLabel}. Chaque événement est placé à sa distance exacte mesurée (OTDR), en suivant cet itinéraire depuis l'origine.</p>`
    : '';
  const gapWarning = (result.mode==='chain' && result.gapPct!=null && result.gapPct>15)
    ? `<div class="row" style="color:var(--fault);"><span class="sub">⚠ Écart important</span><strong>${result.gapPct.toFixed(0)}%</strong></div>
       <p class="sub" style="color:var(--fault);margin-top:4px;">Le tracé trouvé (${fmtLen(result.total)}) diffère beaucoup de la longueur mesurée OTDR (${fmtLen(result.measureLen)}). Les événements proches de l'extrémité peuvent être mal placés — vérifie les noms de sites ou le tracé KML.</p>`
    : '';
  div.innerHTML=`
    <div class="card" style="margin-top:8px;">
      <div class="row"><span class="sub">${esc(result.originName)} → ${esc(result.destName)}</span></div>
      <div class="row"><span class="sub">Mode</span><strong>${modeLabel}</strong></div>
      <div class="row"><span class="sub">Longueur tracé</span><strong>${fmtLen(result.total)}</strong></div>
      ${result.measureLen?`<div class="row"><span class="sub">Longueur mesurée (OTDR)</span><strong>${fmtLen(result.measureLen)}</strong></div>`:''}
      ${roadNote}
      ${gapWarning}
    </div>
    <div class="tablewrap" style="margin-top:8px;"><table><thead><tr><th>#</th><th>Distance</th><th>Lat</th><th>Lon</th><th></th></tr></thead><tbody>
    ${(result.events||[]).map(ev=>{
      const anom=isAnomalyEvent(ev,measure);
      return `<tr class="event-row ${anom?'fault':''}">
        <td>${ev.num}</td><td>${fmtNum(ev.distance,1)} m</td>
        <td>${ev.pos?ev.pos[0].toFixed(5):'—'}</td>
        <td>${ev.pos?ev.pos[1].toFixed(5):'—'}</td>
        <td>${ev.pos?`<button class="btn small secondary" onclick="navigateTo(${ev.pos[0]},${ev.pos[1]})">🧭</button>`:''}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>
  `;
  AppState.activeCorrelation={result,measure};
}

function showCorrelationOnMap(){
  document.getElementById('detailOverlay').classList.remove('active');
  switchView('carte');
  drawCorrelationLayer();
}

function navigateTo(lat,lon){
  const url=`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;
  window.open(url,'_blank');
}

/* ---------------- RENDER : SECTIONS ---------------- */
function renderSections(filter){
  const list=document.getElementById('sectionsList');
  const kpis=document.getElementById('sectionsKpis');
  if(!AppState.sections.length){
    kpis.innerHTML='';
    list.innerHTML='<div class="empty">Aucune section chargée. Importe un fichier KML/KMZ.</div>';
    return;
  }
  const totalLen=AppState.sections.reduce((a,s)=>a+s.length,0);
  kpis.innerHTML=`
    <div class="kpi"><div class="v">${AppState.sections.length}</div><div class="l">Sections</div></div>
    <div class="kpi"><div class="v">${fmtLen(totalLen)}</div><div class="l">Longueur totale</div></div>
  `;
  let secs=AppState.sections;
  if(filter){
    const f=filter.toUpperCase();
    secs=secs.filter(s=>(s.endA||'').toUpperCase().includes(f) || (s.endB||'').toUpperCase().includes(f) || s.name.toUpperCase().includes(f));
  }
  if(!secs.length){
    list.innerHTML='<div class="empty">Aucun résultat pour cette recherche.</div>';
    return;
  }
  list.innerHTML=secs.slice(0,300).map(s=>`
    <div class="card tap" data-id="${s.id}">
      <div class="row"><strong style="font-size:12px;">${s.endA||'?'} ↔ ${s.endB||'?'}</strong><span class="badge kml">${fmtLen(s.length)}</span></div>
      <div class="row"><span class="sub">${s.type||s.name}</span></div>
    </div>`).join('') + (secs.length>300?`<p class="sub" style="text-align:center;margin-top:8px;">${secs.length-300} résultat(s) supplémentaire(s) — affine la recherche.</p>`:'');
  list.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click',()=>{
      const sec=AppState.sections.find(s=>s.id===el.dataset.id);
      openSectionDetail(sec);
    });
  });
}
function openSectionDetail(s){
  document.getElementById('detailContent').innerHTML=`
    <h1>${s.endA||'?'} ↔ ${s.endB||'?'}</h1>
    <p class="sub">${s.name}</p>
    <div class="kpi-grid" style="margin-top:10px;">
      <div class="kpi"><div class="v">${fmtLen(s.length)}</div><div class="l">Longueur</div></div>
      <div class="kpi"><div class="v">${s.coords.length}</div><div class="l">Points GPS</div></div>
    </div>
    <p class="sub" style="margin-top:10px;">Type : ${s.type||'—'}<br>Source : ${s.source}</p>
    <button class="btn secondary" style="margin-top:12px;" onclick="focusSectionOnMap('${s.id}')">Voir sur la carte</button>
  `;
  document.getElementById('detailOverlay').classList.add('active');
}
function focusSectionOnMap(id){
  document.getElementById('detailOverlay').classList.remove('active');
  switchView('carte');
  const s=AppState.sections.find(x=>x.id===id);
  if(!s||!AppState.map) return;
  const bounds=L.latLngBounds(s.coords);
  AppState.map.fitBounds(bounds,{padding:[40,40]});
  if(AppState._highlight) AppState.map.removeLayer(AppState._highlight);
  AppState._highlight=L.polyline(s.coords,{color:'var(--fiber)'.replace('var(--fiber)','#39d98a'),weight:6,opacity:.9}).addTo(AppState.map);
}

/* ---------------- RENDER : HISTORIQUE ---------------- */
function renderHistory(){
  const list=document.getElementById('historyList');
  if(!AppState.files.length){
    list.innerHTML='<div class="empty">Aucun fichier dans l\'historique.</div>';
    return;
  }
  const sorted=[...AppState.files].sort((a,b)=>b.date-a.date);
  list.innerHTML=sorted.map(f=>{
    const d=new Date(f.date);
    const sizeKb=f.size?Math.round(f.size/1024)+' Ko':'';
    let extra='';
    if(f.ext==='pdf') extra=f.parsed?.cable||'';
    else extra=`${(f.parsed.sections||[]).length} section(s), ${(f.parsed.points||[]).length} point(s)`;
    return `<div class="card">
      <div class="row">
        <strong style="font-size:12px;">${f.name}</strong>
        <span class="badge ${f.ext}">${f.ext}</span>
      </div>
      <div class="row"><span class="sub">${extra}</span><span class="sub">${sizeKb}</span></div>
      <div class="row"><span class="sub">${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</span>
        <button class="btn danger small" data-id="${f.id}">Supprimer</button></div>
    </div>`;
  }).join('');
  list.querySelectorAll('button.danger').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      await dbDelete(+btn.dataset.id);
      await loadAll();
      renderAll();
      toast('Fichier supprimé');
    });
  });
}

/* ---------------- CARTE ---------------- */
function initMap(){
  if(AppState.map) return;
  AppState.map=L.map('map',{preferCanvas:true}).setView([14.6,-15.2],8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
    maxZoom:19, attribution:'© OpenStreetMap'
  }).addTo(AppState.map);
  AppState.layers.sections=L.layerGroup().addTo(AppState.map);
  AppState.layers.sites=L.layerGroup();
  AppState.layers.joints=L.layerGroup();
  AppState.layers.events=L.layerGroup().addTo(AppState.map);
  AppState.layers.correlation=L.layerGroup().addTo(AppState.map);
  AppState.layers.waypointEdit=L.layerGroup().addTo(AppState.map);
}
function renderMap(){
  AppState.siteMarkers={};
  if(!AppState.map) return;
  ['sections','sites','joints','events'].forEach(k=>AppState.layers[k].clearLayers());

  AppState.sections.forEach(s=>{
    L.polyline(s.coords,{color:'#4ad7ff',weight:3,opacity:.75})
      .bindPopup(`<b>${s.endA||'?'} ↔ ${s.endB||'?'}</b><br>${fmtLen(s.length)}<br>${s.type||''}`)
      .addTo(AppState.layers.sections);
  });

  AppState.points.forEach(p=>{
    const navBtn=`<button class="btn small secondary" style="margin-top:6px;" onclick="navigateTo(${p.lat},${p.lon})">🧭 Itinéraire</button>`;
    if(p.category==='bts'){
      const marker=L.circleMarker([p.lat,p.lon],{radius:3,color:'#ffb454',fillColor:'#ffb454',fillOpacity:.8,weight:1})
        .bindPopup(`<b>${p.name}</b><br>${navBtn}`)
        .addTo(AppState.layers.sites);
      AppState.siteMarkers[p.name]=marker;
    } else if(p.category==='joint' || p.category==='chamber'){
      L.circleMarker([p.lat,p.lon],{radius:4,color:'#c98bff',fillColor:'#c98bff',fillOpacity:.9,weight:1})
        .bindPopup(`<b>${p.name}</b><br>${p.category==='joint'?'Joint':'Chambre'}<br>${navBtn}`)
        .addTo(AppState.layers.joints);
    }
  });
  updateSiteSearchList();

  // Événements OTDR corrélés (toutes mesures)
  Object.entries(AppState.correlations||{}).forEach(([recId, result])=>{
    if(!result || result.error) return;
    const measure=AppState.measures.find(m=>m.recId==recId);
    (result.placedEvents||[]).forEach(ev=>{
      if(!ev.pos) return;
      const anom=measure?isAnomalyEvent(ev,measure):false;
      L.circleMarker(ev.pos,{radius:7,color:anom?'#ff5d5d':'#39d98a',fillColor:anom?'#ff5d5d':'#39d98a',fillOpacity:.95,weight:2})
        .bindPopup(`<b>${measure?.cable||measure?.name||''}</b><br>Événement #${ev.num} — ${fmtNum(ev.distance,1)} m<br>${anom?'<span style="color:#ff5d5d">À vérifier</span><br>':''}<a href="https://www.google.com/maps/dir/?api=1&destination=${ev.pos[0]},${ev.pos[1]}" target="_blank">Naviguer</a>`)
        .addTo(AppState.layers.events);
    });
  });
}
function drawCorrelationLayer(){
  if(!AppState.activeCorrelation) return;
  if(!AppState.map){ initMap(); }
  if(!AppState.map){ console.error('drawCorrelationLayer: carte non initialisée'); toast('Erreur : carte non prête'); return; }
  if(!AppState.layers.correlation){ console.error('drawCorrelationLayer: layers non initialisés'); return; }
  AppState.layers.correlation.clearLayers();
  AppState.layers.events.clearLayers();
  if(!AppState.layers.correlation._map) AppState.layers.correlation.addTo(AppState.map);
  if(!AppState.layers.events._map) AppState.layers.events.addTo(AppState.map);
  const {result,measure}=AppState.activeCorrelation;
  if(result.error) return;
  const all=[];

  // Tracé : fibre réelle (GPS-chain) > itinéraire routier (voiture) > ligne droite (dernier repli)
  if(result.chain&&result.chain.length){
    result.chain.forEach(({section,reversed})=>{
      const coords=reversed?[...section.coords].reverse():section.coords;
      L.polyline(coords,{color:'#39d98a',weight:5,opacity:.85}).addTo(AppState.layers.correlation);
      all.push(...coords);
    });
  } else if(result.routeCoords&&result.routeCoords.length>1){
    L.polyline(result.routeCoords,{color:'#4f9eff',weight:5,opacity:.85}).addTo(AppState.layers.correlation);
    all.push(...result.routeCoords);
  } else if(result.originGPS&&result.destGPS){
    L.polyline([result.originGPS,result.destGPS],{color:'#39d98a',weight:4,opacity:.7,dashArray:'8,6'})
      .addTo(AppState.layers.correlation);
    all.push(result.originGPS,result.destGPS);
  }

  // Marqueurs Origine (bleu) / Extrémité (orange)
  if(result.originGPS) L.circleMarker(result.originGPS,{radius:9,color:'#4f9eff',fillColor:'#4f9eff',fillOpacity:1,weight:2})
    .bindPopup('<b>Origine</b><br>'+result.originName).addTo(AppState.layers.correlation);
  if(result.destGPS) L.circleMarker(result.destGPS,{radius:9,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2})
    .bindPopup('<b>Extrémité</b><br>'+result.destName).addTo(AppState.layers.correlation);

  // Événements OTDR le long du tracé
  (result.events||[]).forEach(ev=>{
    if(!ev.pos||!isFinite(ev.pos[0])||!isFinite(ev.pos[1])) return;
    let anom=false;
    try{ anom=isAnomalyEvent(ev,measure); }catch(e){ console.error('isAnomalyEvent error',e); }
    all.push(ev.pos);
    const popup='<b>#'+ev.num+'</b> — '+fmtNum(ev.distance,1)+' m'
      +(anom?'<br><span style="color:#ff5d5d">⚠ Anomalie</span>':'')
      +'<br><button class="btn small secondary" onclick="navigateTo('+ev.pos[0]+','+ev.pos[1]+')">🧭 Itinéraire</button>';
    L.circleMarker(ev.pos,{radius:anom?8:5,color:anom?'#ff5d5d':'#39d98a',
      fillColor:anom?'#ff5d5d':'#39d98a',fillOpacity:.95,weight:2})
      .bindPopup(popup).addTo(AppState.layers.events);
  });

  if(all.length) AppState.map.fitBounds(L.latLngBounds(all),{padding:[40,40]});
  toast(result.chain?'Itinéraire affiché sur la carte':'Événements affichés (interpolation)');
}

function switchView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelector(`.tab[data-view="${name}"]`).classList.add('active');
  if(name==='carte'){
    setTimeout(()=>{
      initMap();
      renderMap();
      AppState.map.invalidateSize();
    },50);
  }
}

/* ---------------- HEADER CONTEXT ---------------- */
function updateHeader(){
  const el=document.getElementById('headerCtx');
  if(AppState.measures.length){
    const m=AppState.measures[AppState.measures.length-1];
    el.textContent=(m.cable||m.name)+' · '+AppState.sections.length+' sections';
  } else if(AppState.sections.length){
    el.textContent=AppState.sections.length+' sections chargées';
  } else {
    el.textContent='Aucun fichier actif';
  }
}

/* ---------------- RENDER ALL ---------------- */
function renderAll(){
  renderAccueil();
  renderMesures();
  renderSections(document.getElementById('sectionSearch').value);
  renderHistory();
  if(AppState.map) renderMap();
  updateHeader();
}

/* ---------------- RECHERCHE SITE (CARTE) ---------------- */
function updateSiteSearchList(){
  const dl=document.getElementById('mapSiteList');
  if(!dl) return;
  const sites=AppState.points.filter(p=>p.category==='bts').sort((a,b)=>a.name.localeCompare(b.name));
  dl.innerHTML=sites.map(p=>`<option value="${p.name}">`).join('');
}

function searchSite(){
  const val=(document.getElementById('mapSearchInput').value||'').trim();
  if(!val) return;
  // correspondance exacte d'abord, puis partielle
  const q=val.toUpperCase();
  let found=AppState.points.find(p=>p.category==='bts' && p.name.toUpperCase()===q);
  if(!found) found=AppState.points.find(p=>p.category==='bts' && p.name.toUpperCase().includes(q));
  if(!found){ toast('Site introuvable : '+val); return; }

  // activer la couche Sites si elle est masquée
  const sitesLayer=AppState.layers.sites;
  if(sitesLayer && !sitesLayer._map){
    sitesLayer.addTo(AppState.map);
    document.getElementById('layerSites').classList.add('on');
  }
  AppState.map.setView([found.lat,found.lon],16,{animate:true});
  const marker=AppState.siteMarkers[found.name];
  if(marker) marker.openPopup();
  toast('📍 '+found.name);
}

function toggleMapSearch(){
  const el=document.getElementById('mapSearch');
  const visible=el.style.display!=='none' && el.style.display!=='';
  el.style.display=visible?'none':'flex';
  if(!visible){
    document.getElementById('mapSearchInput').focus();
    updateSiteSearchList();
  }
}

/* ---------------- INIT ---------------- */
window.addEventListener('DOMContentLoaded', async ()=>{
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>switchView(btn.dataset.view));
  });
  document.getElementById('btnImport').addEventListener('click',()=>document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change',e=>{
    if(e.target.files.length) handleFiles(e.target.files);
    e.target.value='';
  });
  document.getElementById('sectionSearch').addEventListener('input',e=>renderSections(e.target.value));
  document.getElementById('detailOverlay').addEventListener('click',e=>{
    if(e.target.id==='detailOverlay') e.target.classList.remove('active');
  });

  document.getElementById('btnSearchSite').addEventListener('click', toggleMapSearch);
  document.getElementById('mapSearchClose').addEventListener('click', ()=>{
    document.getElementById('mapSearch').style.display='none';
    document.getElementById('mapSearchInput').value='';
  });
  document.getElementById('mapSearchGo').addEventListener('click', searchSite);
  document.getElementById('mapSearchInput').addEventListener('keydown', e=>{
    if(e.key==='Enter'){ e.preventDefault(); searchSite(); }
  });

  document.getElementById('btnWaypointUndo').addEventListener('click', undoLastWaypoint);
  document.getElementById('btnWaypointCancel').addEventListener('click', cancelWaypointEdit);
  document.getElementById('btnWaypointDone').addEventListener('click', finishWaypointEdit);
  document.getElementById('btnWaypointAdd').addEventListener('click', addWaypointAtCenter);

  // layer toggles
  const toggles={layerSections:'sections', layerSites:'sites', layerJoints:'joints', layerEvents:'events'};
  Object.entries(toggles).forEach(([btnId,layerKey])=>{
    document.getElementById(btnId).addEventListener('click',()=>{
      const btn=document.getElementById(btnId);
      const layer=AppState.layers[layerKey];
      if(!AppState.map) return;
      if(layer._map){ AppState.map.removeLayer(layer); btn.classList.remove('on'); }
      else { layer.addTo(AppState.map); btn.classList.add('on'); }
    });
  });
  document.getElementById('btnFitAll').addEventListener('click',()=>{
    if(!AppState.map) return;
    let all=[];
    AppState.sections.forEach(s=>all.push(...s.coords));
    AppState.points.forEach(p=>all.push([p.lat,p.lon]));
    if(all.length) AppState.map.fitBounds(L.latLngBounds(all),{padding:[30,30]});
  });

  await loadAll();
  renderAll();

  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('sw.js').catch(()=>{});
  }
});

/* ---------------- EXPOSITION GLOBALE ----------------
   app.js est chargé en type="module" : ses fonctions ne sont PAS sur window.
   Les attributs onclick="..." inline dans le HTML généré s'exécutent en
   contexte global, donc on doit explicitement exposer celles utilisées ainsi. */
window.navigateTo = navigateTo;
window.showCorrelationOnMap = showCorrelationOnMap;
window.focusSectionOnMap = focusSectionOnMap;
window.searchSite = searchSite;
window.toggleMapSearch = toggleMapSearch;
window.applyCorrelation = applyCorrelation;
window.saveEndpoints = saveEndpoints;
window.setOrigine = setOrigine;
window.setExtremite = setExtremite;
window.updSt = updSt;
window.openWaypointEditor = openWaypointEditor;
window.removeWaypointAt = removeWaypointAt;
