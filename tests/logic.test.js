import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeRegex, norm, fmtNum, fmtLen, haversine, lineLength, interpolateAlong,
  isAnomalyEvent, chainSectionsByGPS, placeEventsOnChain, placeEventsOnRoute,
  sampleChainWaypoints
} from '../logic.js';

test('norm() met en majuscule et retire la ponctuation/espaces', ()=>{
  assert.equal(norm('site-A_01 (Dakar)'), 'SITEA01DAKAR');
  assert.equal(norm(''), '');
  assert.equal(norm(null), '');
});

test('escapeRegex() échappe les caractères spéciaux regex', ()=>{
  const re=new RegExp(escapeRegex('A.B*C?'));
  assert.ok(re.test('A.B*C?'));
  assert.ok(!re.test('AxByCz'));
});

test('fmtNum() formate ou retourne — si invalide', ()=>{
  assert.equal(fmtNum(3.14159,2), '3.14');
  assert.equal(fmtNum(null), '—');
  assert.equal(fmtNum(undefined), '—');
  assert.equal(fmtNum(NaN), '—');
});

test('fmtLen() bascule en km au-delà de 1000m', ()=>{
  assert.equal(fmtLen(500), '500 m');
  assert.equal(fmtLen(1500), '1.500 km');
  assert.equal(fmtLen(null), '—');
});

test('haversine() donne ~0 pour un point identique', ()=>{
  assert.equal(haversine(14.6,-17.4,14.6,-17.4), 0);
});

test('haversine() Dakar → Thiès ~ 50-65 km', ()=>{
  // Dakar (14.6928,-17.4467) → Thiès (14.7910,-16.9359)
  const d=haversine(14.6928,-17.4467,14.7910,-16.9359);
  assert.ok(d>50000&&d<65000, `distance inattendue: ${d}`);
});

test('lineLength() additionne les segments consécutifs', ()=>{
  const coords=[[0,0],[0,0.01],[0,0.02]]; // 2 segments égaux
  const total=lineLength(coords);
  const seg=haversine(0,0,0,0.01);
  assert.ok(Math.abs(total-seg*2)<1e-6);
});

test('lineLength() vaut 0 pour un seul point', ()=>{
  assert.equal(lineLength([[0,0]]), 0);
});

test('interpolateAlong() retourne le point de départ à distance 0', ()=>{
  const coords=[[0,0],[0,0.02]];
  const [lat,lon]=interpolateAlong(coords,0);
  assert.ok(Math.abs(lat-0)<1e-9 && Math.abs(lon-0)<1e-9);
});

test('interpolateAlong() retourne le dernier point si distance dépasse la ligne', ()=>{
  const coords=[[0,0],[0,0.01]];
  const total=lineLength(coords);
  const [lat,lon]=interpolateAlong(coords,total*10);
  assert.ok(Math.abs(lat-0)<1e-9 && Math.abs(lon-0.01)<1e-9);
});

test('isAnomalyEvent() ignore les événements d\'extrémité', ()=>{
  const m={events:[{},{},{}]};
  assert.equal(isAnomalyEvent({num:1,affaib:5,reflect:0},m), false);
  assert.equal(isAnomalyEvent({num:3,affaib:5,reflect:0},m), false); // dernier évt = extrémité
});

test('isAnomalyEvent() détecte une atténuation trop forte', ()=>{
  const m={events:[{},{},{}]};
  assert.equal(isAnomalyEvent({num:2,affaib:0.5,reflect:null},m), true);
});

test('isAnomalyEvent() détecte une réflectance trop forte', ()=>{
  const m={events:[{},{},{}]};
  assert.equal(isAnomalyEvent({num:2,affaib:0.1,reflect:-20},m), true);
});

test('isAnomalyEvent() ok si rien d\'anormal', ()=>{
  const m={events:[{},{},{}]};
  assert.equal(isAnomalyEvent({num:2,affaib:0.1,reflect:-40},m), false);
});

test('chainSectionsByGPS() enchaîne deux sections bout à bout', ()=>{
  const sections=[
    {id:'S1',coords:[[0,0],[0,0.01]],length:1},
    {id:'S2',coords:[[0,0.01],[0,0.02]],length:1}
  ];
  const chain=chainSectionsByGPS(sections,[0,0],[0,0.02],50);
  assert.ok(chain);
  assert.equal(chain.length,2);
  assert.equal(chain[0].section.id,'S1');
  assert.equal(chain[1].section.id,'S2');
});

test('chainSectionsByGPS() retourne null si origine trop loin', ()=>{
  const sections=[{id:'S1',coords:[[0,0],[0,0.01]],length:1}];
  const chain=chainSectionsByGPS(sections,[10,10],[0,0.01],50);
  assert.equal(chain,null);
});

test('chainSectionsByGPS() retourne null sans section', ()=>{
  assert.equal(chainSectionsByGPS([],[0,0],[0,1],50), null);
});

test('placeEventsOnChain() place un événement dans la bonne section', ()=>{
  const chain=[
    {section:{coords:[[0,0],[0,0.01]],length:1000,name:'S1'},reversed:false},
    {section:{coords:[[0,0.01],[0,0.02]],length:1000,name:'S2'},reversed:false}
  ];
  const placed=placeEventsOnChain(chain,[{distance:1500}]);
  assert.equal(placed[0].secName,'S2');
});

test('placeEventsOnRoute() interpole sur une polyligne', ()=>{
  const route=[[0,0],[0,0.01]];
  const placed=placeEventsOnRoute(route,[{distance:0}]);
  assert.ok(Math.abs(placed[0].pos[0]-0)<1e-9);
});

test('sampleChainWaypoints() échantillonne un chemin long', ()=>{
  const chain=[{section:{coords:[[0,0],[0,0.5]]},reversed:false}];
  const pts=sampleChainWaypoints(chain,8000,40);
  assert.ok(pts.length>=1);
  assert.ok(pts.length<=40);
});
