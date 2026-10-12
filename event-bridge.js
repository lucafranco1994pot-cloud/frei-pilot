/* FREI v1.3 pilot bridge: one local profile, no silent migration.
 * Legacy localStorage data is quarantined (not imported). If persistent
 * storage is unavailable, write actions fail closed while consent is on.
 */
(function(root,factory){const x=factory(root.FreiEventLedger||(typeof require==='function'?require('./event-ledger'):null),root.FreiEventStore||(typeof require==='function'?require('./event-store'):null));if(typeof module==='object'&&module.exports)module.exports=x;root.FreiEventBridge=x;})(typeof globalThis!=='undefined'?globalThis:this,function(L,S){
'use strict';
function makeBridge({store=null,persist=false,initial=null}={}){
 let state=initial||L.fresh(),storage=store,enabled=!!persist;
 const clone=x=>JSON.parse(JSON.stringify(x));
 async function init(){if(enabled){if(!storage)throw Error('NO_STORAGE');state=await storage.read();}return clone(state);}
 function id(prefix){if(typeof crypto!=='undefined'&&crypto.randomUUID)return prefix+'-'+crypto.randomUUID();return prefix+'-'+Date.now()+'-'+Math.random().toString(36).slice(2);}
 async function dispatch(events,receivedAt=new Date().toISOString()){
  if(!Array.isArray(events)||!events.length)throw Error('EMPTY_BATCH');
  if(enabled){if(!storage)throw Error('NO_STORAGE');const r=await storage.dispatchBatch(events,receivedAt);state=r.state;return r.statuses;}
  // no persistence: use atomic in-memory shadow until every event validates
  let next=clone(state),statuses=[];
  for(const evt of events){const r=L.ingest(next,evt,receivedAt);if(!['APPLIED','DUPLICATE'].includes(r.status))throw Error(r.status);next=r.state;statuses.push(r.status);}
  state=next;return statuses;
 }
 async function setConsent(v){if(v===enabled)return;
  if(v){if(!storage)throw Error('NO_STORAGE');await storage.replace(state);enabled=true;}
  else {if(storage)await storage.clear();enabled=false;state=L.fresh();}
 }
 async function deleteAll(){if(storage)await storage.clear();enabled=false;state=L.fresh();}
 function stateSnapshot(){return clone(state);}
 function history(){return L.project(state).history.map(h=>({...h,started:true}));}
 function cards(day=new Date().toISOString().slice(0,10)){
  const raw=L.project(state).rejectionCards;
  const targets=new Set(raw.map(c=>c.target));const result=[];
  for(const target of targets){
   // Current day, persistent and short-lived cards can coexist; short-lived
   // cards are evaluated by the selector using sessionId, not global day.
   const long=raw.filter(c=>c.target===target&&['TODAY','UNTIL_REVOKED'].includes(c.scope));
   if(long.length&&L.rejectionDecision(state,target,day)!=='ALLOWED'){
    const x=long.filter(c=>c.effect==='EXCLUDE'&&(c.scope==='UNTIL_REVOKED'||c.localDay===day)).at(-1);
    if(x)result.push({target,effect:'EXCLUDE',scope:x.scope,date:x.localDay,condition:x.condition||'ALWAYS'});
   }
   const shorts=raw.filter(c=>c.target===target&&['MOMENT','EPISODE'].includes(c.scope));
   if(shorts.length){const x=shorts.at(-1);if(x.effect==='EXCLUDE')result.push({target,effect:'EXCLUDE',scope:x.scope,
    sessionId:x.sessionId||'',condition:x.condition||'ALWAYS'});}
  }
  return result;
 }
 function hold(target='music',localCalendarDay=new Date().toISOString().slice(0,10)){return L.rejectionDecision(state,target,localCalendarDay)!=='ALLOWED';}
 function count(){return L.nextSequence(state);}
 return {init,id,dispatch,setConsent,deleteAll,stateSnapshot,history,cards,hold,count,get persistent(){return enabled;}};
}
return {makeBridge};
});
