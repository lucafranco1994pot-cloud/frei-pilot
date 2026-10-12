/* FREI — Nikotin-Begleitung, new CANDIDATE engine. Original Frozen Runtime unchanged. */
(function(root, factory){const e=factory();if(typeof module==='object'&&module.exports)module.exports=e;root.FreiEngine=e;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const ACTS=Object.freeze([
  {id:'sort',title:'Formen sortieren',icon:'◈',category:'COGNITIVE_MINI',active:true,requires:['screen','hands'],description:'Kleine Formen zuordnen, ohne Tempo oder Punkte.'},
  {id:'memory',title:'Mini-Memory',icon:'▦',category:'COGNITIVE_MINI',active:true,requires:['screen','hands'],description:'Wenige Paare finden, so langsam du magst.'},
  {id:'blocks',title:'Block-Puzzle',icon:'▤',category:'COGNITIVE_MINI',active:true,requires:['screen','hands'],description:'Kleine Blöcke platzieren und ausprobieren.'},
  {id:'music',title:'Eigene Musik',icon:'♫',category:'AUDIO_PASSIVE',active:false,requires:['audio','file'],description:'Deine Audiodatei abspielen, ohne Aufgabe.'},
  {id:'presence',title:'Einfach hier sein',icon:'◌',category:'QUIET_PRESENCE',active:false,requires:[],description:'Kein Spiel. Keine Aufgabe. Einfach kurz bleiben.'}
]);
const EXTRA=Object.freeze([
  {id:'tactile',title:'Oberflächen fühlen',status:'SPEZIFIZIEREN'},
  {id:'handgrip',title:'Handgrip',status:'FACHLICH_PRUEFEN'},
  {id:'stop',title:'Ruhige Wahrnehmung',status:'FACHLICH_PRUEFEN'},
  {id:'story',title:'Hörgeschichte',status:'INHALT_PRUEFEN'}
]);
const KNOWN=new Set(ACTS.map(a=>a.id));
function cleanContext(v={}){
 const c={...v};return {
  trigger:['coffee','stress','waiting','meal','other'].includes(c.trigger)?c.trigger:'other',
  duration:[60,120,180,300].includes(Number(c.duration))?Number(c.duration):120,
  screen:c.screen!==false,hands:c.hands!==false,audio:c.audio===true,hasFile:c.hasFile===true,
  driving:c.driving===true,danger:c.danger===true,noTechniques:c.noTechniques===true,
  wantsMusic:c.wantsMusic===true, interaction:c.interaction==='choice'?'choice':'direct',
  reject:Array.isArray(c.reject)?c.reject:[], history:Array.isArray(c.history)?c.history:[],
  exclude:Array.isArray(c.exclude)?c.exclude:[], sessionId:typeof c.sessionId==='string'?c.sessionId:'',
  now:typeof c.now==='string'?c.now:new Date().toISOString()
 };
}
function groupFor(id){return id==='music'?'AUDIO':id==='presence'?'PRESENCE':'GAMES';}
function cardApplicable(card,c){
 if(!card||card.effect!=='EXCLUDE'||!card.target)return false;
 if(card.condition && card.condition!=='ALWAYS' && card.condition!==c.trigger)return false;
 if(card.scope==='MOMENT' && card.sessionId && card.sessionId!==c.sessionId)return false;
 if(card.scope==='EPISODE' && card.sessionId!==c.sessionId)return false;
 if(card.scope==='TODAY' && String(card.date)!==c.now.slice(0,10))return false;
 return ['MOMENT','EPISODE','TODAY','UNTIL_REVOKED'].includes(card.scope);
}
function rejected(id,c){return c.reject.some(card=>cardApplicable(card,c)&&(card.target===id||card.target===groupFor(id)||card.target==='ALL'));}
function available(c){
 return ACTS.filter(a=>{
   if(rejected(a.id,c))return false;
   if(a.id==='presence')return true;
   if(a.id==='music')return c.audio&&c.hasFile;
   return c.screen&&c.hands;
 });
}
function comboKey(trigger,base,background){return [trigger,base||'',background||''].join('|');}
function comboStats(c,base,bg){
 const items=c.history.filter(h=>h.trigger===c.trigger&&h.base===base&&(h.background||null)===(bg||null)&&h.started===true);
 let negatives=0,helpful=false;
 for(const h of items){if(h.tech==='negative')negatives++;if(h.tech==='positive')negatives=0;if(h.outcome==='helped')helpful=true;}
 return {negatives,helpful};
}
function makeSelection(c0){
 const c=cleanContext(c0);
 if(c.danger)return {mode:'SAFETY',reason:'EMERGENCY',base:null,background:null,variant:null};
 if(c.driving)return {mode:'SAFETY',reason:'DRIVING',base:null,background:null,variant:null};
 if(c.noTechniques)return rejected('presence',c)?{mode:'END',reason:'NO_ALLOWED',base:null,background:null,variant:null}:{mode:'LOW_DEMAND',reason:'NO_TECHNIQUES',base:'presence',background:null,variant:'quiet'};
 const pool=available(c);const ids=new Set(pool.map(x=>x.id));
 const opts=[];
 for(const id of ['sort','memory','blocks','music']){
  if(!ids.has(id)||c.exclude.includes(id))continue;
  const bgs=(id==='music'||!ids.has('music')||!c.wantsMusic)?[null]:['music',null];
  for(const bg of bgs){if(rejected('music',c)&&bg)continue;
   const stats=comboStats(c,id,bg);
   if(stats.negatives>=2)continue;
   let score=(id==='sort'?20:id==='memory'?18:id==='blocks'?17:10) + (bg?4:0);
   if(id==='music'&&c.wantsMusic)score+=11;
   if(stats.helpful)score+=70;
   if(c.history.some(h=>h.trigger===c.trigger&&h.base===id&&h.started&&h.tech==='positive'))score+=5;
   opts.push({base:id,background:bg,score});
  }
 }
 opts.sort((a,b)=>b.score-a.score||['sort','memory','blocks','music'].indexOf(a.base)-['sort','memory','blocks','music'].indexOf(b.base));
 const best=opts[0];
 if(!best)return ids.has('presence')?{mode:'LOW_DEMAND',reason:'NO_ELIGIBLE',base:'presence',background:null,variant:'quiet'}:{mode:'END',reason:'NO_ALLOWED',base:null,background:null,variant:null};
 const variant=c.duration<=60?'very_short':c.duration<=120?'short':c.duration<=180?'medium':'long';
 return {mode:'NORMAL',reason:comboStats(c,best.base,best.background).helpful?'HELPED_BEFORE':'FIRST_SAFE_FIT',base:best.base,background:best.background,variant};
}
function stillAllowed(selection,context){const c=cleanContext(context);
 if(c.danger||c.driving)return false;
 if(selection.mode==='LOW_DEMAND'){
   if(selection.base!=='presence')return false;
   if(!rejected('presence',c))return true;
   // A deliberate, current request for quiet may override only the quiet
   // restriction that was already known. Any subsequent change invalidates it.
   return selection.reason==='EXPLICIT_QUIET' &&
     selection.rejectionSnapshot===JSON.stringify(c.reject);
 }
 if(selection.mode!=='NORMAL'||!selection.base)return false;
 const ids=new Set(available(c).map(a=>a.id));
 if(!ids.has(selection.base)||c.noTechniques||
    (selection.background&&(!ids.has(selection.background)||!c.wantsMusic)))return false;
 // A prior proposal must not remain primary after the second confirmed
 // technical failure for the same activity + background + trigger.
 // A user's new explicit manual choice is different from an automatic primary.
 if(selection.reason!=='EXPLICIT_CHOICE'&&
   comboStats(c,selection.base,selection.background).negatives>=2)return false;
 return true;
}
function validateFeedback(evt){if(!evt||!KNOWN.has(evt.base)||!['positive','negative',null].includes(evt.tech??null)||!['helped','not_helped',null].includes(evt.outcome??null))return false;
 return evt.started===true && ['coffee','stress','waiting','meal','other'].includes(evt.trigger) && (!evt.background || evt.background==='music');}
function addFeedback(history,event){if(!validateFeedback(event))return history.slice();if(event.eventId&&history.some(h=>h.eventId===event.eventId))return history.slice();return [...history,{eventId:event.eventId||null,trigger:event.trigger,base:event.base,background:event.background||null,started:true,tech:event.tech||null,outcome:event.outcome||null}].slice(-100);}
return {ACTS,EXTRA,cleanContext,available,rejected,makeSelection,stillAllowed,addFeedback,comboStats,comboKey};
});
