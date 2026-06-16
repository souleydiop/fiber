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
async function parsePDF(arrayBuffer){
  const pdf = await pdfjsLib.getDocument({data:arrayBuffer}).promise;
  const page = await pdf.getPage(1);
  const content = await page.getTextContent();
  const text = content.items.map(i=>i.str).join(' ').replace(/\s+/g,' ');

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

function parseKML(text, sourceName, sourceType){
  const doc = new DOMParser().parseFromString(text,'text/xml');
  const placemarks = doc.getElementsByTagName('Placemark');
  const sections=[], points=[];
  for(let i=0;i<placemarks.length;i++){
    const pm=placemarks[i];
    const nameEl = pm.getElementsByTagName('name')[0];
    const name = nameEl ? nameEl.textContent.trim() : '(sans nom)';
    const line = pm.getElementsByTagName('LineString')[0];
    const point = pm.getElementsByTagName('Point')[0];

    if(line){
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
      const coordEl = point.getElementsByTagName('coordinates')[0];
      if(!coordEl) continue;
      const parts = coordEl.textContent.trim().split(',');
      const lon=+parts[0], lat=+parts[1];
      if(isNaN(lat)||isNaN(lon)) continue;
      let category='other';
      if(sourceType==='bts') category='bts';
      else if(/\sJ\d+$/.test(name)) category='joint';
      else if(/_[A-Z]_\d+$/.test(name)) category='chamber';
      points.push({id:sourceName+'_P'+points.length, name, lat, lon, category, source:sourceName});
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
        const parsed=await parsePDF(buf);
        await dbAdd({name:file.name, ext, date:Date.now(), size:file.size, parsed, dataBase64:base64});
      } else if(ext==='kml' || ext==='kmz'){
        let text;
        const sourceType = /site|bts/i.test(file.name) ? 'bts' : 'fiber';
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
    if(r.ext==='pdf'){
      AppState.measures.push({
        recId:r.id, name:r.name, date:r.date,
        manualOrigine:r.manualOrigine||null,
        manualExtremite:r.manualExtremite||null,
        ...r.parsed
      });
    } else if(r.ext==='kml' || r.ext==='kmz'){
      (r.parsed.sections||[]).forEach(s=>AppState.sections.push({...s, recId:r.id}));
      (r.parsed.points||[]).forEach(p=>AppState.points.push({...p, recId:r.id}));
    }
  });
  // Corrélation automatique de chaque mesure avec le tracé disponible
  AppState.correlations={};
  AppState.measures.forEach(m=>{
    AppState.correlations[m.recId]=correlate(m);
  });
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
  const nAnom=(m.events||[]).filter(ev=>isAnomalyEvent(ev,m)).length;
  let html=`
    <h1>${m.cable||m.name}</h1>
    <p class="sub" style="margin-bottom:10px;">${m.name}</p>
    <div class="kpi-grid">
      <div class="kpi"><div class="v">${m.fibre||'—'}</div><div class="l">Fibre</div></div>
      <div class="kpi"><div class="v">${fmtLen(m.finFibre)}</div><div class="l">Longueur</div></div>
      <div class="kpi"><div class="v">${fmtNum(m.bilanTotal,3)}</div><div class="l">Bilan (dB)</div></div>
      <div class="kpi"><div class="v">${fmtNum(m.orl,2)}</div><div class="l">ORL (dB)</div></div>
    </div>
    <div class="row" style="margin-top:6px;">
      <span class="sub">${m.manualOrigine||m.origine||'?'} → ${m.manualExtremite||m.extremite||'?'}${m.manualOrigine?' <span style="font-size:9px;color:var(--fiber)">● manuel</span>':''}</span>
      <span class="badge ${nAnom>0?'fault':'ok'}">${nAnom>0?nAnom+' évt(s) à vérifier':'Liaison OK'}</span>
    </div>

    <h2>Événements OTDR</h2>
    <div class="tablewrap"><table><thead><tr><th>Evt</th><th>Distance</th><th>Affaib.</th><th>Réflect.</th><th>Pente</th><th>Section</th><th>Bilan</th></tr></thead><tbody>
    ${(m.events||[]).map(ev=>{
      const anom=isAnomalyEvent(ev,m);
      return `<tr class="event-row ${anom?'fault':''}">
        <td>#${ev.num}</td>
        <td>${fmtNum(ev.distance,2)} m</td>
        <td>${ev.affaib!==null?fmtNum(ev.affaib,3):'—'}</td>
        <td>${ev.reflect!==null?fmtNum(ev.reflect,2):'—'}</td>
        <td>${ev.pente!==null?fmtNum(ev.pente,3):'—'}</td>
        <td>${ev.section!==null?fmtLen(ev.section):'—'}</td>
        <td>${ev.bilan!==null?fmtNum(ev.bilan,3):'—'}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="sub" style="margin-top:6px;">Table extraite par position (x/y) depuis le PDF Viavi — colonnes : m / dB / dB / dB/km / m / dB.</p>

    <h2>Corrélation avec le tracé KML</h2>

    <div class="card" style="margin-bottom:8px;">
      <p class="sub" style="margin-bottom:8px;">Saisis le site de départ et d'arrivée (liste des sites importés) pour la corrélation :</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div>
          <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;">Extrémité A — Site de départ</label>
          <input id="inpOrigine" list="siteListA" autocomplete="off" placeholder="${m.origine||'ex: KLK_AGENCE_G'}"
            style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px;font-size:13px;margin-top:4px;font-family:ui-monospace,Menlo,monospace;">
          <datalist id="siteListA"></datalist>
        </div>
        <div>
          <label style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;">Extrémité B — Site d'arrivée</label>
          <input id="inpExtremite" list="siteListB" autocomplete="off" placeholder="${m.extremite||'ex: KARANG_POSTE_G'}"
            style="width:100%;background:var(--surface2);border:1px solid var(--border);color:var(--text);border-radius:8px;padding:9px 12px;font-size:13px;margin-top:4px;font-family:ui-monospace,Menlo,monospace;">
          <datalist id="siteListB"></datalist>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:10px;">
        <button class="btn" id="btnCorrelate" style="flex:1;">Lancer la corrélation</button>
        <button class="btn secondary" id="btnSaveEndpoints" style="flex:0 0 auto;width:auto;padding:10px 14px;">💾 Sauvegarder</button>
      </div>
    </div>

    <div id="corrResult"></div>
  `;
  document.getElementById('detailContent').innerHTML=html;
  document.getElementById('detailOverlay').classList.add('active');

  // Datalist : liste des sites issus des KMZ importés (base_site.kmz etc.)
  const siteNames=[...new Set(AppState.points.map(p=>p.name))].sort();
  function fillSiteList(elId){
    const dl=document.getElementById(elId);
    dl.innerHTML='';
    siteNames.forEach(n=>{
      const opt=document.createElement('option'); opt.value=n; dl.appendChild(opt);
    });
  }
  fillSiteList('siteListA');
  fillSiteList('siteListB');

  // Pré-remplissage : valeur manuelle sauvegardée, sinon meilleure correspondance avec le PDF
  function bestGuess(term){
    if(!term) return '';
    const t=norm(term);
    let exact=siteNames.find(n=>norm(n)===t);
    if(exact) return exact;
    let partial=siteNames.find(n=>norm(n).includes(t)||t.includes(norm(n)));
    return partial||term;
  }

  document.getElementById('inpOrigine').value = m.manualOrigine || bestGuess(m.origine);
  document.getElementById('inpExtremite').value = m.manualExtremite || bestGuess(m.extremite);

  // Focus outline sur les inputs
  ['inpOrigine','inpExtremite'].forEach(id=>{
    document.getElementById(id).addEventListener('focus',e=>{e.target.style.outline='1px solid var(--signal)';});
    document.getElementById(id).addEventListener('blur',e=>{e.target.style.outline='';});
  });

  // Sauvegarde manuelle des extrémités dans IndexedDB
  document.getElementById('btnSaveEndpoints').addEventListener('click', async ()=>{
    const a=document.getElementById('inpOrigine').value.trim();
    const b=document.getElementById('inpExtremite').value.trim();
    // Mettre à jour le record en DB
    const recs=await dbGetAll();
    const rec=recs.find(r=>r.id===m.recId);
    if(rec){
      rec.manualOrigine=a||null;
      rec.manualExtremite=b||null;
      await dbUpdate(rec);
      // Mettre à jour AppState
      m.manualOrigine=a||null;
      m.manualExtremite=b||null;
      await loadAll();
      toast('Extrémités sauvegardées');
    }
  });

  // Récupérer la corrélation en cache (avec les endpoints manuels déjà appliqués)
  const cached=AppState.correlations[m.recId];
  if(cached) renderCorrelationResult(cached, m);

  document.getElementById('btnCorrelate').addEventListener('click',()=>{
    // Lire les valeurs en cours dans les inputs (même non sauvegardées)
    const a=document.getElementById('inpOrigine').value.trim();
    const b=document.getElementById('inpExtremite').value.trim();
    const mEff={...m,
      manualOrigine: a||m.manualOrigine||null,
      manualExtremite: b||m.manualExtremite||null
    };
    const result=correlate(mEff);
    AppState.correlations[m.recId]=result;
    AppState.activeCorrelation={result, measure:mEff};
    renderCorrelationResult(result, mEff);
  });
}

/* ---------------- CORRELATION ---------------- */

// Pour une coordonnée GPS [lat,lon], trouve le site le plus proche dans base_site.kmz
// Retourne {name, dist} ou null si aucun site chargé
function nearestSite(lat, lon, maxDistM=1500){
  const sites=AppState.points.filter(p=>p.category==='bts');
  if(!sites.length) return null;
  let best=null;
  sites.forEach(p=>{
    const d=haversine(lat, lon, p.lat, p.lon);
    if(!best || d<best.dist) best={name:p.name, dist:d};
  });
  return (best && best.dist<=maxDistM) ? best : null;
}

function buildGraph(){
  const graph={}, nodeCoords={};
  const hasSites=AppState.points.some(p=>p.category==='bts');

  AppState.sections.forEach(s=>{
    let endA=s.endA, endB=s.endB;

    // Si endA ou endB sont absents, les dériver par GPS depuis base_site.kmz
    if(hasSites && (!endA || !endB)){
      const firstCoord=s.coords[0];
      const lastCoord=s.coords[s.coords.length-1];
      if(!endA && firstCoord){
        const site=nearestSite(firstCoord[0], firstCoord[1]);
        if(site) endA=site.name;
      }
      if(!endB && lastCoord){
        const site=nearestSite(lastCoord[0], lastCoord[1]);
        if(site) endB=site.name;
      }
    }

    if(!endA||!endB) return;
    (graph[endA]=graph[endA]||[]).push({to:endB, w:s.length, sectionId:s.id});
    (graph[endB]=graph[endB]||[]).push({to:endA, w:s.length, sectionId:s.id});
    if(!nodeCoords[endA]) nodeCoords[endA]=s.coords[0];
    if(!nodeCoords[endB]) nodeCoords[endB]=s.coords[s.coords.length-1];
  });
  return {graph, nodeCoords};
}
function norm(t){ return (t||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function findNodeCandidates(graph, term){
  if(!term) return [];
  const t=norm(term);
  return Object.keys(graph).filter(n=>norm(n).includes(t) || t.includes(norm(n)));
}
// Cherche le(s) nœud(s) du graphe de tracé les plus proches d'un terme désignant un SITE
// (ex: "KARANG" -> site "KARANG_POSTE_G" dans base_site.kmz -> nœud fibre le plus proche)
function findNodeViaSite(graph, nodeCoords, term, maxDistM=3000){
  if(!term) return [];
  const t=norm(term);
  const matchingSites=AppState.points.filter(p=>{
    const pn=norm(p.name);
    return pn.includes(t) || t.includes(pn);
  });
  if(!matchingSites.length) return [];
  const nodeNames=Object.keys(nodeCoords);
  if(!nodeNames.length) return [];
  const results=[];
  matchingSites.forEach(site=>{
    let best=null;
    nodeNames.forEach(n=>{
      const c=nodeCoords[n];
      const d=haversine(site.lat, site.lon, c[0], c[1]);
      if(!best || d<best.dist) best={node:n, dist:d, site};
    });
    if(best && best.dist<=maxDistM) results.push(best);
  });
  results.sort((a,b)=>a.dist-b.dist);
  return results;
}
function dijkstra(graph, start, end){
  const dist={}, prev={};
  Object.keys(graph).forEach(n=>dist[n]=Infinity);
  dist[start]=0;
  const pq=new Set(Object.keys(graph));
  while(pq.size){
    let u=null;
    pq.forEach(n=>{ if(u===null||dist[n]<dist[u]) u=n; });
    pq.delete(u);
    if(u===end || dist[u]===Infinity) break;
    (graph[u]||[]).forEach(e=>{
      const alt=dist[u]+e.w;
      if(alt<dist[e.to]){ dist[e.to]=alt; prev[e.to]={node:u, sectionId:e.sectionId}; }
    });
  }
  if(dist[end]===undefined || dist[end]===Infinity) return null;
  const path=[]; let cur=end;
  while(cur!==start){
    const p=prev[cur];
    if(!p) return null;
    path.unshift({from:p.node, to:cur, sectionId:p.sectionId});
    cur=p.node;
  }
  return {path, total:dist[end]};
}
function correlate(measure){
  if(!AppState.sections.length) return {error:'Aucun fichier KML/KMZ de tracé chargé.'};
  const {graph, nodeCoords}=buildGraph();
  const origineEff = measure.manualOrigine || measure.origine;
  const extremiteEff = measure.manualExtremite || measure.extremite;

  // 1) correspondance directe avec un nœud du graphe (extrémité de section)
  let startCands=findNodeCandidates(graph, origineEff).map(n=>({node:n}));
  let endCands=findNodeCandidates(graph, extremiteEff).map(n=>({node:n}));

  // 2) sinon, le terme désigne probablement un SITE (base_site.kmz) -> on cherche
  //    le nœud de tracé géographiquement le plus proche de ce site
  if(!startCands.length) startCands=findNodeViaSite(graph, nodeCoords, origineEff);
  if(!endCands.length) endCands=findNodeViaSite(graph, nodeCoords, extremiteEff);

  if(!startCands.length || !endCands.length){
    const nodes=Object.keys(graph).slice(0,8).join(', ');
    return {error:`Extrémités introuvables.\nOrigine cherchée: "${origineEff}" — Extrémité: "${extremiteEff}".\nAucun nœud de tracé ni site (base_site.kmz) correspondant à proximité.\nExemples de nœuds disponibles : ${nodes}…\n→ Saisis manuellement les extrémités A et B ci-dessus (nom d'un site ou d'un point du tracé).`};
  }
  let best=null;
  startCands.forEach(s=>endCands.forEach(e=>{
    if(s.node===e.node) return;
    const r=dijkstra(graph,s.node,e.node);
    if(r){
      const snapPenalty=(s.dist||0)+(e.dist||0);
      const score = (measure.finFibre ? Math.abs(r.total-measure.finFibre) : r.total) + snapPenalty;
      if(!best || score<best.score) best={...r, start:s.node, end:e.node, startSnap:s, endSnap:e, score};
    }
  }));
  if(!best) return {error:'Aucun chemin continu trouvé entre les deux extrémités dans le tracé chargé.'};

  // placement des événements le long du chemin
  const placed=(measure.events||[]).map(ev=>{
    let acc=0, pos=null, secName=null;
    for(const step of best.path){
      const sec=AppState.sections.find(s=>s.id===step.sectionId);
      if(!sec){ continue; }
      const isLast = step===best.path[best.path.length-1];
      if(ev.distance<=acc+sec.length+0.001 || isLast){
        let coords=sec.coords;
        if(step.from===sec.endB) coords=[...coords].reverse();
        const within=Math.min(sec.length, Math.max(0, ev.distance-acc));
        pos=interpolateAlong(coords, within);
        secName=sec.name;
        break;
      }
      acc+=sec.length;
    }
    return {...ev, pos, sectionName:secName};
  });

  return {path:best.path, total:best.total, start:best.start, end:best.end, placedEvents:placed};
}

function renderCorrelationResult(result, measure){
  const div=document.getElementById('corrResult');
  if(result.error){
    div.innerHTML=`<div class="card" style="border-color:var(--fault);"><span class="sub" style="color:var(--fault);">${result.error}</span></div>`;
    return;
  }
  const diff = measure.finFibre ? (result.total-measure.finFibre) : null;
  div.innerHTML=`
    <div class="card">
      <div class="row"><span class="sub">Itinéraire</span><span class="badge ok">${result.path.length} section(s)</span></div>
      <div class="row"><span class="sub">${result.start} → ${result.end}</span></div>
      <div class="row"><span class="sub">Longueur tracé KML</span><strong>${fmtLen(result.total)}</strong></div>
      ${diff!==null?`<div class="row"><span class="sub">Écart vs mesure PDF</span><strong style="color:${Math.abs(diff)>50?'var(--fault)':'var(--fiber)'}">${diff>=0?'+':''}${fmtLen(diff)}</strong></div>`:''}
    </div>
    <div class="tablewrap"><table><thead><tr><th>Evt</th><th>Distance</th><th>Position GPS</th><th></th></tr></thead><tbody>
    ${result.placedEvents.map(ev=>{
      const anom=isAnomalyEvent(ev,measure);
      const coordTxt = ev.pos? ev.pos[0].toFixed(6)+', '+ev.pos[1].toFixed(6) : '—';
      const navBtn = ev.pos? `<button class="btn small secondary" onclick="navigateTo(${ev.pos[0]},${ev.pos[1]})">Naviguer</button>` : '';
      return `<tr class="event-row ${anom?'fault':''}"><td>#${ev.num}</td><td>${fmtNum(ev.distance,1)} m</td><td>${coordTxt}</td><td>${navBtn}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <button class="btn secondary" style="margin-top:8px;" onclick="showCorrelationOnMap()">Afficher sur la carte</button>
  `;
  AppState.activeCorrelation={result, measure};
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
  if(!AppState.map || !AppState.activeCorrelation) return;
  AppState.layers.correlation.clearLayers();
  AppState.layers.events.clearLayers();
  if(!AppState.layers.events._map) AppState.layers.events.addTo(AppState.map);

  const {result, measure}=AppState.activeCorrelation;
  if(result.error) return;
  const allCoords=[];
  result.path.forEach(step=>{
    const sec=AppState.sections.find(s=>s.id===step.sectionId);
    if(!sec) return;
    let coords=sec.coords;
    if(step.from===sec.endB) coords=[...coords].reverse();
    L.polyline(coords,{color:'#39d98a',weight:6,opacity:.9}).addTo(AppState.layers.correlation);
    allCoords.push(...coords);
  });
  result.placedEvents.forEach(ev=>{
    if(!ev.pos) return;
    const anom=isAnomalyEvent(ev,measure);
    L.circleMarker(ev.pos,{radius:7,color:anom?'#ff5d5d':'#39d98a',fillColor:anom?'#ff5d5d':'#39d98a',fillOpacity:.95,weight:2})
      .bindPopup(`<b>Événement #${ev.num}</b><br>Distance: ${fmtNum(ev.distance,1)} m<br><a href="https://www.google.com/maps/dir/?api=1&destination=${ev.pos[0]},${ev.pos[1]}" target="_blank">Naviguer</a>`)
      .addTo(AppState.layers.events);
  });
  if(allCoords.length) AppState.map.fitBounds(L.latLngBounds(allCoords),{padding:[40,40]});
  toast('Corrélation affichée sur la carte');
}

/* ---------------- NAVIGATION TABS ---------------- */
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
