/* FREI v1.3 CANDIDATE. IndexedDB atomic event batch + projection, no network.
 * An open transaction contains no awaited promise: operations are queued within
 * request callbacks, and UI changes only after tx.oncomplete fires.
 */
(function(root,factory){const x=factory(root.FreiEventLedger||(typeof require==='function'?require('./event-ledger'):null));if(typeof module==='object'&&module.exports)module.exports=x;root.FreiEventStore=x;})(typeof globalThis!=='undefined'?globalThis:this,function(L){
'use strict';
function makeStore(dbName='frei-v13-activity-events',factory=typeof indexedDB!=='undefined'?indexedDB:null){
 if(!factory)throw Error('IndexedDB unavailable – persistent writes blocked');
 let dbPromise;
 function open(){if(dbPromise)return dbPromise;dbPromise=new Promise((resolve,reject)=>{
  const req=factory.open(dbName,1);
  req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('state'))req.result.createObjectStore('state',{keyPath:'key'});};
  req.onsuccess=()=>{const db=req.result;db.onversionchange=()=>{db.close();dbPromise=null;};resolve(db);};
  req.onerror=()=>{dbPromise=null;reject(req.error||Error('Open failed'));};
  req.onblocked=()=>{dbPromise=null;reject(Error('Database blocked by another tab'));};
 });return dbPromise;}
 async function read(){const db=await open();return new Promise((resolve,reject)=>{
  const tx=db.transaction('state','readonly');let result=L.fresh();
  tx.objectStore('state').get('main').onsuccess=e=>{result=e.target.result?.value||L.fresh();};
  tx.oncomplete=()=>resolve(result);tx.onabort=()=>reject(tx.error||Error('Read aborted'));tx.onerror=()=>reject(tx.error||Error('Read failed'));
 });}
 async function dispatchBatch(events,receiptAt){const db=await open();return new Promise((resolve,reject)=>{
  let tx;try{tx=db.transaction('state','readwrite',{durability:'strict'});}catch(_){tx=db.transaction('state','readwrite');}
  const s=tx.objectStore('state');let result=null,error=null;
  s.get('main').onsuccess=e=>{
   let state=e.target.result?.value||L.fresh();const statuses=[];
   try{for(const evt of events){const x=L.ingest(state,evt,receiptAt);statuses.push(x.status);
      if(!['APPLIED','DUPLICATE'].includes(x.status)){error=new Error(x.status);tx.abort();return;}state=x.state;}
      result={state,statuses};if(statuses.some(x=>x==='APPLIED'))s.put({key:'main',value:state});
   }catch(ex){error=ex;try{tx.abort();}catch(_){}}
  };
  tx.oncomplete=()=>resolve(result);
  tx.onabort=()=>reject(error||tx.error||Error('Write aborted'));
  tx.onerror=()=>{error??=tx.error||Error('Write failed');};
 });}
 async function replace(state){const db=await open();return new Promise((resolve,reject)=>{
  const tx=db.transaction('state','readwrite');tx.objectStore('state').put({key:'main',value:state});
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Replace aborted'));tx.onerror=()=>reject(tx.error||Error('Replace failed'));
 });}
 async function clear(){const db=await open();return new Promise((resolve,reject)=>{
  const tx=db.transaction('state','readwrite');tx.objectStore('state').delete('main');
  tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||Error('Clear aborted'));tx.onerror=()=>reject(tx.error||Error('Clear failed'));
 });}
 return {open,read,dispatchBatch,replace,clear};
}
return {makeStore};
});
