/* ============================================================
   OSP MANAGER — PARSER LOGIC (fonctions pures, testables)
   Extrait de parser.js. Ne dépend ni du DOM (DOMParser), ni de
   pdf.js, ni de XLSX — uniquement du JS pur. Permet de tester
   la logique d'extraction (PDF OTDR, Excel, catégorisation KML)
   avec node --test, sans navigateur.
   ============================================================ */

export function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

export function haversine(lat1,lon1,lat2,lon2){
  const R=6371000,toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1),dLon=toRad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

export function lineLength(coords){
  let d=0;
  for(let i=1;i<coords.length;i++) d+=haversine(coords[i-1][0],coords[i-1][1],coords[i][0],coords[i][1]);
  return d;
}

/* ---- PDF OTDR (EXFO + Viavi) ---- */

export function parseFrNum(s){
  if(!s||s==='---') return null;
  const v=parseFloat(s.replace(/>/g,'').replace(/\s+/g,'').replace(',','.'));
  return isNaN(v)?null:v;
}

export function parseEXFOMeta(text){
  function get(re){ const m=text.match(re); return m?m[1].trim():null; }
  const cable=get(/ID du c[aâ]ble\s*:\s*(\S+)/);
  const fibre=get(/ID de la fibre\s*:\s*(\S+)/);
  let origine=null,extremite=null;
  const em=text.match(/Emplacement\s+A\s+Emplacement\s+B\s+Emplacement\s+(\S+)\s+(.*?)\s+Op[eé]rateur/i);
  if(em){ origine=em[1]; extremite=em[2].trim(); }
  let finFibre=parseFrNum(get(/Longueur de la section\s*:\s*([\d.]+)\s*km/));
  if(finFibre===null){
    const mVal=parseFrNum(get(/Longueur de la section\s*:\s*([\d\s,]+)\s*m(?!\w)/));
    if(mVal!==null) finFibre=mVal/1000;
  }
  const bilanTotal=parseFrNum(get(/Perte de la section\s*:\s*([\d,.]+)\s*dB/));
  const orl=parseFrNum(get(/ORL de la section\s*:\s*<?(-?[\d,.]+)\s*dB/));
  return {cable,fibre,origine,extremite,finFibre,bilanTotal,orl,distanceUnit:'km',hasMeta:!!(cable||origine||finFibre)};
}

export function parseEXFOEvents(content){
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

  const posItem=bestG.find(h=>h.str.startsWith('Pos./'));
  let inMeters=false;
  if(posItem){
    if(/\(m\)|\(km\)/.test(posItem.str)){
      inMeters=/\(m\)/.test(posItem.str)&&!/\(km\)/.test(posItem.str);
    } else {
      const candidates=items.filter(i=>
        (i.str==='(m)'||i.str==='(km)')&&
        i.y<posItem.y&&i.y>=posItem.y-25&&
        Math.abs(i.x-posItem.x)<60
      );
      if(candidates.length){
        candidates.sort((a,b)=>
          Math.hypot(a.x-posItem.x,a.y-posItem.y)-Math.hypot(b.x-posItem.x,b.y-posItem.y)
        );
        inMeters=candidates[0].str==='(m)';
      }
    }
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
      distance:rawDist!==null ? (inMeters ? rawDist : rawDist*1000) : null,
      affaib:parseFrNum(a['Perte']),
      reflect:parseFrNum(a['Réflectance']),
      pente:parseFrNum(a['Atténuation']),
      section:null,
      bilan:parseFrNum(a['Cumulé'])
    });
  });
  return evts.sort((a,b)=>a.num-b.num);
}

export function mergeEXFOPages(pages){
  const reports=[];
  let cur=null;
  pages.forEach(p=>{
    if(p.hasMeta){ cur={...p,events:p.events||[]}; reports.push(cur); }
    else if(cur&&(p.events||[]).length){ cur.events=[...cur.events,...p.events]; }
  });
  return reports.length?reports:pages.filter(p=>(p.events||[]).length>0);
}

export function parsePDFPage(content){
  const text=content.items.map(i=>i.str).join(' ').replace(/\s+/g,' ');

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

  const get=(re)=>{ const m=text.match(re); return m?m[1].trim():null; };
  const cable     = get(/Nom Câble\s*:\s*(.*?)\s*Nom Fibre/);
  const fibre     = get(/Nom Fibre\s*:\s*(.*?)\s*(?:\bOrigine\b|\bR[eé]f\b|\bID\s+du\s+c[aâ]ble\b)/i)
                 || get(/Nom Fibre\s*:\s*(\S+)/);
  const origine   = get(/Origine\s*:\s*(.*?)\s*Extrémité/);
  const extremite = get(/Extrémité\s*:\s*(.*?)\s*(?:Réf|Opérateur|$)/);

  let laser=null,bilanTotal=null,orl=null,finFibre=null,nbEvt=null;
  if(origine&&extremite){
    const re=new RegExp('(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+'+escapeRegex(origine)+'\\s*->\\s*'+escapeRegex(extremite)+'\\s+(\\d+)');
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
    const yG={};
    headerItems.forEach(h=>{
      const k=Object.keys(yG).find(ky=>Math.abs(+ky-h.y)<2)||String(h.y);
      (yG[k]=yG[k]||[]).push(h);
    });
    let bestG=[];
    Object.values(yG).forEach(g=>{ if(g.length>bestG.length) bestG=g; });
    if(bestG.length<3) return {cable,fibre,origine,extremite,laser,bilanTotal,orl,finFibre,nbEvt,distanceUnit:'m',events,rawText:text};
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
  return {cable,fibre,origine,extremite,laser,bilanTotal,orl,finFibre,nbEvt,distanceUnit:'m',events,rawText:text};
}

/* ---- Excel ---- */

export function excelSerialToDate(serial){
  if(typeof serial!=='number'||!isFinite(serial)) return null;
  const d=new Date(Math.round((serial-25569)*86400*1000));
  return isNaN(d.getTime())?null:d;
}
export function normHeader(h){ return (h||'').toString().trim().replace(/\s+/g,' ').toUpperCase(); }
export function findExcelCol(headers,candidates){
  for(const c of candidates){ const i=headers.findIndex(h=>normHeader(h)===normHeader(c)); if(i>=0) return i; }
  for(const c of candidates){ const i=headers.findIndex(h=>normHeader(h).includes(normHeader(c))); if(i>=0) return i; }
  return -1;
}
export function parseDegradation(raw){
  if(raw==null||raw==='') return null;
  const parts=raw.toString().split('/').map(s=>parseFloat(s.trim())).filter(n=>isFinite(n));
  return parts.length?Math.max(...parts):null;
}
export function computeEtat(etatRaw,distNum,equipRaw){
  const e=normHeader(etatRaw);
  const equip=(equipRaw||'').toString().trim();
  const hasEquip=equip&&!/^N\/?A$/i.test(equip);
  const hasDistance=isFinite(distNum)&&distNum>0;
  if(e.includes('OCCUP')||hasEquip||!hasDistance) return 'OCCUPE';
  if(e.includes('MAUVAIS')) return 'MAUVAIS';
  if(e.includes('LIBRE')) return 'LIBRE';
  return e||null;
}

/* ---- KML : catégorisation des points ----
   Un point est un site BTS si son style KML est '#Site Style'
   (export "officiel"), si sourceType='bts' est imposé à l'import,
   ou — cas des exports Maps.me/tiers qui utilisent d'autres styles
   (#placemark-red, etc.) — si le fichier ne contient QUE des points
   (aucune section/LineString), auquel cas on suppose un fichier de
   sites. Sinon, les motifs de nommage détectent joint/chambre. */
export function detectPointCategory(name,styleUrl,sourceType,isPointOnlyFile){
  if(styleUrl==='#Site Style'||sourceType==='bts') return 'bts';
  if(/\sJ\d+$/.test(name)) return 'joint';
  if(/_[A-Z]_\d+$/.test(name)) return 'chamber';
  if(isPointOnlyFile) return 'bts';
  return 'other';
}

/* ---- KML : nom de section (TRENCH) ---- */
export function parseSectionName(name){
  const cleaned=name.replace(/\(FIBER\)\s*$/,'');
  const isFiber=name.endsWith('(FIBER)');
  const parts=cleaned.split('-');
  const tIdx=parts.findIndex(p=>p.startsWith('TRENCH'));
  if(tIdx>=1){
    return {endA:parts[0],endB:parts[1],type:parts.slice(tIdx).join('-')+(isFiber?'(FIBER)':'')};
  }
  return {endA:null,endB:null,type:null};
}
