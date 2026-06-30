/* ============================================================
   OSP MANAGER — MAP / AFFICHAGE (Couche 3)
   Leaflet, rendu DOM, init DOMContentLoaded.
   Lit AppState et utilitaires depuis engine.js (via window).
   ============================================================ */

/* ---- Raccourcis vers engine.js (exécuté avant map.js dans l'ordre document) ---- */
const AppState      = window.AppState;
const fmtNum        = window.fmtNum;
const fmtLen        = window.fmtLen;
const norm          = window.norm;
const isAnomalyEvent= window.isAnomalyEvent;
const toast         = window.toast;

/* ================================================================
   RENDER : ACCUEIL
   ================================================================ */
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

/* ================================================================
   RENDER : MESURES
   ================================================================ */
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
  try{ siteNames=[...new Set(AppState.points.filter(p=>p.category==='bts').map(p=>p.name))].sort(); }
  catch(e){ console.error('siteNames error',e); }

  function best(term){
    if(!term) return '';
    try{
      var t=norm(term);
      return siteNames.find(n=>norm(n)===t)||siteNames.find(n=>norm(n).includes(t)||t.includes(norm(n)))||'';
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
  try{ opts=siteNames.map(n=>'<option value="'+esc(n)+'">').join(''); }
  catch(e){ console.error('opts error',e); }

  // --- BLOC 1 : ITINÉRAIRE ---
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
          +'<span class="sub">'+(m.manualWaypoints&&m.manualWaypoints.length?'📍 '+m.manualWaypoints.length+' point(s) de passage':'Aucun point de passage')+'</span>'
          +'<button class="btn small secondary" onclick="openWaypointEditor()">📍 Ajuster sur la carte</button>'
        +'</div>'
        +'<div style="display:flex;gap:8px;align-items:center;">'
          +'<button class="btn" style="flex:1;" onclick="applyCorrelation()">&#128506; Tracer l\'itin&#233;raire</button>'
          +'<button class="btn secondary" style="width:36px;height:36px;padding:0;font-size:16px;" onclick="saveEndpoints()">&#128190;</button>'
        +'</div>'
      +'</div>'
      +'<div id="corrResult"></div>';
  }catch(e){ itinHtml='<h2>Itin&#233;raire</h2><div class="card"><p class="sub" style="color:var(--fault);">Erreur d\'affichage.</p></div>'; }

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
  }catch(e){ headerHtml='<h1>'+esc(m.name||'Mesure')+'</h1>'; }

  // --- BLOC 3 : TABLEAU ÉVÉNEMENTS ---
  var eventsHtml='';
  try{
    var evRows='';
    (m.events||[]).forEach(function(ev){
      var anom=false;
      try{ anom=isAnomalyEvent(ev,m); }catch(e2){}
      evRows+='<tr class="event-row '+(anom?'fault':'')+'">'
        +'<td>'+esc(ev.num)+'</td>'
        +'<td>'+esc(fmtLen(ev.distance))+'</td>'
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
  }catch(e){ eventsHtml='<h2>&#201;v&#233;nements OTDR</h2><p class="sub" style="color:var(--fault);">Erreur d\'affichage du tableau.</p>'; }

  document.getElementById('detailContent').innerHTML=headerHtml+eventsHtml+itinHtml;
  document.getElementById('detailOverlay').classList.add('active');
  try{
    var cached=AppState.correlations[m.recId];
    if(cached) renderCorrelationResult(cached,m);
  }catch(e){ console.error('renderCorrelationResult error',e); }
}

function setOrigine(v){ const e=document.getElementById('inpOrigine'); if(e){e.value=v;updSt('inpOrigine','stA');} }
function setExtremite(v){ const e=document.getElementById('inpExtremite'); if(e){e.value=v;updSt('inpExtremite','stB');} }
function updSt(inputId,statusId){
  const e=document.getElementById(inputId),s=document.getElementById(statusId);
  if(!e||!s) return;
  const v=e.value.trim();
  const sn=[...new Set(AppState.points.filter(p=>p.category==='bts').map(p=>p.name))];
  s.innerHTML=v?(sn.includes(v)
    ?'<span style="color:var(--fiber);font-size:10px;">✓ site trouvé</span>'
    :'<span style="color:var(--fault);font-size:10px;">✗ non trouvé</span>'):'';
}

/* ================================================================
   RENDER : RÉSULTAT CORRÉLATION
   ================================================================ */
function renderCorrelationResult(result,measure){
  const div=document.getElementById('corrResult');
  if(!div) return;
  function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  if(result.error){
    div.innerHTML=`<div class="card" style="border-color:var(--fault);white-space:pre-line;margin-top:8px;"><span class="sub" style="color:var(--fault);">${result.error}</span></div>`;
    return;
  }
  const exclLabel={
    'waypoints_manuels':'📍 points de passage manuels appliqués',
    'route_nationale':'✓ tracé réel de la route nationale (OSM) imposé',
    'motorway,trunk':'autoroute + nationale rapide évitées',
    'motorway':'autoroute évitée (national rapide possible)',
    'aucun':'⚠ tous axes autorisés (autoroute possible)'
  }[result.excludeUsed]||'';
  const modeLabel=result.mode==='chain'?'🟢 Tracé fibre (KML)':result.mode==='road'?'🔵 Itinéraire routier':'⚪ Ligne directe (approximation)';
  const roadNote=result.mode==='road'?`<p class="sub" style="margin-top:4px;">Itinéraire calculé par OSRM (voiture). ${exclLabel}. Chaque événement est placé à sa distance exacte mesurée (OTDR), en suivant cet itinéraire depuis l'origine.</p>`:'';
  const gapWarning=(result.mode==='chain'&&result.gapPct!=null&&result.gapPct>15)
    ?`<div class="row" style="color:var(--fault);"><span class="sub">⚠ Écart important</span><strong>${result.gapPct.toFixed(0)}%</strong></div>
       <p class="sub" style="color:var(--fault);margin-top:4px;">Le tracé trouvé (${fmtLen(result.total)}) diffère beaucoup de la longueur mesurée OTDR (${fmtLen(result.measureLen)}). Les événements proches de l'extrémité peuvent être mal placés.</p>`:'';
  div.innerHTML=`
    <div class="card" style="margin-top:8px;">
      <div class="row"><span class="sub">${esc(result.originName)} → ${esc(result.destName)}</span></div>
      <div class="row"><span class="sub">Mode</span><strong>${modeLabel}</strong></div>
      <div class="row"><span class="sub">Longueur tracé</span><strong>${fmtLen(result.total)}</strong></div>
      ${result.measureLen?`<div class="row"><span class="sub">Longueur mesurée (OTDR)</span><strong>${fmtLen(result.measureLen)}</strong></div>`:''}
      ${roadNote}${gapWarning}
    </div>
    <div class="tablewrap" style="margin-top:8px;"><table><thead><tr><th>#</th><th>Distance</th><th>Lat</th><th>Lon</th><th></th></tr></thead><tbody>
    ${(result.events||[]).map(ev=>{
      const anom=isAnomalyEvent(ev,measure);
      return `<tr class="event-row ${anom?'fault':''}">
        <td>${ev.num}</td><td>${fmtLen(ev.distance)}</td>
        <td>${ev.pos?ev.pos[0].toFixed(5):'—'}</td>
        <td>${ev.pos?ev.pos[1].toFixed(5):'—'}</td>
        <td>${ev.pos?`<button class="btn small secondary" onclick="navigateTo(${ev.pos[0]},${ev.pos[1]})">🧭</button>`:''}</td>
      </tr>`;
    }).join('')}
    </tbody></table></div>`;
  AppState.activeCorrelation={result,measure};
}

function showCorrelationOnMap(){
  document.getElementById('detailOverlay').classList.remove('active');
  switchView('carte');
  drawCorrelationLayer();
}
function navigateTo(lat,lon){
  window.open(`https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`,'_blank');
}

/* ================================================================
   RENDER : SECTIONS
   ================================================================ */
function renderSections(filter){
  const list=document.getElementById('sectionsList'),kpis=document.getElementById('sectionsKpis');
  if(!AppState.sections.length){
    kpis.innerHTML='';
    list.innerHTML='<div class="empty">Aucune section chargée. Importe un fichier KML/KMZ.</div>';
    return;
  }
  const totalLen=AppState.sections.reduce((a,s)=>a+s.length,0);
  kpis.innerHTML=`<div class="kpi"><div class="v">${AppState.sections.length}</div><div class="l">Sections</div></div>
    <div class="kpi"><div class="v">${fmtLen(totalLen)}</div><div class="l">Longueur totale</div></div>`;
  let secs=AppState.sections;
  if(filter){
    const f=filter.toUpperCase();
    secs=secs.filter(s=>(s.endA||'').toUpperCase().includes(f)||(s.endB||'').toUpperCase().includes(f)||s.name.toUpperCase().includes(f));
  }
  if(!secs.length){ list.innerHTML='<div class="empty">Aucun résultat pour cette recherche.</div>'; return; }
  list.innerHTML=secs.slice(0,300).map(s=>`
    <div class="card tap" data-id="${s.id}">
      <div class="row"><strong style="font-size:12px;">${s.endA||'?'} ↔ ${s.endB||'?'}</strong><span class="badge kml">${fmtLen(s.length)}</span></div>
      <div class="row"><span class="sub">${s.type||s.name}</span></div>
    </div>`).join('')+(secs.length>300?`<p class="sub" style="text-align:center;margin-top:8px;">${secs.length-300} résultat(s) supplémentaire(s).</p>`:'');
  list.querySelectorAll('.card').forEach(el=>{
    el.addEventListener('click',()=>openSectionDetail(AppState.sections.find(s=>s.id===el.dataset.id)));
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
    <button class="btn secondary" style="margin-top:12px;" onclick="focusSectionOnMap('${s.id}')">Voir sur la carte</button>`;
  document.getElementById('detailOverlay').classList.add('active');
}
function focusSectionOnMap(id){
  document.getElementById('detailOverlay').classList.remove('active');
  switchView('carte');
  const s=AppState.sections.find(x=>x.id===id);
  if(!s||!AppState.map) return;
  AppState.map.fitBounds(L.latLngBounds(s.coords),{padding:[40,40]});
  if(AppState._highlight) AppState.map.removeLayer(AppState._highlight);
  AppState._highlight=L.polyline(s.coords,{color:'#39d98a',weight:6,opacity:.9}).addTo(AppState.map);
}

/* ================================================================
   RENDER : HISTORIQUE
   ================================================================ */
function renderHistory(){
  const list=document.getElementById('historyList');
  if(!AppState.files.length){ list.innerHTML='<div class="empty">Aucun fichier dans l\'historique.</div>'; return; }
  const sorted=[...AppState.files].sort((a,b)=>b.date-a.date);
  list.innerHTML=sorted.map(f=>{
    const d=new Date(f.date);
    const sizeKb=f.size?Math.round(f.size/1024)+' Ko':'';
    const extra=f.ext==='pdf'?f.parsed?.cable||'':
      `${(f.parsed.sections||[]).length} section(s), ${(f.parsed.points||[]).length} point(s)`;
    return `<div class="card">
      <div class="row"><strong style="font-size:12px;">${f.name}</strong><span class="badge ${f.ext}">${f.ext}</span></div>
      <div class="row"><span class="sub">${extra}</span><span class="sub">${sizeKb}</span></div>
      <div class="row"><span class="sub">${d.toLocaleDateString('fr-FR')} ${d.toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'})}</span>
        <button class="btn danger small" data-id="${f.id}">Supprimer</button></div>
    </div>`;
  }).join('');
  list.querySelectorAll('button.danger').forEach(btn=>{
    btn.addEventListener('click',async()=>{
      await window.dbDelete(+btn.dataset.id);
      await window.loadAll();
      renderAll();
      toast('Fichier supprimé');
    });
  });
}

/* ================================================================
   CARTE LEAFLET
   ================================================================ */
function initMap(){
  if(AppState.map) return;
  AppState.map=L.map('map',{preferCanvas:true,zoomControl:false}).setView([14.6,-15.2],8);
  L.control.zoom({position:'bottomright'}).addTo(AppState.map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap'}).addTo(AppState.map);
  AppState.layers.sections    = L.layerGroup().addTo(AppState.map);
  AppState.layers.sites       = L.layerGroup();
  AppState.layers.joints      = L.layerGroup();
  AppState.layers.events      = L.layerGroup().addTo(AppState.map);
  AppState.layers.correlation = L.layerGroup().addTo(AppState.map);
  AppState.layers.waypointEdit= L.layerGroup().addTo(AppState.map);
  AppState.layers.probe       = L.layerGroup().addTo(AppState.map);

  // Bouton 📏 flottant sur la carte → ouvre l'outil de localisation par distance
  const ProbeCtrl = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const btn = L.DomUtil.create('button');
      btn.innerHTML = '📏';
      btn.title = 'Localiser une distance';
      btn.style.cssText = 'width:36px;height:36px;font-size:18px;cursor:pointer;'
        + 'background:var(--surface,#1e1e2e);color:var(--text,#fff);'
        + 'border:1px solid var(--border,#333);border-radius:8px;';
      L.DomEvent.disableClickPropagation(btn);
      btn.addEventListener('click', toggleDistanceProbe);
      return btn;
    }
  });
  new ProbeCtrl().addTo(AppState.map);
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
        .bindPopup(`<b>${p.name}</b><br>${navBtn}`).addTo(AppState.layers.sites);
      AppState.siteMarkers[p.name]=marker;
    } else if(p.category==='joint'||p.category==='chamber'){
      L.circleMarker([p.lat,p.lon],{radius:4,color:'#c98bff',fillColor:'#c98bff',fillOpacity:.9,weight:1})
        .bindPopup(`<b>${p.name}</b><br>${p.category==='joint'?'Joint':'Chambre'}<br>${navBtn}`)
        .addTo(AppState.layers.joints);
    }
  });
  updateSiteSearchList();
  Object.entries(AppState.correlations||{}).forEach(([recId,result])=>{
    if(!result||result.error) return;
    const measure=AppState.measures.find(m=>m.recId==recId);
    (result.placedEvents||[]).forEach(ev=>{
      if(!ev.pos) return;
      const anom=measure?isAnomalyEvent(ev,measure):false;
      L.circleMarker(ev.pos,{radius:7,color:anom?'#ff5d5d':'#39d98a',fillColor:anom?'#ff5d5d':'#39d98a',fillOpacity:.95,weight:2})
        .bindPopup(`<b>${measure?.cable||measure?.name||''}</b><br>Événement #${ev.num} — ${fmtLen(ev.distance)}<br>${anom?'<span style="color:#ff5d5d">À vérifier</span><br>':''}<a href="https://www.google.com/maps/dir/?api=1&destination=${ev.pos[0]},${ev.pos[1]}" target="_blank">Naviguer</a>`)
        .addTo(AppState.layers.events);
    });
  });
}

function drawCorrelationLayer(){
  if(!AppState.activeCorrelation) return;
  if(!AppState.map) initMap();
  if(!AppState.map){toast('Erreur : carte non prête');return;}
  AppState.layers.correlation.clearLayers();
  AppState.layers.events.clearLayers();
  if(!AppState.layers.correlation._map) AppState.layers.correlation.addTo(AppState.map);
  if(!AppState.layers.events._map) AppState.layers.events.addTo(AppState.map);
  const {result,measure}=AppState.activeCorrelation;
  if(result.error) return;
  const all=[];
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
    L.polyline([result.originGPS,result.destGPS],{color:'#39d98a',weight:4,opacity:.7,dashArray:'8,6'}).addTo(AppState.layers.correlation);
    all.push(result.originGPS,result.destGPS);
  }
  if(result.originGPS) L.circleMarker(result.originGPS,{radius:9,color:'#4f9eff',fillColor:'#4f9eff',fillOpacity:1,weight:2})
    .bindPopup('<b>Origine</b><br>'+result.originName).addTo(AppState.layers.correlation);
  if(result.destGPS) L.circleMarker(result.destGPS,{radius:9,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2})
    .bindPopup('<b>Extrémité</b><br>'+result.destName).addTo(AppState.layers.correlation);
  (result.events||[]).forEach(ev=>{
    if(!ev.pos||!isFinite(ev.pos[0])||!isFinite(ev.pos[1])) return;
    let anom=false;
    try{ anom=isAnomalyEvent(ev,measure); }catch(e){}
    all.push(ev.pos);
    const popup='<b>#'+ev.num+'</b> — '+fmtLen(ev.distance)
      +(anom?'<br><span style="color:#ff5d5d">⚠ Anomalie</span>':'')
      +'<br><button class="btn small secondary" onclick="navigateTo('+ev.pos[0]+','+ev.pos[1]+')">🧭 Itinéraire</button>';
    L.circleMarker(ev.pos,{radius:anom?8:5,color:anom?'#ff5d5d':'#39d98a',fillColor:anom?'#ff5d5d':'#39d98a',fillOpacity:.95,weight:2})
      .bindPopup(popup).addTo(AppState.layers.events);
  });
  if(all.length) AppState.map.fitBounds(L.latLngBounds(all),{padding:[40,40]});
  toast(result.chain?'Itinéraire affiché sur la carte':'Événements affichés (interpolation)');
}

/* ================================================================
   ÉDITEUR WAYPOINTS — UI / Leaflet
   ================================================================ */
function attachWaypointMapClick(){
  if(!AppState.map||AppState.map._waypointClickAttached) return;
  AppState.map.on('click',e=>window.addWaypointPoint(e.latlng.lat,e.latlng.lng));
  AppState.map._waypointClickAttached=true;
}
function detachWaypointMapClick(){
  if(!AppState.map) return;
  AppState.map.off('click');
  AppState.map._waypointClickAttached=false;
}
function redrawWaypointEdit(){
  if(!AppState.map||!AppState.waypointMode) return;
  const wm=AppState.waypointMode;
  AppState.layers.waypointEdit.clearLayers();
  if(!AppState.layers.waypointEdit._map) AppState.layers.waypointEdit.addTo(AppState.map);
  const allPts=[wm.oGPS,...wm.points,wm.dGPS];
  L.polyline(allPts,{color:'#ffd454',weight:3,opacity:.85,dashArray:'6,6'}).addTo(AppState.layers.waypointEdit);
  L.circleMarker(wm.oGPS,{radius:8,color:'#4f9eff',fillColor:'#4f9eff',fillOpacity:1,weight:2}).bindPopup('Origine').addTo(AppState.layers.waypointEdit);
  L.circleMarker(wm.dGPS,{radius:8,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2}).bindPopup('Extrémité').addTo(AppState.layers.waypointEdit);
  wm.points.forEach((p,idx)=>{
    L.marker(p,{icon:L.divIcon({
      className:'',
      html:'<div style="background:#ffd454;color:#1a1408;width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;border:2px solid #1a1408;">'+(idx+1)+'</div>',
      iconSize:[24,24],iconAnchor:[12,12]
    })}).bindPopup('Point '+(idx+1)+'<br><button class="btn small secondary" onclick="removeWaypointAt('+idx+')">🗑 Retirer</button>').addTo(AppState.layers.waypointEdit);
  });
  const countEl=document.getElementById('waypointCount');
  if(countEl) countEl.textContent=wm.points.length?'📍 '+wm.points.length+' point(s)':'📍 Aucun point — vise et appuie sur "+"';
}
function exitWaypointEditor(){
  detachWaypointMapClick();
  if(AppState.layers.waypointEdit) AppState.layers.waypointEdit.clearLayers();
  document.getElementById('waypointBanner').style.display='none';
  document.getElementById('waypointCrosshair').style.display='none';
  document.getElementById('btnWaypointAdd').style.display='none';
  AppState.waypointMode=null;
}

/* ================================================================
   OUTIL LOCALISATION PAR DISTANCE (standalone — sans fichier)
   ================================================================ */

/** Retourne le point GPS à une distance distM depuis l'origine d'un résultat de corrélation */
function getPosAtDistance(result, distM){
  if(result.chain && result.chain.length){
    let acc=0;
    for(const {section,reversed} of result.chain){
      const coords=reversed?[...section.coords].reverse():section.coords;
      if(acc+section.length>=distM) return window.interpolateAlong(coords, Math.max(0,distM-acc));
      acc+=section.length;
    }
    const last=result.chain[result.chain.length-1];
    const c=last.reversed?[...last.section.coords].reverse():last.section.coords;
    return c[c.length-1];
  }
  if(result.routeCoords && result.routeCoords.length>1)
    return window.interpolateAlong(result.routeCoords, distM);
  if(result.originGPS && result.destGPS){
    const total=result.total||window.haversine(result.originGPS[0],result.originGPS[1],result.destGPS[0],result.destGPS[1]);
    const r=total>0?Math.min(1,Math.max(0,distM/total)):0;
    return [result.originGPS[0]+(result.destGPS[0]-result.originGPS[0])*r,
            result.originGPS[1]+(result.destGPS[1]-result.originGPS[1])*r];
  }
  return null;
}

function toggleDistanceProbe(){
  switchView('carte');
  const panel=document.getElementById('distanceProbePanel');
  if(!panel) return;
  const visible=panel.style.display!=='none';
  panel.style.display=visible?'none':'block';
  if(!visible) document.getElementById('probeOrigine').focus();
}

function _updateProbeWpLabel(){
  const n=(AppState.probeWaypoints||[]).length;
  const el=document.getElementById('probeWpCount');
  if(el) el.textContent=n?'📍 '+n+' point(s) de passage':'Aucun point de passage';
}

function openProbeWaypointEditor(){
  const oName=(document.getElementById('probeOrigine').value||'').trim();
  const dName=(document.getElementById('probeExtremite').value||'').trim();
  if(!oName||!dName){ toast('Renseigne Origine et Extrémité d\'abord'); return; }
  const oGPS=_siteGPS(oName), dGPS=_siteGPS(dName);
  if(!oGPS){ toast('Site introuvable : '+oName); return; }
  if(!dGPS){ toast('Site introuvable : '+dName); return; }
  // Fermer le panneau probe et ouvrir l'éditeur Leaflet
  document.getElementById('distanceProbePanel').style.display='none';
  AppState.probeWaypoints=AppState.probeWaypoints||[];
  AppState.waypointMode={
    oGPS, dGPS,
    points:[...AppState.probeWaypoints],
    onFinish:async(pts)=>{
      AppState.probeWaypoints=pts;
      _updateProbeWpLabel();
      document.getElementById('distanceProbePanel').style.display='block';
      toast(pts.length?pts.length+' point(s) enregistrés — relance le tracé':'Points effacés');
    }
  };
  setTimeout(()=>{
    if(!AppState.map) initMap();
    AppState.map.invalidateSize();
    document.getElementById('waypointBanner').style.display='flex';
    document.getElementById('waypointCrosshair').style.display='block';
    document.getElementById('btnWaypointAdd').style.display='flex';
    attachWaypointMapClick();
    redrawWaypointEdit();
    toast('Vise un point puis "+ Ajouter ici"');
  },200);
}

/** Cherche les coordonnées GPS d'un site dans AppState.points */
function _siteGPS(name){
  if(!name) return null;
  const q=window.norm(name);
  const p=AppState.points.find(p=>p.category==='bts'&&window.norm(p.name)===q)
         ||AppState.points.find(p=>p.category==='bts'&&(window.norm(p.name).includes(q)||q.includes(window.norm(p.name))));
  return p?[p.lat,p.lon]:null;
}

async function traceAndLocate(){
  const oName =(document.getElementById('probeOrigine').value||'').trim();
  const dName =(document.getElementById('probeExtremite').value||'').trim();
  const raw   =(document.getElementById('probeDist').value||'').trim();
  const unit  =(document.getElementById('probeUnit').value||'m');
  const res   = document.getElementById('probeResult');

  if(!oName||!dName||!raw){ res.innerHTML='<p class="sub" style="color:var(--fault);">Remplis les 3 champs.</p>'; return; }
  let distM=parseFloat(raw);
  if(isNaN(distM)||distM<0){ res.innerHTML='<p class="sub" style="color:var(--fault);">Distance invalide.</p>'; return; }
  if(unit==='km') distM*=1000;

  res.innerHTML='<p class="sub">⏳ Calcul de l\'itinéraire…</p>';

  // Mesure virtuelle — aucun fichier requis
  const fakeMeasure={
    origine:oName, extremite:dName,
    manualOrigine:oName, manualExtremite:dName,
    manualWaypoints:(AppState.probeWaypoints&&AppState.probeWaypoints.length)?AppState.probeWaypoints:null,
    events:[], finFibre:distM*2, recId:'_probe'
  };

  let result;
  try{
    result=await window.correlateLinear(fakeMeasure);
  }catch(e){
    res.innerHTML=`<p class="sub" style="color:var(--fault);">Erreur : ${e.message}</p>`;
    return;
  }
  if(result.error){
    res.innerHTML=`<p class="sub" style="color:var(--fault);white-space:pre-line;">${result.error}</p>`;
    return;
  }

  const pos=getPosAtDistance(result, distM);
  if(!pos||!isFinite(pos[0])){
    res.innerHTML='<p class="sub" style="color:var(--fault);">Impossible de placer le point.</p>';
    return;
  }

  // Afficher tracé + marqueur sur la carte
  if(!AppState.map) initMap();
  AppState.layers.probe.clearLayers();
  if(!AppState.layers.probe._map) AppState.layers.probe.addTo(AppState.map);

  // Tracé de la route
  const routeCoords=result.routeCoords||(result.chain
    ?result.chain.flatMap(({section,reversed})=>reversed?[...section.coords].reverse():section.coords)
    :[result.originGPS,result.destGPS]);
  if(routeCoords&&routeCoords.length>1)
    L.polyline(routeCoords,{color:'#4f9eff',weight:5,opacity:.8}).addTo(AppState.layers.probe);

  // Marqueurs Origine / Extrémité
  if(result.originGPS) L.circleMarker(result.originGPS,{radius:8,color:'#4f9eff',fillColor:'#4f9eff',fillOpacity:1,weight:2})
    .bindPopup('<b>Origine</b><br>'+oName).addTo(AppState.layers.probe);
  if(result.destGPS)   L.circleMarker(result.destGPS,{radius:8,color:'#ffb454',fillColor:'#ffb454',fillOpacity:1,weight:2})
    .bindPopup('<b>Extrémité</b><br>'+dName).addTo(AppState.layers.probe);

  // Marqueur de distance d'arrêt
  L.circleMarker(pos,{radius:11,color:'#ffd454',fillColor:'#ffd454',fillOpacity:1,weight:3})
    .bindPopup(
      `<b>📍 ${fmtLen(distM)} depuis ${oName}</b><br>`+
      `${pos[0].toFixed(5)}, ${pos[1].toFixed(5)}<br>`+
      `<button class="btn small secondary" style="margin-top:6px;" `+
      `onclick="navigateTo(${pos[0]},${pos[1]})">🧭 Naviguer</button>`
    ).addTo(AppState.layers.probe).openPopup();

  // Centrer
  const allPts=[result.originGPS,result.destGPS,pos].filter(Boolean);
  AppState.map.fitBounds(L.latLngBounds(allPts),{padding:[50,50]});

  // Résultat texte dans le panneau
  const modeLabel=result.mode==='chain'?'tracé fibre KML':result.mode==='road'?'itinéraire routier':'ligne directe';
  res.innerHTML=`
    <div style="margin-top:10px;padding:10px;background:var(--surface2,#2a2a3e);border-radius:8px;">
      <div class="row"><span class="sub">Mode</span><strong>${modeLabel}</strong></div>
      <div class="row"><span class="sub">Longueur totale</span><strong>${fmtLen(result.total)}</strong></div>
      <div class="row"><span class="sub">Distance d'arrêt</span><strong>${fmtLen(distM)}</strong></div>
      <div class="row"><span class="sub">Latitude</span><strong>${pos[0].toFixed(6)}</strong></div>
      <div class="row"><span class="sub">Longitude</span><strong>${pos[1].toFixed(6)}</strong></div>
      <button class="btn secondary" style="width:100%;margin-top:8px;" onclick="navigateTo(${pos[0]},${pos[1]})">🧭 Naviguer vers ce point</button>
    </div>`;
}

/* ================================================================
   NAVIGATION
   ================================================================ */
function switchView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
  document.getElementById('view-'+name).classList.add('active');
  document.querySelector(`.tab[data-view="${name}"]`).classList.add('active');
  // Nettoyer le tracé probe et fermer le panneau dès qu'on quitte la carte
  if(name!=='carte'){
    if(AppState.layers&&AppState.layers.probe) AppState.layers.probe.clearLayers();
    const panel=document.getElementById('distanceProbePanel');
    if(panel) panel.style.display='none';
  }
  if(name==='carte') setTimeout(()=>{ initMap(); renderMap(); AppState.map.invalidateSize(); },50);
}
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
function renderAll(){
  renderAccueil(); renderMesures();
  renderSections(document.getElementById('sectionSearch').value);
  renderHistory();
  if(AppState.map) renderMap();
  updateHeader();
}

/* ================================================================
   RECHERCHE SITE
   ================================================================ */
function updateSiteSearchList(){
  const dl=document.getElementById('mapSiteList');
  if(!dl) return;
  dl.innerHTML=AppState.points.filter(p=>p.category==='bts').sort((a,b)=>a.name.localeCompare(b.name)).map(p=>`<option value="${p.name}">`).join('');
}
function searchSite(){
  const val=(document.getElementById('mapSearchInput').value||'').trim();
  if(!val) return;
  const q=val.toUpperCase();
  let found=AppState.points.find(p=>p.category==='bts'&&p.name.toUpperCase()===q)
         ||AppState.points.find(p=>p.category==='bts'&&p.name.toUpperCase().includes(q));
  if(!found){toast('Site introuvable : '+val);return;}
  const sitesLayer=AppState.layers.sites;
  if(sitesLayer&&!sitesLayer._map){sitesLayer.addTo(AppState.map);document.getElementById('layerSites').classList.add('on');}
  AppState.map.setView([found.lat,found.lon],16,{animate:true});
  const marker=AppState.siteMarkers[found.name];
  if(marker) marker.openPopup();
  toast('📍 '+found.name);
}
function toggleMapSearch(){
  const el=document.getElementById('mapSearch');
  const visible=el.style.display!=='none'&&el.style.display!=='';
  el.style.display=visible?'none':'flex';
  if(!visible){document.getElementById('mapSearchInput').focus();updateSiteSearchList();}
}

/* ================================================================
   INIT — DOMContentLoaded
   ================================================================ */
window.addEventListener('DOMContentLoaded',async()=>{

  // ---- Panneau "Localisation par distance" injecté dans le DOM ----
  const siteOpts=()=>[...new Set(AppState.points.filter(p=>p.category==='bts').map(p=>p.name))].sort()
    .map(n=>`<option value="${n}">`).join('');

  const panel=document.createElement('div');
  panel.id='distanceProbePanel';
  panel.style.cssText='display:none;position:fixed;bottom:60px;left:0;right:0;z-index:1200;'
    +'background:var(--surface,#1e1e2e);border-top:1px solid var(--border,#333);'
    +'padding:14px 16px 16px;max-height:80vh;overflow-y:auto;';
  panel.innerHTML=`
    <datalist id="probeSiteList"></datalist>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
      <strong style="font-size:14px;">📏 Localisation par distance</strong>
      <button onclick="toggleDistanceProbe()" style="background:none;border:none;color:var(--muted,#888);font-size:20px;cursor:pointer;padding:0 4px;">✕</button>
    </div>
    <div style="margin-bottom:8px;">
      <label class="sub" style="display:block;margin-bottom:4px;">Origine</label>
      <input id="probeOrigine" list="probeSiteList" placeholder="Nom du site A" autocomplete="off"
        style="width:100%;background:var(--surface2,#2a2a3e);border:1px solid var(--border,#333);color:var(--text,#fff);border-radius:8px;padding:9px 12px;font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:8px;">
      <label class="sub" style="display:block;margin-bottom:4px;">Extrémité</label>
      <input id="probeExtremite" list="probeSiteList" placeholder="Nom du site B" autocomplete="off"
        style="width:100%;background:var(--surface2,#2a2a3e);border:1px solid var(--border,#333);color:var(--text,#fff);border-radius:8px;padding:9px 12px;font-size:13px;box-sizing:border-box;">
    </div>
    <div style="margin-bottom:12px;display:flex;gap:8px;">
      <div style="flex:1;">
        <label class="sub" style="display:block;margin-bottom:4px;">Distance d'arrêt</label>
        <input id="probeDist" type="number" min="0" step="0.001" placeholder="ex: 8500"
          style="width:100%;background:var(--surface2,#2a2a3e);border:1px solid var(--border,#333);color:var(--text,#fff);border-radius:8px;padding:9px 12px;font-size:13px;box-sizing:border-box;"
          onkeydown="if(event.key==='Enter') traceAndLocate();">
      </div>
      <div style="width:70px;">
        <label class="sub" style="display:block;margin-bottom:4px;">Unité</label>
        <select id="probeUnit" style="width:100%;background:var(--surface2,#2a2a3e);border:1px solid var(--border,#333);color:var(--text,#fff);border-radius:8px;padding:9px 8px;font-size:13px;">
          <option value="m">m</option>
          <option value="km">km</option>
        </select>
      </div>
    </div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;padding:8px;background:var(--surface2,#2a2a3e);border-radius:8px;">
      <span id="probeWpCount" class="sub">Aucun point de passage</span>
      <button class="btn secondary" style="padding:0 12px;height:32px;font-size:12px;" onclick="openProbeWaypointEditor()">📍 Ajuster sur la carte</button>
    </div>
    <button class="btn" style="width:100%;" onclick="traceAndLocate()">🗺️ Tracer et localiser</button>
    <div id="probeResult"></div>`;
  document.body.appendChild(panel);

  // Mettre à jour la datalist sites quand le panneau s'ouvre
  document.getElementById('probeOrigine').addEventListener('focus',()=>{
    document.getElementById('probeSiteList').innerHTML=siteOpts();
  });
  document.getElementById('probeExtremite').addEventListener('focus',()=>{
    document.getElementById('probeSiteList').innerHTML=siteOpts();
  });
  document.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>switchView(btn.dataset.view)));
  document.getElementById('btnImport').addEventListener('click',()=>document.getElementById('fileInput').click());
  document.getElementById('fileInput').addEventListener('change',e=>{
    if(e.target.files.length) window.handleFiles(e.target.files);
    e.target.value='';
  });
  document.getElementById('sectionSearch').addEventListener('input',e=>renderSections(e.target.value));
  document.getElementById('detailOverlay').addEventListener('click',e=>{
    if(e.target.id==='detailOverlay') e.target.classList.remove('active');
  });
  document.getElementById('btnSearchSite').addEventListener('click',toggleMapSearch);
  document.getElementById('mapSearchClose').addEventListener('click',()=>{
    document.getElementById('mapSearch').style.display='none';
    document.getElementById('mapSearchInput').value='';
  });
  document.getElementById('mapSearchGo').addEventListener('click',searchSite);
  document.getElementById('mapSearchInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();searchSite();}});
  document.getElementById('btnWaypointUndo').addEventListener('click',window.undoLastWaypoint);
  document.getElementById('btnWaypointCancel').addEventListener('click',window.cancelWaypointEdit);
  document.getElementById('btnWaypointDone').addEventListener('click',window.finishWaypointEdit);
  document.getElementById('btnWaypointAdd').addEventListener('click',window.addWaypointAtCenter);
  const toggles={layerSections:'sections',layerSites:'sites',layerJoints:'joints',layerEvents:'events'};
  Object.entries(toggles).forEach(([btnId,layerKey])=>{
    document.getElementById(btnId).addEventListener('click',()=>{
      const btn=document.getElementById(btnId),layer=AppState.layers[layerKey];
      if(!AppState.map) return;
      if(layer._map){AppState.map.removeLayer(layer);btn.classList.remove('on');}
      else{layer.addTo(AppState.map);btn.classList.add('on');}
    });
  });
  document.getElementById('btnFitAll').addEventListener('click',()=>{
    if(!AppState.map) return;
    let all=[];
    AppState.sections.forEach(s=>all.push(...s.coords));
    AppState.points.forEach(p=>all.push([p.lat,p.lon]));
    if(all.length) AppState.map.fitBounds(L.latLngBounds(all),{padding:[30,30]});
  });
  await window.loadAll();
  renderAll();
  if('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
});

/* ================================================================
   EXPOSITION GLOBALE (onclick inline dans HTML généré)
   ================================================================ */
window.renderAll             = renderAll;
window.renderCorrelationResult=renderCorrelationResult;
window.drawCorrelationLayer  = drawCorrelationLayer;
window.initMap               = initMap;
window.switchView            = switchView;
window.navigateTo            = navigateTo;
window.showCorrelationOnMap  = showCorrelationOnMap;
window.focusSectionOnMap     = focusSectionOnMap;
window.searchSite            = searchSite;
window.toggleMapSearch       = toggleMapSearch;
window.setOrigine            = setOrigine;
window.setExtremite          = setExtremite;
window.updSt                 = updSt;
window.redrawWaypointEdit    = redrawWaypointEdit;
window.attachWaypointMapClick= attachWaypointMapClick;
window.detachWaypointMapClick= detachWaypointMapClick;
window.exitWaypointEditor    = exitWaypointEditor;
window.toggleDistanceProbe   = toggleDistanceProbe;
window.traceAndLocate        = traceAndLocate;
window.openProbeWaypointEditor=openProbeWaypointEditor;
