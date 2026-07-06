/* ============================================================
   OSP MANAGER — LOGIC (fonctions pures, testables sans DOM)
   Extrait de engine.js pour permettre les tests unitaires
   (node --test) sans navigateur. Ne dépend ni du DOM, ni de
   window/AppState, ni d'IndexedDB. engine.js importe ces
   fonctions et les réexpose sur window pour rester compatible
   avec map.js et index.html.
   ============================================================ */

export function escapeRegex(s){ return s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }

export function norm(t){ return (t||'').toUpperCase().replace(/[^A-Z0-9]/g,''); }

export function fmtNum(n,d=1){ return (n===null||n===undefined||isNaN(n))?'—':Number(n).toFixed(d); }

export function fmtLen(m){
  if(m===null||m===undefined||isNaN(m)) return '—';
  return m>=1000?(m/1000).toFixed(3)+' km':Math.round(m)+' m';
}

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

export function interpolateAlong(coords,targetLen){
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

export function isAnomalyEvent(ev,m){
  const isEndpoint=ev.num===1||ev.num===(m.nbEvt||m.events?.length);
  if(isEndpoint) return false;
  const badAffaib=ev.affaib!==null&&ev.affaib>0.3;
  const badReflect=ev.reflect!==null&&ev.reflect>-35;
  return badAffaib||badReflect;
}

export function chainSectionsByGPS(sections,originCoord,destCoord,maxGapM){
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

export function placeEventsOnChain(chain,events){
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

export function placeEventsOnRoute(routeCoords,events){
  return (events||[]).map(ev=>({...ev,pos:interpolateAlong(routeCoords,ev.distance)}));
}

export function sampleChainWaypoints(chain,stepM=8000,maxPoints=40){
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
