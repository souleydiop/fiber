import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseFrNum, parseEXFOMeta, parseEXFOEvents, mergeEXFOPages, parsePDFPage,
  excelSerialToDate, normHeader, findExcelCol, parseDegradation, computeEtat,
  detectPointCategory, parseSectionName, haversine, lineLength
} from '../parser-logic.js';

/* ---- parseFrNum ---- */
test('parseFrNum() gère la virgule décimale française', ()=>{
  assert.equal(parseFrNum('1,25'), 1.25);
  assert.equal(parseFrNum('---'), null);
  assert.equal(parseFrNum(''), null);
  assert.equal(parseFrNum('>0,003'), 0.003);
});

/* ---- parseEXFOMeta ---- */
test('parseEXFOMeta() extrait câble/origine/extrémité/longueur/pertes', ()=>{
  const text=`ID du câble : CBL-42 Emplacement A Emplacement B Emplacement DAKAR THIES Opérateur X `+
              `Longueur de la section : 11.5447 km Perte de la section : 3,21 dB ORL de la section : <-42,5 dB`;
  const meta=parseEXFOMeta(text);
  assert.equal(meta.cable,'CBL-42');
  assert.equal(meta.origine,'DAKAR');
  assert.equal(meta.extremite,'THIES');
  assert.equal(meta.finFibre,11.5447);
  assert.equal(meta.bilanTotal,3.21);
  assert.equal(meta.orl,-42.5);
  assert.equal(meta.hasMeta,true);
});

test('parseEXFOMeta() convertit une longueur en mètres vers km', ()=>{
  const text=`ID du câble : CBL-1 Longueur de la section : 20 313,9 m`;
  const meta=parseEXFOMeta(text);
  assert.ok(Math.abs(meta.finFibre-20.3139)<1e-6);
});

test('parseEXFOMeta() hasMeta=false sans données', ()=>{
  const meta=parseEXFOMeta('texte sans rapport');
  assert.equal(meta.hasMeta,false);
});

/* ---- Excel helpers ---- */
test('excelSerialToDate() convertit un numéro de série Excel', ()=>{
  const d=excelSerialToDate(45000);
  assert.ok(d instanceof Date);
  assert.equal(excelSerialToDate(NaN),null);
  assert.equal(excelSerialToDate('abc'),null);
});

test('normHeader() normalise espaces et casse', ()=>{
  assert.equal(normHeader('  Etat   FO  '),'ETAT FO');
  assert.equal(normHeader(null),'');
});

test('findExcelCol() trouve par correspondance exacte puis partielle', ()=>{
  const headers=['SITE','ETAT FO (LIBRE / OCCUPE / MAUVAIS)','PORT'];
  assert.equal(findExcelCol(headers,['PORT']),2);
  assert.equal(findExcelCol(headers,['ETAT FO']),1); // partiel
  assert.equal(findExcelCol(headers,['INEXISTANT']),-1);
});

test('parseDegradation() prend le max des valeurs séparées par /', ()=>{
  assert.equal(parseDegradation('0.12/0.34'),0.34);
  assert.equal(parseDegradation(''),null);
  assert.equal(parseDegradation(null),null);
});

test('computeEtat() priorise OCCUPE si équipement présent', ()=>{
  assert.equal(computeEtat('LIBRE',100,'ROUTEUR-X'),'OCCUPE');
});
test('computeEtat() OCCUPE si pas de distance valide', ()=>{
  assert.equal(computeEtat('LIBRE',NaN,'N/A'),'OCCUPE');
});
test('computeEtat() MAUVAIS et LIBRE détectés', ()=>{
  assert.equal(computeEtat('MAUVAIS ETAT',100,'N/A'),'MAUVAIS');
  assert.equal(computeEtat('LIBRE',100,'N/A'),'LIBRE');
});

/* ---- KML : catégorisation ---- */
test('detectPointCategory() reconnaît le style officiel Site Style', ()=>{
  assert.equal(detectPointCategory('DAKAR01','#Site Style','fiber',false),'bts');
});
test('detectPointCategory() reconnaît sourceType=bts forcé', ()=>{
  assert.equal(detectPointCategory('DAKAR01','#placemark-red','bts',false),'bts');
});
test('detectPointCategory() reconnaît un joint via le motif " J<num>"', ()=>{
  assert.equal(detectPointCategory('CABLE-X J12','#placemark-blue','fiber',false),'joint');
});
test('detectPointCategory() reconnaît une chambre via le motif "_LETTRE_num"', ()=>{
  assert.equal(detectPointCategory('SEG_A_01','#placemark-blue','fiber',false),'chamber');
});
test('detectPointCategory() classe en bts un fichier ne contenant que des points (ex. Maps.me)', ()=>{
  assert.equal(detectPointCategory('A08_DIOURBEL','#placemark-red','fiber',true),'bts');
});
test('detectPointCategory() classe en other si mélangé à des sections et sans motif', ()=>{
  assert.equal(detectPointCategory('A08_DIOURBEL','#placemark-red','fiber',false),'other');
});

/* ---- KML : nom de section ---- */
test('parseSectionName() extrait endA/endB/type pour un nom TRENCH', ()=>{
  const r=parseSectionName('SITEA-SITEB-TRENCH-1(FIBER)');
  assert.equal(r.endA,'SITEA');
  assert.equal(r.endB,'SITEB');
  assert.ok(r.type.startsWith('TRENCH-1'));
  assert.ok(r.type.endsWith('(FIBER)'));
});
test('parseSectionName() renvoie des nulls si pas de TRENCH', ()=>{
  const r=parseSectionName('NOM_QUELCONQUE');
  assert.equal(r.endA,null);
  assert.equal(r.endB,null);
  assert.equal(r.type,null);
});

/* ---- géométrie ---- */
test('haversine()/lineLength() cohérents avec logic.js', ()=>{
  assert.equal(haversine(0,0,0,0),0);
  assert.ok(lineLength([[0,0],[0,0.01],[0,0.02]])>0);
});

/* ---- parsePDFPage : format EXFO ---- */
function makeItem(str,x,y){ return {str,transform:[1,0,0,1,x,y]}; }

test('parsePDFPage() détecte un rapport EXFO et retourne isEXFO=true', ()=>{
  const content={items:[
    ...'ID du câble : CBL-1 Emplacement A Emplacement B Emplacement DAKAR THIES Opérateur X'
      .split(' ').map((w,i)=>makeItem(w,i*10,100)),
  ]};
  const parsed=parsePDFPage(content);
  assert.equal(parsed.isEXFO,true);
  assert.equal(parsed.cable,'CBL-1');
});

test('parsePDFPage() retourne un objet Viavi (isEXFO absent) sans marqueurs EXFO', ()=>{
  const content={items:[makeItem('Nom',0,0),makeItem('Câble',20,0),makeItem(':',40,0),makeItem('CBL-9',60,0),makeItem('Nom',80,0),makeItem('Fibre',100,0)]};
  const parsed=parsePDFPage(content);
  assert.equal(parsed.isEXFO,undefined);
});

/* ---- mergeEXFOPages ---- */
test('mergeEXFOPages() regroupe les pages d\'événements sous la page de métadonnées', ()=>{
  const pages=[
    {hasMeta:true,events:[{num:1}]},
    {hasMeta:false,events:[{num:2}]},
    {hasMeta:true,events:[{num:3}]},
  ];
  const merged=mergeEXFOPages(pages);
  assert.equal(merged.length,2);
  assert.equal(merged[0].events.length,2); // page 1 + page 2 fusionnées
  assert.equal(merged[1].events.length,1);
});

test('mergeEXFOPages() repli sur les pages avec événements si aucune n\'a hasMeta', ()=>{
  const pages=[{hasMeta:false,events:[{num:1}]},{hasMeta:false,events:[]}];
  const merged=mergeEXFOPages(pages);
  assert.equal(merged.length,1);
});
