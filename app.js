/* GRACE Explorer V39: repair post-zoom large-boundary hover without polygon scanning.
   Based on V38 recovery, leaves country/district selection and data unchanged.
   Static data arrives only as classic JavaScript files.
   No fetch(), XHR, module imports, or local web server required. */
'use strict';
const $=id=>document.getElementById(id);
const M=window.GRACE_MANIFEST, R=window.GRACE_REGION_SERIES;
// Boundaries are loaded after the first map frame so heavy Level-2 JSON does not block the initial map.
let B=window.GRACE_BOUNDARIES||null;
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
    overlayToken:0,overlayLayer:null,lut:null,lutKey:null,showTrend:false,footprint:null,trimStart:0,trimEnd:null,regionalRenderToken:0,activeTab:"time",analysisOrigin:'technical',publicOpen:false,publicSeries:Object.fromEntries(ORDER.map(k=>[k,true])),publicTrend:true,mobileTapRegion:null,mobileTapLatLng:null};
function friendly(date){const [y,m]=date.split('-').map(Number);return `${MONTHS[m-1]} ${y}`;}
function pretty(x,n=2){return Number.isFinite(x)?Number(x).toFixed(n):'—';}
function say(message){const n=$('toast');n.textContent=message;n.classList.add('show');clearTimeout(say.t);say.t=setTimeout(()=>n.classList.remove('show'),3000);}
function has(layer,i){return (M.available[layer]||[]).includes(M.dates[i]);}
// V36: one standard Leaflet + zoom step above the initial overview enables Level-2.
// The threshold is calculated after fitBounds, not hardcoded (screen sizes differ).
// It is shared by the renderers, geographic hit testing and lazy chunk loader.
let LEVEL2_SELECTION_ZOOM=6.5;
let level2WasActive=false;
const onDetailZoom=()=>Boolean(st.map)&&st.map.getZoom()>=LEVEL2_SELECTION_ZOOM;
function clearBoundarySelection(){
 if(st.region==='footprint')return;
 st.previousBoundary=st.region;
 st.region='footprint';
 for(const id of ['regionSelect','timeRegionSelect','spatialRegionSelect']){
  const select=$(id);if(select)select.value='';
 }
 outlineRegion();
}
function syncBoundarySelectionMode(){
 const detail=onDetailZoom();
 // On returning to overview, release an old Level-2 selection; keep any
 // explicitly selected country (especially during a Technical-use fitBounds).
 if(detail!==level2WasActive){
  level2WasActive=detail;
  hideMobileBoundaryCard();
  resetActiveBoundaryHover();
  st.map?.closeTooltip?.();
  if(!detail && (st.region.startsWith('level2_') || region(st.region)?.kind==='level2') && !st.chartOpen && !st.publicOpen)
   clearBoundarySelection();
 }
 // Prevent invisible district hit targets from blocking a country after zoom-out.
 if(!detail){
  if(st.level2Regions&&st.map?.hasLayer(st.level2Regions))st.map.removeLayer(st.level2Regions);
  st.regions?.bringToFront();
 }
}
const REGION_BY_ID=new Map((M?.regions||[]).map(r=>[r.id,r]));
function region(id){return REGION_BY_ID.get(id);}
function monthPath(layer,date){
 // Fast display rasters are optional. Full-resolution numeric fields remain untouched.
 const root=M.fastDisplayMaps?'fast_maps':'maps';
 return `data/${root}/${layer}/${date.slice(0,4)}/${date}.webp`;
}
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
 st.trimStart=begin;st.trimEnd=end+1;
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
 if(!st.playing||st.layer==='none'||!defaultColors()|| (useTapBoundaryPopup()&&st.map?._animatingZoom))return;
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
// V39: Leaflet Canvas stores the last hovered polygon in renderer._hoveredLayer.
// Zoom can cause a synthetic mouseover while hover is temporarily disarmed,
// leaving that cache set even though our cyan highlight never started.
// The next real mouse movement must clear the cache so Leaflet emits a NEW
// mouseover. Track only the TWO currently active renderers (not every polygon).
let hoveredBoundary=null;
let boundaryHoverArmed=false;
let overviewHoverRenderer=null;
let detailHoverRenderer=null;
function resetCanvasHoverCache(){
 for(const renderer of [overviewHoverRenderer,detailHoverRenderer]){
  if(renderer && renderer._hoveredLayer)renderer._hoveredLayer=null;
 }
}
function resetActiveBoundaryHover(clearRendererCache=true){
 const current=hoveredBoundary;
 hoveredBoundary=null;
 if(current){
  if(current.layer._graceHoverFrame!=null){
   cancelAnimationFrame(current.layer._graceHoverFrame);
   current.layer._graceHoverFrame=null;
  }
  if(current.layer._map)current.layer.setStyle(boundaryStyle(current.feature));
  current.layer.closeTooltip?.();
 }
 if(clearRendererCache)resetCanvasHoverCache();
}
function installLightweightHoverReset(map){
 const container=map.getContainer?.();
 if(container){
  // Capture precedes Leaflet Canvas's mousemove handler: the FIRST genuine
  // mouse movement after zoom re-arms and can trigger a fresh mouseover.
  container.addEventListener('pointermove',event=>{
   if(event.pointerType==='touch')return;
   if(!boundaryHoverArmed){
    resetCanvasHoverCache();
    boundaryHoverArmed=true;
   }
  },{capture:true,passive:true});
  container.addEventListener('pointerleave',()=>{
   boundaryHoverArmed=false;
   resetActiveBoundaryHover();
  },{passive:true});
 }
 map.on('zoomstart',()=>{boundaryHoverArmed=false;resetActiveBoundaryHover();});
 map.on('zoomend',()=>{boundaryHoverArmed=false;resetActiveBoundaryHover();});
 map.on('dragstart',()=>{boundaryHoverArmed=false;resetActiveBoundaryHover();});
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
 // Sort only the small country/basin collection, not thousands of Level-2 polygons.
 // Fine boundaries are rendered separately above the countries at close zoom.
 const visible=B.features.filter(f=>!['southeast_asia','tonle_sap_basin'].includes(f.properties?.id));
 const area=f=>{const b=region(f.properties?.id)?.bbox;
  return b?Math.abs((b[2]-b[0])*(b[3]-b[1])):Infinity;};
 return visible.filter(f=>f.properties?.kind!=='level2').sort((a,b)=>area(b)-area(a))
         .concat(visible.filter(f=>f.properties?.kind==='level2'));
}
function openAreaTimeSeries(id){
 if(!region(id))return;
 hideMobileBoundaryCard();
 st.map?.closePopup();
 chooseRegion(id,false);
 openPublicTimeSeries();
}

// TOUCH-FRIENDLY BOUNDARY INTERACTION (frontend only; no GRACE data changes).
// On phones/tablets, a first tap selects the real polygon and shows a small
// Leaflet popup near the tapped location. Only the popup's Time series button
// opens the chart. Desktop single/double-click still opens the chart directly.
function useTapBoundaryPopup(){
 return Boolean(window.matchMedia?.('(hover: none), (pointer: coarse)').matches) || window.innerWidth <= 700;
}
// Display an ordinary HTML card, not a Leaflet popup. This remains tappable
// even while district canvas layers redraw after a mobile zoom or pan.
function hideMobileBoundaryCard(){
 const card=$('mobileBoundaryCard');
 if(card)card.hidden=true;
 st.mobileTapRegion=null;st.mobileTapLatLng=null;
}
function positionMobileBoundaryCard(){
 const card=$('mobileBoundaryCard'),map=st.map;
 if(!card||card.hidden||!map||!st.mobileTapLatLng)return;
 const bounds=$('map').getBoundingClientRect();
 const pt=map.latLngToContainerPoint(st.mobileTapLatLng);
 const rect=card.getBoundingClientRect();
 const width=rect.width||260,height=rect.height||145;
 const x=bounds.left+pt.x,y=bounds.top+pt.y;
 let left=Math.max(8,Math.min(window.innerWidth-width-8,x-width/2));
 let top=y-height-13;
 if(top<66)top=y+18;
 top=Math.max(66,Math.min(window.innerHeight-height-14,top));
 card.style.left=Math.round(left)+'px';
 card.style.top=Math.round(top)+'px';
}
function showTapBoundaryPopup(id,latlng){
 const r=region(id),map=st.map,card=$('mobileBoundaryCard');
 if(!r||!map||!card)return;
 chooseRegion(id,false);
 st.boundaryLayers.get(id)?.layer?.closeTooltip?.();
 const date=M.dates[st.month],v=R?.[id]?.[st.layer]?.[st.month];
 $('mobileBoundaryName').textContent=r.name||'Selected area';
 $('mobileBoundaryValue').textContent=st.layer==='none'?
   `${date} · No GRACE layer selected`:
   Number.isFinite(v)?`${date} · Mean TWSA: ${v.toFixed(2)} cm`:
   `${date} · TWSA unavailable`;
 st.mobileTapRegion=id;
 const box=r.bbox;
 st.mobileTapLatLng=latlng||(box?L.latLng((box[0]+box[2])/2,(box[1]+box[3])/2):map.getCenter());
 card.hidden=false;
 requestAnimationFrame(positionMobileBoundaryCard);
}
// GeoJSON point-in-polygon fallback: mobile click is not dependent on a Leaflet
// canvas feature being drawn or receiving the event. Polygon holes are excluded.
function pointInsideRing(lon,lat,ring){
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [xi,yi]=ring[i],[xj,yj]=ring[j];
  if((yi>lat)!==(yj>lat) && lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)inside=!inside;
 }
 return inside;
}
function pointInsideGeometry(lon,lat,geom){
 if(!geom)return false;
 const polygons=geom.type==='Polygon'?[geom.coordinates]:
   geom.type==='MultiPolygon'?geom.coordinates:[];
 return polygons.some(poly=>Array.isArray(poly)&&poly.length>0&&
  pointInsideRing(lon,lat,poly[0])&&
  !poly.slice(1).some(hole=>pointInsideRing(lon,lat,hole)));
}
let touchFeatureIndex=null;
// Geographic hit testing is the selection authority on BOTH mobile and desktop.
// Relying on whichever overlapping Leaflet Canvas happens to receive the event
// can leave a district intercepting a country click after zooming out.
function touchRegionAt(latlng){
 if(!B?.features)return null;
 if(!touchFeatureIndex){
  touchFeatureIndex=B.features.flatMap(f=>{
   const id=f.properties?.id,r=region(id);
   return r&&!['footprint','southeast_asia','tonle_sap_basin'].includes(id)&&r.bbox
     ?[{id,bbox:r.bbox,feature:f,level2:f.properties?.kind==='level2',
        size:Math.abs((r.bbox[2]-r.bbox[0])*(r.bbox[3]-r.bbox[1]))}]:[];
  });
 }
 const lon=((latlng.lng+180)%360+360)%360-180,lat=latlng.lat;
 const allowLevel2=(st.map?.getZoom()??0)>=LEVEL2_SELECTION_ZOOM;
 let small=null,large=null;
 for(const item of touchFeatureIndex){
  if(item.level2&&!allowLevel2)continue;
  const [south,west,north,east]=item.bbox;
  if(lat<south||lat>north||lon<west||lon>east)continue;
  const candidate=item.level2?small:large;
  if(candidate&&item.size>=candidate.size)continue;
  if(!pointInsideGeometry(lon,lat,item.feature.geometry))continue;
  if(item.level2)small=item;
  else large=item;
 }
 return (allowLevel2?small?.id:null)||large?.id||null;
}
// One handler for actual boundary clicks and geographic fallback map clicks.
// An overlapping district can never supersede a country below the threshold.
function pickClickedRegion(clickedId,latlng){
 const geographicHit=latlng?touchRegionAt(latlng):null;
 if(geographicHit)return geographicHit;
 // Never use a stale district renderer as a fallback at country-level zoom.
 if(region(clickedId)?.kind==='level2' && (st.map?.getZoom()??0)<LEVEL2_SELECTION_ZOOM)return null;
 return clickedId;
}

function installMobileBoundaryFallback(map){
 // Native map click is fired after a tap, not a drag.
 map.on('click',event=>{
  // Leaflet Canvas may miss a country click immediately after removing a
  // district renderer; direct polygon hit testing keeps selection reliable.
  const id=touchRegionAt(event.latlng);
  if(useTapBoundaryPopup()){
   if(id)showTapBoundaryPopup(id,event.latlng);
   else hideMobileBoundaryCard();
  }else if(id){
   openAreaTimeSeries(id);
  }
 });
 // Capture pointer events at the map itself as a second path. Some mobile
 // browsers don't deliver a Leaflet feature-click after panning/Canvas redraw.
 // Only a short, stationary touch counts; swipes still pan normally.
 const element=map.getContainer();
 let origin=null;
 element.addEventListener('pointerdown',event=>{
  if(!useTapBoundaryPopup()||event.pointerType==='mouse')return;
  origin={id:event.pointerId,x:event.clientX,y:event.clientY,time:performance.now()};
 },true);
 element.addEventListener('pointercancel',()=>{origin=null;},true);
 element.addEventListener('pointerup',event=>{
  if(!origin||event.pointerId!==origin.id)return;
  const move=Math.hypot(event.clientX-origin.x,event.clientY-origin.y);
  const duration=performance.now()-origin.time;
  origin=null;
  if(move>11||duration>650||!useTapBoundaryPopup())return;
  const rect=element.getBoundingClientRect();
  const latlng=map.containerPointToLatLng([event.clientX-rect.left,event.clientY-rect.top]);
  const id=touchRegionAt(latlng);
  if(id)showTapBoundaryPopup(id,latlng);
 },true);
 map.on('dragstart',hideMobileBoundaryCard);
 map.on('zoomstart',hideMobileBoundaryCard);
 map.on('resize',()=>{if(st.mobileTapRegion)positionMobileBoundaryCard();});
}

function installBoundaryInteractions(map){
 const features=regionFeatures();if(!features.length)return;
 const configure=(feature,layer)=>{
  const id=feature.properties?.id;
  const name=feature.properties?.name||region(id)?.name||'Selected area';
  // Keep ONE interactive layer for every boundary. The old extra SVG outline
  // could cover the same polygon after the chart was closed and stop re-clicks.
  if(id)st.boundaryLayers.set(id,{layer,feature});
  // onEachFeature runs BEFORE Leaflet mounts the Canvas renderer. Register
  // the real instance on the layer's add event (constant memory per zoom).
  if(!useTapBoundaryPopup()){
   layer.on('add',()=>{
    if(feature.properties?.kind==='level2')detailHoverRenderer=layer._renderer||null;
    else overviewHoverRenderer=layer._renderer||null;
   });
   // Native Leaflet hover only: never scan all district polygons on mousemove.
   layer.bindTooltip(name,{sticky:true,direction:'top',className:'grace-region-tip'});
   layer.on('mouseover',()=>{
    if(!boundaryHoverArmed || st.map?._animatingZoom){layer.closeTooltip?.();return;}
    if(hoveredBoundary && hoveredBoundary.layer!==layer)resetActiveBoundaryHover(false);
    hoveredBoundary={layer,feature};
    animateBoundaryHover(layer,feature,true);
   });
   layer.on('mouseout',()=>{
    if(hoveredBoundary?.layer===layer){
     hoveredBoundary=null;
     animateBoundaryHover(layer,feature,false);
    }
   });
  }
  layer.on('click',event=>{
   if(!id||!region(id))return;
   if(event.originalEvent)L.DomEvent.stopPropagation(event.originalEvent);
   const picked=pickClickedRegion(id,event.latlng);
   if(!picked||!region(picked))return;
   if(useTapBoundaryPopup()){
    // Native touch map panning is unchanged; taps show the small action card.
    showTapBoundaryPopup(picked,event.latlng);
   }else{
    openAreaTimeSeries(picked);
   }
  });
  layer.on('dblclick',event=>{
   if(!id||!region(id))return;
   if(event.originalEvent)L.DomEvent.stop(event.originalEvent);
   if(useTapBoundaryPopup())return;
   const picked=pickClickedRegion(id,event.latlng);
   if(picked&&region(picked))openAreaTimeSeries(picked);
  });
 };
 const overview=features.filter(f=>f.properties?.kind!=='level2');
 const detail=features.filter(f=>f.properties?.kind==='level2');
 const desktopOptions={style:boundaryStyle,interactive:true,bubblingMouseEvents:false,
                       renderer:L.canvas({padding:.4}),onEachFeature:configure};
 st.regions=L.geoJSON({type:'FeatureCollection',features:overview},desktopOptions).addTo(map);
 if(detail.length){
  // Viewport-based Level-2 drawing for desktop AND phones.
  // Keep only the administrative features that intersect the current map view.
  // Scientific data, original polygons and clickable geometry are never changed.
  const touch=useTapBoundaryPopup();
  const minDetailZoom=LEVEL2_SELECTION_ZOOM;
  const options={style:boundaryStyle,interactive:true,bubblingMouseEvents:false,
    smoothFactor:touch?2.1:1.25,renderer:L.canvas({padding:touch?.12:.28}),onEachFeature:configure};
  const boundsById=new Map(detail.map(f=>[f.properties?.id,region(f.properties?.id)?.bbox]));
  let visibleIds=new Set(),lastKey='',pending=0;
  const sync=()=>{
   pending=0;
   if(map.getZoom()<minDetailZoom){
    if(st.level2Regions&&map.hasLayer(st.level2Regions))map.removeLayer(st.level2Regions);
    for(const id of visibleIds)st.boundaryLayers.delete(id);
    visibleIds=new Set();lastKey='';st.level2Regions=null;
    return;
   }
   const b=map.getBounds(),pad=touch?.45:.30;
   const w=b.getWest()-pad,e=b.getEast()+pad,s=b.getSouth()-pad,n=b.getNorth()+pad;
   const items=detail.filter(f=>{
    const box=boundsById.get(f.properties?.id);
    return box && box[1]<=e && box[3]>=w && box[0]<=n && box[2]>=s;
   });
   const nextKey=items.map(f=>f.properties?.id).join('|');
   if(nextKey===lastKey&&st.level2Regions&&map.hasLayer(st.level2Regions))return;
   const oldLayer=st.level2Regions;
   if(oldLayer&&map.hasLayer(oldLayer))map.removeLayer(oldLayer);
   for(const id of visibleIds)st.boundaryLayers.delete(id);
   visibleIds=new Set(items.map(f=>f.properties?.id));
   lastKey=nextKey;
   st.level2Regions=items.length
     ?L.geoJSON({type:'FeatureCollection',features:items},options).addTo(map)
     :null;
  };
  const schedule=()=>{
   if(pending)cancelAnimationFrame(pending);
   pending=requestAnimationFrame(sync);
  };
  map.on('moveend zoomend',schedule);
  schedule();
 }

 // Immediately restore large-boundary click targets on zoom-out, before
 // the deferred Level-2 viewport refresh. This also handles rapid wheel zoom.
 map.on('zoomend',()=>{
  if(map.getZoom()>=LEVEL2_SELECTION_ZOOM)return;
  if(st.level2Regions && map.hasLayer(st.level2Regions))map.removeLayer(st.level2Regions);
  st.level2Regions=null;
  for(const [rid,entry] of st.boundaryLayers){
   if(entry.feature?.properties?.kind==='level2')st.boundaryLayers.delete(rid);
  }
  st.regions?.bringToFront();
 });
 if(M.admin2LazyVersion===34&&Array.isArray(M.admin2Chunks))installLazyLevel2(map,configure);
}
// V34 lazy district architecture: the initial manifest and time-series file contain
// ONLY countries/basins. District metadata, precise interactive polygons, and ALL
// original district TWSA arrays stay in small JS chunks until geographically needed.
// This is significantly faster than parsing thousands of regions on initial load.
function installLazyLevel2(map,configure){
 const catalog=M.admin2Chunks||[];
 if(!catalog.length)return;
 const chunks=new Map(),inflight=new Set();
 let queue=[],frame=0,active=0,lastDrawing='',lastQueued='';
 const maxConcurrent=2;  // prevent browser resource contention with Esri tiles
 const detailZoom=LEVEL2_SELECTION_ZOOM;
 const intersects=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
 function currentBounds(padding=0){
  const b=map.getBounds();
  return [b.getSouth()-padding,b.getWest()-padding,b.getNorth()+padding,b.getEast()+padding];
 }
 function installChunk(desc,data){
  chunks.set(desc.id,data);
  for(const r of data.regions||[]){
   if(REGION_BY_ID.has(r.id))continue;
   REGION_BY_ID.set(r.id,r);M.regions.push(r);
   if(data.series?.[r.id]){
    R[r.id]=data.series[r.id];
    if(st.trimEnd!==null){
     for(const key of Object.keys(R[r.id])){
      if(Array.isArray(R[r.id][key]))R[r.id][key]=R[r.id][key].slice(st.trimStart,st.trimEnd);
     }
    }
   }
  }
  // The tap fallback uses the same geometries, but only when a district is loaded.
  const used=new Set(B.features.map(f=>f.properties?.id));
  for(const f of data.features||[])if(!used.has(f.properties?.id))B.features.push(f);
  touchFeatureIndex=null;
  for(const sel of [$('regionSelect'),$('spatialRegionSelect'),$('timeRegionSelect')]){
   if(!sel)continue;
   let group=[...sel.children].find(e=>e.tagName==='OPTGROUP'&&e.dataset.lazyCountry===desc.country);
   if(!group){group=document.createElement('optgroup');group.label=`${desc.country} — Level 2`;
    group.dataset.lazyCountry=desc.country;sel.append(group);}
   const fragment=document.createDocumentFragment();
   for(const r of data.regions||[])fragment.append(new Option(r.name,r.id));
   group.append(fragment);
  }
 }
 function applyVisible(){
  frame=0;
  if(map.getZoom()<detailZoom){
   if(st.level2Regions){map.removeLayer(st.level2Regions);st.level2Regions=null;}
   for(const [id,entry] of st.boundaryLayers)if(entry.feature?.properties?.kind==='level2')st.boundaryLayers.delete(id);
   lastDrawing='';return;
  }
  const extent=currentBounds(.16),features=[];
  const ids=[];
  for(const desc of catalog){
   const data=chunks.get(desc.id);
   if(!data||!intersects(desc.bbox,extent))continue;
   for(const f of data.features||[]){
    const r=REGION_BY_ID.get(f.properties?.id);
    if(r?.bbox&&intersects(r.bbox,extent)){features.push(f);ids.push(r.id);}
   }
  }
  const key=ids.join('|');
  if(key===lastDrawing && st.level2Regions && map.hasLayer(st.level2Regions))return;
  lastDrawing=key;
  if(st.level2Regions){map.removeLayer(st.level2Regions);st.level2Regions=null;}
  for(const [id,entry] of st.boundaryLayers)if(entry.feature?.properties?.kind==='level2')st.boundaryLayers.delete(id);
  if(features.length){
   st.level2Regions=L.geoJSON({type:'FeatureCollection',features},{
    style:boundaryStyle,renderer:L.canvas({padding:.15}),interactive:true,
    bubblingMouseEvents:false,smoothFactor:useTapBoundaryPopup()?2.1:1.5,
    onEachFeature:configure
   }).addTo(map);
  }
 }
 function scheduleDrawing(){if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(applyVisible);}
 function pump(){
  while(active<maxConcurrent&&queue.length){
   const desc=queue.shift();
   if(inflight.has(desc.id)||chunks.has(desc.id))continue;
   active++;inflight.add(desc.id);
   loadScript(desc.file).then(()=>{
    const data=window.GRACE_ADMIN2_CHUNKS?.[desc.id];
    if(!data)throw Error(`Missing district data for ${desc.id}`);
    delete window.GRACE_ADMIN2_CHUNKS[desc.id];
    installChunk(desc,data);
    // Schedule on the next browser frame; do not synchronously build hundreds
    // of Leaflet paths inside a script's onload callback.
    scheduleDrawing();
   }).catch(error=>{console.warn('District chunk could not load:',desc.id,error);})
   .finally(()=>{inflight.delete(desc.id);active--;pump();});
  }
 }
 function update(){
  scheduleDrawing();
  if(map.getZoom()<detailZoom){queue=[];lastQueued='';return;}
  const extent=currentBounds(.25);
  const center=map.getCenter();
  const needed=catalog.filter(d=>intersects(d.bbox,extent)&&!chunks.has(d.id)&&!inflight.has(d.id));
  needed.sort((a,b)=>{
    const da=Math.hypot((a.bbox[0]+a.bbox[2])/2-center.lat,(a.bbox[1]+a.bbox[3])/2-center.lng);
    const db=Math.hypot((b.bbox[0]+b.bbox[2])/2-center.lat,(b.bbox[1]+b.bbox[3])/2-center.lng);
    return da-db;
  });
  const key=needed.map(d=>d.id).join('|');
  if(key===lastQueued)return;
  lastQueued=key;queue=needed;pump();
 }
 let debounce=0;
 const schedule=()=>{clearTimeout(debounce);debounce=setTimeout(update,125);};
 map.on('moveend zoomend',schedule);
 // At the initial Southeast Asia overview no district data is requested at all.
 schedule();
}

// Keep the website responsive while reading its full Level-2 map geometry.
// This also works when index.html is opened locally via file://.
function loadBoundariesOnDemand(){
 if(!st.map || st.regions)return;
 touchFeatureIndex=null;
 if(window.GRACE_BOUNDARIES){
  B=window.GRACE_BOUNDARIES;
  installBoundaryInteractions(st.map);
  return;
 }
 loadScript('data/boundaries.js')
  .then(()=>{
   B=window.GRACE_BOUNDARIES;
   if(B && st.map && !st.regions)installBoundaryInteractions(st.map);
  })
  .catch(error=>{console.error('Boundary data unavailable:',error);say('Some geographic boundaries could not be loaded.');});
}

function initializeMap(){
 if(!window.L){$('error').hidden=false;return;}
 // Preserve V17 natural zoom animation, map controls and tile behavior.
 // Restore ONLY V23 geographic bounds and minimum zoom restrictions.
 const compact=window.innerWidth<700;
 const map=L.map('map',{minZoom:compact?2.5:3,maxZoom:16,zoomSnap:.25,
   worldCopyJump:true,preferCanvas:true,
   maxBounds:[[-26,72],[40,164]],maxBoundsViscosity:.9});st.map=map;
 const opt={maxNativeZoom:17,maxZoom:19,updateWhenIdle:true,keepBuffer:useTapBoundaryPopup()?1:2,
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
 const overviewZoom=map.getZoom();
 // The + / - Leaflet controls normally change zoom by one level. Accommodate
 // floating-point rounding and the existing 0.25 zoom snap without changing zoom animation.
 LEVEL2_SELECTION_ZOOM=overviewZoom+(map.options.zoomDelta||1)-0.001;
 level2WasActive=false;
 // Do not allow zooming out beyond the initial Southeast Asia overview.
 map.setMinZoom(map.getZoom());
 // Switch highlight/selection priority on every completed zoom step.
 // Bind before the asynchronous Level-2 feature loader, so the large layer
 // is always restored even when district scripts have not finished loading.
 map.on('zoomend',syncBoundarySelectionMode);
 installLightweightHoverReset(map);
 // Map tap fallback works even if an administrative canvas path is not rendered.
 installMobileBoundaryFallback(map);
 // Defer the potentially large boundary source until after the initial map draw.
 requestAnimationFrame(()=>setTimeout(loadBoundariesOnDemand,60));
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
 // Keep the previous raster while the next image downloads/decodes. This avoids
 // an empty patch of basemap on GitHub Pages when changing GRACE months.
 const previous=st.overlay;
 if(previous?._graceUrl===url){previous.setOpacity(Number($('opacity').value)/100);return;}
 const next=L.imageOverlay(url,bounds,{
  opacity:0,interactive:false,alt:`${M.labels[layer]} ${date}`
 });
 next._graceUrl=url;
 next.once('load',()=>{
  if(token!==st.overlayToken){if(st.map?.hasLayer(next))st.map.removeLayer(next);return;}
  next.setOpacity(Number($('opacity').value)/100);
  if(previous&&st.map?.hasLayer(previous))st.map.removeLayer(previous);
  st.overlay=next;st.overlayLayer=layer;
  st.regions?.bringToFront();st.level2Regions?.bringToFront();
 });
 next.once('error',()=>{
  if(st.map?.hasLayer(next))st.map.removeLayer(next);
  if(token===st.overlayToken)say('The GRACE map image could not be loaded.');
 });
 next.addTo(st.map);
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
  if(st.mobileTapRegion)showTapBoundaryPopup(st.mobileTapRegion,st.mobileTapLatLng);
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
 if(!id){clearBoundarySelection();return;}
 if(!region(id))return;
 st.region=id;$('regionSelect').value=id;
 if($('spatialRegionSelect'))$('spatialRegionSelect').value=id;
 if($('timeRegionSelect'))$('timeRegionSelect').value=id;
 outlineRegion();
 const r=region(id);if(zoom&&st.map){const b=r.bbox;st.map.fitBounds([[b[0],b[1]],[b[2],b[3]]],{padding:[35,35],maxZoom:8});}
 describeStudy();
 // A region click should open its popup immediately. The SVG chart
 // renders only while its analysis window is visible.
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
// Lightweight accessible public chart using native SVG.
// Technical use has its own lightweight SVG chart with the existing selectors.
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

// Native SVG chart for Technical use: no external plotting library required.
// Dataset toggles, linear trends, month selection and missing-data gaps remain.
const TECH_COLORS={tws_m:'#167da0',tws_m_1km:'#389755',obs_m:'#ad681c',
                   csr:'#7943a7',gsfc:'#198359',jpl:'#b93561'};
function technicalChartSvg(light=false){
 const data=activeSeries(),ids=ORDER.filter(k=>st.series[k]);
 const w=1200,h=490,l=93,r=1165,t=light?85:35,b=light?390:390;
 const n=M.dates.length;
 const values=ids.flatMap(k=>(data?.[k]||[]).filter(Number.isFinite));
 let low=values.length?Math.min(0,...values):-10;
 let high=values.length?Math.max(0,...values):10;
 const pad=Math.max(3,(high-low)*.12);low-=pad;high+=pad;
 const x=i=>n<=1?(l+r)/2:l+(i/(n-1))*(r-l);
 const y=v=>b-(v-low)/(high-low)*(b-t);
 const ink=light?'#233d54':'#ebf5fd',grid=light?'#d6e4ed':'#31516a';
 const result=[];
 if(light){
  result.push(svg('rect',{x:0,y:0,width:w,height:h,fill:'#ffffff'}));
  result.push(svg('text',{x:65,y:41,fill:ink,'font-size':26,'font-weight':700},
   `GRACE water storage · ${region(st.region)?.name||'Selected region'}`));
 } else result.push(svg('rect',{x:0,y:0,width:w,height:h,fill:'#102b43'}));
 for(let z=0;z<=5;z++){
  const v=low+(high-low)*z/5,p=y(v);
  result.push(svg('line',{x1:l,y1:p,x2:r,y2:p,stroke:grid,'stroke-width':1}));
  result.push(svg('text',{x:l-12,y:p+5,'text-anchor':'end',fill:ink,'font-size':16},v.toFixed(0)));
 }
 const years=[];
 for(let i=0;i<n;i++){
  const [yr,month]=M.dates[i].split('-').map(Number);
  if(n<=16){if(i===0||i===n-1||i%2===0)years.push([i,MONTHS[month-1].slice(0,3)+' '+yr]);}
  else if(month===1&&yr%2===0)years.push([i,String(yr)]);
 }
 if(!years.length&&n)years.push([0,M.dates[0]]);
 for(const [i,label] of years){
  result.push(svg('line',{x1:x(i),x2:x(i),y1:b,y2:b+6,stroke:grid}));
  result.push(svg('text',{x:x(i),y:b+27,'text-anchor':'middle',fill:ink,'font-size':15},label));
 }
 for(const id of ids){
  const items=data?.[id]||[],color=light?TECH_COLORS[id]:SERIES_COLORS[id];
  let path='',connect=false,num=0;
  for(let i=0;i<n;i++){
   const v=items[i];if(!Number.isFinite(v)){connect=false;continue;}
   path+=(connect?'L':'M')+x(i).toFixed(2)+' '+y(v).toFixed(2)+' ';
   connect=true;num++;
  }
  if(path)result.push(svg('path',{d:path.trim(),stroke:color,fill:'none',
     'stroke-width':2.15,'stroke-linejoin':'round','stroke-linecap':'round'}));
  if(num>0&&num<=2){for(let i=0;i<n;i++)if(Number.isFinite(items[i]))
   result.push(svg('circle',{cx:x(i),cy:y(items[i]),r:5.2,fill:color}));}
  if(st.showTrend){
   const fit=linearTrend(items);
   if(fit)result.push(svg('line',{x1:x(fit.first),y1:y(fit.intercept+fit.slope*fit.first),
    x2:x(fit.last),y2:y(fit.intercept+fit.slope*fit.last),stroke:color,
    'stroke-width':1.7,'stroke-dasharray':'8 5'}));
  }
 }
 if(n)result.push(svg('line',{x1:x(st.month),x2:x(st.month),y1:t,y2:b,
  stroke:light?'#a67622':'#e9cb7e','stroke-dasharray':'5 5','stroke-width':1.5}));
 result.push(svg('text',{x:(l+r)/2,y:h-20,'text-anchor':'middle',fill:ink,
  'font-size':20,'font-weight':600},'Date'));
 result.push(svg('text',{x:28,y:(t+b)/2,transform:`rotate(-90 28 ${(t+b)/2})`,
  'text-anchor':'middle',fill:ink,'font-size':20,'font-weight':600},'TWSA (cm)'));
 if(!values.length)result.push(svg('text',{x:w/2,y:(t+b)/2,'text-anchor':'middle',
  fill:ink,'font-size':20},'No valid observations for selected datasets'));
 if(light){
  // Compact key on the high-resolution white-background PNG export.
  let keyX=70,keyY=66;
  for(const id of ids){
   const label=M.labels[id]||id;
   const itemWidth=Math.min(265,70+label.length*8);
   if(keyX+itemWidth>w-30){keyX=70;keyY+=24;}
   result.push(svg('line',{x1:keyX,y1:keyY-5,x2:keyX+25,y2:keyY-5,
    stroke:TECH_COLORS[id],'stroke-width':3}));
   result.push(svg('text',{x:keyX+32,y:keyY,fill:ink,'font-size':14},label));
   keyX+=itemWidth;
  }
 }
 return {markup:result.join(''),w,h,l,r,n};
}
function drawChart(){
 if(!st.chartOpen||st.activeTab!=='time')return;
 const target=$('plot'),chart=technicalChartSvg();
 target.setAttribute('viewBox',`0 0 ${chart.w} ${chart.h}`);
 target.setAttribute('preserveAspectRatio','xMidYMid meet');
 target.innerHTML=chart.markup;
 $('trendRates').replaceChildren();
 if(st.showTrend){
  for(const id of ORDER.filter(k=>st.series[k])){
   const fit=linearTrend(activeSeries()?.[id]||[]);
   if(!fit)continue;
   const label=document.createElement('span');label.style.color=SERIES_COLORS[id];
   label.textContent=`${M.labels[id]}: ${fit.slopeCmYear>=0?'+':''}${fit.slopeCmYear.toFixed(3)} cm/year`;
   $('trendRates').append(label);
  }
 }
}
// Reposition month cursor without rebuilding source data or requesting a library.
function updatePlotCursor(){if(st.chartOpen&&st.activeTab==='time')drawChart();}
function installTechnicalChartClick(){
 const target=$('plot');
 target.addEventListener('click',event=>{
  if(!st.chartOpen||st.activeTab!=='time'||!M.dates.length)return;
  const point=target.createSVGPoint();point.x=event.clientX;point.y=event.clientY;
  const ctm=target.getScreenCTM();if(!ctm)return;
  const loc=point.matrixTransform(ctm.inverse());
  const l=93,r=1165;
  if(loc.x<l||loc.x>r)return;
  const idx=Math.round((loc.x-l)/(r-l)*(M.dates.length-1));
  if(idx>=0&&idx<M.dates.length)setMonth(idx);
 });
}
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
 const data=activeSeries(),ids=ORDER.filter(k=>st.series[k]);
 if(!data||!ids.some(k=>(data[k]||[]).some(Number.isFinite))){
  say('No time-series observations to export.');return;
 }
 try{
  const chart=technicalChartSvg(true);
  const svgText=`<svg xmlns="http://www.w3.org/2000/svg" width="${chart.w}" height="${chart.h}" viewBox="0 0 ${chart.w} ${chart.h}">${chart.markup}</svg>`;
  const uri='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svgText);
  const img=new Image();
  await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=uri;});
  const canvas=document.createElement('canvas');canvas.width=chart.w*2;canvas.height=chart.h*2;
  const ctx=canvas.getContext('2d');if(!ctx)throw Error('Canvas not available');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(img,0,0,canvas.width,canvas.height);
  await savePng(canvas,`GRACE_TimeSeries_${filePart(st.region)}_${M.dates[st.month]}.png`);
 }catch(err){console.error(err);say('Time-series PNG download failed.');}
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
 // Phone-only collapsible datasets: reduce map obstruction and accidental lag.
 // Desktop always keeps the three big buttons and opacity slider expanded.
 const quickToggle=$('quickLayerToggle');
 const quickPanel=$('quickLayerContent');
 const quickCurrent=$('quickLayerCurrent');
 const quickNav=document.querySelector('.quick-layers');
 const isPhoneQuick=()=>window.innerWidth<=700;
 function setQuickOpen(open){
  if(!quickToggle||!quickPanel||!quickNav)return;
  const expanded=isPhoneQuick()&&Boolean(open);
  quickNav.classList.toggle('mobile-open',expanded);
  quickToggle.setAttribute('aria-expanded',String(expanded));
 }
 function updateQuickLabel(){
  if(quickCurrent)quickCurrent.textContent=
   ({tws_m:'Downscaled GRACE (5 km, SEA)',obs_m:'Interpolated GRACE (5 km, SEA)',
     tws_m_1km:'Downscaled GRACE (1 km, Thailand)'})[st.layer] || 'Other GRACE dataset';
 }
 quickToggle?.addEventListener('click',()=>setQuickOpen(quickToggle.getAttribute('aria-expanded')!=='true'));
 document.addEventListener('pointerdown',ev=>{
  if(isPhoneQuick()&&quickToggle?.getAttribute('aria-expanded')==='true' &&
     !ev.target.closest('.quick-layers'))setQuickOpen(false);
 },{capture:true});
 updateQuickLabel();setQuickOpen(false);
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
  if(isPhoneQuick())setQuickOpen(false);
 };
 $('quickDownscaled').addEventListener('click',()=>chooseSimple('tws_m'));
 $('publicOpacity').addEventListener('input',e=>{
  const value=e.target.value;$('opacity').value=value;$('opacityLabel').textContent=value+'%';
  $('publicOpacityLabel').textContent=value+'%';st.overlay?.setOpacity(Number(value)/100);
 });
 $('mobileBoundaryClose').addEventListener('click',hideMobileBoundaryCard);
 $('mobileBoundaryTime').addEventListener('click',event=>{
  event.preventDefault();event.stopPropagation();
  const id=st.mobileTapRegion;if(id)openAreaTimeSeries(id);
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
 const visibleRegions=M.regions.filter(r=>!['footprint','tonle_sap_basin','southeast_asia'].includes(r.id));
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
 // Do not preselect or highlight Thailand (or any other region) on page load.
 // Region selection begins only when someone clicks a map polygon or chooses a menu item.
 st.region='footprint';st.previousBoundary=null;
 for(const id of ['regionSelect','timeRegionSelect','spatialRegionSelect']){
  const select=$(id);if(!select)continue;
  select.insertBefore(new Option('Select a country or district',''),select.firstChild);
  select.value='';
 }
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
   stopPlayback();st.layer=e.target.value;updateQuickLabel();
   for(const [id,key] of [['quickDownscaled','tws_m'],['quickOriginal','obs_m'],['quickDownscaled1km','tws_m_1km']]){
     $(id).classList.toggle('active',st.layer===key);
     $(id).setAttribute('aria-pressed',String(st.layer===key));
   }
   if(ORDER.includes(st.layer))$('spatialLayerSelect').value=st.layer;
   updateLegend();updateAvailability();updateDateSelectors();showOverlay();updateTechnicalMetrics();if(st.chartOpen&&st.activeTab==='spatial')drawRegionalSpatialMap();
   if(st.mobileTapRegion)showTapBoundaryPopup(st.mobileTapRegion,st.mobileTapLatLng);
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

 // Technical SVG chart: click any visible date to move the monthly navigator.
 installTechnicalChartClick();
 $('aboutButton').addEventListener('click',()=>$('aboutDialog').showModal());
 $('closeAbout').addEventListener('click',()=>$('aboutDialog').close());
 window.addEventListener('resize',()=>{st.map?.invalidateSize();positionMapControls();if(st.publicOpen)renderPublicChart();if(st.chartOpen&&st.activeTab==='time')drawChart();});
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
 if(!M||!R){document.body.textContent='Generated data not found. Build the website using build_dashboard.py, then open grace_site/index.html.';return;}
 trimTimelineToObservations();controls();describeStudy();initializeMap();positionMapControls();installDraggableAnalysis();initializeWelcomeGuide();
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(positionMapControls).observe(document.querySelector('.timeline'));
}
window.addEventListener('DOMContentLoaded',init);
