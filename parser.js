/* ============================================================
   OSP MANAGER — PARSER (Couche 1)
   Lecture PDF (OTDR Viavi / EXFO), KML/KMZ, Excel.
   Aucune dépendance : DOM, Leaflet, AppState.
   Exposition : window.parsePDF  window.parseExcelWorkbook  window.parseKML
   ============================================================ */

import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

/* ---- Utilitaires internes (copiés pour rester autonome) ---- */
function _escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function _haversine(lat1,lon1,lat2,lon2){
  const R=6371000,toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function _lineLength(coords){
  let d=0;
  for(let i=1;i<coords.length;i++) d+=_haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
  return d;
}

/* ================================================================
   PARSER PDF — EXFO
   ================================================================ */

function parseFrNum(s){
  if(!s||s==='---') return null;
  const v=parseFloat(s.replace(/>/g,'').replace(/\s+/g,'').replace(',','.'));
  return isNaN(v)?null:v;
}

function parseEXFOMeta(text){
  function get(re){ const m=text.match(re); return m?m[1].trim():null; }
  const cable=get(/ID du c[aâ]ble\s*:\s*(\S+)/);
  const fibre=get(/ID de la fibre\s*:\s*(\S+)/);
  let origine=null,extremite=null;
  const em=text.match(/Emplacement\s+A\s+Emplacement\s+B\s+Emplacement\s+(\S+)\s+(.*?)\s+Op[eé]rateur/i);
  if(em){ origine=em[1]; extremite=em[2].trim(); }
  // finFibre : format km (11.5447 km) ou m (20 313,9 m → convertir)
  let finFibre=parseFrNum(get(/Longueur de la section\s*:\s*([\d.]+)\s*km/));
  if(finFibre===null){
    const mVal=parseFrNum(get(/Longueur de la section\s*:\s*([\d\s,]+)\s*m(?!\w)/));
    if(mVal!==null) finFibre=mVal/1000;
  }
  // bilanTotal / orl : gérer virgule ET point décimal
  const bilanTotal=parseFrNum(get(/Perte de la section\s*:\s*([\d,.]+)\s*dB/));
  const orl=parseFrNum(get(/ORL de la section\s*:\s*<?(-?[\d,.]+)\s*dB/));
  return {cable,fibre,origine,extremite,finFibre,bilanTotal,orl,hasMeta:!!(cable||origine||finFibre)};
}

function parseEXFOEvents(content){
  const items=content.items.filter(i=>i.str.trim()!=='').map(i=>({
    str:i.str.trim(),x:i.transform[4],y:i.transform[5]
  }));
  function matchHeader(s){
    if(['Type','Perte','Nº','N°','N\u00ba','N\u00b0'].includes(s)) return true;
    if(s==='Pos./Long.'||s.startsWith('Pos./')) return true;
    if(s.startsWith('R\u00e9fl')||s.startsWith('Refl')) return true;
    if(s.startsWith('Att\u00e9')||s.startsWith('Atte')||s.startsWith('Att.')) return true;
    if(s.startsWith('Cum')||s==='Cumulé') return true;
    return false;
  }
  const cands=items.filter(i=>matchHeader(i.str));
  if(cands.length<3) return [];

  const yG={};
  cands.forEach(c=>{
    const k=Object.keys(yG).find(ky=>Math.abs(+ky-c.y)<4)||String(c.y);
    (yG[k]=yG[k]||[]).push(c);
  });
  let bestG=[];
  Object.values(yG).forEach(g=>{ if(g.length>bestG.length) bestG=g; });
  if(bestG.length<3) return [];

  const headerY=bestG[0].y;
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

  // Détecter unité depuis Pos./Long. (m) ou Pos./Long. (km)
  // Cas 1 : unité dans le même item  → extraire depuis bestG
  // Cas 2 : item séparé (m)/(km) sous l'en-tête → fallback Y-range
  const posItem=bestG.find(h=>h.str.startsWith('Pos./'));
  let inMeters=false;
  if(posItem&&/\(m\)|\(km\)/.test(posItem.str)){
    inMeters=/\(m\)/.test(posItem.str)&&!/\(km\)/.test(posItem.str);
  } else {
    const unitTokens=items
      .filter(i=>i.y>=headerY-25&&i.y<headerY-1&&(i.str==='(m)'||i.str==='(km)'))
      .sort((a,b)=>a.x-b.x);
    inMeters=unitTokens.length>0&&unitTokens[0].str==='(m)';
  }

  const COL_ORDER=['Type','Nº','Pos./Long.','Perte','Réflectance','Atténuation','Cumulé'];
  const present=COL_ORDER.filter(c=>colX[c]!==undefined);
  for(let i=0;i<present.length;i++){
    if(present[i]==='Type') continue;
    if(i<present.length-1){
      const w=colX[present[i+1]]-colX[present[i]];
      if(w>0) colX[present[i]]+=Math.round(w*0.65);
    } else {
      colX[present[i]]+=40;
    }
  }

  const skip=new Set(['(m)','(km)','(dB)','(dB/km)']);
  const below=items.filter(i=>i.y<headerY-4&&!skip.has(i.str));
  const rowMap={};
  below.forEach(it=>{
    const k=Object.keys(rowMap).find(ky=>Math.abs(+ky-it.y)<2.5)||String(it.y);
    (rowMap[k]=rowMap[k]||[]).push(it);
  });

  const sortedCols=Object.keys(colX).sort((a,b)=>colX[a]-colX[b]);
  const colRanges={};
  sortedCols.forEach((col,idx)=>{
    const left =idx===0                    ?-Infinity:(colX[sortedCols[idx-1]]+colX[col])/2;
    const right=idx===sortedCols.length-1 ? Infinity:(colX[col]+colX[sortedCols[idx+1]])/2;
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
    const ns=(a['Nº']||'').trim();
    if(!/^\d+$/.test(ns)) return;
    const rawDist=parseFrNum(a['Pos./Long.']);
    evts.push({
      num:parseInt(ns,10),
      distance:rawDist!==null&&inMeters ? rawDist/1000 : rawDist,
      affaib:parseFrNum(a['Perte']),
      reflect:parseFrNum(a['Réflectance']),
      pente:parseFrNum(a['Atténuation']),
      section:null,
      bilan:parseFrNum(a['Cumulé'])
    });
  });
  return evts.sort((a,b)=>a.num-b.num);
}

function mergeEXFOPages(pages){
  const reports=[];
  let cur=null;
  pages.forEach(p=>{
    if(p.hasMeta){ cur={...p,events:p.events||[]}; reports.push(cur); }
    else if(cur&&(p.events||[]).length){ cur.events=[...cur.events,...p.events]; }
  });
  return reports.length?reports:pages.filter(p=>(p.events||[]).length>0);
}

/* ================================================================
   PARSER PDF — VIAVI + EXFO (dispatch par page)
   ================================================================ */

function parsePDFPage(content){
  const text=content.items.map(i=>i.str).join(' ').replace(/\s+/g,' ');

  // ---- Format EXFO ----
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

  // ---- Format Viavi ----
  const get=(re)=>{ const m=text.match(re); return m?m[1].trim():null; };
  const cable     = get(/Nom Câble\s*:\s*(.*?)\s*Nom Fibre/);
  const fibre     = get(/Nom Fibre\s*:\s*(.*?)\s*(?:\bOrigine\b|\bR[eé]f\b|\bID\s+du\s+c[aâ]ble\b)/i)
                 || get(/Nom Fibre\s*:\s*(\S+)/);
  const origine   = get(/Origine\s*:\s*(.*?)\s*Extrémité/);
  const extremite = get(/Extrémité\s*:\s*(.*?)\s*(?:Réf|Opérateur|$)/);

  let laser=null,bilanTotal=null,orl=null,finFibre=null,nbEvt=null;
  if(origine&&extremite){
    const re=new RegExp('(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+'+_escapeRegex(origine)+'\\s*->\\s*'+_escapeRegex(extremite)+'\\s+(\\d+)');
    const m=text.match(re);
    if(m){ laser=+m[1]; bilanTotal=+m[2]; orl=+m[3]; finFibre=+m[4]; nbEvt=+m[5]; }
  }

  const COLS=['Evt','Distance','Affaib.','Réflect.','Pente','Section','Bilan'];
  const items=content.items.filter(i=>i.str.trim()!=='').map(i=>({
    str:i.str.trim(),x:i.transform[4],y:i.transform[5]
  }));
  const headerItems=items.filter(i=>COLS.includes(i.str));
  const events=[];
  if(headerItems.length>=4){
    // Regrouper par Y et prendre la ligne qui a le PLUS de colonnes correspondantes.
    // Évite de confondre la ligne "Résumé" (qui contient aussi Evt, Bilan)
    // avec la vraie ligne d'en-tête du tableau des événements.
    const yG={};
    headerItems.forEach(h=>{
      const k=Object.keys(yG).find(ky=>Math.abs(+ky-h.y)<2)||String(h.y);
      (yG[k]=yG[k]||[]).push(h);
    });
    let bestG=[];
    Object.values(yG).forEach(g=>{ if(g.length>bestG.length) bestG=g; });
    if(bestG.length<3) return {cable,fibre,origine,extremite,laser,bilanTotal,orl,finFibre,nbEvt,events,rawText:text};
    const headerY=bestG[0].y;
    const colX={};
    bestG.forEach(h=>{ colX[h.str]=h.x; });

    const dataItems=items.filter(i=>i.y<headerY-2&&!/^(m|dB|dB\/km)$/.test(i.str));
    const rows={};
    dataItems.forEach(it=>{
      const key=Object.keys(rows).find(k=>Math.abs(+k-it.y)<2);
      const k=key!==undefined?key:it.y;
      (rows[k]=rows[k]||[]).push(it);
    });

    const sortedCols=Object.keys(colX).sort((a,b)=>colX[a]-colX[b]);
    const colRanges={};
    sortedCols.forEach((col,idx)=>{
      const left =idx===0                    ?-Infinity:(colX[sortedCols[idx-1]]+colX[col])/2;
      const right=idx===sortedCols.length-1 ? Infinity:(colX[col]+colX[sortedCols[idx+1]])/2;
      colRanges[col]=[left,right];
    });
    const pn=s=>{ if(!s) return null; const v=parseFloat(s.replace(/[~\s]+/g,'')); return isNaN(v)?null:v; };
    Object.keys(rows).map(Number).sort((a,b)=>b-a).forEach(y=>{
      const row={};
      rows[y].forEach(it=>{
        const col=sortedCols.find(c=>it.x>=colRanges[c][0]&&it.x<colRanges[c][1]);
        if(col) row[col]=row[col]?row[col]+' '+it.str:it.str;
      });
      if(row['Evt']!==undefined){
        events.push({
          num:parseInt(row['Evt'],10),
          distance:pn(row['Distance']),
          affaib:pn(row['Affaib.']),
          reflect:pn(row['Réflect.']),
          pente:pn(row['Pente']),
          section:pn(row['Section']),
          bilan:pn(row['Bilan'])
        });
      }
    });
  }
  return {cable,fibre,origine,extremite,laser,bilanTotal,orl,finFibre,nbEvt,events,rawText:text};
}

async function parsePDF(arrayBuffer){
  const pdf=await pdfjsLib.getDocument({data:arrayBuffer}).promise;
  const pages=[];
  for(let p=1;p<=pdf.numPages;p++){
    try{
      const page=await pdf.getPage(p);
      const content=await page.getTextContent();
      const parsed=parsePDFPage(content);
      if(parsed.cable||parsed.fibre||parsed.isEXFO||parsed.events.length) pages.push(parsed);
    }catch(e){ console.error('Erreur parsing page '+p+':',e); }
  }
  if(pages.length&&pages.some(p=>p.isEXFO)) return mergeEXFOPages(pages);
  // Dédupliquer les pages identiques (Viavi SmartOTDR répète chaque fibre 3-4x dans le PDF)
  const seen=new Set();
  return pages.filter(p=>{
    const k=(p.fibre||'')+'|'+(p.cable||'')+'|'+(p.origine||'')+'|'+(p.extremite||'');
    if(seen.has(k)) return false;
    seen.add(k); return true;
  });
}

/* ================================================================
   PARSER EXCEL
   ================================================================ */

function excelSerialToDate(serial){
  if(typeof serial!=='number'||!isFinite(serial)) return null;
  const d=new Date(Math.round((serial-25569)*86400*1000));
  return isNaN(d.getTime())?null:d;
}
function normHeader(h){ return (h||'').toString().trim().replace(/\s+/g,' ').toUpperCase(); }
function findExcelCol(headers,candidates){
  for(const c of candidates){ const i=headers.findIndex(h=>normHeader(h)===normHeader(c)); if(i>=0) return i; }
  for(const c of candidates){ const i=headers.findIndex(h=>normHeader(h).includes(normHeader(c))); if(i>=0) return i; }
  return -1;
}
function parseDegradation(raw){
  if(raw==null||raw==='') return null;
  const parts=raw.toString().split('/').map(s=>parseFloat(s.trim())).filter(n=>isFinite(n));
  return parts.length?Math.max(...parts):null;
}
function computeEtat(etatRaw,distNum,equipRaw){
  const e=normHeader(etatRaw);
  const equip=(equipRaw||'').toString().trim();
  const hasEquip=equip&&!/^N\/?A$/i.test(equip);
  const hasDistance=isFinite(distNum)&&distNum>0;
  if(e.includes('OCCUP')||hasEquip||!hasDistance) return 'OCCUPE';
  if(e.includes('MAUVAIS')) return 'MAUVAIS';
  if(e.includes('LIBRE')) return 'LIBRE';
  return e||null;
}
function parseExcelSheet(sheet){
  const rows=XLSX.utils.sheet_to_json(sheet,{header:1,raw:true,defval:null});
  if(!rows.length) return null;
  const headers=rows[0];
  const col={
    site:findExcelCol(headers,['SITE']),
    section:findExcelCol(headers,['SECTION OPTIQUE','SECTION']),
    port:findExcelCol(headers,['PORT']),
    distance:findExcelCol(headers,['DISTANCE OPTIQUE (M)','DISTANCE OPTIQUE','DISTANCE']),
    etat:findExcelCol(headers,['ETAT FO (LIBRE / OCCUPE / MAUVAIS)','ETAT FO','ETAT']),
    equip:findExcelCol(headers,['NOM EQUIPEMENT','EQUIPEMENT']),
    degrad:findExcelCol(headers,['DEGRADATION/DB','DEGRADATION','D&#201;GRADATION']),
  };
  if(col.port<0) return null;
  const events=[];
  let occupiedCount=0,cableLabel=null;
  for(let r=1;r<rows.length;r++){
    const row=rows[r];
    if(!row||row.every(c=>c===null||c==='')) continue;
    const get=(i)=>i>=0?row[i]:null;
    const portVal=get(col.port);
    if(portVal===null||portVal==='') continue;
    if(!cableLabel) cableLabel=(get(col.section)||get(col.site)||'').toString().trim()||null;
    const distRaw=get(col.distance);
    const distNum=typeof distRaw==='number'?distRaw:parseFloat(distRaw);
    const hasDistance=isFinite(distNum)&&distNum>0;
    const etat=computeEtat(get(col.etat),hasDistance?distNum:NaN,get(col.equip));
    if(etat==='OCCUPE'||!hasDistance){ occupiedCount++; continue; }
    events.push({
      num:isFinite(parseFloat(portVal))?parseFloat(portVal):portVal.toString(),
      distance:distNum,affaib:parseDegradation(get(col.degrad)),
      reflect:null,pente:null,bilan:null,etat
    });
  }
  if(!events.length) return null;
  events.sort((a,b)=>{
    const na=typeof a.num==='number'?a.num:parseFloat(a.num);
    const nb=typeof b.num==='number'?b.num:parseFloat(b.num);
    return (isFinite(na)&&isFinite(nb))?na-nb:String(a.num).localeCompare(String(b.num));
  });
  return {
    cable:cableLabel,fibre:events.length+' port(s)',
    origine:null,extremite:null,
    finFibre:Math.max(...events.map(e=>e.distance)),
    bilanTotal:null,orl:null,events,occupiedCount,source:'xlsx'
  };
}
async function parseExcelWorkbook(arrayBuffer){
  const wb=XLSX.read(arrayBuffer,{type:'array',cellDates:false});
  const out=[];
  wb.SheetNames.forEach(name=>{
    try{ const m=parseExcelSheet(wb.Sheets[name]); if(m) out.push(m); }
    catch(e){ console.error('Erreur parsing feuille '+name+':',e); }
  });
  return out;
}

/* ================================================================
   PARSER KML / KMZ
   ================================================================ */

function parseKML(text,sourceName,sourceType){
  const doc=new DOMParser().parseFromString(text,'text/xml');
  const placemarks=doc.getElementsByTagName('Placemark');
  const sections=[],points=[];
  function parseDesc(pm){
    const descEl=pm.getElementsByTagName('description')[0];
    if(!descEl) return {};
    const meta={};
    (descEl.textContent||'').replace(/&#x0A;/gi,'\n').replace(/&#xA;/gi,'\n')
      .split('\n').forEach(line=>{
        const idx=line.indexOf('=');
        if(idx>0){ const k=line.slice(0,idx).trim(); const v=line.slice(idx+1).trim(); if(k) meta[k]=v; }
      });
    return meta;
  }
  function getName(pm){
    const el=pm.getElementsByTagName('name')[0]||pm.getElementsByTagName('n')[0];
    return el?el.textContent.trim():'(sans nom)';
  }
  const seenCoords=new Set();
  for(let i=0;i<placemarks.length;i++){
    const pm=placemarks[i];
    const name=getName(pm);
    const styleUrlEl=pm.getElementsByTagName('styleUrl')[0];
    const styleUrl=styleUrlEl?styleUrlEl.textContent.trim():'';
    const line=pm.getElementsByTagName('LineString')[0];
    const point=pm.getElementsByTagName('Point')[0];
    const polygon=pm.getElementsByTagName('Polygon')[0];
    if(line){
      const coordEl=line.getElementsByTagName('coordinates')[0];
      if(!coordEl) continue;
      const coords=coordEl.textContent.trim().split(/\s+/).filter(Boolean).map(c=>{
        const parts=c.split(','); return [+parts[1],+parts[0]];
      });
      if(coords.length<2) continue;
      const len=_lineLength(coords);
      let endA=null,endB=null,type=null;
      const cleaned=name.replace(/\(FIBER\)\s*$/,'');
      const isFiber=name.endsWith('(FIBER)');
      const parts=cleaned.split('-');
      const tIdx=parts.findIndex(p=>p.startsWith('TRENCH'));
      if(tIdx>=1){ endA=parts[0]; endB=parts[1]; type=parts.slice(tIdx).join('-')+(isFiber?'(FIBER)':''); }
      sections.push({id:sourceName+'_S'+sections.length,name,endA,endB,type,coords,length:len,source:sourceName});
    } else if(point){
      const coordEl=point.getElementsByTagName('coordinates')[0];
      if(!coordEl) continue;
      const parts=coordEl.textContent.trim().split(',');
      const lon=+parts[0],lat=+parts[1];
      if(isNaN(lat)||isNaN(lon)) continue;
      const coordKey=lat.toFixed(5)+','+lon.toFixed(5);
      if(seenCoords.has(coordKey)) continue;
      seenCoords.add(coordKey);
      let category='other';
      if(styleUrl==='#Site Style'||sourceType==='bts') category='bts';
      else if(/\sJ\d+$/.test(name)) category='joint';
      else if(/_[A-Z]_\d+$/.test(name)) category='chamber';
      points.push({id:sourceName+'_P'+points.length,name,lat,lon,category,source:sourceName});
    } else if(polygon){
      const meta=parseDesc(pm);
      const btsLat=parseFloat(meta['LATITUDE']);
      const btsLon=parseFloat(meta['LONGITUDE']);
      const siteName=meta['NOM SITE']||meta['NOM_SITE']||name;
      if(!isNaN(btsLat)&&!isNaN(btsLon)){
        const coordKey=btsLat.toFixed(5)+','+btsLon.toFixed(5);
        if(!seenCoords.has(coordKey)){
          seenCoords.add(coordKey);
          points.push({id:sourceName+'_P'+points.length,name:siteName,lat:btsLat,lon:btsLon,category:'bts',source:sourceName});
        }
      }
    }
  }
  return {sections,points};
}

/* ================================================================
   EXPOSITION GLOBALE
   ================================================================ */
window.parsePDF           = parsePDF;
window.parseExcelWorkbook = parseExcelWorkbook;
window.parseKML           = parseKML;
