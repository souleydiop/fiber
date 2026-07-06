/* ============================================================
   OSP MANAGER — PARSER (Couche 1)
   Lecture PDF (OTDR Viavi / EXFO), KML/KMZ, Excel.
   Aucune dépendance : DOM, Leaflet, AppState.
   Exposition : window.parsePDF  window.parseExcelWorkbook  window.parseKML

   La logique pure (parsing texte, tableaux OTDR, catégorisation
   KML) vit dans parser-logic.js et est testée avec `node --test`
   sans dépendre de pdf.js ni du DOMParser du navigateur.
   ============================================================ */

import * as pdfjsLib from './pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

import {
  parsePDFPage, mergeEXFOPages,
  excelSerialToDate, normHeader, findExcelCol, parseDegradation, computeEtat,
  detectPointCategory, parseSectionName, lineLength
} from './parser-logic.js';

/* ================================================================
   PARSER PDF — dispatch page par page
   ================================================================ */
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
  // Fichier composé uniquement de points (aucun tracé) : très probablement
  // un fichier de sites (ex. export Maps.me avec styles #placemark-*).
  const isPointOnlyFile=doc.getElementsByTagName('LineString').length===0;
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
      const len=lineLength(coords);
      const {endA,endB,type}=parseSectionName(name);
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
      const category=detectPointCategory(name,styleUrl,sourceType,isPointOnlyFile);
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
