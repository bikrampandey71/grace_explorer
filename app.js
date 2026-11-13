/* GRACE Explorer. Static data arrives only as classic JavaScript files.
   No fetch(), XHR, module imports, or local web server required. */
'use strict';
const $=id=>document.getElementById(id);
const M=window.GRACE_MANIFEST, R=window.GRACE_REGION_SERIES, B=window.GRACE_BOUNDARIES;
const MONTHS=['January','February','March','April','May','June','July','August','September','October','November','December'];
const ORDER=['tws_m','tws_m_1km','obs_m','csr','gsfc','jpl'];
const SERIES_COLORS={tws_m:'#64cbed',tws_m_1km:'#9ce5a9',obs_m:'#ffc36f',csr:'#ae8ff2',gsfc:'#80e2aa',jpl:'#ff8594'};
const HELP={
 none:'Show basemap without a GRACE raster layer.',
 tws_m:'CSR–GSFC–JPL downscaled ensemble mean (0.05° grid).',
 tws_m_1km:'Thailand-only downscaled ensemble mean on a nominal 1-km grid (tws_m).',
 obs_m:'Original mascon ensemble interpolated to 0.05°.',
 csr:'CSR RL06.3 mascon · UT Austin · 0.25° grid.',
 gsfc:'GSFC RL06v2.0 mascon · NASA Goddard · 0.5° grid.',
 jpl:'JPL RL06.3Mv04 mascon · NASA JPL · 0.5° grid.'
};
const st={map:null,base:{},overlay:null,regions:null,level2Regions:null,boundaryLayers:new Map(),previousBoundary:null,
    month:0,layer:'tws_m',region:'footprint',playing:false,timer:null,chartOpen:false,
    series:{tws_m:true,tws_m_1km:true,obs_m:true,csr:false,gsfc:false,jpl:false},
    colorMin:-50,colorMax:50,fieldCache:new Map(),fieldPending:new Map(),
    overlayToken:0,overlayLayer:null,plotReady:false,lut:null,lutKey:null,showTrend:false,footprint:null,regionalRenderToken:0,activeTab:"time",analysisOrigin:'technical',publicOpen:false,publicSeries:Object.fromEntries(ORDER.map(k=>[k,true])),publicTrend:true};
function friendly(date){const [y,m]=date.split('-').map(Number);return `${MONTHS[m-1]} ${y}`;}
function pretty(x,n=2){return Number.isFinite(x)?Number(x).toFixed(n):'—';}
function say(message){const n=$('toast');n.textContent=message;n.classList.add('show');clearTimeout(say.t);say.t=setTimeout(()=>n.classList.remove('show'),3000);}
function has(layer,i){return (M.available[layer]||[]).includes(M.dates[i]);}
const REGION_BY_ID=new Map((M?.regions||[]).map(r=>[r.id,r]));
function region(id){return REGION_BY_ID.get(id);}
function monthPath(layer,date){return `data/maps/${layer}/${date.slice(0,4)}/${date}.webp`; }
function boundsFor(layer){const b=M.bounds[layer];return b?[[b[0],b[1]],[b[2],b[3]]]:null;}
// Bound the interactive timeline to REAL observed dates, not a future calendar year.
// Existing V18 sites can use this without rebuilding the NetCDF archive.
function trimTimelineToObservations(){
 const preferred=[...(M.available.tws_m||[]),...(M.available.tws_m_1km||[]),...(M.available.obs_m||[])].sort();
 const all=preferred.length?preferred:Object.values(M.available||{}).flat().sort();
 if(!all.length)return;
 const begin=Math.max(0,M.dates.indexOf(all[0]));
 const end=M.dates.lastIndexOf(all.at(-1));
 if(end<begin)return;
 if(begin===0 && end===M.dates.length-1)return;
 const oldDates=M.dates;
 M.dates=oldDates.slice(begin,end+1);
 for(const series of Object.values(R||{})){
  for(const layer of ORDER){
   if(Array.isArray(series[layer]))series[layer]=series[layer].slice(begin,end+1);
  }
 }
}
function nextObserved(i,dir=1,layer=st.layer){
 const key=layer==='none'?'tws_m':layer;
 for(let j=i+dir;j>=0&&j<M.dates.length;j+=dir){if(has(key,j))return j;}
 return null;
}
// Avoid speculative full-raster downloads while zooming: satellite tiles must
// take network priority. The currently displayed raster stays in one Leaflet layer.
function scheduleWarmMaps(){
 if(!st.playing||st.layer==='none'||!defaultColors())return;
 const next=nextObserved(st.month,1);
 if(next===null)return;
 const img=new Image();img.decoding='async';img.src=monthPath(st.layer,M.dates[next]);
}
function positionMapControls(){
 const t=document.querySelector('.timeline');if(!t)return;
 const rect=t.getBoundingClientRect();
 const clearance=Math.max(110,Math.ceil(window.innerHeight-rect.top));
 document.documentElement.style.setProperty('--timeline-clearance',clearance+'px');
}
function updateDateSelectors(){
 const date=M.dates[st.month];if(!date)return;
 for(const option of $('monthSelect').options){
  option.disabled=!M.dates.includes($('yearSelect').value+'-'+option.value);
 }
 $('timelineStartLabel').textContent=friendly(M.dates[0]);
 $('timelineEndLabel').textContent=friendly(M.dates.at(-1));
 const hasMultiple=(M.available[st.layer==='none'?'tws_m':st.layer]||[]).filter(d=>M.dates.includes(d)).length>1;
 $('play').disabled=!hasMultiple;
 positionMapControls();
}

// Country/basin outlines are visible from the overview; fine Level-2
// boundaries only appear once users zoom in. Canvas rendering avoids thousands
// of SVG paths slowing zoom and pan on the main map.
function boundaryStyle(feature){
 const detailed=feature.properties?.kind==='level2';
 const selected=st.region===feature.properties?.id;
 return {color:selected?'#9deaf9':detailed?'#f3a0df':'#24455d',
         weight:selected?2.3:(detailed?.65:1.2),opacity:selected?1:(detailed?.8:.86),
         fill:true,fillColor:'#6ac7de',fillOpacity:selected?0.012:0.004};
}
// Animate the *existing* Leaflet feature: no rectangles, bounding boxes or
// additional GeoJSON layers are generated on hover or on selection.
// This works with Canvas-rendered Level-2 boundaries and respects reduced motion.
function animateBoundaryHover(layer, feature, entered){
 const previous=layer._graceHoverFrame;
 if(previous!==undefined&&previous!==null)cancelAnimationFrame(previous);
 const normal=boundaryStyle(feature);
 const highlight={color:'#6de6ff',weight:3.0,opacity:1,fillOpacity:0.065};
 const dest=entered?highlight:normal;
 const startStyle={
  weight:Number(layer.options.weight??normal.weight),
  opacity:Number(layer.options.opacity??normal.opacity),
  fillOpacity:Number(layer.options.fillOpacity??normal.fillOpacity)
 };
 const finish=()=>{layer.setStyle(dest);layer._graceHoverFrame=null;};
 if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){finish();return;}
 const start=performance.now(),duration=190;
 const tick=now=>{
  if(!layer._map){layer._graceHoverFrame=null;return;}
  const p=Math.max(0,Math.min(1,(now-start)/duration));
  const ease=1-Math.pow(1-p,3);
  const mix=key=>startStyle[key]+(dest[key]-startStyle[key])*ease;
  layer.setStyle({
   color:entered?'#6de6ff':normal.color,
   weight:mix('weight'),opacity:mix('opacity'),fillOpacity:mix('fillOpacity'),
   fillColor:'#6ac7de'
  });
  if(p<1)layer._graceHoverFrame=requestAnimationFrame(tick);
  else finish();
 };
 layer._graceHoverFrame=requestAnimationFrame(tick);
}
function regionFeatures(){
 if(!B?.features)return [];
 const area=f=>{const b=region(f.properties?.id)?.bbox;
  return b?Math.abs((b[2]-b[0])*(b[3]-b[1])):Infinity;};
 return B.features.filter(f=>!['southeast_asia','tonle_sap_basin'].includes(f.properties?.id))
          .slice().sort((a,b)=>area(b)-area(a));
}
function openAreaTimeSeries(id){
 if(!region(id))return;
 chooseRegion(id,false);
 openPublicTimeSeries();
}
function installBoundaryInteractions(map){
 const features=regionFeatures();if(!features.length)return;
 const configure=(feature,layer)=>{
  const id=feature.properties?.id;
  const name=feature.properties?.name||region(id)?.name||'Selected area';
  // Keep ONE interactive layer for every boundary. The old extra SVG outline
  // could cover the same polygon after the chart was closed and stop re-clicks.
  if(id)st.boundaryLayers.set(id,{layer,feature});
  layer.bindTooltip(name,{sticky:true,direction:'top',className:'grace-region-tip'});
  layer.on('mouseover',()=>animateBoundaryHover(layer,feature,true));
  layer.on('mouseout',()=>animateBoundaryHover(layer,feature,false));
  layer.on('click',event=>{
   if(!id||!region(id))return;
   if(event.originalEvent)L.DomEvent.stopPropagation(event.originalEvent);
   openAreaTimeSeries(id);
  });
  layer.on('dblclick',event=>{
   if(!id||!region(id))return;
   if(event.originalEvent)L.DomEvent.stop(event.originalEvent);
   openAreaTimeSeries(id);
  });
 };
 const overview=features.filter(f=>f.properties?.kind!=='level2');
 const detail=features.filter(f=>f.properties?.kind==='level2');
 const options={style:boundaryStyle,interactive:true,bubblingMouseEvents:false,
                renderer:L.canvas({padding:.4}),onEachFeature:configure};
 st.regions=L.geoJSON({type:'FeatureCollection',features:overview},options).addTo(map);
 if(detail.length){
  const sync=()=>{
   const show=map.getZoom()>=5.5;
   // First construct the detailed layer after the user zooms in; this keeps
   // initial rendering responsive even with thousands of admin-2 features.
   if(show&&!st.level2Regions){
     st.level2Regions=L.geoJSON({type:'FeatureCollection',features:detail},options);
   }
   if(show&&!map.hasLayer(st.level2Regions))st.level2Regions.addTo(map);
   else if(!show&&st.level2Regions&&map.hasLayer(st.level2Regions))map.removeLayer(st.level2Regions);
  };
  map.on('zoomend',sync);
  sync();
 }
}
function initializeMap(){
 if(!window.L){$('error').hidden=false;return;}
 // Preserve V17 natural zoom animation, map controls and tile behavior.
 // Restore ONLY V23 geographic bounds and minimum zoom restrictions.
 const compact=window.innerWidth<700;
 const map=L.map('map',{minZoom:compact?2.5:3,maxZoom:16,zoomSnap:.25,
   worldCopyJump:true,preferCanvas:true,
   maxBounds:[[-26,72],[40,164]],maxBoundsViscosity:.9});st.map=map;
 const opt={maxNativeZoom:17,maxZoom:19,updateWhenIdle:true,keepBuffer:2,
   attribution:'Tiles © Esri and imagery/data contributors'};
 st.base={
   satellite:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',opt),
   topographic:L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',opt)
 };
 for(const layer of Object.values(st.base))layer.on('tileerror',ev=>{if(ev.tile)ev.tile.style.visibility='hidden';});
 chooseBase('satellite');
 // V17's default Leaflet zoom control appears at the top left.
 // Keep scale bottom right so the V23 lower-left coordinates stay legible.
 L.control.scale({metric:true,imperial:false,position:'bottomright'}).addTo(map);
 const extent=M.bounds.tws_m;
 map.fitBounds([[extent[0],extent[1]],[extent[2],extent[3]]],{padding:[20,20],maxZoom:6});
 // Do not allow zooming out beyond the initial Southeast Asia overview.
 map.setMinZoom(map.getZoom());
 installBoundaryInteractions(map);
 // Only shapefile regions are selectable; empty-map clicks never add points.
 map.on('mousemove',ev=>updateCursorCoordinates(ev.latlng));
 map.on('mouseout',()=>{
  $('cursorCoords').textContent='Lat: —   Lon: —';
 });
 showOverlay();
}

function formatCoordinate(value,positive,negative){
 const direction=value<0?negative:positive;
 return `${Math.abs(value).toFixed(3)}° ${direction}`;
}
function updateCursorCoordinates(latlng){
 const lat=Math.max(-90,Math.min(90,latlng.lat));
 // Keep displayed longitudes within the usual geographic range.
 const lon=((latlng.lng+180)%360+360)%360-180;
 $('cursorCoords').textContent=`Lat: ${formatCoordinate(lat,'N','S')}   Lon: ${formatCoordinate(lon,'E','W')}`;
}
// Map mouse movement only updates latitude/longitude and polygon name tooltips.
// Point-by-point TWSA hovering was removed; regional values are shown on click.
function chooseBase(name){
 if(!st.map||!st.base[name])return;
 Object.values(st.base).forEach(l=>{if(st.map.hasLayer(l))st.map.removeLayer(l);});
 st.base[name].addTo(st.map);$('basemapSelect').value=name;
 st.overlay?.bringToFront();st.regions?.bringToFront();st.level2Regions?.bringToFront();
}
function outlineRegion(){
 // Never draw an extent rectangle or clone a selected polygon: style only the
 // true geographic feature already registered in st.boundaryLayers.
 // The same region remains re-selectable after the analysis dialog closes.
 const old=st.boundaryLayers.get(st.previousBoundary);
 if(old){
  if(old.layer._graceHoverFrame!=null)cancelAnimationFrame(old.layer._graceHoverFrame);
  old.layer._graceHoverFrame=null;
  old.layer.setStyle(boundaryStyle(old.feature));
 }
 const chosen=st.boundaryLayers.get(st.region);
 if(chosen){
  if(chosen.layer._graceHoverFrame!=null)cancelAnimationFrame(chosen.layer._graceHoverFrame);
  chosen.layer._graceHoverFrame=null;
  chosen.layer.setStyle(boundaryStyle(chosen.feature));
 }
 st.previousBoundary=st.region;
}
// V17 overlay behavior: a normal Leaflet image overlay that participates in
// Leaflet's standard zoom transformation. No persistent URL swaps or CSS fades.
function removeOverlay(){
 if(st.overlay&&st.map){st.map.removeLayer(st.overlay);st.overlay=null;st.overlayLayer=null;}
}
function installOverlay(url,layer,date,token=st.overlayToken){
 if(!st.map||token!==st.overlayToken)return;
 const bounds=boundsFor(layer);if(!bounds)return;
 removeOverlay();
 st.overlay=L.imageOverlay(url,bounds,{
  opacity:Number($('opacity').value)/100,interactive:false,
  alt:`${M.labels[layer]} ${date}`
 }).addTo(st.map);
 st.overlayLayer=layer;
 st.regions?.bringToFront();st.level2Regions?.bringToFront();
}
function defaultColors(){return st.colorMin===-50&&st.colorMax===50;}
async function showOverlay(){
 if(!st.map)return;
 const token=++st.overlayToken,layer=st.layer,date=M.dates[st.month];
 if(layer==='none'){$('noData').hidden=true;removeOverlay();return;}
 const seen=has(layer,st.month);$('noData').hidden=seen;
 if(!seen||!boundsFor(layer)){removeOverlay();return;}
 if(defaultColors()||!M.dynamicColors){
  installOverlay(monthPath(layer,date),layer,date,token);scheduleWarmMaps();return;
 }
 try{
  const uri=await makeCustomImage(layer,date);
  if(token!==st.overlayToken)return;
  installOverlay(uri,layer,date,token);
 }catch(err){
  console.error('Color rendering failed',err);
  if(token===st.overlayToken)say('Unable to recolor this month. Check data/fields and pako.min.js.');
 }
}
function parseRgb(hex){return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));}
function recolorLut(){
 const key=`${st.colorMin}/${st.colorMax}`;
 if(st.lutKey===key&&st.lut)return st.lut;
 const stops=M.colors.map(([v,c])=>[
    v<0?v/50*Math.abs(st.colorMin):v/50*st.colorMax,parseRgb(c)]);
 const result=new Uint8Array(65536*3);
 for(let q=-32767;q<=32767;q++){
   const value=q*M.colorPrecision;
   let j=0;
   while(j<stops.length-2&&value>stops[j+1][0])j++;
   const [x0,c0]=stops[j],[x1,c1]=stops[j+1];
   const t=Math.max(0,Math.min(1,(value-x0)/(x1-x0)));
   const base=(q+32768)*3;
   for(let k=0;k<3;k++)result[base+k]=Math.round(c0[k]+t*(c1[k]-c0[k]));
 }
 st.lutKey=key;st.lut=result;return result;
}
async function loadField(layer,date){
 const key=`${layer}:${date}`;
 if(st.fieldCache.has(key))return st.fieldCache.get(key);
 if(!st.fieldPending.has(key)){
   st.fieldPending.set(key,(async()=>{
     if(!window.GRACE_FIELDS[key])await loadScript(`data/fields/${layer}/${date.slice(0,4)}/${date}.js`);
     const base64=window.GRACE_FIELDS[key];
     if(!base64)throw Error(`Missing raw color field ${key}`);
     if(!window.pako)throw Error('pako.min.js is required for recoloring');
     const zipped=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
     const raw=window.pako.ungzip(zipped);
     const g=M.grids[layer];
     if(raw.byteLength!==g.rows*g.cols*2)throw Error(`Field size mismatch: ${key}`);
     const q=new Int16Array(raw.byteLength/2);
     const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
     for(let i=0;i<q.length;i++)q[i]=view.getInt16(2*i,true);
     delete window.GRACE_FIELDS[key];
     st.fieldCache.set(key,q);
     if(st.fieldCache.size>3)st.fieldCache.delete(st.fieldCache.keys().next().value);
     return q;
   })().finally(()=>st.fieldPending.delete(key)));
 }
 return st.fieldPending.get(key);
}
function mercatorLatitude(y){return (2*Math.atan(Math.exp(y))-Math.PI/2)*180/Math.PI;}
function loadFootprint(){
 if(st.footprint)return st.footprint;
 if(!window.GRACE_FOOTPRINT_B64||!window.pako)throw Error('Land mask or pako missing');
 const zipped=Uint8Array.from(atob(window.GRACE_FOOTPRINT_B64),c=>c.charCodeAt(0));
 const mask=window.pako.ungzip(zipped);
 const g=M.footprintGrid;
 if(mask.length!==g.rows*g.cols)throw Error('Land mask grid dimensions incorrect');
 st.footprint=mask;return mask;
}
async function makeCustomImage(layer,date,exportWidth=null,format='image/webp'){
 const values=await loadField(layer,date);
 const g=M.grids[layer],b=M.bounds[layer],dimensions=M.imageSizes[layer];
 // Browser recoloring is display-only; an 1800px raster preserves the 0.05° cells.
 const W=exportWidth||Math.min(1800,dimensions[0]);
 const H=Math.max(1,Math.round(W*dimensions[1]/dimensions[0]));
 const cols=g.cols,rows=g.rows,fg=M.footprintGrid,footprint=loadFootprint();
 const palette=recolorLut();
 const canvas=document.createElement('canvas');canvas.width=W;canvas.height=H;
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas unavailable');
 const picture=ctx.createImageData(W,H),pixels=picture.data;
 const colByX=new Int32Array(W),footCol=new Int32Array(W);
 for(let x=0;x<W;x++){
   const lon=b[1]+(x+.5)/W*(b[3]-b[1]);
   colByX[x]=Math.round((lon-g.west)/g.dx);
   footCol[x]=Math.round((lon-fg.west)/fg.dx);
 }
 const rad=Math.PI/180;
 const northMerc=Math.log(Math.tan(Math.PI/4+b[2]*rad/2));
 const southMerc=Math.log(Math.tan(Math.PI/4+b[0]*rad/2));
 for(let y=0;y<H;y++){
   const m=northMerc-(y+.5)/H*(northMerc-southMerc);
   const lat=mercatorLatitude(m);
   const row=Math.round((g.north-lat)/g.dy),frow=Math.round((fg.north-lat)/fg.dy);
   if(row<0||row>=rows||frow<0||frow>=fg.rows)continue;
   const begin=row*cols,fbegin=frow*fg.cols;
   for(let x=0;x<W;x++){
     const col=colByX[x],fc=footCol[x];
     if(col<0||col>=cols||fc<0||fc>=fg.cols||!footprint[fbegin+fc])continue;
     const q=values[begin+col];if(q===-32768)continue;
     const pal=(q+32768)*3,off=(y*W+x)*4;
     pixels[off]=palette[pal];pixels[off+1]=palette[pal+1];
     pixels[off+2]=palette[pal+2];pixels[off+3]=255;
   }
 }
 ctx.putImageData(picture,0,0);
 return canvas.toDataURL(format,format==='image/webp'?0.92:undefined);
}
function updateLegend(){
 const lo=st.colorMin,hi=st.colorMax;
 const stops=M.colors.map(([v,c])=>[v<0?v/50*Math.abs(lo):v/50*hi,c]);
 $('gradient').style.background=`linear-gradient(90deg,${stops.map(([v,c])=>`${c} ${(v-lo)/(hi-lo)*100}%`).join(',')})`;
 $('legendMin').textContent=String(lo).replace('-', '−');
 $('legendMax').textContent=`+${hi}`;
 $('layerInfo').textContent=HELP[st.layer]||'';
}
function applyColors(){
 const lo=Number($('colorMin').value),hi=Number($('colorMax').value);
 if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo>=0||hi<=0||lo< -500||hi>500){
   say('Use a negative minimum (−500 to −1) and positive maximum (1 to 500).');return;
 }
 st.colorMin=lo;st.colorMax=hi;st.lutKey=null;st.lut=null;
 updateLegend();showOverlay();if(st.chartOpen&&st.activeTab==='spatial')drawRegionalSpatialMap();
}

function setMonth(i){
 st.month=Math.max(0,Math.min(M.dates.length-1,Math.round(i)));
 const date=M.dates[st.month];if(!date)return;
 $('dateLabel').textContent=friendly(date);
 $('yearSelect').value=date.slice(0,4);$('monthSelect').value=date.slice(5,7);
 $('monthSlider').value=String(st.month);
 for(const [j,span] of [...$('availability').children].entries())span.classList.toggle('current',j===st.month);
 updateDateSelectors();showOverlay();if(st.publicOpen)renderPublicChart();
 if(st.chartOpen){
  if(st.activeTab==='time')updatePlotCursor();
  else drawRegionalSpatialMap();
 }
}
function stopPlayback(){
 st.playing=false;
 if(st.timer){clearTimeout(st.timer);st.timer=null;}
 $('play').textContent='▶';$('play').setAttribute('aria-pressed','false');
}
function togglePlay(){
 if(st.playing){stopPlayback();return;}
 if(!M.dates.length)return;
 if(nextObserved(st.month,1)===null){
  const first=M.dates.findIndex((d,i)=>has(st.layer==='none'?'tws_m':st.layer,i));
  if(first<0||nextObserved(first,1)===null)return;
  setMonth(first);
 }
 st.playing=true;$('play').textContent='Ⅱ';$('play').setAttribute('aria-pressed','true');
 const advance=()=>{
  if(!st.playing)return;
  const next=nextObserved(st.month,1);
  if(next===null){stopPlayback();return;}
  setMonth(next);
  st.timer=setTimeout(advance,720);
 };
 st.timer=setTimeout(advance,720);
}
function changeSelectors(){
 const value=`${$('yearSelect').value}-${$('monthSelect').value}`;
 const i=M.dates.indexOf(value);
 if(i>=0)setMonth(i);
 else{
  const nearest=M.dates.findIndex(d=>d.startsWith($('yearSelect').value+'-'));
  if(nearest>=0)setMonth(nearest);
 }
}
function chooseRegion(id,zoom){
 if(!region(id))return;
 st.region=id;$('regionSelect').value=id;
 if($('spatialRegionSelect'))$('spatialRegionSelect').value=id;
 if($('timeRegionSelect'))$('timeRegionSelect').value=id;
 outlineRegion();
 const r=region(id);if(zoom&&st.map){const b=r.bbox;st.map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:[35,35],maxZoom:8});}
 describeStudy();
 // A region click should open its popup immediately; only render costly Plotly
 // work when the analysis dialog is actually visible.
 if(st.chartOpen)drawChart();
 updateTechnicalMetrics();
}
function loadScript(path){
 return new Promise((resolve,reject)=>{
   const s=document.createElement('script');s.src=path;s.async=true;
   s.onload=()=>{s.remove();resolve();};
   s.onerror=()=>{s.remove();reject(Error(`Cannot load ${path}`));};
   document.head.append(s);
 });
}
function niceInterval(range,goal=5){
 const rough=Math.max(1e-7,range/goal),power=Math.pow(10,Math.floor(Math.log10(rough)));
 const n=rough/power;
 return (n<=1?1:n<=2?2:n<=5?5:10)*power;
}
function regionGeoFeature(id){return B?.features?.find(f=>f.properties?.id===id)||null;}
function traceGeometryPath(ctx,geometry,project){
 const ring=points=>{
  if(!points?.length)return;
  for(let i=0;i<points.length;i++){
   const [x,y]=project(points[i][0],points[i][1]);
   if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
  }
  ctx.closePath();
 };
 if(geometry?.type==='Polygon')geometry.coordinates.forEach(ring);
 else if(geometry?.type==='MultiPolygon')geometry.coordinates.forEach(poly=>poly.forEach(ring));
}
function rgbForStorage(v){
 const anchors=M.colors.map(([x,c])=>[x<0?x*Math.abs(st.colorMin)/50:x*st.colorMax/50,parseRgb(c)]);
 if(v<=anchors[0][0])return anchors[0][1];
 for(let i=1;i<anchors.length;i++){
  if(v<=anchors[i][0]){
   const a=anchors[i-1],b=anchors[i],f=Math.max(0,Math.min(1,(v-a[0])/(b[0]-a[0])));
   return a[1].map((channel,k)=>Math.round(channel+f*(b[1][k]-channel)));
  }
 }
 return anchors.at(-1)[1];
}
function regionMapMessage(ctx,text,theme='dark'){
 const c=ctx.canvas;
 const ratio=Math.max(1,ctx.getTransform().a||1);
 const cw=c.width/ratio,ch=c.height/ratio;
 ctx.clearRect(0,0,cw,ch);
 ctx.fillStyle=theme==='light'?'#ffffff':'#0b233a';ctx.fillRect(0,0,cw,ch);
 ctx.fillStyle=theme==='light'?'#40566e':'#c9deed';
 ctx.textAlign='center';ctx.font='20px Arial, sans-serif';
 ctx.fillText(text,cw/2,ch/2);
}
// The on-screen spatial figure uses the navy dashboard palette. Export mode
// re-renders from the same numeric field onto a separate WHITE canvas.
// Source grid cells are drawn without interpolation; real missing cells remain transparent.
async function drawRegionalSpatialMap(options={}){
 const exportMode=Boolean(options.exportMode),theme=exportMode?'light':'dark';
 const block=$('regionSpatial'),heading=$('regionSpatialHeading');
 const canvas=exportMode?document.createElement('canvas'):$('regionSpatialCanvas');
 if(!block||!canvas||!M)return null;
 const token=exportMode?st.regionalRenderToken:++st.regionalRenderToken;
 const ctx=canvas.getContext('2d');if(!ctx)return null;
 const date=M.dates[st.month],key=st.layer,r=region(st.region),feature=regionGeoFeature(st.region);
 if(!exportMode)heading.textContent=(r?.name||'Selected region')+' · '+(M.labels[key]||'GRACE')+' · '+date;
 const notice=(message)=>{regionMapMessage(ctx,message,theme);return canvas;};
 if(st.region==='footprint'||!feature)return notice('Select a country or basin to view its spatial map');
 if(key==='none')return notice('Select a GRACE spatial dataset');
 if(!has(key,st.month))return notice('No valid '+(M.labels[key]||'GRACE')+' observation for '+date);
 const grid=M.grids[key];if(!grid)return notice('Grid information unavailable');
 if(!exportMode)notice('Loading spatial values…');
 let values;
 try{values=await loadField(key,date);}
 catch(e){console.error(e);return exportMode?null:(token===st.regionalRenderToken?notice('Monthly raster unavailable'):null);}
 if(!exportMode&&(token!==st.regionalRenderToken||!st.chartOpen))return null;
 // Canvas follows the real geographic aspect ratio of the selected polygon.
 let [s,w,n,e]=r.bbox;
 const latPad=Math.max(0.13,(n-s)*.045),lonPad=Math.max(0.13,(e-w)*.045);
 s-=latPad;n+=latPad;w-=lonPad;e+=lonPad;
 const mid=(n+s)/2,cos=Math.max(0.35,Math.cos(mid*Math.PI/180));
 // Scientific grid resolution remains unchanged. Supersampling increases
 // on-screen pixel density for labels, native cells and geographic outlines.
 const H=575,Top=44,Bottom=H-82,Lft=102;
 const desiredWidth=(e-w)*cos/(n-s)*(Bottom-Top);
 const mapAreaWidth=Math.min(1160,Math.max(235,desiredWidth));
 const W=Math.round(Lft+mapAreaWidth+180);
 const pixelRatio=exportMode?3:2;
 const pxW=W*pixelRatio,pxH=H*pixelRatio;
 if(canvas.width!==pxW||canvas.height!==pxH){canvas.width=pxW;canvas.height=pxH;}
 ctx.setTransform(pixelRatio,0,0,pixelRatio,0,0);
 if(!exportMode){canvas.style.width=`min(100%, ${W}px)`;canvas.style.maxWidth='100%';}
 const bg=theme==='light'?'#ffffff':'#0b233a';
 const gridColor=theme==='light'?'#dfe9f1':'#2d516e';
 const textColor=theme==='light'?'#35506a':'#d5e9f7';
 const axisColor=theme==='light'?'#132f4d':'#eff8ff';
 ctx.fillStyle=bg;ctx.fillRect(0,0,W,H);
 const Rgt=W-160;
 const scale=Math.min((Rgt-Lft)/((e-w)*cos),(Bottom-Top)/(n-s));
 const mapWidth=(e-w)*cos*scale,mapHeight=(n-s)*scale;
 const xStart=Lft+((Rgt-Lft)-mapWidth)/2,yStart=Top+((Bottom-Top)-mapHeight)/2;
 const project=(lng,lat)=>[xStart+(lng-w)*cos*scale,yStart+(n-lat)*scale];
 const xTick=niceInterval(e-w),yTick=niceInterval(n-s);
 ctx.lineWidth=1;ctx.strokeStyle=gridColor;ctx.fillStyle=textColor;ctx.font='21px Arial, sans-serif';
 ctx.textAlign='center';
 for(let lng=Math.ceil(w/xTick)*xTick;lng<=e+1e-8;lng+=xTick){
  const [x]=project(lng,n);ctx.beginPath();ctx.moveTo(x,yStart);ctx.lineTo(x,yStart+mapHeight);ctx.stroke();
  ctx.fillText((Math.round(lng*1000)/1000).toString(),x,Bottom+20);
 }
 ctx.textAlign='right';
 for(let lat=Math.ceil(s/yTick)*yTick;lat<=n+1e-8;lat+=yTick){
  const [,y]=project(w,lat);ctx.beginPath();ctx.moveTo(xStart,y);ctx.lineTo(xStart+mapWidth,y);ctx.stroke();
  ctx.fillText((Math.round(lat*1000)/1000).toString(),Lft-10,y+6);
 }
 ctx.fillStyle=axisColor;ctx.textAlign='center';ctx.font='bold 24px Arial, sans-serif';
 ctx.fillText('Longitude', (Lft+Rgt)/2,H-12);
 ctx.save();ctx.translate(23,(Top+Bottom)/2);ctx.rotate(-Math.PI/2);ctx.fillText('Latitude',0,0);ctx.restore();
 const miniature=document.createElement('canvas');miniature.width=grid.cols;miniature.height=grid.rows;
 const mc=miniature.getContext('2d'),pic=mc.createImageData(grid.cols,grid.rows);
 for(let i=0;i<values.length;i++){
  const q=values[i];if(q===-32768)continue;
  const [rr,gg,bb]=rgbForStorage(q*M.colorPrecision),j=i*4;
  pic.data[j]=rr;pic.data[j+1]=gg;pic.data[j+2]=bb;pic.data[j+3]=255;
 }
 mc.putImageData(pic,0,0);
 // Raster clipped to the exact polygon. Gridded values remain nearest-neighbor.
 ctx.save();ctx.beginPath();traceGeometryPath(ctx,feature.geometry,project);ctx.clip('evenodd');
 const [rasterX,rasterY]=project(grid.west-grid.dx/2,grid.north+grid.dy/2);
 ctx.imageSmoothingEnabled=false;
 ctx.drawImage(miniature,rasterX,rasterY,grid.cols*grid.dx*cos*scale,grid.rows*grid.dy*scale);
 ctx.restore();
 ctx.beginPath();traceGeometryPath(ctx,feature.geometry,project);
 ctx.strokeStyle=theme==='light'?'#101d2a':'#ffffff';ctx.lineWidth=2.6;ctx.stroke();
 const bx=W-99,by=52,bw=30,bh=H-135;
 const bar=ctx.createLinearGradient(0,by+bh,0,by);
 for(const [value,color] of M.colors){
  const actual=value<0?value/50*Math.abs(st.colorMin):value/50*st.colorMax;
  bar.addColorStop(Math.max(0,Math.min(1,(actual-st.colorMin)/(st.colorMax-st.colorMin))),color);
 }
 ctx.fillStyle=bar;ctx.fillRect(bx,by,bw,bh);
 ctx.strokeStyle=theme==='light'?'#aebccb':'#a3c0d1';ctx.lineWidth=1;ctx.strokeRect(bx,by,bw,bh);
 ctx.fillStyle=textColor;ctx.font='20px Arial, sans-serif';ctx.textAlign='left';
 ctx.fillText('TWSA (cm)',bx-22,by-23);
 for(const v of [st.colorMax,0,st.colorMin]){
  const t=(st.colorMax-v)/(st.colorMax-st.colorMin),y=by+bh*t;
  ctx.fillText((v>0?'+':'')+String(v),bx+bw+7,y+5);
 }
 return canvas;
}

function describeStudy(){
 $('studyName').textContent=(region(st.region)?.name||'Region')+' · monthly average';
 $('studyInfo').textContent='Basin and Country Average';
}
function activeSeries(){return R[st.region];}
function setAnalysisTab(tab){
 st.activeTab=tab==='spatial'?'spatial':'time';
 const time=st.activeTab==='time';
 $('timeTabPanel').hidden=!time;$('spatialTabPanel').hidden=time;
 for(const [key,selected] of [['tabTime',time],['tabSpatial',!time]]){
  $(key).classList.toggle('active',selected);
  $(key).setAttribute('aria-selected',String(selected));
  $(key).tabIndex=selected?0:-1;
 }
 if(time)drawChart();else drawRegionalSpatialMap();
}
function toggleChart(force,tab,origin='technical'){
 st.chartOpen=force===undefined?!st.chartOpen:Boolean(force);
 if(st.chartOpen)st.analysisOrigin=origin==='boundary'?'boundary':'technical';
 $('chartDrawer').classList.toggle('boundary-analysis',st.chartOpen&&st.analysisOrigin==='boundary');
 $('chartDrawer').classList.toggle('open',st.chartOpen);
 $('chartDrawer').setAttribute('aria-hidden',String(!st.chartOpen));
 $('analysisBackdrop').hidden=!st.chartOpen;
 if(st.chartOpen){
  describeStudy();setAnalysisTab(tab||st.activeTab);$('closeChart').focus();
 } else {
  st.map?.closePopup();
  const modal=$('chartDrawer');
  modal.classList.remove('dragged-analysis');
  modal.style.removeProperty('--dialog-x');modal.style.removeProperty('--dialog-y');
 }
}
// Drag the analysis popup by its title bar. Escape, tab actions, chart zoom,
// buttons, and map gestures remain unaffected. Small screens stay centered.
function installDraggableAnalysis(){
 const dialog=$('chartDrawer'),bar=dialog?.querySelector('.drawer-heading');
 if(!dialog||!bar)return;
 let drag=null;
 bar.addEventListener('pointerdown',ev=>{
  if(!st.chartOpen||ev.button!==0||window.innerWidth<720||
     ev.target.closest('button,a,input,select'))return;
  const rect=dialog.getBoundingClientRect();
  dialog.classList.add('dragged-analysis');
  dialog.style.setProperty('--dialog-x',rect.left+'px');
  dialog.style.setProperty('--dialog-y',rect.top+'px');
  drag={id:ev.pointerId,startX:ev.clientX,startY:ev.clientY,left:rect.left,top:rect.top};
  bar.setPointerCapture(ev.pointerId);
  ev.preventDefault();
 });
 bar.addEventListener('pointermove',ev=>{
  if(!drag||drag.id!==ev.pointerId)return;
  const x=Math.max(4,Math.min(window.innerWidth-dialog.offsetWidth-4,
      drag.left+ev.clientX-drag.startX));
  const y=Math.max(4,Math.min(window.innerHeight-55,
      drag.top+ev.clientY-drag.startY));
  dialog.style.setProperty('--dialog-x',x+'px');
  dialog.style.setProperty('--dialog-y',y+'px');
 });
 for(const kind of ['pointerup','pointercancel','lostpointercapture']){
  bar.addEventListener(kind,()=>{drag=null;});
 }
}
function escapeXml(s){return String(s).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));}
function svg(tag,attrs,body=''){return `<${tag} ${Object.entries(attrs).map(([k,v])=>`${k}="${escapeXml(v)}"`).join(' ')}>${body}</${tag}>`;}
// Ordinary least-squares trend through observed months only (x in elapsed months).
// Missing data are never filled; the dashed trend is a summary, not observations.
function linearTrend(values){
 const pts=[];
 for(let i=0;i<values.length;i++)if(Number.isFinite(values[i]))pts.push([i,values[i]]);
 if(pts.length<3)return null;
 const n=pts.length;
 const mx=pts.reduce((sum,p)=>sum+p[0],0)/n;
 const my=pts.reduce((sum,p)=>sum+p[1],0)/n;
 let numerator=0,denominator=0;
 for(const [x,y] of pts){numerator+=(x-mx)*(y-my);denominator+=(x-mx)**2;}
 if(denominator===0)return null;
 const slope=numerator/denominator;
 return {slope,intercept:my-slope*mx,first:pts[0][0],last:pts.at(-1)[0],n,
         slopeCmYear:slope*12};
}
// Lightweight accessible public chart, without Plotly or backend computation.
// Technical use retains its own Plotly window with all its existing selectors.
const PUBLIC_P={w:1120,h:455,l:88,r:1080,t:47,b:359};
const PUBLIC_MOBILE_P={w:560,h:445,l:67,r:535,t:40,b:345};
function publicPlotGeometry(){return window.innerWidth<=640?PUBLIC_MOBILE_P:PUBLIC_P;}
function openPublicTimeSeries(){
 st.publicOpen=true;document.body.classList.add('public-analysis-open');
 st.publicSeries=Object.fromEntries(ORDER.map(id=>[id,true]));
 st.publicTrend=true;
 $('publicTrend').checked=true;
 $('publicBackdrop').hidden=false;$('publicTimeDialog').hidden=false;
 $('publicTimeDialog').setAttribute('aria-hidden','false');
 $('publicTimeTitle').textContent=region(st.region)?.name||'Selected region';
 renderPublicLegend();renderPublicChart();$('publicClose').focus();
}
function closePublicTimeSeries(){
 st.publicOpen=false;
 $('publicBackdrop').hidden=true;
 $('publicTimeDialog').hidden=true;
 $('publicTimeDialog').setAttribute('aria-hidden','true');
 document.body.classList.remove('public-analysis-open');
 // Release any sticky tooltip and return interaction to the same Leaflet
 // polygon layer. No redraw of NetCDF data or new boundary overlay is needed.
 st.boundaryLayers.get(st.region)?.layer?.closeTooltip?.();
 requestAnimationFrame(()=>st.map?.invalidateSize({pan:false}));
}
function renderPublicLegend(){
 const wrap=$('publicLegend');wrap.replaceChildren();
 for(const id of ORDER){
  const button=document.createElement('button');button.type='button';
  button.className='public-legend-button';button.dataset.layer=id;
  button.setAttribute('aria-pressed',String(st.publicSeries[id]));
  const swatch=document.createElement('span');swatch.className='public-legend-swatch';
  swatch.style.background=SERIES_COLORS[id];
  button.append(swatch,document.createTextNode(M.labels[id]||id));
  button.addEventListener('click',()=>{
   st.publicSeries[id]=!st.publicSeries[id];renderPublicLegend();renderPublicChart();
  });
  wrap.append(button);
 }
}
function renderPublicChart(){
 if(!st.publicOpen)return;
 const plot=$('publicPlot'),data=R?.[st.region];
 const p=publicPlotGeometry(),n=M.dates.length;
 plot.setAttribute('viewBox',`0 0 ${p.w} ${p.h}`);
 if(!data){plot.innerHTML=`<text x="${p.w/2}" y="${p.h/2}" text-anchor="middle" fill="white" font-size="22">No regional series available</text>`;return;}
 const ids=ORDER.filter(k=>st.publicSeries[k]);
 const values=ids.flatMap(k=>(data[k]||[]).filter(Number.isFinite));
 let low=Math.min(0,...values),high=Math.max(0,...values);
 if(!values.length){low=-10;high=10;}
 const padding=Math.max(4,(high-low)*.12);low-=padding;high+=padding;
 const X=i=>n===1?(p.l+p.r)/2:p.l+i*(p.r-p.l)/(n-1);
 const Y=v=>p.b-(v-low)/(high-low)*(p.b-p.t);
 const parts=[];
 for(let i=0;i<=5;i++){
  const v=low+(high-low)*i/5, y=Y(v);
  parts.push(svg('line',{x1:p.l,x2:p.r,y1:y,y2:y,stroke:'#34516a','stroke-width':1}));
  parts.push(svg('text',{x:p.l-14,y:y+6,'text-anchor':'end','font-size':19,fill:'#e0edf7'},v.toFixed(0)));
 }
 const xticks=[];
 for(let i=0;i<n;i++){
  const [y,m]=M.dates[i].split('-').map(Number);
  if(n>24){if(m===1&&y%(p.w<700?4:2)===0)xticks.push([i,String(y)]);}
  else if(n<=5||i%Math.max(1,Math.ceil(n/8))===0)xticks.push([i,MONTHS[m-1].slice(0,3)+' '+y]);
 }
 if(!xticks.length&&n>0)xticks.push([0,M.dates[0]]);
 for(const [i,year] of xticks){
  parts.push(svg('line',{x1:X(i),x2:X(i),y1:p.b,y2:p.b+6,stroke:'#8fb5cb'}));
  parts.push(svg('text',{x:X(i),y:p.b+29,'text-anchor':'middle','font-size':18,fill:'#e0edf7'},year));
 }
 const trendLabels=[];
 for(const id of ids){
  const series=data[id]||[],color=SERIES_COLORS[id];
  let path='',continued=false,validCount=0;
  for(let i=0;i<n;i++){
   const v=series[i];if(!Number.isFinite(v)){continued=false;continue;}
   path+=(continued?'L':'M')+X(i).toFixed(2)+' '+Y(v).toFixed(2)+' ';
   continued=true;validCount++;
  }
  if(path)parts.push(svg('path',{d:path,stroke:color,fill:'none',
    'stroke-width':2.05,'stroke-linejoin':'round','stroke-linecap':'round'}));
  if(validCount<=2){for(let i=0;i<n;i++)if(Number.isFinite(series[i])){
   parts.push(svg('circle',{cx:X(i),cy:Y(series[i]),r:5.5,fill:color}));
  }}
  if(st.publicTrend){
   const fit=linearTrend(series);
   if(fit){
    parts.push(svg('line',{x1:X(fit.first),x2:X(fit.last),
      y1:Y(fit.intercept+fit.slope*fit.first),
      y2:Y(fit.intercept+fit.slope*fit.last),stroke:color,
      'stroke-width':1.8,'stroke-dasharray':'10 7'}));
    trendLabels.push(`${M.labels[id]}: ${fit.slopeCmYear.toFixed(3)} cm/year`);
   }
  }
 }
 if(n>0)parts.push(svg('line',{x1:X(st.month),x2:X(st.month),y1:p.t,y2:p.b,
    stroke:'#f4cf8a','stroke-dasharray':'4 5','stroke-width':1.5}));
 parts.push(svg('text',{x:(p.l+p.r)/2,y:p.h-27,'text-anchor':'middle','font-size':22,
  'font-weight':'600',fill:'#eff9ff'},'Date'));
 const titleX=p.w<700?21:27,titleY=(p.t+p.b)/2;
 parts.push(svg('text',{x:titleX,y:titleY,transform:`rotate(-90 ${titleX} ${titleY})`,
  'text-anchor':'middle','font-size':22,'font-weight':'600',fill:'#eff9ff'},'TWSA (cm)'));
 if(!values.length)parts.push(svg('text',{x:p.w/2,y:p.h/2,'text-anchor':'middle','font-size':22,
  fill:'#d9e9f5'},'No valid observations in selected datasets'));
 plot.innerHTML=parts.join('');
 $('publicTimeSubtitle').textContent='Monthly water storage anomalies · '+
  M.dates[st.month]+' · '+(trendLabels.length ? trendLabels.length+' trend lines' : 'Observation gaps preserved');
 const valueLegend=$('publicTrendValues');
 if(valueLegend){
  valueLegend.replaceChildren();
  for(const id of ids){
   const fit=st.publicTrend?linearTrend(data[id]||[]):null;
   if(!fit)continue;
   const chip=document.createElement('span');chip.className='trend-value-chip';
   chip.style.borderColor=SERIES_COLORS[id];
   const dot=document.createElement('span');dot.className='trend-value-dot';
   dot.style.background=SERIES_COLORS[id];
   const value=fit.slopeCmYear;
   chip.append(dot,document.createTextNode(`${M.labels[id]}: ${value>=0?'+':''}${value.toFixed(3)} cm/year`));
   valueLegend.append(chip);
  }
  valueLegend.hidden=!valueLegend.childElementCount;
 }

}

// Interactive Plotly time series. Cached numeric regional means are reused
// directly; browser interaction never requests the original NetCDF files.
const PLOT_EXPORT_COLORS={tws_m:'#087ca6',tws_m_1km:'#409e57',obs_m:'#b66b17',csr:'#7845b2',gsfc:'#1e875a',jpl:'#bb3758'};
let plotRequest=0;
function buildPlotSpec(exportLight=false){
 const s=activeSeries(),ids=ORDER.filter(k=>st.series[k]);
 const dates=M.dates.map(d=>d+'-01');
 const traces=[];
 for(const id of ids){
  const values=s?.[id]||Array(M.dates.length).fill(null);
  const count=values.filter(Number.isFinite).length;
  const color=exportLight?PLOT_EXPORT_COLORS[id]:SERIES_COLORS[id];
  traces.push({
   type:'scatter',mode:count<=2?'markers':'lines+markers',
   name:M.labels[id],x:dates,y:values.map(v=>Number.isFinite(v)?v:null),
   connectgaps:false,
   line:{color,width:1.7,shape:'linear'},
   marker:{color,size:count<=2?9:3.5},
   hovertemplate:'%{x|%B %Y}<br>%{y:.2f} cm<extra>'+M.labels[id]+'</extra>'
  });
  if(st.showTrend){
   const fit=linearTrend(values);
   if(fit){
    traces.push({type:'scatter',mode:'lines',showlegend:false,hoverinfo:'skip',
     name:M.labels[id]+' trend',x:[dates[fit.first],dates[fit.last]],
     y:[fit.intercept+fit.slope*fit.first,fit.intercept+fit.slope*fit.last],
     line:{color,width:1.45,dash:'dash'}});
   }
  }
 }
 const ink=exportLight?'#284157':'#e5f3fc';
 const grid=exportLight?'#dbe5ed':'#294b66';
 const paper=exportLight?'#ffffff':'#0b263e';
 const layout={
  paper_bgcolor:paper,plot_bgcolor:paper,
  font:{family:'Segoe UI, Arial, sans-serif',size:16,color:ink},
  margin:{l:86,r:25,t:22,b:90},autosize:true,
  showlegend:true,legend:{orientation:'h',y:1.17,x:0,font:{size:13}},
  xaxis:{title:{text:'Date',standoff:15,font:{size:18}},
    type:'date',tick0:dates[0],dtick:M.dates.length<=24?'M1':'M24',
    tickformat:M.dates.length<=24?'%b %Y':'%Y',
    gridcolor:grid,linecolor:grid,zeroline:false,automargin:true,
    rangeslider:{visible:!exportLight,thickness:.10,bgcolor:exportLight?'#f4f7fa':'#18374f'},
    range:[dates[0],monthAfter(M.dates.at(-1))]},
  yaxis:{title:{text:'TWSA (cm)',standoff:15,font:{size:18}},gridcolor:grid,
    zeroline:true,zerolinecolor:exportLight?'#8397a7':'#7b9cb7',automargin:true},
  hovermode:'x unified',hoverlabel:{bgcolor:exportLight?'#fff':'#14344e',font:{size:14,color:ink}},
  dragmode:'zoom',hoverdistance:24,
  shapes:[currentMonthLine(exportLight)],
  uirevision:'region:'+st.region
 };
 return {traces,layout};
}
function monthAfter(date){
 const [year,month]=date.split('-').map(Number);
 const next=new Date(Date.UTC(year,month,1));
 return next.toISOString().slice(0,7)+'-01';
}
function currentMonthLine(light=false){
 const x=M.dates[st.month]+'-01';
 return {type:'line',xref:'x',yref:'paper',x0:x,x1:x,y0:0,y1:1,
  line:{color:light?'#ba7e23':'#e8ca7c',dash:'dot',width:1.5}};
}
function updatePlotCursor(){
 if(!st.plotReady||!window.Plotly||st.activeTab!=='time')return;
 Plotly.relayout($('plot'),{shapes:[currentMonthLine()]})
  .catch(err=>console.debug('Plot cursor not updated',err));
}
async function drawChart(){
 if(!st.chartOpen||st.activeTab!=='time')return;
 if(!window.Plotly){$('plot').textContent='Plotly is unavailable. Check the vendor/plotly.min.js file.';return;}
 const request=++plotRequest;
 const target=$('plot'),spec=buildPlotSpec();
 $('trendRates').replaceChildren();
 if(st.showTrend){
  for(const id of ORDER.filter(k=>st.series[k])){
   const fit=linearTrend(activeSeries()?.[id]||[]);if(!fit)continue;
   const label=document.createElement('span');label.style.color=SERIES_COLORS[id];
   label.textContent=`${M.labels[id]}: ${fit.slopeCmYear>=0?'+':''}${fit.slopeCmYear.toFixed(3)} cm/yr`;
   $('trendRates').append(label);
  }
 }
 const config={responsive:true,displaylogo:false,scrollZoom:false,
  modeBarButtonsToRemove:['lasso2d','select2d','autoScale2d','toggleSpikelines','toImage'],
  doubleClick:'reset'};
 try{
  if(!st.plotReady){await Plotly.newPlot(target,spec.traces,spec.layout,config);st.plotReady=true;
   target.on('plotly_click',event=>{
    const date=event.points?.[0]?.x;
    const month=typeof date==='string'?date.slice(0,7):null;
    const i=M.dates.indexOf(month);if(i>=0)setMonth(i);
   });
  }else await Plotly.react(target,spec.traces,spec.layout,config);
  if(request!==plotRequest)return;
  Plotly.Plots.resize(target);
 }catch(err){console.error('Plotly rendering error',err);say('Cannot render interactive time series.');}
}

// Two separate lossless exports. Each captures exactly the active dataset,
// selected region, visible traces and current monthly spatial field.
// No network calls, external charting libraries or local HTTP server required.
function savePng(canvas,filename){
 return new Promise((resolve,reject)=>{
   canvas.toBlob(blob=>{
    if(!blob){reject(Error('PNG encoding failed'));return;}
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=filename;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),5000);
    resolve();
   },'image/png');
 });
}
function filePart(value){return String(value||'unknown').replace(/[^a-z0-9_-]+/gi,'_').slice(0,75);}
function makeCanvas(width,height,scale=2){
 const c=document.createElement('canvas');
 c.width=Math.round(width*scale);c.height=Math.round(height*scale);
 const ctx=c.getContext('2d');if(!ctx)throw Error('Canvas 2D unavailable');
 ctx.scale(scale,scale);return {c,ctx};
}
async function downloadTimePng(){
 if(!window.Plotly){say('Plotly is not loaded.');return;}
 const s=activeSeries(),ids=ORDER.filter(k=>st.series[k]);
 if(!s||!ids.some(k=>(s[k]||[]).some(Number.isFinite))){
  say('No time-series observations to export.');return;
 }
 const node=document.createElement('div');
 Object.assign(node.style,{position:'fixed',left:'-20000px',top:'0',width:'1580px',height:'780px'});
 document.body.append(node);
 try{
  const {traces,layout}=buildPlotSpec(true);
  layout.width=1580;layout.height=780;layout.autosize=false;
  layout.margin={l:118,r:35,t:115,b:92};
  layout.title={text:'GRACE terrestrial water storage anomalies',x:.04,xanchor:'left',font:{size:28}};
  layout.font={...layout.font,size:20};
  layout.legend={orientation:'h',x:0,y:1.08,font:{size:19}};
  layout.xaxis.rangeslider={visible:false};
  await Plotly.newPlot(node,traces,layout,{displayModeBar:false,staticPlot:true});
  const url=await Plotly.toImage(node,{format:'png',width:1580,height:780,scale:2});
  const a=document.createElement('a');a.href=url;
  a.download=`GRACE_TimeSeries_${filePart(st.region)}_${M.dates[st.month]}.png`;
  document.body.append(a);a.click();a.remove();
 }catch(err){console.error(err);say('Time-series PNG download failed.');}
 finally{try{Plotly.purge(node);}catch(_e){}node.remove();}
}

async function downloadSpatialPng(){
 if(st.layer==='none'||st.region==='footprint'||!has(st.layer,st.month)){
    say('Select a valid month, GRACE layer and region for the spatial map.');return;
 }
 try{
   const src=await drawRegionalSpatialMap({exportMode:true});
   if(!src){say('Spatial field unavailable for export.');return;}
   const heading=$('regionSpatialHeading').textContent.trim();
   // drawRegionalSpatialMap(exportMode) is already 3x supersampled;
   // do NOT multiply it by another 2.4x and exhaust browser memory.
   const margin=82,top=145,bottom=62;
   const W=src.width+margin*2,H=src.height+top+bottom;
   const {c,ctx}=makeCanvas(W,H,1);
   ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);
   ctx.fillStyle='#19364f';ctx.font='bold 49px Arial, sans-serif';ctx.textAlign='center';
   const title=heading.length>90?heading.slice(0,87)+'…':heading;
   ctx.fillText(title,W/2,83,Math.max(350,W-100));
   ctx.strokeStyle='#e2eaf1';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(45,110);ctx.lineTo(W-45,110);ctx.stroke();
   ctx.imageSmoothingEnabled=false;
   ctx.drawImage(src,margin,top,src.width,src.height);
   await savePng(c,`GRACE_Spatial_${filePart(st.region)}_${filePart(st.layer)}_${M.dates[st.month]}.png`);
 }catch(e){console.error(e);say('Spatial-map PNG download failed.');}
}

function downloadCsv(){
 const s=activeSeries();if(!s){say('Time series not loaded yet.');return;}
 const rows=['month,'+ORDER.map(k=>k+'_cm').join(',')];
 M.dates.forEach((date,i)=>rows.push([date,...ORDER.map(k=>Number.isFinite(s[k]?.[i])?s[k][i]:'')].join(',')));
 const url=URL.createObjectURL(new Blob(['\ufeff'+rows.join('\r\n')],{type:'text/csv;charset=utf-8'}));
 const a=document.createElement('a');a.href=url;a.download=`GRACE_${st.region}_TWSA.csv`;
 document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),3000);
}
// Pairwise metrics (technical users only). No server/NetCDF processing.
// Dates are already aligned in M.dates, with real missing months represented as null.
function agreementMetrics(a,b){
 const paired=[];
 for(let i=0;i<Math.min(a?.length||0,b?.length||0);i++){
  const x=a[i],y=b[i];if(Number.isFinite(x)&&Number.isFinite(y))paired.push([x,y]);
 }
 const n=paired.length;
 if(n<3)return {n,r:null,nse:null,rmse:null};
 const ma=paired.reduce((s,p)=>s+p[0],0)/n;
 const mb=paired.reduce((s,p)=>s+p[1],0)/n;
 let cov=0,sa=0,sb=0,se=0;
 for(const [x,y] of paired){
  cov+=(x-ma)*(y-mb);sa+=(x-ma)**2;sb+=(y-mb)**2;se+=(x-y)**2;
 }
 return {n,r:sa>0&&sb>0?cov/Math.sqrt(sa*sb):null,
  nse:sb>0?1-se/sb:null,rmse:Math.sqrt(se/n)};
}
function updateTechnicalMetrics(){
 if(!$('metricsModal') || $('metricsModal').hidden)return;
 const a=$('metricA').value,b=$('metricB').value;
 const title=`Region: ${region(st.region)?.name||'Selected area'}`;
 $('metricScope').textContent=title;
 const reset=()=>{for(const id of ['metricCorr','metricNse','metricRmse'])$(id).textContent='—';};
 if(a===b){reset();$('metricNote').textContent='Choose two different datasets.';return;}
 const s=activeSeries();
 if(!s){reset();$('metricNote').textContent='Region data unavailable.';return;}
 const v=agreementMetrics(s[a],s[b]);
 $('metricCorr').textContent=Number.isFinite(v.r)?v.r.toFixed(3):'—';
 $('metricNse').textContent=Number.isFinite(v.nse)?v.nse.toFixed(3):'—';
 $('metricRmse').textContent=Number.isFinite(v.rmse)?v.rmse.toFixed(2):'—';
 $('metricNote').textContent=v.n<3?
   `Only ${v.n} paired months; at least 3 are needed.`:
   `${v.n} common observed months. NSE uses Dataset B as reference. Baseline differences affect NSE/RMSE; product agreement is not absolute accuracy.`;
}

function controls(){
 // Simple interface for all visitors; technical settings remain collapsed.
 function setTechnical(open){
  $('technicalContent').hidden=!open;
  $('technicalToggle').setAttribute('aria-expanded',String(open));
  $('panel').classList.toggle('expanded',open);
  document.body.classList.toggle('technical-expanded',open);
  if(open)updateTechnicalMetrics();
 }
 $('technicalToggle').addEventListener('click',()=>setTechnical($('technicalContent').hidden));
 // Close advanced controls whenever the visitor returns to the map/timeline or a public button.
 document.addEventListener('pointerdown',e=>{
  if(!$('technicalContent').hidden && !e.target.closest('#panel'))setTechnical(false);
 },{capture:true});
 document.addEventListener('keydown',e=>{if(e.key==='Escape')setTechnical(false);});
 setTechnical(false);
 function closeMetrics(){
  $('metricsModal').hidden=true;$('metricsBackdrop').hidden=true;
  $('metricsToggle').setAttribute('aria-expanded','false');
 }
 $('metricsToggle').addEventListener('click',()=>{
  setTechnical(false);
  $('metricsModal').hidden=false;$('metricsBackdrop').hidden=false;
  $('metricsToggle').setAttribute('aria-expanded','true');
  updateTechnicalMetrics();$('metricA').focus();
 });
 $('closeMetrics').addEventListener('click',closeMetrics);
 $('metricsBackdrop').addEventListener('click',closeMetrics);
 document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('metricsModal').hidden)closeMetrics();});
 for(const layer of ORDER){
  $('metricA').add(new Option(M.labels[layer],layer));
  $('metricB').add(new Option(M.labels[layer],layer));
 }
 $('metricA').value='tws_m';$('metricB').value='obs_m';
 $('metricA').addEventListener('change',updateTechnicalMetrics);
 $('metricB').addEventListener('change',updateTechnicalMetrics);
 const chooseSimple=layer=>{
  $('layerSelect').value=layer;
  $('layerSelect').dispatchEvent(new Event('change'));
 };
 $('quickDownscaled').addEventListener('click',()=>chooseSimple('tws_m'));
 $('publicOpacity').addEventListener('input',e=>{
  const value=e.target.value;$('opacity').value=value;$('opacityLabel').textContent=value+'%';
  $('publicOpacityLabel').textContent=value+'%';st.overlay?.setOpacity(Number(value)/100);
 });
 $('publicClose').addEventListener('click',closePublicTimeSeries);
 $('publicBackdrop').addEventListener('click',closePublicTimeSeries);
 $('publicTrend').addEventListener('change',e=>{
  st.publicTrend=e.target.checked;renderPublicChart();
 });
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&st.publicOpen)closePublicTimeSeries();
 });
 $('quickOriginal').addEventListener('click',()=>chooseSimple('obs_m'));
 $('quickDownscaled1km').addEventListener('click',()=>chooseSimple('tws_m_1km'));
 if(!(M.available.tws_m_1km||[]).length){
  $('quickDownscaled1km').disabled=true;
  $('quickDownscaled1km').title='No 1-km Thailand observations have been included in this build';
 }

 $('tabTime').addEventListener('click',()=>setAnalysisTab('time'));
 $('tabSpatial').addEventListener('click',()=>setAnalysisTab('spatial'));
 $('analysisBackdrop').addEventListener('click',()=>toggleChart(false));
 document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&st.chartOpen)toggleChart(false);
 });
 $('layerSelect').add(new Option('No GRACE layer (basemap only)','none'));
 ORDER.forEach(k=>{$('layerSelect').add(new Option(M.labels[k],k));});
 const visibleRegions=M.regions.filter(r=>r.id!=='footprint'&&r.id!=='tonle_sap_basin');
 // Group administrative Level-2 units by country. Their geometry and
 // names are extracted from NAME_2 of each supplied *_adm2.shp file.
 const ordinary=visibleRegions.filter(r=>!r.id.startsWith('level2_'));
 const level2=visibleRegions.filter(r=>r.id.startsWith('level2_'));
 const byCountry=new Map();
 for(const item of level2){
  const suffix=item.name.match(/\(([^()]+)\)$/);
  const country=suffix?suffix[1]:'Administrative Level-2';
  if(!byCountry.has(country))byCountry.set(country,[]);
  byCountry.get(country).push(item);
 }
 function addRegionsToSelect(select){
  for(const r of ordinary)select.add(new Option(r.name,r.id));
  for(const [country,items] of [...byCountry.entries()].sort((a,b)=>a[0].localeCompare(b[0]))){
   const group=document.createElement('optgroup');group.label=`${country} — Level 2`;
   items.sort((a,b)=>a.name.localeCompare(b.name)).forEach(r=>group.append(new Option(r.name,r.id)));
   select.append(group);
  }
 }
 for(const select of [$('regionSelect'),$('spatialRegionSelect'),$('timeRegionSelect')]){
  if(!select)continue;
  addRegionsToSelect(select);
  if(select!==$('regionSelect'))select.addEventListener('change',e=>chooseRegion(e.target.value,false));
 }
 // Time-series dropdown can isolate one product, while checkboxes still
 // allow adding additional products back for comparison.
 $('timeLayerSelect').add(new Option('Multiple selected datasets','multiple'));
 for(const id of ORDER){
  $('timeLayerSelect').add(new Option(M.labels[id],id));
  $('spatialLayerSelect').add(new Option(M.labels[id],id));
 }
 $('timeLayerSelect').value='multiple';
 $('timeLayerSelect').addEventListener('change',event=>{
  const selected=event.target.value;
  if(selected==='multiple')return;
  for(const id of ORDER){
   st.series[id]=id===selected;
   const cb=document.querySelector(`[data-layer="${id}"]`);
   if(cb)cb.checked=st.series[id];
  }
  $('layerSelect').value=selected;
  $('layerSelect').dispatchEvent(new Event('change'));
  drawChart();
 });
 $('spatialLayerSelect').addEventListener('change',event=>{
  $('layerSelect').value=event.target.value;
  $('layerSelect').dispatchEvent(new Event('change'));
 });
 const startRegion=visibleRegions.find(r=>r.id==='southeast_asia')||visibleRegions[0];
 if(startRegion){st.region=startRegion.id;$('regionSelect').value=st.region;
  if($('spatialRegionSelect'))$('spatialRegionSelect').value=st.region;
  if($('timeRegionSelect'))$('timeRegionSelect').value=st.region;}
 $('layerSelect').value=st.layer; // The initial map and visible dropdown must agree.
 $('spatialLayerSelect').value=st.layer;
 // Region and raster in analysis follow the current map selection.
 for(let y=Number(M.dates[0].slice(0,4));y<=Number(M.dates.at(-1).slice(0,4));y++)$('yearSelect').add(new Option(String(y),String(y)));
 MONTHS.forEach((m,i)=>$('monthSelect').add(new Option(m.slice(0,3),String(i+1).padStart(2,'0'))));
 $('monthSlider').min='0';$('monthSlider').max=String(M.dates.length-1);
 M.dates.forEach((date,i)=>{
  const elem=document.createElement('span');elem.title=`${friendly(date)}: ${has(st.layer==='none'?'tws_m':st.layer,i)?'data':'gap'}`;
  elem.className=has(st.layer,i)?'observed':'';elem.addEventListener('click',()=>setMonth(i));$('availability').append(elem);
 });
 $('layerSelect').addEventListener('change',e=>{
   stopPlayback();st.layer=e.target.value;
   for(const [id,key] of [['quickDownscaled','tws_m'],['quickOriginal','obs_m'],['quickDownscaled1km','tws_m_1km']]){
     $(id).classList.toggle('active',st.layer===key);
     $(id).setAttribute('aria-pressed',String(st.layer===key));
   }
   if(ORDER.includes(st.layer))$('spatialLayerSelect').value=st.layer;
   updateLegend();updateAvailability();updateDateSelectors();showOverlay();updateTechnicalMetrics();if(st.chartOpen&&st.activeTab==='spatial')drawRegionalSpatialMap();
 });
 $('regionSelect').addEventListener('change',e=>chooseRegion(e.target.value,true));
 $('basemapSelect').addEventListener('change',e=>chooseBase(e.target.value));
 $('opacity').addEventListener('input',e=>{$('opacityLabel').textContent=e.target.value+'%';$('publicOpacity').value=e.target.value;$('publicOpacityLabel').textContent=e.target.value+'%';st.overlay?.setOpacity(+e.target.value/100);});
 $('applyColors').addEventListener('click',applyColors);
  $('resetColors').addEventListener('click',()=>{$('colorMin').value=-50;$('colorMax').value=50;applyColors();});
 ['colorMin','colorMax'].forEach(id=>$(id).addEventListener('keydown',e=>{if(e.key==='Enter')applyColors();}));
 $('yearSelect').addEventListener('change',changeSelectors);$('monthSelect').addEventListener('change',changeSelectors);
 $('monthSlider').addEventListener('input',e=>{stopPlayback();setMonth(Number(e.target.value));});
 $('prev').addEventListener('click',()=>{stopPlayback();setMonth(st.month-1);});$('next').addEventListener('click',()=>{stopPlayback();setMonth(st.month+1);});
 $('play').addEventListener('click',togglePlay);
 $('showChart').addEventListener('click',()=>toggleChart(true,'time','technical'));$('closeChart').addEventListener('click',()=>toggleChart(false));
 $('csvButton').addEventListener('click',downloadCsv);
 $('timePngButton').addEventListener('click',downloadTimePng);
 $('spatialPngButton').addEventListener('click',downloadSpatialPng);
 $('trendToggle').addEventListener('change',e=>{st.showTrend=e.target.checked;drawChart();});
 document.querySelectorAll('[data-layer]').forEach(input=>input.addEventListener('change',()=>{
  st.series[input.dataset.layer]=input.checked;
  const selected=ORDER.filter(id=>st.series[id]);
  $('timeLayerSelect').value=selected.length===1?selected[0]:'multiple';
  drawChart();
 }));

 // Plotly provides its own high-quality hover and zoom interactions.
 
 
 $('aboutButton').addEventListener('click',()=>$('aboutDialog').showModal());
 $('closeAbout').addEventListener('click',()=>$('aboutDialog').close());
 window.addEventListener('resize',()=>{st.map?.invalidateSize();positionMapControls();if(st.publicOpen)renderPublicChart();if(st.plotReady&&st.chartOpen&&st.activeTab==='time')Plotly.Plots.resize($('plot'));});
 const start=M.dates.indexOf(M.available.tws_m?.[0]);setMonth(start>=0?start:0);updateLegend();
}
function updateAvailability(){
 [...$('availability').children].forEach((span,i)=>{
    span.classList.toggle('observed',has(st.layer==='none'?'tws_m':st.layer,i));
    span.title=`${friendly(M.dates[i])}: ${has(st.layer==='none'?'tws_m':st.layer,i)?'observed':'missing'}`;
 });
}

// WELCOME GUIDE — MANUAL OPEN ONLY on every device.
// Desktop: normal modal dialog when the visitor clicks "? Guide".
// Mobile (<=640px): non-modal, compact dropdown below the header.
// Do not auto-open on page load. No preference tracking is needed.
function initializeWelcomeGuide(){
 const dialog=$('welcomeDialog');
 const opener=$('openWelcome');
 const close=$('welcomeClose');
 const start=$('welcomeStart');
 const title=$('welcomeTitle');
 if(!dialog||!opener||!close||!start)return;
 const compact=window.matchMedia('(max-width: 640px)');
 let openedOnMobile=false;

 function dismiss(){
  if(dialog.open)dialog.close();
  openedOnMobile=false;
  dialog.classList.remove('mobile-guide');
  dialog.setAttribute('aria-modal','false');
  opener.setAttribute('aria-expanded','false');
 }

 function openGuide(){
  // Clicking Guide twice closes its dropdown/dialog.
  if(dialog.open){dismiss();return;}
  openedOnMobile=compact.matches;
  dialog.classList.toggle('mobile-guide',openedOnMobile);
  dialog.setAttribute('aria-modal',String(!openedOnMobile));
  opener.setAttribute('aria-expanded','true');
  if(openedOnMobile)dialog.show(); // Dropdown: no full-screen dimming or blocked map.
  else dialog.showModal();        // Desktop: only opens after the user clicks Guide.
  // Keep keyboard focus on the title, not the X button (avoids the initial
  // orange focus ring/cross seen in the previous desktop welcome popup).
  if(title)title.focus({preventScroll:true});
 }

 opener.setAttribute('aria-expanded','false');
 opener.addEventListener('click',openGuide);
 close.addEventListener('click',dismiss);
 start.addEventListener('click',dismiss);
 dialog.addEventListener('cancel',event=>{event.preventDefault();dismiss();});
 dialog.addEventListener('close',()=>{
  openedOnMobile=false;
  dialog.classList.remove('mobile-guide');
  dialog.setAttribute('aria-modal','false');
  opener.setAttribute('aria-expanded','false');
 });
 dialog.addEventListener('click',event=>{
  // On desktop, clicking the shaded backdrop closes the modal.
  if(event.target===dialog&&!openedOnMobile)dismiss();
 });
 document.addEventListener('pointerdown',event=>{
  // On phones the Guide behaves like a dropdown and closes on an outside tap.
  if(openedOnMobile&&dialog.open &&
     !dialog.contains(event.target) && !opener.contains(event.target))dismiss();
 });
 // If the viewport crosses the phone/desktop threshold, close the old layout.
 if(compact.addEventListener)compact.addEventListener('change',dismiss);
 else if(compact.addListener)compact.addListener(dismiss);
 // Deliberately no requestAnimationFrame(openGuide) on initial page load.
}
function init(){
 if(!M||!R||!B){document.body.textContent='Generated data not found. Build the website using build_dashboard.py, then open grace_site/index.html.';return;}
 trimTimelineToObservations();controls();describeStudy();initializeMap();positionMapControls();installDraggableAnalysis();initializeWelcomeGuide();
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(positionMapControls).observe(document.querySelector('.timeline'));
}
window.addEventListener('DOMContentLoaded',init);
