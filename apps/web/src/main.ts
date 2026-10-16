import './live.css';
import {invoke} from '@tauri-apps/api/core';
import type * as Leaflet from 'leaflet';
import type {Context,RawFrame,UnitRecord,Status,Source,Observation,WorldPoint,NormalizedFrame} from '../../../packages/core/types';
import {STATUSES} from '../../../packages/core/types';
import {worldToMap,distance} from '../../../packages/core/coordinates';
import {normalize,recognizeMap,MatchLifecycle} from '../../../packages/core/telemetry';
import {BattleStore,siteSummary,timerLabel} from '../../../packages/core/battle';
import {StaticTracker} from '../../../packages/core/static-tracker';
import {dataUpdateSnapshot} from './data-updates';
import {Poller} from '../../../packages/core/poller';
import {catalog} from './engine';
import {directProvider,bridgeProvider,nativeProvider,demoProvider} from './providers';
import type {RouteResult} from '../../../packages/core/route';
import {LiveTracks,observationLabel} from './live-tracks';
import {airfieldSnapshot} from './session-tools';
import './nearby-map';

const engine=window.ntlMap,L=engine.L;
const $=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const safe=(s:unknown)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const presetLabel=(id:string)=>{const preset=engine.presets().find(p=>p.id===id);return preset?`${preset.label}${preset.rank_range?` · match max BR ${preset.rank_range.map(rank=>(1+rank/3).toFixed(1)).join('–')}`:''}`:id;};
const native=!!window.__TAURI_INTERNALS__;
const store=new BattleStore();let lifecycle=new MatchLifecycle();
let units:UnitRecord[]=[],context:Context,selectedSite='',mode='manual',connected=false;
let staticTracker=new StaticTracker([]),manualLayout='';
let lastFrame:NormalizedFrame|null=null,rawFrame:RawFrame|null=null,lastSuccess:number|null=null;
let detected= {mapId:null,confidence:'unknown',matches:0,reason:'No telemetry'} as ReturnType<typeof recognizeMap>;
let applyingContext=false,previousView:{center:Leaflet.LatLng;zoom:number}|null=null;
let processingMs=0,matched=0,previousStatus='';
const liveLayer=L.layerGroup().addTo(engine.map),convoyLayer=L.layerGroup().addTo(engine.map),routeLayer=L.layerGroup().addTo(engine.map);
let playerMarker:Leaflet.Marker|null=null;
let selectedTrack:number|null=null,contextEvidence='Choose the battle settings or enable automatic detection.',inferredTeam=0,manualScenario='';
let routePoints:WorldPoint[]=[],routePicking=false,routeRequest=0,routeWorker:Worker|null=null;
const diagnostics:{at:number;message:string}[]=[];
function diagnostic(message:string){if(diagnostics.at(-1)?.message===message)return;diagnostics.push({at:Date.now(),message});if(diagnostics.length>100)diagnostics.shift();}
function readPrefs(){try{return JSON.parse(localStorage.getItem('ntl.preferences.v2')||localStorage.getItem('ntl.preferences.v1')||'{}');}catch{return {};}}
const storedPrefs=readPrefs();
const preferences={mode:storedPrefs.mode||'manual',follow:storedPrefs.follow===true,showObserved:storedPrefs.showObserved!==false,pollInterval:[250,400,750,1200].includes(storedPrefs.pollInterval)?storedPrefs.pollInterval:400,markerScale:Math.max(.8,Math.min(2,Number(storedPrefs.markerScale)||1.2)),trails:storedPrefs.trails!==false,trailLength:[12,30,60,100].includes(storedPrefs.trailLength)?storedPrefs.trailLength:30,smoothMovement:storedPrefs.smoothMovement!==false,followSelected:false,showPoints:storedPrefs.showPoints!==false,showNuclearAlerts:storedPrefs.showNuclearAlerts!==false,team:Number(storedPrefs.team)||0};
function savePrefs(){preferences.mode=mode==='demo'?'manual':mode;preferences.follow=$<HTMLInputElement>('follow-player').checked;preferences.showObserved=$<HTMLInputElement>('show-observed').checked;try{localStorage.setItem('ntl.preferences.v2',JSON.stringify(preferences));}catch{diagnostic('Settings storage unavailable');}window.dispatchEvent(new CustomEvent('ntl:settings',{detail:{...preferences}}));}
const tracks=new LiveTracks(L,engine.map,()=>preferences,id=>selectTrack(id));

document.body.insertAdjacentHTML('beforeend',`
<div class="ntl-bar"><strong>NUCLEAR THUNDER LIVE</strong><span class="version">0.2.2 • LIVE MAP</span><span id="connection-pill" class="ntl-pill" role="status">MANUAL • OFFLINE</span><button id="open-nearby" title="Open a compact map of nearby activity">Nearby map</button><button id="open-live" aria-expanded="true">Battle controls</button></div>
<aside class="ntl-panel" id="live-panel" aria-label="Live battle controls">
<header><h2>BATTLE CONTROLS</h2><div class="ntl-header-actions"><button id="open-settings" aria-label="Open settings">Settings</button><button id="close-live" aria-label="Collapse live panel">−</button></div></header>
<section><div class="row"><select id="connection-mode" aria-label="Connection mode"><option value="manual">Manual / offline</option>${native?'<option value="native">Native War Thunder</option>':''}<option value="direct">Direct localhost</option><option value="bridge">Local bridge</option><option value="demo">Simulation / demo</option></select><button id="connect-button">Connect</button></div>
<label id="pairing-row" hidden>Bridge pairing code <input id="bridge-token" type="password" autocomplete="off" placeholder="Code printed by ntl-bridge.exe"></label>
<p id="connection-detail" class="ntl-muted">Static mission data is ready. Unit states begin unknown.</p>
<div id="simulation-banner" class="ntl-demo-banner" hidden>SIMULATION — all observations and demo actions are generated.</div>
<div class="row"><label><input id="follow-player" type="checkbox"> Keep me centered</label><label><input id="show-observed" type="checkbox" checked> Show live contacts</label></div>
<div class="ntl-color-key"><span class="enemy">● Enemy</span><span class="friendly">● Friendly</span><span class="unknown">● Unknown team</span></div>
<div id="nuclear-alert" class="ntl-nuclear-alert" role="status" hidden></div>
</section>
<details open><summary>Map, battle rating & sides</summary><p id="identification" class="ntl-muted">Waiting for game data…</p>
<label><input id="auto-map" type="checkbox" checked> Detect the map automatically</label>
<label><input id="auto-context" type="checkbox" checked> Detect battle rating and side layout when possible</label>
<label for="match-max-br">Match maximum battle rating</label><div class="row"><input id="match-max-br" type="number" min="1" max="18" step="0.1" placeholder="For example, 14.3" aria-label="Match maximum battle rating"><button id="apply-match-br">Apply BR</button></div><p class="ntl-muted">Use the highest BR shown for this match, not your aircraft's BR. Leave empty and Apply BR to restore automatic selection.</p>
<label>My faction <select id="player-team"><option value="0">Automatic / unknown</option><option value="1">USSR / REDFOR</option><option value="2">NATO / BLUFOR</option></select></label>
<label><input id="match-static" type="checkbox" checked> Track SAM and ground-unit states automatically</label>
<p class="ntl-muted">A crossed-out unit has destruction evidence. An amber ? means it stopped reporting; it may be hidden. HUD kills are matched only to a unique recently missing component.</p>
<p class="ntl-muted">Automatic choices require enough matching game data. If detection is uncertain, choose the battle rating and Swap sides in the map controls. Enemy contacts are always red.</p>
<button id="reset-battle">Reset this battle</button></details>
<details open><summary>Target & component states</summary>
<input id="site-search" type="search" placeholder="Search SAM, radar, airfield, depot…" aria-label="Search sites">
<select id="site-select" aria-label="Selected site"></select>
<div class="row"><button id="focus-site">Focus target</button><button id="return-view">Previous view</button><button id="undo-status">Undo</button></div>
<p id="site-summary" class="ntl-site-summary"></p><div class="row"><button id="destroy-site">Mark whole site destroyed</button><button id="reset-site">Reset site to unknown</button></div><div id="unit-details" class="ntl-units"></div>
</details>
<details id="movement-section"><summary>Convoys & movement</summary>
<label>Live contact <select id="track-select" aria-label="Selected live contact"><option value="">Select a moving contact…</option></select></label>
<div class="row"><button id="focus-track">Show contact</button><button id="focus-player">Show me</button></div><label><input id="follow-track" type="checkbox"> Follow selected contact</label><label id="manual-nuclear-row" hidden><input id="manual-nuclear" type="checkbox"> Mark this aircraft as nuclear (manual)</label><p id="track-detail" class="ntl-muted">Click any live marker to select it. Aircraft and nuclear aircraft have larger symbols.</p>
<label><input id="show-convoys" type="checkbox"> Show predicted convoy routes</label>
<select id="convoy-select" aria-label="Predicted convoy route"></select><button id="focus-convoy">Show route</button><p id="convoy-detail" class="ntl-muted">Dashed routes show where mission convoys are expected to travel.</p>
<label><input id="show-history" type="checkbox" checked> Show contact trails</label><p class="ntl-muted">Solid trails show observed movement. Dashed amber lines show predicted routes. Blue lines show your planned flight.</p></details>
<details><summary>Threat-aware flight planner</summary><p class="ntl-route-note">Place your start and destination on the map, then calculate a route that avoids known threats. Terrain cover is not included.</p>
<div class="row"><button id="pick-route">Place waypoints</button><button id="route-undo">Undo point</button><button id="route-clear">Clear</button></div>
<label><input id="avoid-active" type="checkbox" checked> Avoid active threats</label><label><input id="avoid-unknown" type="checkbox" checked> Avoid threats with unknown status</label>
<label>Threat side <select id="threat-team"><option value="0">Both sides (conservative)</option><option value="1">REDFOR</option><option value="2">BLUFOR</option></select></label>
<button id="calculate-route">Calculate estimate</button><p id="route-result" class="ntl-muted">No waypoints.</p></details>
<details id="settings-section"><summary>Settings</summary>
<label>Live update speed <select id="update-speed"><option value="250">Fast · 4 times per second</option><option value="400">Balanced · 2.5 times per second</option><option value="750">Low load · about once per second</option><option value="1200">Battery saver · every 1.2 seconds</option></select></label>
<label>Live marker size <input id="marker-scale" type="range" min="0.8" max="2" step="0.1"><output id="marker-scale-value"></output></label>
<label>Trail length <select id="trail-length"><option value="12">Short · 12 positions</option><option value="30">Medium · 30 positions</option><option value="60">Long · 60 positions</option><option value="100">Very long · 100 positions</option></select></label>
<label><input id="smooth-movement" type="checkbox" checked> Smooth moving contacts</label>
<label><input id="show-points" type="checkbox" checked> Show my aiming points and point of interest</label>
<label><input id="show-nuclear-alerts" type="checkbox" checked> Show nuclear aircraft alerts</label>
<p class="ntl-muted">Yellow crosshairs: your aiming points. Red diamond: your point of interest. These appear only when the game exposes them. Nuclear labels use explicit game identifiers or your manual aircraft marks.</p>
<button id="overlay-button">${native?'Open in-game mini map':'Open nearby mini map'}</button>
<p class="ntl-muted">${native?'Use borderless or windowed game mode to keep the mini map visible.':'The website can show a compact nearby map. An always-on-top game overlay requires the Windows app.'}</p>
<details class="ntl-help"><summary>Connecting from a browser</summary><p class="ntl-muted">Start War Thunder and enter a battle. Choose Direct localhost and allow local-network access if your browser asks. If it cannot connect, start the local bridge, allow this website as its origin, and paste its pairing code. The Windows app connects directly.</p></details>
<button id="reset-settings">Restore default settings</button></details>
<details><summary>Battle timeline</summary><select id="timeline-filter" aria-label="Timeline filter"><option value="all">All events</option><option value="sam">SAM</option><option value="radar">Radar</option><option value="ground">MBT / SPAA / strongpoints</option><option value="convoy">Convoys</option><option value="objective">Objectives</option><option value="manual">Manual changes</option><option value="system">System</option></select><ol id="timeline" class="ntl-timeline"></ol><button id="export-timeline">Export battle JSON</button></details>
<details><summary>Diagnostics & credits</summary><pre id="diagnostics"></pre><button id="export-diagnostics">Export diagnostic JSON</button>
<p class="ntl-muted">Map and mission extraction: majorlier, Nuclear Thunder Interactive Map. Leaflet © Vladimir Agafonkin, BSD-2-Clause. War Thunder assets © their respective owners. Unofficial project; not affiliated with Gaijin.</p><p><a href="./credits.html" target="_blank" rel="noopener">Data provenance & third-party notices</a></p>
<p class="ntl-muted">Public HTTPS sites may be blocked from localhost by browser policy. The bridge requires pairing and an allowed origin. The desktop build connects natively. No telemetry leaves your computer.</p></details>
</aside>`);
function togglePanel(open:boolean){$('live-panel').hidden=!open;$('open-live').setAttribute('aria-expanded',String(open));}
$('open-live').onclick=()=>togglePanel($('live-panel').hidden);$('close-live').onclick=()=>togglePanel(false);
if(matchMedia('(max-width:700px)').matches)togglePanel(false);
$<HTMLInputElement>('follow-player').checked=preferences.follow===true;
$<HTMLInputElement>('show-observed').checked=preferences.showObserved!==false;
$<HTMLSelectElement>('player-team').value=String(preferences.team);
$<HTMLSelectElement>('update-speed').value=String(preferences.pollInterval);
$<HTMLInputElement>('marker-scale').value=String(preferences.markerScale);
$('marker-scale-value').textContent=`${preferences.markerScale.toFixed(1)}×`;
$<HTMLSelectElement>('trail-length').value=String(preferences.trailLength);
$<HTMLInputElement>('show-history').checked=preferences.trails;
$<HTMLInputElement>('smooth-movement').checked=preferences.smoothMovement;
$<HTMLInputElement>('show-points').checked=preferences.showPoints;
$<HTMLInputElement>('show-nuclear-alerts').checked=preferences.showNuclearAlerts;
$('open-settings').onclick=()=>{const section=$<HTMLDetailsElement>('settings-section');section.open=true;section.scrollIntoView({block:'nearest'});};
const requestOverlay=()=>window.dispatchEvent(new CustomEvent('ntl:overlay-request',{detail:{native}}));
$('open-nearby').onclick=requestOverlay;$('overlay-button').onclick=requestOverlay;
$('update-speed').onchange=()=>{preferences.pollInterval=Number($<HTMLSelectElement>('update-speed').value);poller.setInterval(preferences.pollInterval);savePrefs();};
$('marker-scale').oninput=()=>{preferences.markerScale=Number($<HTMLInputElement>('marker-scale').value);$('marker-scale-value').textContent=`${preferences.markerScale.toFixed(1)}×`;tracks.refresh();savePrefs();};
$('trail-length').onchange=()=>{preferences.trailLength=Number($<HTMLSelectElement>('trail-length').value);tracks.refresh();savePrefs();};
$('smooth-movement').onchange=()=>{preferences.smoothMovement=$<HTMLInputElement>('smooth-movement').checked;savePrefs();};
$('show-points').onchange=()=>{preferences.showPoints=$<HTMLInputElement>('show-points').checked;if(!preferences.showPoints)tracks.hidePoints();savePrefs();};
$('show-nuclear-alerts').onchange=()=>{preferences.showNuclearAlerts=$<HTMLInputElement>('show-nuclear-alerts').checked;updateTrackControls(true);savePrefs();};
$('reset-settings').onclick=()=>{try{localStorage.removeItem('ntl.preferences.v2');localStorage.removeItem('ntl.preferences.v1');}catch{}location.reload();};
const sourceSelect=$<HTMLSelectElement>('connection-mode');
sourceSelect.value=native?'native':['direct','bridge'].includes(preferences.mode)?preferences.mode:'manual';
sourceSelect.onchange=()=>{stopConnection();$('pairing-row').hidden=sourceSelect.value!=='bridge';};
$('pairing-row').hidden=sourceSelect.value!=='bridge';
$('connect-button').onclick=()=>connected?stopConnection():startConnection();
function stopConnection(){poller.stop();if(mode==='demo'){store.reset('Simulation ended; generated states cleared');refreshStates();}connected=false;mode='manual';lastFrame=null;rawFrame=null;lastSuccess=null;detected={mapId:null,confidence:'unknown',matches:0,reason:'No telemetry'};
  lifecycle=new MatchLifecycle();clearObserved();$('connect-button').textContent='Connect';$('simulation-banner').hidden=true;updateStatus();savePrefs();}
function startConnection(){
  const next=sourceSelect.value;if(next==='manual'){stopConnection();return;}
  const token=$<HTMLInputElement>('bridge-token').value.trim();
  if(next==='bridge'&&!/^[a-f0-9]{64}$/i.test(token)){$('connection-detail').textContent='Paste the 64-character pairing code printed by the bridge.';return;}
  if((mode==='demo')!==(next==='demo')){store.reset('Telemetry source changed; previous session cleared');refreshStates();}
  clearObserved();lifecycle=new MatchLifecycle();mode=next;connected=true;lastSuccess=null;lastFrame=null;
  $('simulation-banner').hidden=mode!=='demo';$('connect-button').textContent='Disconnect';
  store.event(`Connection mode: ${mode}`,mode==='demo'?'SIMULATED':'MANUAL');
  poller.start(next==='native'?nativeProvider:next==='bridge'?bridgeProvider(token):next==='demo'?demoProvider():directProvider());savePrefs();updateStatus();
}
const poller=new Poller(receive);
poller.setInterval(preferences.pollInterval);
function receive(frame:RawFrame){
  const start=performance.now();rawFrame=frame;const value=normalize(frame);lastFrame=value;
  const transition=lifecycle.update(value);
  if(transition==='start'||transition==='change'){
    window.dispatchEvent(new Event('ntl:battle-reset'));
    store.reset(transition==='start'?'Battle activity detected':'Map generation changed; new session');
    store.event('Battle identity inferred from local activity / map generation',mode==='demo'?'SIMULATED':'INFERRED');
    staticTracker=new StaticTracker(units,name=>engine.displayName(name),name=>engine.specs(name).hud_names||[]);
    if(transition==='change'){manualScenario='';manualLayout='';inferredTeam=0;$<HTMLInputElement>('match-max-br').value='';}
    clearObserved();clearRoute();refreshStates();
  }else if(transition==='end'){store.invalidateTimers();clearObserved();store.event('Battle ended (sustained inactive telemetry)',mode==='demo'?'SIMULATED':'INFERRED');}
  if(value.connected&&value.objects.length)lastSuccess=frame.at;
  if(mode==='demo')detected={mapId:'archipelago',confidence:'inferred',matches:0,reason:'SIMULATED Archipelago fixture'};
  else detected=recognizeMap(frame,engine.variants());
  if(value.active&&detected.mapId&&$<HTMLInputElement>('auto-map').checked&&context.mapId!==detected.mapId){
    applyingContext=true;engine.setContext(detected.mapId,detected.mapId==='city'?'city':'standard');applyingContext=false;
  }
  const mapAgrees=detected.mapId===context.mapId || (!$<HTMLInputElement>('auto-map').checked && value.info?.valid===true &&
    value.info.map_min[0]===engine.definitions[context.mapId].mapCoord0[0]&&value.info.map_max[0]===engine.definitions[context.mapId].mapCoord1[0]);
  if(mapAgrees&&value.active){
    drawPlayer(value.player,frame.at);
    tracks.update(value.objects.filter(o=>!o.player&&o.kind!=='objective'&&(preferences.showPoints||!o.kind||o.kind==='vehicle')),frame.at,context.mapId,preferences.pollInterval);
    const selected=tracks.get(selectedTrack);if(preferences.followSelected&&selected)engine.map.panTo(worldToMap(selected.observation.position,context.mapId),{animate:false});
    if($<HTMLInputElement>('match-static').checked){if(staticTracker.update(value,store,Number($<HTMLSelectElement>('player-team').value)||inferredTeam))refreshStates();matched=staticTracker.matches;}else matched=0;
  } else {staticTracker.update({...value,active:false},store);clearObserved();matched=0;}
  for(const [endpoint,error] of Object.entries(value.errors))diagnostic(`${endpoint}: ${error}`);
  if(mode==='demo')demoEvents();
  processingMs=performance.now()-start;updateStatus();renderTimeline();updateTrackControls();
  window.dispatchEvent(new CustomEvent('ntl:frame',{detail:{frame:value,context,mapAgrees,tracks:tracks.snapshot(),teamMode:Number($<HTMLSelectElement>('player-team').value),preferences:{...preferences,teamMode:Number($<HTMLSelectElement>('player-team').value),autoContext:$<HTMLInputElement>('auto-context').checked},mode}}));
}
function clearObserved(){liveLayer.clearLayers();tracks.clear();selectedTrack=null;playerMarker=null;updateTrackControls(true);}
function drawPlayer(player:Observation|null,at:number){
  if(!player){if(playerMarker)playerMarker.setOpacity(.35);return;}
  const latlng=worldToMap(player.position,context.mapId);
  if(!playerMarker){playerMarker=L.marker(latlng,{zIndexOffset:3000,icon:L.divIcon({className:'ntl-player',html:'<span>▲</span>',iconSize:[28,28],iconAnchor:[14,14]})}).bindTooltip('Player • telemetry').addTo(liveLayer);}
  playerMarker.setLatLng(latlng).setOpacity(1);
  const el=playerMarker.getElement()?.firstElementChild as HTMLElement|undefined;
  if(el){el.textContent=player.heading===null?'●':'▲';el.style.transform=`rotate(${player.heading??0}deg)`;}
  playerMarker.setTooltipContent(`${mode==='demo'?'SIMULATED':'TELEMETRY'} player • ${player.heading===null?'heading unknown':Math.round(player.heading)+'°'}`);
  if($<HTMLInputElement>('follow-player').checked&&!preferences.followSelected)engine.map.panTo(latlng,{animate:false});
}
let lastTrackControls=0,trackOptionsKey='';
function selectTrack(id:number){
  selectedTrack=id;tracks.select(id);togglePanel(true);$<HTMLDetailsElement>('movement-section').open=true;updateTrackControls(true);
}
function focusTrack(){const track=tracks.get(selectedTrack);if(!track)return;previousView={center:engine.map.getCenter(),zoom:engine.map.getZoom()};engine.map.setView(worldToMap(track.observation.position,context.mapId),Math.max(1,engine.map.getZoom()),{animate:false});}
function updateTrackControls(force=false){
  if(!force&&performance.now()-lastTrackControls<800)return;lastTrackControls=performance.now();
  const snapshot=tracks.snapshot().sort((a,b)=>Number(!!b.observation.nuclear)-Number(!!a.observation.nuclear)||Number(b.observation.type==='aircraft')-Number(a.observation.type==='aircraft')||a.id-b.id);
  const visible=snapshot.filter(t=>!t.observation.kind||t.observation.kind==='vehicle'),key=visible.map(t=>`${t.id}:${t.observation.nuclear}:${t.observation.relation}`).join('|');
  if(key!==trackOptionsKey){trackOptionsKey=key;$<HTMLSelectElement>('track-select').innerHTML='<option value="">Select a live contact…</option>'+visible.map(t=>`<option value="${t.id}">#${t.id} · ${safe(observationLabel(t.observation))}</option>`).join('');}
  const chosen=tracks.get(selectedTrack);$<HTMLSelectElement>('track-select').value=chosen?String(chosen.id):'';
  $('focus-track').toggleAttribute('disabled',!chosen);$('manual-nuclear-row').hidden=chosen?.observation.type!=='aircraft';$<HTMLInputElement>('manual-nuclear').checked=chosen?.nuclearManual===true;
  if(chosen){const away=lastFrame?.player?` · ${(distance(lastFrame.player.position,chosen.observation.position)/1000).toFixed(1)} km from you`:'';$('track-detail').textContent=`#${chosen.id} · ${observationLabel(chosen.observation)}${away}. ${chosen.nuclearManual?'Nuclear label set manually. ':''}${chosen.observation.telemetryId?'Telemetry ID available.':'Track continuity is estimated; identity can change in dense groups.'}`;}
  else $('track-detail').textContent='Click a live marker to select it, then Show contact or Follow selected contact.';
  const nuclear=snapshot.filter(t=>t.observation.nuclear&&Date.now()-t.at<3500),alert=$('nuclear-alert');alert.hidden=!preferences.showNuclearAlerts||!nuclear.length;
  if(!alert.hidden)alert.innerHTML=`<strong>${nuclear.length} nuclear aircraft ${nuclear.length===1?'contact':'contacts'}</strong><span>${nuclear.some(t=>t.nuclearManual)?'Includes aircraft marked manually.':'Explicit nuclear identifier reported by the game.'}</span><button id="focus-nuclear">Show aircraft</button>`;
  const button=$('focus-nuclear');if(button)button.onclick=()=>{selectTrack(nuclear[0].id);focusTrack();};
}
$('track-select').onchange=()=>{const id=Number($<HTMLSelectElement>('track-select').value);selectedTrack=id||null;tracks.select(selectedTrack);updateTrackControls(true);};
$('focus-track').onclick=focusTrack;
$('focus-player').onclick=()=>{if(lastFrame?.player){preferences.followSelected=false;$<HTMLInputElement>('follow-track').checked=false;engine.map.setView(worldToMap(lastFrame.player.position,context.mapId),Math.max(1,engine.map.getZoom()),{animate:false});}};
$('follow-track').onchange=()=>{preferences.followSelected=$<HTMLInputElement>('follow-track').checked;if(preferences.followSelected){$<HTMLInputElement>('follow-player').checked=false;focusTrack();}savePrefs();};
$('manual-nuclear').onchange=()=>{tracks.setManualNuclear(selectedTrack,$<HTMLInputElement>('manual-nuclear').checked);updateTrackControls(true);};
function onContext(){
  const next=engine.context();if(context&&(next.mapId!==context.mapId||next.variant!==context.variant||next.scenario!==context.scenario)){
    if(!applyingContext&&next.mapId!==context.mapId)$<HTMLInputElement>('auto-map').checked=false;
    if(!applyingContext){if(next.variant!==context.variant)manualLayout=next.variant;if(next.scenario!==context.scenario)manualScenario=next.scenario;contextEvidence='Your selected settings take precedence. Other settings can still be detected.';}
    store.event(`Selected ${next.mapId} / ${next.variant} / ${next.scenario}`,applyingContext?'INFERRED':'MANUAL');
    clearObserved();clearRoute();
  }
  const changed=!context||JSON.stringify(context)!==JSON.stringify(next);
  context=next;units=catalog(engine);if(changed)staticTracker=new StaticTracker(units,name=>engine.displayName(name),name=>engine.specs(name).hud_names||[]);engine.setPlayerTeam?.(Number($<HTMLSelectElement>('player-team').value)||inferredTeam);populateSites();renderConvoys();refreshStates();updateStatus();
  for(const option of $<HTMLSelectElement>('scenario-options').options)option.textContent=presetLabel(option.value);
}
function populateSites(){
  const query=$<HTMLInputElement>('site-search').value.toLowerCase(),select=$<HTMLSelectElement>('site-select');
  const sites=engine.sites().filter(s=>`${s.name} ${engine.category(s)}`.toLowerCase().includes(query));
  const myTeam=Number($<HTMLSelectElement>('player-team').value)||inferredTeam;
  select.innerHTML=sites.map(s=>`<option value="${safe(s.name)}">${myTeam?(s.team===myTeam?'FRIENDLY':'ENEMY'):(s.team===1?'USSR':'NATO')} · ${safe(s.name.replace(/^t[12]_/,'').replaceAll('_',' '))}</option>`).join('');
  if(sites.some(s=>s.name===selectedSite))select.value=selectedSite;else selectedSite=select.value;
  renderDetails();
}
function selectSite(name:string){selectedSite=name;$<HTMLInputElement>('site-search').value='';populateSites();togglePanel(true);}
function renderDetails(){
  const items=units.filter(u=>u.siteId===selectedSite),states=items.map(u=>store.get(u.id));
  $('site-summary').textContent=`${items.length} components • ${siteSummary(states).replaceAll('_',' ')} • ${context?.scenario||''}`;
  $('unit-details').innerHTML=items.map(u=>{const state=store.get(u.id);return `<div class="ntl-unit" data-unit-id="${safe(u.id)}"><strong>${safe(u.label)}</strong><span class="ntl-muted">${safe(u.role)} · ${u.approximate?'approximate placement':'mission position'}${u.range?` · weapon ${(u.range/1000).toFixed(1)} km`:''}${u.detectionRange?` · radar ${(u.detectionRange/1000).toFixed(1)} km`:''}</span>
    <select data-status="${safe(u.id)}" aria-label="Status for ${safe(u.label)}">${STATUSES.map(s=>`<option ${s===state.status?'selected':''} value="${s}">${s.replaceAll('_',' ')}</option>`).join('')}</select>
    <div class="row unit-actions"><button data-set="DESTROYED" data-id="${safe(u.id)}">Destroyed</button><button data-set="CONFIRMED_ACTIVE" data-id="${safe(u.id)}">Active</button><button data-set="UNKNOWN" data-id="${safe(u.id)}">Unknown</button></div>
    <span class="state-source">${state.at?`${state.source} · ${new Date(state.at).toLocaleTimeString()}`:'UNKNOWN · no observation'}${state.lastSeen?` · seen ${new Date(state.lastSeen).toLocaleTimeString()}`:''}</span>
    <span class="ntl-muted" data-timer="${safe(u.id)}">${state.status==='DESTROYED'?timerLabel(state):u.restoreSeconds?`Rule: ${u.restoreSeconds}s ${safe(u.restoreKind)} (${safe(u.restoreSource)}, conditional)`:'No fixed restoration rule'}</span></div>`;}).join('');
}
function refreshSiteState(id:string){const component=siteSummary(units.filter(u=>u.siteId===id).map(u=>store.get(u.id))),airfield=airfieldSnapshot().find(a=>a.id===id);engine.markSite(id,airfield?.status==='destroyed'?'DESTROYED':airfield?.status==='missing'&&component!=='DESTROYED'?'POSSIBLY_DESTROYED':component);}
window.addEventListener('ntl:airfields-changed',()=>{if(context)for(const field of airfieldSnapshot())refreshSiteState(field.id);});
function refreshStates(){for(const u of units)engine.markUnit(u.id,store.get(u.id).status);for(const site of engine.sites())refreshSiteState(site.name);renderDetails();renderTimeline();}
function changeUnit(id:string,status:Status){const unit=units.find(u=>u.id===id);if(!unit||!STATUSES.includes(status))return;store.set(unit,status,mode==='demo'?'SIMULATED':'MANUAL');engine.markUnit(id,status);refreshSiteState(unit.siteId);renderDetails();renderTimeline();$('route-result').textContent=routePoints.length?'Threats changed; recalculate the route estimate.':$('route-result').textContent;}
$('unit-details').onclick=event=>{const button=(event.target as HTMLElement).closest<HTMLButtonElement>('button[data-set]');if(button)changeUnit(button.dataset.id!,button.dataset.set as Status);};
$('unit-details').onchange=event=>{const select=event.target as HTMLSelectElement;if(select.dataset.status)changeUnit(select.dataset.status,select.value as Status);};
$('site-search').oninput=populateSites;$('site-select').onchange=()=>{selectedSite=$<HTMLSelectElement>('site-select').value;renderDetails();};
$('focus-site').onclick=()=>{previousView={center:engine.map.getCenter(),zoom:engine.map.getZoom()};engine.focus(selectedSite);const site=engine.sites().find(s=>s.name===selectedSite);if(site)engine.map.setView(engine.worldToLatLng(site.world_pos[0],site.world_pos[2]),1,{animate:false});};
$('return-view').onclick=()=>{if(previousView)engine.map.setView(previousView.center,previousView.zoom);};
$('undo-status').onclick=()=>{store.undo();refreshStates();};
$('reset-site').onclick=()=>{for(const u of units.filter(u=>u.siteId===selectedSite))store.set(u,'UNKNOWN',mode==='demo'?'SIMULATED':'MANUAL');refreshStates();};
$('destroy-site').onclick=()=>{for(const u of units.filter(u=>u.siteId===selectedSite))store.set(u,'DESTROYED',mode==='demo'?'SIMULATED':'MANUAL');refreshStates();};
$('reset-battle').onclick=()=>{window.dispatchEvent(new Event('ntl:battle-reset'));store.reset('Manual new battle');staticTracker=new StaticTracker(units,name=>engine.displayName(name),name=>engine.specs(name).hud_names||[]);lifecycle=new MatchLifecycle();clearObserved();refreshStates();};
$('player-team').onchange=()=>{preferences.team=Number($<HTMLSelectElement>('player-team').value);const team=preferences.team||inferredTeam;engine.setPlayerTeam?.(team);if(team)$<HTMLSelectElement>('threat-team').value=String(team===1?2:1);store.event(`My faction: ${$<HTMLSelectElement>('player-team').selectedOptions[0].textContent}`);populateSites();renderTimeline();savePrefs();window.dispatchEvent(new CustomEvent('ntl:team-mode',{detail:{team:preferences.team}}));};
$('match-static').onchange=()=>{staticTracker=new StaticTracker(units,name=>engine.displayName(name),name=>engine.specs(name).hud_names||[]);store.event(`Automatic unit states ${$<HTMLInputElement>('match-static').checked?'enabled':'disabled'}`);renderTimeline();};
$('follow-player').onchange=()=>{if($<HTMLInputElement>('follow-player').checked){preferences.followSelected=false;$<HTMLInputElement>('follow-track').checked=false;}savePrefs();};$('show-observed').onchange=()=>{clearObserved();savePrefs();};
$('show-history').onchange=()=>{preferences.trails=$<HTMLInputElement>('show-history').checked;tracks.refresh();savePrefs();};
engine.map.on('dragstart',()=>{$<HTMLInputElement>('follow-player').checked=false;$<HTMLInputElement>('follow-track').checked=false;preferences.followSelected=false;savePrefs();});
window.addEventListener('ntl:context',onContext);window.addEventListener('ntl:select',event=>selectSite((event as CustomEvent<string>).detail));
window.addEventListener('ntl:team-inferred',event=>{const evidence=(event as CustomEvent<{team:number;reason:string}>).detail;inferredTeam=evidence.team;if(!Number($<HTMLSelectElement>('player-team').value)){engine.setPlayerTeam?.(inferredTeam);populateSites();if(inferredTeam)$<HTMLSelectElement>('threat-team').value=String(inferredTeam===1?2:1);}diagnostic(evidence.reason);});
window.addEventListener('ntl:context-evidence',event=>{const evidence=(event as CustomEvent<{mapId?:Context['mapId'];variant?:string;scenario?:string;alternatives?:string[];reason?:string}>).detail;const alternatives=!evidence.scenario?evidence.alternatives?.map(id=>engine.presets().find(p=>p.id===id)?.label||id).join(' / '):'';contextEvidence=(manualScenario?'Battle rating selected manually. ':'')+(evidence.reason||'Checking battle data.')+(alternatives?` Possible presets: ${alternatives}.`:'');const scenario=manualScenario||evidence.scenario,variant=manualLayout||evidence.variant;if($<HTMLInputElement>('auto-context').checked&&context&&(variant&&variant!==context.variant||scenario&&scenario!==context.scenario)){
  applyingContext=true;engine.setContext(evidence.mapId||context.mapId,variant||context.variant,scenario||context.scenario);applyingContext=false;
}updateStatus();});
$('auto-context').onchange=()=>{if($<HTMLInputElement>('auto-context').checked){manualScenario='';manualLayout='';$<HTMLInputElement>('match-max-br').value='';}contextEvidence=$<HTMLInputElement>('auto-context').checked?'Checking game data for battle rating and side layout.':'Using your chosen battle rating and side layout.';updateStatus();};
$('apply-match-br').onclick=()=>{const input=$<HTMLInputElement>('match-max-br');if(!input.value.trim()){manualScenario='';$<HTMLInputElement>('auto-context').checked=true;contextEvidence='Checking game data for battle rating and side layout.';updateStatus();return;}const br=Number(input.value),rank=Math.round((br-1)*3),preset=engine.presets().find(p=>p.rank_range&&rank>=p.rank_range[0]&&rank<=p.rank_range[1]);if(!Number.isFinite(br)||br<1||br>18||!preset){input.setCustomValidity('Enter a match maximum BR covered by the available scenarios (1.0 to 17.7).');input.reportValidity();return;}input.setCustomValidity('');manualScenario=preset.id;applyingContext=true;engine.setContext(context.mapId,context.variant,preset.id);applyingContext=false;contextEvidence=`Maximum match BR ${br.toFixed(1)} selected manually. Side detection remains available.`;store.event(`Match maximum BR set to ${br.toFixed(1)} (${preset.label})`);updateStatus();};
$('match-max-br').oninput=()=>{$<HTMLInputElement>('match-max-br').setCustomValidity('');};

function renderConvoys(){
  const routes=engine.convoyRoutes(),select=$<HTMLSelectElement>('convoy-select'),previous=select.value;
  select.innerHTML='<option value="">Choose predicted route…</option>'+routes.map((r,i)=>`<option value="${i}">${safe(r.kind)} ${safe(r.link.resource||'')} · ${safe(r.link.factory||r.link.assembly||r.link.from_site||i)}</option>`).join('');
  if(previous&&Number(previous)<routes.length)select.value=previous;drawConvoys();
}
function drawConvoys(){
  convoyLayer.clearLayers();if(!$<HTMLInputElement>('show-convoys').checked)return;
  const routes=engine.convoyRoutes(),selected=$<HTMLSelectElement>('convoy-select').value;
  routes.forEach((route,index)=>{if(selected!==''&&Number(selected)!==index)return;
    L.polyline(route.points.map(p=>engine.worldToLatLng(p[0],p[2])),{color:'#e1b36d',weight:selected===''?1.5:4,dashArray:'7 8',opacity:selected===''?.45:.9}).bindTooltip(`PREDICTED ${safe(route.kind)} route — not a live convoy`).addTo(convoyLayer);
  });
  if(selected!==''){
    const route=routes[Number(selected)];if(route){$('convoy-detail').textContent=`PREDICTED ${route.kind} · ${route.link.resource||'armoured'} · team ${route.link.team} · ${route.link.factory||route.link.assembly||'?'} → ${route.link.assembly||route.link.target||'?'} · Actual position unknown.`;
      store.event(`Selected predicted ${route.kind} route`,'MANUAL','convoy');}
  }
}
$('show-convoys').onchange=drawConvoys;$('convoy-select').onchange=()=>{$<HTMLInputElement>('show-convoys').checked=true;drawConvoys();};
$('focus-convoy').onclick=()=>{const selected=$<HTMLSelectElement>('convoy-select').value,route=engine.convoyRoutes()[Number(selected)];if(selected!==''&&route?.points.length){previousView={center:engine.map.getCenter(),zoom:engine.map.getZoom()};engine.map.fitBounds(L.latLngBounds(route.points.map(p=>engine.worldToLatLng(p[0],p[2]))),{padding:[40,40],maxZoom:2});}};
function drawWaypoints(){routeLayer.clearLayers();for(const [i,p]of routePoints.entries())L.circleMarker(worldToMap(p,context.mapId),{radius:6,color:'#84baff',fillOpacity:1}).bindTooltip(`Waypoint ${i+1}`).addTo(routeLayer);$('route-result').textContent=`${routePoints.length} waypoints. ${routePicking?'Click map to add; press Finish placing to pan.':''}`;}
function clearRoute(){routePoints=[];routeRequest++;routePicking=false;routeLayer.clearLayers();$('pick-route').textContent='Place waypoints';$('route-result').textContent='No waypoints.';}
$('pick-route').onclick=()=>{routePicking=!routePicking;$('pick-route').textContent=routePicking?'Finish placing':'Place waypoints';drawWaypoints();};
$('route-clear').onclick=clearRoute;$('route-undo').onclick=()=>{routePoints.pop();routeRequest++;drawWaypoints();};
// Capture before unit-marker handlers consume the click. Planning works over markers too.
engine.map.getContainer().addEventListener('click',(event:MouseEvent)=>{
  if(!routePicking||routePoints.length>=12)return;
  event.stopImmediatePropagation();event.preventDefault();
  const [x,z]=engine.latLngToWorld(engine.map.mouseEventToLatLng(event));
  const def=engine.definitions[context.mapId];
  if(x<def.mapCoord0[0]||x>def.mapCoord1[0]||z<def.mapCoord0[1]||z>def.mapCoord1[1]){$('route-result').textContent='Choose a point inside the map image.';return;}
  routePoints.push({x,z});routeRequest++;drawWaypoints();
},true);
$('calculate-route').onclick=()=>{
  if(!routeWorker){routeWorker=new Worker(new URL('./route-worker.ts',import.meta.url),{type:'module'});routeWorker.onmessage=event=>{
    if(event.data.id!==routeRequest)return;if(event.data.error){$('route-result').textContent=event.data.error;return;}
    const result=event.data.result as RouteResult;drawWaypoints();L.polyline(result.points.map(p=>worldToMap(p,context.mapId)),{color:'#78abff',weight:4}).addTo(routeLayer);
    $('route-result').textContent=`ESTIMATE ${(result.distance/1000).toFixed(1)} km · ${(result.exposure/1000).toFixed(1)} km inside selected threat rings · grid ${(result.resolution/1000).toFixed(2)} km. No terrain masking guarantee.`;
  };routeWorker.onerror=()=>{$('route-result').textContent='Route worker failed. Reload to retry.';};}
  routeWorker.postMessage({id:++routeRequest,request:{points:routePoints,mapId:context.mapId,avoidUnknown:$<HTMLInputElement>('avoid-unknown').checked,avoidActive:$<HTMLInputElement>('avoid-active').checked,enemyTeam:Number($<HTMLSelectElement>('threat-team').value),threats:units.filter(u=>u.position&&u.range>0).map(u=>({position:u.position!,range:u.range,status:store.get(u.id).status,team:u.team}))}});
  $('route-result').textContent='Calculating…';
};

let timelineKey='',lastDiagnosticsAt=0;
function renderTimeline(){
  const filter=$<HTMLSelectElement>('timeline-filter').value;
  const key=`${filter}|${store.events.length}|${store.events.at(-1)?.id}`;if(key===timelineKey)return;timelineKey=key;
  const events=store.events.filter(e=>filter==='all'||filter==='manual'&&e.source==='MANUAL'||filter==='system'&&e.category==='system'||filter==='sam'&&/sam/i.test(e.category)||filter==='radar'&&/radar/i.test(e.category)||filter==='ground'&&/strong|vehicle|spaa/i.test(e.category)||filter==='convoy'&&e.category==='convoy'||filter==='objective'&&/airfield|fuel|strategic/i.test(e.category));
  $('timeline').innerHTML=events.slice(-70).reverse().map(e=>`<li><span class="ntl-muted">${new Date(e.at).toLocaleTimeString()} · ${e.source}</span><br>${safe(e.text)}</li>`).join('');
}
$('timeline-filter').onchange=renderTimeline;
function updateStatus(){
  const stale=lastSuccess!==null&&Date.now()-lastSuccess>3000;
  const status=mode==='manual'?'MANUAL • OFFLINE':!lastFrame?'SEARCHING':!lastFrame.connected?'CONNECTION LOST':lastFrame.unsupported?'UNSUPPORTED / PARTIAL':lastFrame.active?'IN BATTLE':lastFrame.active===false?'CONNECTED • NO BATTLE':'CONNECTED • ACTIVITY UNKNOWN';
  $('connection-pill').textContent=(mode==='demo'?'SIMULATED • ':'')+status+(stale?' • STALE':'');
  $('connection-pill').dataset.active=String(lastFrame?.connected&&!stale);$('connection-pill').dataset.demo=String(mode==='demo');
  if(previousStatus!==status){if(mode!=='manual')store.event(status,mode==='demo'?'SIMULATED':'TELEMETRY');previousStatus=status;}
  $('connection-detail').textContent=mode==='manual'?'Static map • manual operation. No live data.':!lastFrame?.connected?(mode==='direct'?'Connection failed: game unavailable or browser blocked localhost. Try the paired bridge or desktop app.':'Waiting for local telemetry. Requests retry automatically.'):
    `${mode.toUpperCase()} · ${lastFrame.objects.length} observed objects · ${stale?'STALE':lastSuccess?new Date(lastSuccess).toLocaleTimeString():'No current player position'}${lastFrame.unsupported?' · Some endpoints unavailable':''}`;
  if(context){const text=`${context.mapId==='city'?'South Eastern City':'Archipelago'} · ${presetLabel(context.scenario)} · ${context.variant.includes('mirror')?'swapped sides':'default sides'}. ${contextEvidence}`;if($('identification').textContent!==text)$('identification').textContent=text;}
  if(stale&&playerMarker)playerMarker.setOpacity(.3);
  if($('diagnostics').closest('details')?.open&&performance.now()-lastDiagnosticsAt>1000){lastDiagnosticsAt=performance.now();$('diagnostics').textContent=JSON.stringify(diagnosticSnapshot(),null,2);}
}
function diagnosticSnapshot(){return {version:'0.2.2',mode,connection:lastFrame?.connected||false,activity:lastFrame?.active??null,session:lifecycle.session,selected:context,recognized:detected,lastSuccess,pollingMs:poller.interval,processingMs:Math.round(processingMs*100)/100,observed:lastFrame?.objects.length||0,hudMessages:lastFrame?.hud?.length||0,liveTracks:tracks.snapshot().length,trackComparisons:tracks.comparisonCount,trackedComponents:units.length,confirmedIdentityMatches:0,inferredPositionCandidates:matched,matchingEnabled:$<HTMLInputElement>('match-static').checked,contextEvidence,errors:lastFrame?.errors||{},warnings:['Automatic battle settings require sufficient evidence; manual choices take precedence.','A generation change is an inferred session boundary, not a confirmed battle ID.','Disappearance alone means possibly destroyed. HUD-to-position links are inferred.']};}
async function exportJson(name:string,value:unknown){
  const content=JSON.stringify(value,null,2);
  if(native){try{const path=await invoke<string>('export_json',{kind:name.includes('diagnostics')?'diagnostics':'battle',content});diagnostic(`Export saved: ${path}`);$('connection-detail').textContent=`Saved to ${path}`;}catch(error){diagnostic(`Export failed: ${error}`);$('connection-detail').textContent=`Export failed: ${error}`;}return;}
  const url=URL.createObjectURL(new Blob([content],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
$('export-timeline').onclick=()=>exportJson('nuclear-thunder-battle.json',{context,mode,events:store.events,states:Object.fromEntries(store.units)});
$('export-diagnostics').onclick=()=>exportJson('nuclear-thunder-diagnostics.json',{...diagnosticSnapshot(),log:diagnostics});
let demoTick=0;
function demoEvents(){demoTick++;if(!lastFrame?.active)return;const sam=units.find(u=>u.role==='launcher'),radar=units.find(u=>/radar/i.test(u.role));
  if(demoTick%25===0&&sam){store.set(sam,'DESTROYED','SIMULATED');selectSite(sam.siteId);refreshStates();}
  if(demoTick%40===0&&radar){store.set(radar,'DESTROYED','SIMULATED');refreshStates();}
}
const timer=setInterval(()=>{updateStatus();document.querySelectorAll<HTMLElement>('[data-timer]').forEach(el=>{const state=store.get(el.dataset.timer!);if(state.status==='DESTROYED')el.textContent=timerLabel(state);});},1000);
window.addEventListener('beforeunload',()=>{poller.stop();clearInterval(timer);routeWorker?.terminate();tracks.clear();});
window.ntlApp={snapshot:()=>({...diagnosticSnapshot(),dataUpdates:dataUpdateSnapshot(),airfields:airfieldSnapshot(),preferences:{...preferences},liveContacts:tracks.snapshot(),unitStates:Object.fromEntries(store.units),events:store.events,playerMarker:playerMarker?.getLatLng()||null})};
if(engine.ready){onContext();if(native)startConnection();}
else window.addEventListener('ntl:context',()=>{if(native&&!connected)startConnection();},{once:true});
