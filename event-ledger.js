/* FREI – v1.2 CANDIDATE: event correctness research kernel.
 * NOT integrated with the v1.1 UI; designed for separate validation.
 * One report per attempt, immutable historical decisions, UTC intake vs local day.
 */
(function(root,factory){const x=factory();if(typeof module==='object'&&module.exports)module.exports=x;root.FreiEventLedger=x;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const BASES = new Set(['sort','memory','blocks','music','presence']);
const TRIGGERS = new Set(['coffee','stress','waiting','meal','other']);
const TECH = new Set(['positive','negative',null]);
const OUTCOME = new Set(['helped','not_helped',null]);
function copy(v){return JSON.parse(JSON.stringify(v));}
function fresh(){return {schema:2,attempts:{},events:{},decisions:[],rejectionCards:[],uncertainDays:[]};}
function stable(x){if(Array.isArray(x))return '['+x.map(stable).join(',')+']';if(x!==null&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';return JSON.stringify(x);}
function validId(s){return typeof s==='string'&&s.length>=1&&s.length<=120;}
function validTime(t){return typeof t==='string'&&!Number.isNaN(Date.parse(t))&&/Z$|[+-]\d\d:\d\d$/.test(t);}
function localDay(utc,tz){if(!validTime(utc)||typeof tz!=='string'||tz.length>100) return null;try{
 const pts=new Intl.DateTimeFormat('en-US',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(utc));
 const f=k=>pts.find(x=>x.type===k)?.value;return `${f('year')}-${f('month')}-${f('day')}`;
}catch(_e){return null;}}
function check(e){if(!e||typeof e!=='object'||!validId(e.eventId)||!['START','FEEDBACK','CORRECTION','INTERRUPT','REJECTION','DAY_UNCERTAIN','RESOLVE_DAY','AUDIO_INSTANCE','AUDIO_END','DECISION'].includes(e.type))return 'INVALID_EVENT';
 if(!validTime(e.occurredAt))return 'INVALID_OCCURRENCE_TIME';
 if(e.type==='START'){
   if(!validId(e.attemptId)||!Number.isSafeInteger(e.sequence)||e.sequence<=0||!BASES.has(e.base)||!TRIGGERS.has(e.trigger)||!(e.background===null||e.background===undefined||e.background==='music')||
     e.base==='music'&&e.background==='music'||e.base==='presence'&&e.background)return 'INVALID_START';
 }
 if(e.type==='FEEDBACK'){
   if(!validId(e.attemptId)||!TECH.has(e.tech??null)||!OUTCOME.has(e.outcome??null)||
     (e.tech??null)===null&&(e.outcome??null)===null)return 'INVALID_FEEDBACK';
   // An explicitly rated technique needs a user-confirmed attempt, not a mere timer event.
   if(e.tech==='negative' && (e.userConfirmedAttempt!==true || e.techCause!=='INTERVENTION'))return 'TECH_EVIDENCE_MISSING';
   if(e.tech==='positive' && e.userConfirmedPerformed!==true)return 'TECH_EVIDENCE_MISSING';
 }
 if(['AUDIO_INSTANCE','AUDIO_END'].includes(e.type)&&(!validId(e.attemptId)||!validId(e.mediaInstanceId)||!Number.isSafeInteger(e.mediaOrder)||e.mediaOrder<1))return 'INVALID_AUDIO_EVENT';
 if(e.type==='CORRECTION'){
   if(!validId(e.attemptId)||!validId(e.replacesEventId)||!TECH.has(e.tech??null)||!OUTCOME.has(e.outcome??null))return 'INVALID_CORRECTION';
   const withdrawn=(e.tech??null)===null&&(e.outcome??null)===null;
   if(withdrawn && !['EXTERNAL_CIRCUMSTANCE','EVALUATION_UNKNOWN'].includes(e.retractReason))return 'INVALID_CORRECTION';
   if(!withdrawn && e.retractReason!==undefined)return 'INVALID_CORRECTION';
   if(e.tech==='negative' && (e.userConfirmedAttempt!==true || e.techCause!=='INTERVENTION'))return 'TECH_EVIDENCE_MISSING';
   if(e.tech==='positive' && e.userConfirmedPerformed!==true)return 'TECH_EVIDENCE_MISSING';
 }
 if(e.type==='DAY_UNCERTAIN'&&(!validId(e.target)||e.target!=='music'))return 'INVALID_UNCERTAIN_DAY';
 if(e.type==='RESOLVE_DAY'&&(!validId(e.uncertainEventId)||!['ALLOW_NOW','KEEP_EXCLUDED'].includes(e.resolution)))return 'INVALID_DAY_RESOLUTION';
 if(e.type==='INTERRUPT'&&(!validId(e.attemptId)||!['hidden','switch','audio','pause','reload'].includes(e.reason)))return 'INVALID_INTERRUPTION';
 if(e.type==='REJECTION'){
   if(!validId(e.target)||!['MOMENT','TODAY','EPISODE','UNTIL_REVOKED'].includes(e.scope)||!['EXCLUDE','ALLOW'].includes(e.effect))return 'INVALID_REJECTION';
   if(e.scope==='TODAY'&&(localDay(e.occurredAt,e.timeZone)!==e.localDay||!/\d{4}-\d{2}-\d{2}/.test(e.localDay)))return 'INVALID_DAY_PROVENANCE';
 }
 if(e.type==='DECISION'&&(!validId(e.decisionId)||!validId(e.sourceRuleVersion)||!['NORMAL','LOW_DEMAND','END','SAFETY'].includes(e.mode)))return 'INVALID_DECISION';
 return null;
}
function ingest(original, incoming, receivedAt){
 const state=copy(original||fresh()),e=copy(incoming||{});
 const fault=check(e);if(fault)return {state,status:fault};
 if(!validTime(receivedAt))return {state,status:'INVALID_RECEIPT_TIME'};
 const existing=state.events[e.eventId];
 if(existing)return {state,status:stable(existing.event)===stable(e)?'DUPLICATE':'EVENT_ID_CONFLICT'};
 if(e.type==='START'&&state.attempts[e.attemptId])return {state,status:'ATTEMPT_ID_CONFLICT'};
 if(e.type==='AUDIO_INSTANCE'&&Object.values(state.events).some(x=>x.event.type==='AUDIO_INSTANCE'&&x.event.mediaInstanceId===e.mediaInstanceId))return {state,status:'AUDIO_INSTANCE_CONFLICT'};
 if(e.type==='AUDIO_INSTANCE'&&Object.values(state.events).some(x=>x.event.type==='AUDIO_INSTANCE'&&x.event.attemptId===e.attemptId&&x.event.mediaOrder===e.mediaOrder))return {state,status:'AUDIO_ORDER_CONFLICT'};
 if(e.type==='AUDIO_END'&&!Object.values(state.events).some(x=>x.event.type==='AUDIO_INSTANCE'&&x.event.mediaInstanceId===e.mediaInstanceId&&x.event.attemptId===e.attemptId&&x.event.mediaOrder===e.mediaOrder))return {state,status:'AUDIO_INSTANCE_MISSING'};
 if(['AUDIO_INSTANCE','AUDIO_END'].includes(e.type)&&!state.attempts[e.attemptId])return {state,status:'AUDIO_ATTEMPT_MISSING'};
 if(e.type==='CORRECTION'){const old=state.events[e.replacesEventId]?.event;
  if(!old||old.type!=='FEEDBACK'||old.attemptId!==e.attemptId)return {state,status:'CORRECTION_TARGET_MISSING'};
  if(Object.values(state.events).some(x=>x.event.type==='CORRECTION'&&x.event.replacesEventId===e.replacesEventId))return {state,status:'CORRECTION_CONFLICT'};
 }
 if(e.type==='RESOLVE_DAY'){
  if(!state.uncertainDays?.some(x=>x.eventId===e.uncertainEventId))return {state,status:'UNKNOWN_DAY_REFERENCE'};
  if(Object.values(state.events).some(x=>x.event.type==='RESOLVE_DAY'&&x.event.uncertainEventId===e.uncertainEventId))return {state,status:'DAY_RESOLUTION_CONFLICT'};
 }
 if(e.type==='START'&&Object.values(state.attempts).some(a=>a.order===e.sequence))return {state,status:'START_SEQUENCE_CONFLICT'};
 if(e.type==='DECISION'&&state.decisions.some(x=>x.decisionId===e.decisionId))return {state,status:'DECISION_ID_CONFLICT'};
 if(e.type==='START'){
  state.attempts[e.attemptId]={attemptId:e.attemptId,order:e.sequence,trigger:e.trigger,base:e.base,background:e.background||null,
   startedAt:e.occurredAt,localDay:e.localDay||null};
 }
 state.events[e.eventId]={event:e,receivedAt};
 if(e.type==='DECISION'){
  state.decisions.push({eventId:e.eventId,decisionId:e.decisionId,selection:copy(e.selection||null),mode:e.mode,
   sourceRuleVersion:e.sourceRuleVersion,decidedAt:e.occurredAt,receivedAt,reasonCodes:copy(e.reasonCodes||[])});
 }
 if(e.type==='DAY_UNCERTAIN')(state.uncertainDays??=[]).push({eventId:e.eventId,target:e.target,receivedAt});
 if(e.type==='REJECTION')state.rejectionCards.push({eventId:e.eventId,target:e.target,effect:e.effect,scope:e.scope,localDay:e.scope==='TODAY'?e.localDay:null,
  timeZone:e.scope==='TODAY'?e.timeZone:null,sessionId:e.sessionId||null,condition:e.condition||'ALWAYS',occurredAt:e.occurredAt,receivedAt});
 return {state,status:'APPLIED'};
}
function feedbackIndex(s){const byAttempt={};const replacements={};
 for(const r of Object.values(s.events)){const e=r.event;if(e.type==='CORRECTION')replacements[e.replacesEventId]=e;}
 for(const r of Object.values(s.events)){
  const e=r.event;if(e.type!=='FEEDBACK')continue;
  const c=replacements[e.eventId];
  // Old v1.3 records were accepted without the explicit technical-evidence fields.
  // Retain their raw history, but project unverified TECH as UNKNOWN rather than
  // silently treating old ratings as verified positive/negative on v1.4.
  const current=c?{...e,tech:c.tech,outcome:c.outcome,
   ...(c.userConfirmedAttempt!==undefined?{userConfirmedAttempt:c.userConfirmedAttempt}:{}),
   ...(c.userConfirmedPerformed!==undefined?{userConfirmedPerformed:c.userConfirmedPerformed}:{}),
   ...(c.techCause!==undefined?{techCause:c.techCause}:{}),
   correctionEventId:c.eventId}:e;
  const evidence=current.tech==='negative'?(current.userConfirmedAttempt===true&&current.techCause==='INTERVENTION'):
    current.tech==='positive'?current.userConfirmedPerformed===true:true;
  (byAttempt[e.attemptId]??=[]).push(evidence?current:{...current,tech:null,unverifiedHistoricalTech:true});
 }return byAttempt;}
function project(s){
 const fb=feedbackIndex(s),history=[],ambiguous=[],pending=[];
 for(const [id,items] of Object.entries(fb)){
  if(!s.attempts[id])pending.push(id);
  else if(items.length>1)ambiguous.push(id);
 }
 for(const a of Object.values(s.attempts).sort((x,y)=>x.order-y.order)){
  const items=fb[a.attemptId]||[];
  if(items.length!==1)continue;
  const e=items[0];history.push({attemptId:a.attemptId,attemptOrder:a.order,trigger:a.trigger,base:a.base,background:a.background,
   eventId:e.eventId,started:true,tech:e.tech??null,outcome:e.outcome??null,reportedAt:e.occurredAt});
 }
 return {history,ambiguous:ambiguous.sort(),pending:pending.sort(),decisions:copy(s.decisions),rejectionCards:copy(s.rejectionCards)};
}
function stats(s,trigger,base,background=null){let negatives=0,helpful=false,reportCount=0;
 for(const h of project(s).history){if(h.trigger!==trigger||h.base!==base||(h.background||null)!==(background||null))continue;
  reportCount++;if(h.tech==='negative')negatives++;else if(h.tech==='positive')negatives=0;
  if(h.outcome==='helped')helpful=true;
 }return {negatives,helpful,reportCount,primaryEligible:negatives<2};
}
function mediaState(s,attemptId){
 const events=Object.values(s.events).map(x=>x.event);
 const starts=events.filter(e=>e.type==='AUDIO_INSTANCE'&&e.attemptId===attemptId).sort((a,b)=>a.mediaOrder-b.mediaOrder);
 if(!starts.length)return {mediaInstanceId:null,ended:false};
 const current=starts.at(-1);
 return {mediaInstanceId:current.mediaInstanceId,ended:events.some(e=>e.type==='AUDIO_END'&&e.attemptId===attemptId&&e.mediaInstanceId===current.mediaInstanceId)};
}
function nextSequence(s){return Math.max(0,...Object.values(s.attempts).map(a=>a.order||0))+1;}
function activeAttempt(s){
 // A historical INTERRUPTION is attached to its attempt; it never rewinds newer START.
 const attempts=Object.values(s.attempts).sort((a,b)=>a.order-b.order);return attempts.at(-1)?.attemptId||null;
}
function rejectionDecision(s,target,day,knowledgeCutoff=null){
 // Only an explicit correction of the SAME target may override a specific exclusion.
 // Ordering follows the capture timestamp, not arrival time; equal conflicting
 // timestamps are treated as UNKNOWN rather than guessed.
 const cutoff=knowledgeCutoff?Date.parse(knowledgeCutoff):Infinity;
 const unresolved=(s.uncertainDays||[]).filter(u=>u.target===target&&!Object.values(s.events).some(r=>r.event.type==='RESOLVE_DAY'&&r.event.uncertainEventId===u.eventId));
 if(unresolved.length)return 'UNKNOWN';
 const kept=(s.uncertainDays||[]).filter(u=>u.target===target&&Object.values(s.events).some(r=>r.event.type==='RESOLVE_DAY'&&r.event.uncertainEventId===u.eventId&&r.event.resolution==='KEEP_EXCLUDED'));
 if(kept.length)return 'EXCLUDED';
 const applicable=s.rejectionCards.filter(c=>c.target===target && Date.parse(c.occurredAt)<=cutoff &&
    (c.scope==='UNTIL_REVOKED'||c.scope==='TODAY'&&c.localDay===day));
 if(!applicable.length)return 'ALLOWED';
 applicable.sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt));
 const last=applicable.at(-1);
 const equal=applicable.filter(c=>Date.parse(c.occurredAt)===Date.parse(last.occurredAt));
 if(new Set(equal.map(x=>x.effect)).size>1)return 'UNKNOWN';
 return last.effect==='EXCLUDE'?'EXCLUDED':'ALLOWED';
}
function rejectionOnDay(s,target,day,knowledgeCutoff=null){return rejectionDecision(s,target,day,knowledgeCutoff)!=='ALLOWED';}
function createClockState(){return {totalMs:0,open:null,uncertain:false};}
function clockEvent(original,{kind,attemptId,navigationId,now}){
 const c=copy(original||createClockState());if(!['start','pause','resume','restore','stop'].includes(kind)||!validId(attemptId)||!validId(navigationId)||!Number.isFinite(now)||now<0)return {state:c,status:'INVALID_CLOCK_EVENT'};
 if(kind==='restore'){
   // Across navigations no origin comparison is permitted; unfinished spans are unknown.
   if(c.open){c.open=null;c.uncertain=true;}return {state:c,status:'RESTORED_PAUSED'};
 }
 if(kind==='start'||kind==='resume'){
   if(c.open)return {state:c,status:'ALREADY_ACTIVE'};
   c.open={attemptId,navigationId,at:now};return {state:c,status:'STARTED'};
 }
 if(!c.open)return {state:c,status:'ALREADY_PAUSED'};
 if(c.open.attemptId!==attemptId||c.open.navigationId!==navigationId||now<c.open.at)return {state:c,status:'MISMATCH_NO_COUNT'};
 c.totalMs+=now-c.open.at;c.open=null;return {state:c,status:kind==='stop'?'STOPPED':'PAUSED'};
}
return {fresh,ingest,project,stats,nextSequence,mediaState,activeAttempt,rejectionDecision,rejectionOnDay,localDay,createClockState,clockEvent,stable};
});
