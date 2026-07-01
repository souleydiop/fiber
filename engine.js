/* ============================================================
   OSP MANAGER — ENGINE (Couche 2)
   AppState, IndexedDB, utilitaires, import, corrélation GPS.
   Appels sortants vers map.js via window.xxx()
   Appels entrants depuis parser.js via window.parsePDF / parseKML / parseExcelWorkbook
   ============================================================ */

/* ================================================================
   APPSTATE — singleton partagé via window
   ================================================================ */
const AppState = {
  files:[], measures:[], sections:[], points:[],
  siteMarkers:{}, activeCorrelation:null, waypointMode:null,
  currentMeasure:null, map:null, layers:{}, correlations:{}
};
window.AppState = AppState;

/* ================================================================
   UTILITAIRES
   ================================================================ */
function toast(msg){
  const t=document.getElementById('toast');
  t.textContent=msg; t.classList.add('show');
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>t.classList.remove('show'),2200);
}
function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function norm(t){ return (t||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }
function fmtNum(n,d=1){ return (n===null||n===undefined||isNaN(n))?'—':Number(n).toFixed(d); }
function fmtLen(m){
  if(m===null||m===undefined||isNaN(m)) return '—';
  return m>=1000?(m/1000).toFixed(3)+' km':Math.round(m)+' m';
}
function haversine(lat1,lon1,lat2,lon2){
  const R=6371000,toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function lineLength(coords){
  let d=0;
  for(let i=1;i<coords.length;i++) d+=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
  return d;
}
function interpolateAlong(coords,targetLen){
  let acc=0;
  for(let i=1;i<coords.length;i++){
    const d=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
    if(acc+d>=targetLen||i===coords.length-1){
      const f=d>0?Math.min(1,Math.max(0,(targetLen-acc)/d)):0;
      return [coords[i-1][0]+(coords[i][0]-coords[i-1][0])*f,
              coords[i-1][1]+(coords[i][1]-coords[i-1][1])*f];
    }
    acc+=d;
  }
  return coords[coords.length-1];
}
function arrayBufferToBase64(buffer){
  let binary='';
  const bytes=new Uint8Array(buffer),chunk=0x8000;
  for(let i=0;i<bytes.length;i+=chunk) binary+=String.fromCharCode.apply(null,bytes.subarray(i,i+chunk));
  return btoa(binary);
}
function base64ToArrayBuffer(b64){
  const binary=atob(b64),bytes=new Uint8Array(binary.length);
  for(let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return bytes.buffer;
}

/* ================================================================
   INDEXEDDB
   ================================================================ */
const DB_NAME='ospmanager_db',DB_VER=1,STORE='files';
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
    const req=db.transaction(STORE,'readwrite').objectStore(STORE).add(rec);
    req.onsuccess=()=>resolve(req.result); req.onerror=e=>reject(e);
  });
}
async function dbGetAll(){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,'readonly').objectStore(STORE).getAll();
    req.onsuccess=()=>resolve(req.result); req.onerror=e=>reject(e);
  });
}
async function dbDelete(id){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,'readwrite').objectStore(STORE).delete(id);
    req.onsuccess=()=>resolve(); req.onerror=e=>reject(e);
  });
}
async function dbUpdate(rec){
  const db=await openDB();
  return new Promise((resolve,reject)=>{
    const req=db.transaction(STORE,'readwrite').objectStore(STORE).put(rec);
    req.onsuccess=()=>resolve(); req.onerror=e=>reject(e);
  });
}

/* ================================================================
   LOGIQUE MÉTIER : ANOMALIE
   ================================================================ */
function isAnomalyEvent(ev,m){
  const isEndpoint=ev.num===1||ev.num===(m.nbEvt||m.events?.length);
  if(isEndpoint) return false;
  const badAffaib=ev.affaib!==null&&ev.affaib>0.3;
  const badReflect=ev.reflect!==null&&ev.reflect>-35;
  return badAffaib||badReflect;
}

/* ================================================================
   IMPORT FICHIERS
   ================================================================ */
async function handleFiles(fileList){
  const bar=document.getElementById('importProgress');
  bar.style.display='block';
  const inner=bar.querySelector('div');
  const files=[...fileList];
  for(let i=0;i<files.length;i++){
    const file=files[i];
    inner.style.width=Math.round((i/files.length)*100)+'%';
    const ext=file.name.split('.').pop().toLowerCase();
    try{
      if(ext==='pdf'){
        const buf=await file.arrayBuffer();
        const base64=arrayBufferToBase64(buf);
        const pages=await window.parsePDF(buf);
        if(!pages.length){
          toast('Aucune mesure détectée dans '+file.name);
        } else {
          const isEXFOFile=pages.some(pg=>pg.isEXFO);
          const baseCableKey=file.name+'|'+(pages[0].origine||'')+'|'+(pages[0].extremite||'');
          for(let p=0;p<pages.length;p++){
            const parsed=pages[p];
            const label=parsed.fibre?('Fibre '+parsed.fibre):('page '+(p+1));
            const name=pages.length>1?file.name+' — '+label:file.name;
            const cableKey=isEXFOFile
              ?file.name+'|'+(parsed.origine||'')+'|'+(parsed.extremite||'')
              :baseCableKey;
            await dbAdd({name,ext,date:Date.now(),size:file.size,parsed,
              dataBase64:p===0?base64:undefined,cableKey,pageIndex:p});
          }
        }
      } else if(ext==='kml'||ext==='kmz'){
        let text;
        const sourceType=/site|bts|u900|lte|2g|3g|4g|coverage|sector|couverture/i.test(file.name)?'bts':'fiber';
        if(ext==='kmz'){
          const buf=await file.arrayBuffer();
          const zip=await JSZip.loadAsync(buf);
          const kmlName=Object.keys(zip.files).find(n=>n.toLowerCase().endsWith('.kml'));
          text=await zip.files[kmlName].async('text');
        } else {
          text=await file.text();
        }
        const parsed=window.parseKML(text,file.name,sourceType);
        await dbAdd({name:file.name,ext,date:Date.now(),size:file.size,parsed,sourceType});
      } else if(ext==='xlsx'||ext==='xls'){
        const buf=await file.arrayBuffer();
        const sheets=await window.parseExcelWorkbook(buf);
        if(!sheets.length){
          toast('Aucune mesure détectée dans '+file.name);
        } else {
          for(let s=0;s<sheets.length;s++){
            const parsed=sheets[s];
            const name=sheets.length>1?file.name+' — feuille '+(s+1):file.name;
            await dbAdd({name,ext,date:Date.now(),size:file.size,parsed});
          }
        }
      } else {
        toast('Type de fichier non supporté : '+file.name);
      }
    }catch(err){
      console.error(err);
      toast('Erreur sur '+file.name+' : '+(err&&err.message?err.message:err));
    }
  }
  inner.style.width='100%';
  setTimeout(()=>{ bar.style.display='none'; inner.style.width='0%'; },400);
  await loadAll();
  window.renderAll();
  toast(files.length+' fichier(s) importé(s)');
}

/* ================================================================
   CHARGEMENT ÉTAT
   ================================================================ */
async function loadAll(){
  const recs=await dbGetAll();
  AppState.files=recs;
  AppState.measures=[];
  AppState.sections=[];
  AppState.points=[];
  recs.forEach(r=>{
    if(r.ext==='pdf'||r.ext==='xlsx'||r.ext==='xls'){
      AppState.measures.push({
        recId:r.id,name:r.name,date:r.date,
        manualOrigine:r.manualOrigine||null,
        manualExtremite:r.manualExtremite||null,
        manualWaypoints:r.manualWaypoints||null,
        cableKey:r.cableKey||null,
        ...r.parsed
      });
    } else if(r.ext==='kml'||r.ext==='kmz'){
      (r.parsed.sections||[]).forEach(s=>AppState.sections.push({...s,recId:r.id}));
      (r.parsed.points||[]).forEach(p=>AppState.points.push({...p,recId:r.id}));
    }
  });
  AppState.correlations={};
}

/* ================================================================
   CORRÉLATION GPS
   ================================================================ */
function sitePair(name){
  if(!name) return null;
  const t=norm(name);
  const s=AppState.points.find(p=>p.category==='bts'&&norm(p.name)===t)
       ||AppState.points.find(p=>p.category==='bts'&&(norm(p.name).includes(t)||t.includes(norm(p.name))));
  return s?[s.lat,s.lon]:null;
}

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
  const used=new Set(),chain=[];
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
function placeEventsOnRoute(routeCoords,events){
  return (events||[]).map(ev=>({...ev,pos:interpolateAlong(routeCoords,ev.distance)}));
}

async function fetchRoadRouteOnce(coordsList,excludeParam,timeoutMs){
  const coordsStr=coordsList.map(c=>c[1]+','+c[0]).join(';');
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
    return {coords:route.geometry.coordinates.map(c=>[c[1],c[0]]),distance:route.distance,excludeUsed:excludeParam||'aucun'};
  }catch(e){
    clearTimeout(timer);
    console.error('fetchRoadRoute(exclude='+(excludeParam||'aucun')+') a échoué:',e);
    return null;
  }
}

const NATIONAL_ROAD_REFS=['N1','N2','N3','N4','N5','N6','N7','N8','N9','N10','N11','N12','N13','N14','N15'];

async function fetchNationalRoadSections(oGPS,dGPS,timeoutMs=15000){
  const south=Math.min(oGPS[0],dGPS[0])-0.4,north=Math.max(oGPS[0],dGPS[0])+0.4;
  const west=Math.min(oGPS[1],dGPS[1])-0.4,east=Math.max(oGPS[1],dGPS[1])+0.4;
  const refPattern='^(N1|N2|N3|N4|N5|N6|N7|N8|N9|N10|N11|N12|N13|N14|N15)$';
  const query='[out:json][timeout:20];rel["route"="road"]["ref"~"'+refPattern+'"]('+south+','+west+','+north+','+east+');out geom;';
  const ctrl=new AbortController();
  const timer=setTimeout(()=>ctrl.abort(),timeoutMs);
  try{
    const res=await fetch('https://overpass-api.de/api/interpreter',{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'data='+encodeURIComponent(query),signal:ctrl.signal
    });
    clearTimeout(timer);
    if(!res.ok) return [];
    const data=await res.json();
    const sections=[];
    (data.elements||[]).forEach(el=>{
      if(el.type!=='relation'||!el.members) return;
      const ref=(el.tags&&el.tags.ref)||'?';
      el.members.forEach((mem,idx)=>{
        if(mem.type==='way'&&mem.geometry&&mem.geometry.length>=2)
          sections.push({id:ref+'_'+(mem.ref||idx),coords:mem.geometry.map(g=>[g.lat,g.lon])});
      });
    });
    return sections;
  }catch(e){ clearTimeout(timer); console.error('fetchNationalRoadSections a échoué:',e); return []; }
}

function sampleChainWaypoints(chain,stepM=8000,maxPoints=40){
  const pts=[];
  let accSinceLastPt=Infinity;
  chain.forEach(({section,reversed})=>{
    const coords=reversed?[...section.coords].reverse():section.coords;
    for(let i=0;i<coords.length;i++){
      if(i>0) accSinceLastPt+=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
      if(accSinceLastPt>=stepM||(pts.length===0)){ pts.push(coords[i]); accSinceLastPt=0; }
    }
  });
  if(pts.length>maxPoints){
    const out=[pts[0]],step=(pts.length-1)/(maxPoints-1);
    for(let i=1;i<maxPoints-1;i++) out.push(pts[Math.round(i*step)]);
    out.push(pts[pts.length-1]); return out;
  }
  return pts;
}

async function fetchNationalRoadRoute(oGPS,dGPS,timeoutMs=9000){
  const sections=await fetchNationalRoadSections(oGPS,dGPS,15000);
  if(!sections.length) return null;
  const chain=chainSectionsByGPS(sections,oGPS,dGPS,3000);
  if(!chain||chain.length<1) return null;
  const firstPt=chain[0].reversed?chain[0].section.coords[chain[0].section.coords.length-1]:chain[0].section.coords[0];
  const lastSeg=chain[chain.length-1];
  const lastPt=lastSeg.reversed?lastSeg.section.coords[0]:lastSeg.section.coords[lastSeg.section.coords.length-1];
  if(haversine(firstPt[0],firstPt[1],oGPS[0],oGPS[1])>15000) return null;
  if(haversine(lastPt[0],lastPt[1],dGPS[0],dGPS[1])>15000) return null;
  const waypoints=sampleChainWaypoints(chain);
  if(waypoints.length<2) return null;
  let r=await fetchRoadRouteOnce([oGPS,...waypoints,dGPS],'motorway',timeoutMs);
  if(!r) r=await fetchRoadRouteOnce([oGPS,...waypoints,dGPS],'',timeoutMs);
  if(r) r.excludeUsed='route_nationale';
  return r;
}

async function fetchRoadRoute(oGPS,dGPS,timeoutMs=9000){
  try{
    const national=await fetchNationalRoadRoute(oGPS,dGPS,timeoutMs);
    if(national) return national;
  }catch(e){ console.error('fetchNationalRoadRoute a échoué:',e); }
  const tiers=['motorway,trunk','motorway',''];
  for(let i=0;i<tiers.length;i++){
    const r=await fetchRoadRouteOnce([oGPS,dGPS],tiers[i],timeoutMs);
    if(r){
      if(i>0) console.error('Niveau d\'évitement réduit à "'+(tiers[i]||'aucun')+'"');
      return r;
    }
  }
  return null;
}

async function correlateLinear(measure){
  try{
    const oName=measure.manualOrigine||measure.origine;
    const dName=measure.manualExtremite||measure.extremite;
    const oGPS=sitePair(oName);
    const dGPS=sitePair(dName);
    if(!oGPS) return {error:`Site introuvable : "${oName}"\n→ Charge base_site.kmz et vérifie le nom.`};
    if(!dGPS) return {error:`Site introuvable : "${dName}"\n→ Charge base_site.kmz et vérifie le nom.`};

    // parser.js stocke ev.distance en MÈTRES pour tous les formats
    // (EXFO km *1000 dans parser, EXFO m brut, Viavi brut).
    // finFibre est toujours en KM (map.js fait *1000 pour fmtLen).
    const eventsM=(measure.events||[]).map(ev=>({...ev,distance:ev.distance||0}));
    const finFibreM=measure.finFibre!=null?measure.finFibre*1000:null;
    const finFibreKm=measure.finFibre;

    if(measure.manualWaypoints&&measure.manualWaypoints.length){
      try{
        const coordsList=[oGPS,...measure.manualWaypoints,dGPS];
        let r=await fetchRoadRouteOnce(coordsList,'motorway',9000);
        if(!r) r=await fetchRoadRouteOnce(coordsList,'',9000);
        if(r&&r.coords&&r.coords.length>1&&r.distance>0){
          return {routeCoords:r.coords,events:placeEventsOnRoute(r.coords,eventsM),
            originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,
            total:r.distance,measureLen:finFibreKm,excludeUsed:'waypoints_manuels',mode:'road'};
        }
      }catch(e){ console.error('Itinéraire par waypoints manuels a échoué:',e); }
    }

    let chain=null;
    try{ chain=buildPathByGPS(oGPS,dGPS); }catch(e){ console.error('buildPathByGPS a échoué:',e); }
    if(chain&&chain.length){
      const total=chain.reduce((s,{section})=>s+(section.length||0),0);
      if(total>0&&isFinite(total)){
        const gapPct=finFibreM?Math.abs(total-finFibreM)/finFibreM*100:null;
        return {chain,events:placeEventsOnChain(chain,eventsM),
          originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,
          total,measureLen:finFibreKm,gapPct,mode:'chain'};
      }
    }

    const road=await fetchRoadRoute(oGPS,dGPS);
    if(road&&road.coords&&road.coords.length>1&&road.distance>0){
      return {routeCoords:road.coords,events:placeEventsOnRoute(road.coords,eventsM),
        originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,
        total:road.distance,measureLen:finFibreKm,excludeUsed:road.excludeUsed,mode:'road'};
    }

    const total=finFibreM||haversine(oGPS[0],oGPS[1],dGPS[0],dGPS[1]);
    const events=eventsM.map(ev=>{
      const r=total>0?Math.min(1,Math.max(0,ev.distance/total)):0;
      return {...ev,pos:[oGPS[0]+(dGPS[0]-oGPS[0])*r,oGPS[1]+(dGPS[1]-oGPS[1])*r]};
    });
    return {events,originName:oName,destName:dName,originGPS:oGPS,destGPS:dGPS,total,measureLen:finFibreKm,mode:'linear'};
  }catch(e){
    console.error('correlateLinear a échoué:',e);
    return {error:'Erreur de calcul : '+e.message};
  }
}

async function applyCorrelation(){
  try{
    const m=AppState.currentMeasure;
    if(!m){toast('Aucune mesure ouverte');return;}
    const inpA=document.getElementById('inpOrigine'),inpB=document.getElementById('inpExtremite');
    if(!inpA||!inpB){toast('Erreur : champs introuvables');return;}
    const a=inpA.value.trim(),b=inpB.value.trim();
    if(!a||!b){toast('Renseigne les deux sites');return;}
    toast('Calcul de l\'itinéraire…');
    const mEff={...m,manualOrigine:a,manualExtremite:b};
    const result=await correlateLinear(mEff);
    AppState.correlations[m.recId]=result;
    AppState.activeCorrelation={result,measure:mEff};
    window.renderCorrelationResult(result,mEff);
    if(result.error){toast('Erreur : '+result.error.split('\n')[0]);return;}
    if(result.mode==='road') toast('Itinéraire routier trouvé 🚗');
    else if(result.mode==='linear') toast('Pas de route trouvée — ligne directe affichée');
    setTimeout(()=>{
      try{
        document.getElementById('detailOverlay').classList.remove('active');
        window.switchView('carte');
        setTimeout(()=>{
          try{ if(AppState.map) AppState.map.invalidateSize(); window.drawCorrelationLayer(); }
          catch(e2){ console.error('Erreur affichage carte (2):',e2); toast('Erreur affichage carte : '+e2.message); }
        },120);
      }catch(e){ console.error('Erreur affichage carte:',e); toast('Erreur affichage carte : '+e.message); }
    },300);
  }catch(e){ console.error('applyCorrelation a échoué:',e); toast('Erreur : '+e.message); }
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
  let sharedCount=0;
  if(m.cableKey){
    const siblings=recs.filter(r=>r.id!==m.recId&&r.cableKey===m.cableKey);
    for(const sib of siblings){ sib.manualOrigine=a||null; sib.manualExtremite=b||null; await dbUpdate(sib); sharedCount++; }
  }
  AppState.currentMeasure={...m,manualOrigine:a||null,manualExtremite:b||null};
  await loadAll();
  toast(sharedCount>0?`Sauvegardé ✓ (partagé sur ${sharedCount} autre(s) fibre(s))`:'Sauvegardé ✓');
}

/* ================================================================
   ÉDITEUR DE WAYPOINTS — logique (UI dans map.js)
   ================================================================ */
function openWaypointEditor(){
  const m=AppState.currentMeasure;
  if(!m){toast('Aucune mesure ouverte');return;}
  const oName=m.manualOrigine||m.origine,dName=m.manualExtremite||m.extremite;
  const oGPS=sitePair(oName),dGPS=sitePair(dName);
  if(!oGPS||!dGPS){toast('Renseigne d\'abord Origine et Extrémité (sites trouvés)');return;}
  AppState.waypointMode={recId:m.recId,oGPS,dGPS,points:(m.manualWaypoints||[]).map(p=>[p[0],p[1]])};
  document.getElementById('detailOverlay').classList.remove('active');
  window.switchView('carte');
  setTimeout(()=>{
    try{
      if(!AppState.map) window.initMap();
      if(AppState.map) AppState.map.invalidateSize();
      document.getElementById('waypointBanner').style.display='flex';
      document.getElementById('waypointCrosshair').style.display='block';
      document.getElementById('btnWaypointAdd').style.display='flex';
      window.attachWaypointMapClick();
      window.redrawWaypointEdit();
      toast('Vise un endroit puis appuie sur "+ Ajouter ici"');
    }catch(e){console.error('openWaypointEditor error',e);toast('Erreur ouverture éditeur : '+e.message);}
  },350);
}

function addWaypointPoint(lat,lng){
  if(!AppState.waypointMode) return;
  AppState.waypointMode.points.push([lat,lng]);
  window.redrawWaypointEdit();
}
function addWaypointAtCenter(){
  if(!AppState.map||!AppState.waypointMode) return;
  const c=AppState.map.getCenter();
  addWaypointPoint(c.lat,c.lng);
  toast('Point ajouté');
}
function removeWaypointAt(idx){
  if(!AppState.waypointMode) return;
  AppState.waypointMode.points.splice(idx,1);
  window.redrawWaypointEdit();
  toast('Point retiré');
}
function undoLastWaypoint(){
  if(!AppState.waypointMode||!AppState.waypointMode.points.length) return;
  AppState.waypointMode.points.pop();
  window.redrawWaypointEdit();
}
function cancelWaypointEdit(){
  window.exitWaypointEditor();
  toast('Modifications annulées');
}
async function finishWaypointEdit(){
  const wm=AppState.waypointMode;
  if(!wm) return;
  // Callback custom (outil probe — pas de DB)
  if(wm.onFinish){
    const pts=wm.points.slice();
    window.exitWaypointEditor();
    await wm.onFinish(pts);
    return;
  }
  try{
    const recs=await dbGetAll();
    const rec=recs.find(r=>r.id===wm.recId);
    if(rec){ rec.manualWaypoints=wm.points.length?wm.points:null; await dbUpdate(rec); }
    const pointsSnapshot=wm.points.slice();
    window.exitWaypointEditor();
    await loadAll();
    toast(pointsSnapshot.length?'Points enregistrés ✓ — recalcul…':'Points effacés ✓ — recalcul…');
    const m=AppState.measures.find(x=>x.recId===wm.recId);
    if(m){
      AppState.currentMeasure=m;
      const result=await correlateLinear(m);
      AppState.correlations[m.recId]=result;
      AppState.activeCorrelation={result,measure:m};
      if(!result.error) window.drawCorrelationLayer();
      else toast('Erreur itinéraire : '+result.error.split('\n')[0]);
    }
  }catch(e){console.error('finishWaypointEdit error',e);toast('Erreur : '+e.message);}
}

/* ================================================================
   EXPOSITION GLOBALE
   ================================================================ */
// Utilitaires (lus par map.js au démarrage)
window.toast              = toast;
window.fmtNum             = fmtNum;
window.fmtLen             = fmtLen;
window.norm               = norm;
window.haversine          = haversine;
window.lineLength         = lineLength;
window.interpolateAlong   = interpolateAlong;
window.arrayBufferToBase64= arrayBufferToBase64;
window.base64ToArrayBuffer= base64ToArrayBuffer;
// Logique métier
window.isAnomalyEvent     = isAnomalyEvent;
window.loadAll            = loadAll;
window.handleFiles        = handleFiles;
window.correlateLinear    = correlateLinear;
// Actions (appelées depuis les onclick inline et map.js)
window.applyCorrelation   = applyCorrelation;
window.saveEndpoints      = saveEndpoints;
window.openWaypointEditor = openWaypointEditor;
window.addWaypointAtCenter= addWaypointAtCenter;
window.removeWaypointAt   = removeWaypointAt;
window.undoLastWaypoint   = undoLastWaypoint;
window.cancelWaypointEdit = cancelWaypointEdit;
window.finishWaypointEdit = finishWaypointEdit;
// DB (lues par map.js pour suppression historique)
window.dbGetAll           = dbGetAll;
window.dbDelete           = dbDelete;
window.dbUpdate           = dbUpdate;
