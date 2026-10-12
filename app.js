/* FREI – local-first experimental activity pilot. No network requests. */
(()=>{'use strict';
const E=globalThis.FreiEngine, L=globalThis.FreiEventLedger, B=globalThis.FreiEventBridge;
if(!E)throw new Error('Auswahlkern nicht geladen');
const $=id=>document.getElementById(id);
const byId=id=>E.ACTS.find(x=>x.id===id);
let page='home';let toastTimeout=0;let timerId=null;let deadline=0;let timeLeft=120;let paused=false;
let mediaToken=null,mediaOrder=0;let audioUrl=null;let current=null;let selection=null;let episodeStarted=false;let duration=120;
let pendingBatch=null;let busy=false, clock=L.createClockState(), navigationId='n-'+Date.now(), feedbackIds=null;
let bridge=B.makeBridge({store:(()=>{try{return globalThis.FreiEventStore.makeStore()}catch(_){return null}})(),persist:(()=>{try{return localStorage.getItem('frei-v13-consent')==='yes'}catch(_){return false}})()});
let eventSerial=0;let session='s-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);
let trigger='coffee',interaction='direct', excluded=[],tech=null,outcome=null,rejection='none';
let memoryEnabled=false, history=[], cards=[];
const STORE='frei-candidate-storage-v1';
function localDate(){const d=new Date();return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-');}
memoryEnabled=bridge.persistent;
$('opt-memory').checked=memoryEnabled;
function refreshMemory(){history=bridge.history();cards=bridge.cards(localDate());}
function persist(){/* Data is persisted only by atomic bridge dispatch; never localStorage. */}
async function record(events){const result=await bridge.dispatch(events);refreshMemory();return result;}
async function recordInterrupt(reason,source=current){if(!source?.attemptId)return;
 try{await record([{type:'INTERRUPT',eventId:bridge.id('interrupt'),attemptId:source.attemptId,reason,occurredAt:new Date().toISOString()}]);}
 catch(_){notify('Unterbrechung nicht sicher gespeichert. Ergebnis bleibt unbekannt.');}}
function pauseMonotonic(){if(paused)return;const now=performance.now();const result=L.clockEvent(clock,{kind:'pause',attemptId:current?.attemptId||'unknown',navigationId,now});clock=result.state;
 timeLeft=Math.max(0,(duration*1000-clock.totalMs)/1000);paused=true;stopClock();updateClock();}
function resumeMonotonic(){if(!current?.attemptId)return;const r=L.clockEvent(clock,{kind:'resume',attemptId:current.attemptId,navigationId,now:performance.now()});clock=r.state;paused=false;stopClock();timerId=setInterval(tick,250);}
function localZone(){return Intl.DateTimeFormat().resolvedOptions().timeZone||'Europe/Berlin';}
async function initialize(){$('go-context').disabled=true;$('quick-quiet').disabled=true;try{await bridge.init();refreshMemory();$('opt-memory').checked=bridge.persistent;
 try{if(localStorage.getItem(STORE))notify('Ältere Lerndaten wurden nicht automatisch übernommen.');}catch(_){}}
 catch(_){notify('Lokaler Datenspeicher nicht verfügbar. Dauerhaftes Lernen ist gesperrt.');}
 $('go-context').disabled=false;$('quick-quiet').disabled=false;show('home');}

function notify(msg){const el=$('toast');el.textContent=msg;el.classList.add('show');clearTimeout(toastTimeout);toastTimeout=setTimeout(()=>el.classList.remove('show'),3300);}
function show(where){if(page==='activity' && where!=='activity' && where!=='feedback'){pauseMonotonic();recordInterrupt('switch',current);safeStopAudio();current=null;episodeStarted=false;}page=where;for(const el of document.querySelectorAll('.screen'))el.classList.toggle('visible',el.id==='screen-'+where);for(const [key,id] of [['home','tab-home'],['library','tab-library'],['settings','tab-settings']])$(id).classList.toggle('selected',key===where||(key==='home'&&!['library','settings'].includes(where)));window.scrollTo(0,0);if(where==='settings')renderSettings();if(where==='library')renderLibrary();}
function safeStopAudio(){mediaToken=null;const p=$('music-player');try{p.pause();p.currentTime=0;}catch(_e){}$('audio-player').classList.add('hidden');}
async function startMedia(attempt){
 const old=$('music-player');const player=old.cloneNode(false);old.replaceWith(player);
 const token=bridge.id('media'),order=++mediaOrder;mediaToken=token;
 const stamp=new Date().toISOString();
 try{await record([{type:'AUDIO_INSTANCE',eventId:bridge.id('media-evt'),attemptId:attempt.attemptId,mediaInstanceId:token,mediaOrder:order,occurredAt:stamp}]);}
 catch(_){notify('Audio-Instanz nicht sicher gespeichert. Audio bleibt aus.');return;}
 if(!current||current.attemptId!==attempt.attemptId||mediaToken!==token)return;
 player.src=audioUrl;$('audio-player').classList.remove('hidden');
 player.addEventListener('ended',()=>{
  // A late event from a detached former player is ignored.
  if(!current||current.attemptId!==attempt.attemptId||mediaToken!==token)return;
  record([{type:'AUDIO_END',eventId:bridge.id('audio-end'),attemptId:attempt.attemptId,mediaInstanceId:token,mediaOrder:order,occurredAt:new Date().toISOString()}])
   .catch(()=>notify('Audio-Ende nicht sicher gespeichert.'));
 });
 player.play().catch(()=>notify('Musik bitte über den Player starten.'));
}
function stopClock(){if(timerId){clearInterval(timerId);timerId=null;}}
function resetEpisode(){stopClock();safeStopAudio();clock=L.createClockState();feedbackIds=null;pendingBatch=null;current=null;selection=null;episodeStarted=false;excluded=[];tech=outcome=null;rejection='none';session='s-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);cards=cards.filter(c=>c.scope!=='EPISODE'&&c.scope!=='MOMENT');}
function beginEpisode(){resetEpisode();show('context');}
function goHome(){resetEpisode();show('home');}
function readContext(){const audio=$('can-audio').checked;refreshMemory();const hold=bridge.hold('music',localDate());const rejects=hold?[...cards,{target:'music',effect:'EXCLUDE',scope:'MOMENT',sessionId:session}]:cards;return E.cleanContext({trigger,duration,screen:$('can-screen').checked,hands:$('can-screen').checked,audio,hasFile:!!audioUrl,wantsMusic:audio,driving:$('is-driving').checked,interaction,reject:rejects,history,exclude:excluded,sessionId:session,now:localDate()+'T12:00:00'});}
function checkSafety(){if($('is-driving').checked){if(current){pauseMonotonic();recordInterrupt('pause',current);}stopClock();safeStopAudio();$('safety-message').textContent='Bitte bediene die App nicht während einer Fahrt oder an gefährlichen Maschinen. Richte deine Aufmerksamkeit auf die Umgebung und komm erst zurück, wenn du sicher stehst.';$('emergency-link').classList.add('hidden');show('safety');return true;}return false;}
function allowPresence(){
 // Current permission for quiet does not remove unrelated broad rejection cards.
 // Explicit quiet is a one-time UI choice; no historical cards are deleted.
 selection={mode:'LOW_DEMAND',base:'presence',background:null,
   variant:'quiet',reason:'EXPLICIT_QUIET',rejectionSnapshot:JSON.stringify(cards)};
 current=null;showSuggestion();
}
function offer(){if(checkSafety())return;excluded=[];selection=E.makeSelection(readContext());showSuggestion();}
function buildChoices(){const choice=$('choices');choice.replaceChildren();const c=readContext();if(interaction!=='choice'||selection.mode!=='NORMAL'){choice.classList.add('hidden');return;}const pool=E.available(c).filter(x=>x.id!==selection.base && x.id!=='presence').slice(0,1);
 if(!pool.length){choice.classList.add('hidden');return;}choice.classList.remove('hidden');const label=document.createElement('p');label.className='subtle';label.textContent='Oder lieber:';choice.append(label);
 for(const a of pool){const b=document.createElement('button');b.className='option-button';b.textContent=a.icon+'  '+a.title;b.addEventListener('click',()=>{selection={mode:'NORMAL',base:a.id,background:null,variant:selection.variant,reason:'EXPLICIT_CHOICE'};showSuggestion()});choice.append(b);}}
function showSuggestion(){if(!selection)selection=E.makeSelection(readContext());if(selection.mode==='SAFETY'){checkSafety();return;}
 if(selection.mode==='END'){$('recommend-icon').textContent='—';$('recommend-title').textContent='Gerade keine passende Aktivität';$('recommend-description').textContent='Deine Grenzen haben Vorrang. Du kannst ohne Aufgabe beenden oder eine Einstellung ändern.';$('suggestion-reason').textContent='Keine erlaubte Aktivität vorhanden.';$('recommend-tags').replaceChildren();$('music-prep').classList.add('hidden');$('choices').classList.add('hidden');$('start-activity').disabled=false;$('start-activity').firstChild.textContent='Ohne Aktivität abschließen ';$('try-another').classList.add('hidden');show('suggestion');return;}$('start-activity').firstChild.textContent='Jetzt starten ';$('try-another').classList.remove('hidden');const a=byId(selection.base)||byId('presence');$('recommend-icon').textContent=a.icon;$('recommend-title').textContent=a.title;$('recommend-description').textContent=a.description;
 $('suggestion-reason').textContent=selection.reason==='HELPED_BEFORE'?'Diese Art wurde dir für diesen Auslöser schon ausdrücklich als hilfreich bestätigt.':'Ein kleiner Vorschlag. Du kannst ihn jederzeit ändern.';
 const tags=$('recommend-tags');tags.replaceChildren();const xs=[duration/60+' Min.',selection.base==='presence'?'Ohne Aufgabe':'Ohne Zeitdruck'];if(selection.background)xs.push('+ Eigene Musik');for(const t of xs){const n=document.createElement('span');n.textContent=t;tags.append(n)}
 $('music-prep').classList.toggle('hidden',!$('can-audio').checked);$('start-activity').disabled=selection.base==='music'&&!audioUrl;
 buildChoices();show('suggestion');}
function another(){if(selection?.base!=='presence')excluded.push(selection.base);const next=E.makeSelection({...readContext(),exclude:excluded});selection=next;if(selection.base==='presence'&&excluded.length>0)notify('Keine weitere passende Aktivität. Ruhe bleibt eine Option.');showSuggestion();}
async function start(){if(busy)return;if(checkSafety())return;if(selection?.mode==='END'){current=null;episodeStarted=false;$('done-copy').textContent='Keine Aktivität wurde gestartet und keine Wirkung angenommen.';show('done');return;}const c=readContext();if(!E.stillAllowed(selection,c)){selection=E.makeSelection(c);notify('Die Situation hat sich geändert. Bitte prüfe den neuen Vorschlag.');showSuggestion();return;}
 busy=true;$('start-activity').disabled=true;
 const attemptId=bridge.id('attempt'),occurredAt=new Date().toISOString(),proposed={...selection};
 const dec={type:'DECISION',eventId:bridge.id('dec-event'),decisionId:bridge.id('decision'),mode:selection.mode,sourceRuleVersion:'candidate-v1.4',selection:{base:proposed.base,background:proposed.background,variant:proposed.variant,trigger},reasonCodes:[proposed.reason],occurredAt};
 const started={type:'START',eventId:bridge.id('start-event'),attemptId,sequence:bridge.count(),trigger,base:selection.base,background:selection.background||null,occurredAt};
 try{await record([dec,started]);}catch(_){busy=false;$('start-activity').disabled=false;notify('Start nicht sicher gespeichert. Bitte erneut versuchen.');return;}
 busy=false;$('start-activity').disabled=false;
 if(!E.stillAllowed(selection,readContext())||$('is-driving').checked){await recordInterrupt('pause',{attemptId});notify('Die Situation hat sich geändert. Start abgebrochen.');selection=E.makeSelection(readContext());showSuggestion();return;}
 current={...selection,trigger,attemptId,decisionId:dec.decisionId};episodeStarted=true;duration=c.duration;timeLeft=duration;paused=false;clock=L.createClockState();
 clock=L.clockEvent(clock,{kind:'start',attemptId,navigationId,now:performance.now()}).state;
 $('activity-heading').textContent=byId(current.base).title;$('activity-description').textContent=current.base==='presence'?'Keine neue Aufgabe. Du kannst einfach einen Moment hierbleiben.':'Du kannst jederzeit aufhören. Es gibt keine Punkte oder Strafen.';$('activity-kicker').textContent=current.base==='presence'?'OHNE AUFGABE':'DEIN SPIEL';$('pause-toggle').textContent='Pausieren';updateClock();drawGame();show('activity');
 if((current.background==='music'||current.base==='music')&&audioUrl){startMedia(current);}else $('audio-player').classList.add('hidden');
 stopClock();timerId=setInterval(tick,250);
}
function updateClock(){const v=Math.max(0,Math.ceil(timeLeft));$('activity-time').textContent=String(Math.floor(v/60)).padStart(2,'0')+':'+String(v%60).padStart(2,'0');}
function tick(){if(paused||!current)return;const now=performance.now();const active=clock.open?Math.max(0,now-clock.open.at):0;timeLeft=Math.max(0,(duration*1000-clock.totalMs-active)/1000);updateClock();if(timeLeft<=0){pauseMonotonic();$('activity-description').textContent='Die gewählte Zeit ist um. Ob es geholfen hat, kannst nur du beurteilen.';$('pause-toggle').disabled=true;notify('Der Zeitraum ist vorbei. Du kannst beenden oder noch bleiben.');}}
function stopActivity(){pendingBatch=null;document.querySelectorAll('[data-tech],[data-outcome],[data-reject]').forEach(b=>b.disabled=false);$('skip-feedback').disabled=false;pauseMonotonic();recordInterrupt('pause',current);stopClock();safeStopAudio();feedbackIds=null;$('pause-toggle').disabled=false;tech=null;outcome=null;rejection='none';for(const b of document.querySelectorAll('[data-tech],[data-outcome],[data-reject]'))b.classList.remove('selected');const b=$('[data-reject="none"]');b?.classList.add('selected');show('feedback');}
function chooseFeedback(selector,key,val){for(const el of document.querySelectorAll(selector))el.classList.toggle('selected',el.dataset[key]===val);}
async function finalize(save){if(busy)return;busy=true;$('save-feedback').disabled=true;
 const events=[],at=new Date().toISOString();if(!pendingBatch&&save&&current&&episodeStarted){
  if(tech||outcome){feedbackIds??={};if(!feedbackIds.feedback)feedbackIds.feedback=bridge.id('feedback');
   events.push({type:'FEEDBACK',eventId:feedbackIds.feedback,attemptId:current.attemptId,tech,outcome,occurredAt:at,
     ...(tech==='negative'?{userConfirmedAttempt:true,techCause:'INTERVENTION'}:tech==='positive'?{userConfirmedPerformed:true}:{})});}
  if(rejection!=='none'){feedbackIds??={};if(!feedbackIds.rejection)feedbackIds.rejection=bridge.id('rejection');
   const e={type:'REJECTION',eventId:feedbackIds.rejection,target:current.base,effect:'EXCLUDE',scope:rejection,condition:'ALWAYS',sessionId:session,occurredAt:at};
   if(rejection==='TODAY'){e.localDay=localDate();e.timeZone=localZone();}events.push(e);}
 }
 if(!pendingBatch)pendingBatch=events;
 try{if(pendingBatch.length)await record(pendingBatch);}catch(_){notify('Speicherung unbestätigt. Erneut versuchen, ohne Angaben zu ändern.');document.querySelectorAll('[data-tech],[data-outcome],[data-reject]').forEach(b=>b.disabled=true);$('skip-feedback').disabled=true;busy=false;$('save-feedback').disabled=false;return;}
 busy=false;$('save-feedback').disabled=false;pendingBatch=null;
 $('done-copy').textContent=(save&&events.length)?'Deine ausdrücklich gewählten Angaben sind berücksichtigt. Du kannst jederzeit wiederkommen.':'Du musst nichts bewerten. Für jetzt reicht das.';
 stopClock();safeStopAudio();show('done');}
function renderSettings(){const root=$('reject-list');root.replaceChildren();const applicable=cards.filter(c=>c.effect==='EXCLUDE'&&['TODAY','UNTIL_REVOKED'].includes(c.scope)&& (c.scope!=='TODAY'||c.date===localDate()) );if(!applicable.length){const p=document.createElement('p');p.className='settings-text';p.textContent='Keine aktuellen länger geltenden Ablehnungen.';root.append(p);return;}for(const card of applicable){const button=document.createElement('button');const a=byId(card.target);button.textContent=(a?.title||card.target)+' · '+(card.scope==='TODAY'?'heute':'bis Widerruf')+' · wieder erlauben';button.addEventListener('click',async()=>{const at=new Date().toISOString(),e={type:'REJECTION',eventId:bridge.id('allow'),target:card.target,effect:'ALLOW',scope:card.scope,occurredAt:at};if(card.scope==='TODAY'){e.localDay=localDate();e.timeZone=localZone();}try{await record([e]);renderSettings();}catch(_){notify('Änderung konnte nicht gespeichert werden.');}});root.append(button);}}
function renderLibrary(){const root=$('library-list');root.replaceChildren();for(const a of E.ACTS){const card=document.createElement('div');card.className='library-item';const i=document.createElement('span');i.className='library-icon';i.textContent=a.icon;const x=document.createElement('div');const h=document.createElement('strong');h.textContent=a.title;const small=document.createElement('small');small.textContent=a.description;x.append(h,small);card.append(i,x);root.append(card);}for(const a of E.EXTRA){const card=document.createElement('div');card.className='library-item';const i=document.createElement('span');i.className='library-icon';i.textContent='◌';const x=document.createElement('div');const h=document.createElement('strong');h.textContent=a.title;const small=document.createElement('small');small.textContent='Kandidat · noch nicht für den Piloten freigegeben';x.append(h,small);const tag=document.createElement('span');tag.className='soon';tag.textContent='SPÄTER';card.append(i,x,tag);root.append(card);}}
function drawGame(){const area=$('game-area');area.replaceChildren();if(!current)return;
 if(current.base==='sort')setupSort(area);else if(current.base==='memory')setupMemory(area);else if(current.base==='blocks')setupBlocks(area);else if(current.base==='music'){const d=document.createElement('div');d.className='presence-card';d.innerHTML='<div class="presence-orb">♫</div><p class="game-instructions">Wenn du möchtest, höre einfach deiner Musik zu.</p>';area.append(d);}else{const d=document.createElement('div');d.className='presence-card';d.innerHTML='<div class="presence-orb">✳</div><p class="game-instructions">Nichts erledigen. Nichts richtig machen.<br>Du kannst einfach hierbleiben.</p>';area.append(d);}}
function setupSort(area){const forms=[['●','Kreis'],['◆','Raute'],['▲','Dreieck'],['■','Quadrat'],['★','Stern'],['✿','Blüte']];let idx=0;const info=document.createElement('div');info.className='game-info';const target=document.createElement('div');target.className='shape-big';target.setAttribute('role','img');const title=document.createElement('div');title.className='shape-title';const options=document.createElement('div');options.className='shape-options';area.append(info,target,title,options);
 function round(){info.textContent='FORMEN FINDEN · RUNDE '+(idx+1);const t=forms[(idx*5+1)%forms.length];target.textContent=t[0];target.setAttribute('aria-label',t[1]);title.textContent='Tippe '+t[1].toLowerCase();options.replaceChildren();const picks=[t,forms[(idx*5+3)%forms.length],forms[(idx*5+4)%forms.length]];picks.sort((a,b)=>(forms.indexOf(a)+idx)%3-(forms.indexOf(b)+idx)%3);for(const p of picks){const b=document.createElement('button');b.textContent=p[0];b.setAttribute('aria-label',p[1]);b.addEventListener('click',()=>{if(p===t){idx++;round();}else{b.classList.add('incorrect');setTimeout(()=>b.classList.remove('incorrect'),350);}});options.append(b);}}
 round();}
function setupMemory(area){const symbols=['✿','◆','●','★'];const pairs=duration<=60?2:duration<=180?3:4;let deck=Array.from({length:pairs},(_,i)=>i).flatMap(i=>[i,i]);let seed=duration+trigger.length;for(let i=deck.length-1;i>0;i--){seed=(seed*1664525+1013904223)>>>0;const j=seed%(i+1);[deck[i],deck[j]]=[deck[j],deck[i]];}let open=[],matched=new Set(),lock=false;let epoch=0;const info=document.createElement('p');info.className='game-instructions';info.textContent='Finde gleiche Symbole. Kein Zeitlimit für einzelne Züge.';const grid=document.createElement('div');grid.className='memory-grid';area.append(info,grid);const buttons=deck.map((n,i)=>{const b=document.createElement('button');b.className='memory-card';b.textContent='?';b.setAttribute('aria-label','Verdeckte Karte '+(i+1));b.addEventListener('click',()=>{if(lock||open.includes(i)||matched.has(i))return;open.push(i);b.textContent=symbols[n];b.classList.add('flipped');b.setAttribute('aria-label',symbols[n]);if(open.length===2){if(deck[open[0]]===deck[open[1]]){open.forEach(k=>{matched.add(k);buttons[k].classList.add('matched')});open=[];if(matched.size===deck.length){info.textContent='Alle Paare gefunden. Du kannst weitermachen oder beenden.';setTimeout(()=>{if(page==='activity'&&current?.base==='memory'){}},0);}}else{lock=true;const old=++epoch;setTimeout(()=>{if(old!==epoch||page!=='activity'||current?.base!=='memory')return;open.forEach(k=>{buttons[k].textContent='?';buttons[k].classList.remove('flipped');buttons[k].setAttribute('aria-label','Verdeckte Karte '+(k+1));});open=[];lock=false;},750);}}});grid.append(b);return b;});}
function setupBlocks(area){let cells=Array(16).fill(0),orientation='horizontal',placed=0;const info=document.createElement('div');info.className='game-instructions';const board=document.createElement('div');board.className='block-board';const controls=document.createElement('div');controls.className='block-controls';area.append(info,board,controls);const rotate=document.createElement('button');rotate.textContent='↻ Drehen';rotate.addEventListener('click',()=>{orientation=orientation==='horizontal'?'vertical':'horizontal';render();});const undo=document.createElement('button');undo.textContent='↶ Zurück';const snapshots=[];undo.addEventListener('click',()=>{if(snapshots.length){cells=snapshots.pop();placed=Math.max(0,placed-1);render();}});controls.append(rotate,undo);
 function place(index){if(placed>=4)return;const row=Math.floor(index/4),col=index%4;const targets=[];for(let k=0;k<4;k++){const r=row+(orientation==='vertical'?k:0),cl=col+(orientation==='horizontal'?k:0);if(r>=4||cl>=4)return;if(cells[r*4+cl])return;targets.push(r*4+cl);}snapshots.push([...cells]);targets.forEach(i=>cells[i]=placed+1);placed++;render();}
 function render(){info.textContent=placed===4?'Fläche ausgefüllt. Du kannst die Runde beenden oder etwas Neues probieren.':'Setze vier lange Blöcke ins Feld. Drehen ist erlaubt.';board.replaceChildren();cells.forEach((n,i)=>{const b=document.createElement('button');b.className='block-cell'+(n?' filled':'');b.setAttribute('aria-label','Zeile '+(Math.floor(i/4)+1)+', Spalte '+(i%4+1)+(n?', belegt':' frei'));b.addEventListener('click',()=>place(i));board.append(b);});undo.disabled=!snapshots.length;rotate.disabled=placed===4;}
 render();}
// Navigation and user controls
$('brand').addEventListener('click',e=>{e.preventDefault();goHome();});$('nav-settings').addEventListener('click',()=>show('settings'));$('tab-home').addEventListener('click',goHome);$('tab-library').addEventListener('click',()=>show('library'));$('tab-settings').addEventListener('click',()=>show('settings'));
document.querySelectorAll('[data-back]').forEach(b=>b.addEventListener('click',()=>show(b.dataset.back)));
$('go-context').addEventListener('click',beginEpisode);$('quick-quiet').addEventListener('click',()=>{resetEpisode();allowPresence();});$('context-quiet').addEventListener('click',allowPresence);$('suggestion-quiet').addEventListener('click',allowPresence);
document.querySelectorAll('[data-trigger]').forEach(b=>b.addEventListener('click',()=>{trigger=b.dataset.trigger;document.querySelectorAll('[data-trigger]').forEach(x=>{x.classList.toggle('active',x===b);x.setAttribute('aria-pressed',x===b?'true':'false');});}));
document.querySelectorAll('[data-duration]').forEach(b=>b.addEventListener('click',()=>{duration=Number(b.dataset.duration);document.querySelectorAll('[data-duration]').forEach(x=>x.classList.toggle('selected',x===b));}));
document.querySelectorAll('[data-interaction]').forEach(b=>b.addEventListener('click',()=>{interaction=b.dataset.interaction;document.querySelectorAll('[data-interaction]').forEach(x=>x.classList.toggle('selected',x===b));}));
$('is-driving').addEventListener('change',()=>{if($('is-driving').checked)checkSafety();});$('safety-close').addEventListener('click',()=>show('context'));$('safety-now').addEventListener('click',()=>{$('safety-message').textContent='Wenn du dich in einer akuten medizinischen Notlage befindest, rufe 112. Die App ist dafür keine geeignete Hilfe.';$('emergency-link').classList.remove('hidden');show('safety');});
$('get-choice').addEventListener('click',offer);$('try-another').addEventListener('click',another);$('start-activity').addEventListener('click',start);
$('audio-input').addEventListener('change',e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>60*1024*1024){notify('Diese Datei ist für den Pilot zu groß (maximal 60 MB).');e.target.value='';return;}if(!file.type.startsWith('audio/')){notify('Bitte eine Audiodatei auswählen.');return;}safeStopAudio();if(audioUrl)URL.revokeObjectURL(audioUrl);audioUrl=URL.createObjectURL(file);$('can-audio').checked=true;selection=E.makeSelection(readContext());showSuggestion();notify('Musik wurde nur lokal ausgewählt.');});
$('pause-toggle').addEventListener('click',()=>{if(!current)return;if(!paused){pauseMonotonic();recordInterrupt('pause',current);$('pause-toggle').textContent='Fortsetzen';$('music-player').pause();}else{resumeMonotonic();$('pause-toggle').textContent='Pausieren';if(!$('audio-player').classList.contains('hidden'))$('music-player').play().catch(()=>{});}});
$('activity-end-top').addEventListener('click',stopActivity);$('activity-finish').addEventListener('click',stopActivity);$('activity-change').addEventListener('click',()=>{pauseMonotonic();recordInterrupt('switch',current);stopClock();safeStopAudio();if(current?.base!=='presence')excluded.push(current.base);selection=E.makeSelection({...readContext(),exclude:excluded});current=null;showSuggestion();});
document.querySelectorAll('[data-tech]').forEach(b=>b.addEventListener('click',()=>{tech=b.dataset.tech==='none'?null:b.dataset.tech;chooseFeedback('[data-tech]','tech',b.dataset.tech)}));
document.querySelectorAll('[data-outcome]').forEach(b=>b.addEventListener('click',()=>{outcome=b.dataset.outcome==='none'?null:b.dataset.outcome;chooseFeedback('[data-outcome]','outcome',b.dataset.outcome)}));
document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',()=>{rejection=b.dataset.reject;chooseFeedback('[data-reject]','reject',b.dataset.reject)}));
$('save-feedback').addEventListener('click',()=>finalize(true));$('skip-feedback').addEventListener('click',()=>finalize(false));$('done-home').addEventListener('click',goHome);$('done-another').addEventListener('click',beginEpisode);
$('opt-memory').addEventListener('change',async e=>{e.target.disabled=true;try{await bridge.setConsent(e.target.checked);memoryEnabled=bridge.persistent;try{localStorage.setItem('frei-v13-consent',memoryEnabled?'yes':'no');}catch(_){}refreshMemory();notify(memoryEnabled?'Ab jetzt werden Daten lokal gespeichert.':'Gespeicherte Lerndaten wurden gelöscht.');}catch(_){notify('Speichern nicht verfügbar; Einstellung unverändert.');}e.target.checked=bridge.persistent;e.target.disabled=false;});
$('delete-data').addEventListener('click',async()=>{if(!confirm('Alle gespeicherten und aktuellen Lerndaten löschen?'))return;try{await bridge.deleteAll();try{localStorage.removeItem('frei-v13-consent');localStorage.removeItem(STORE);}catch(_){}refreshMemory();memoryEnabled=false;$('opt-memory').checked=false;renderSettings();notify('Neue und alte lokale Lerndaten gelöscht.');}catch(_){notify('Löschung nicht bestätigt. Daten bitte prüfen.');}});
document.addEventListener('visibilitychange',()=>{
 // A backgrounded episode is interrupted, not silently completed.
 if(page==='activity'&&!paused&&document.visibilityState==='hidden'){
   pauseMonotonic();recordInterrupt('hidden',current);
   paused=true;$('pause-toggle').textContent='Fortsetzen';
   $('music-player').pause();updateClock();
 }
});
window.addEventListener('pagehide',()=>{if(current&&!paused)pauseMonotonic();safeStopAudio();});
if('serviceWorker' in navigator&&(location.protocol==='https:'||location.hostname==='localhost'))navigator.serviceWorker.register('./service-worker.js').catch(()=>{});
initialize();
})();
