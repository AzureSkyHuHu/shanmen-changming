import { performance } from 'node:perf_hooks';
import { prepareUnregisteredCommandCandidateV10 } from '../src/core/kernel/commands-v10';
import { createPrivateRuntimeV10 } from '../src/core/world/runtime-instance-v10';
import { createUnregisteredWorldV9 } from '../src/core/world/create-world-v9';
import { MANAGEMENT_V10_IDENTITY, MANAGEMENT_V10_CONTENT_VERSION } from '../src/content/sect-v10/world-content';
import { createSectUpgradeStateV10 } from '../src/core/sect-expansion/upgrade-validation';
import { cloneJson, canonicalStringify } from '../src/core/kernel/serialization';
import { inspectUnregisteredWorldV10Records } from '../src/core/kernel/validation';
import { prepareNormalTickCandidateV10 } from '../src/core/kernel/simulation-v10';
import { advanceCapacityLimitedTicksV10 } from '../src/core/world/runtime-capacity-v10';
import type { WorldStateV10 } from '../src/core/sect-expansion/upgrade-types';
function fixture(){
 const old=createUnregisteredWorldV9('bench-v10-strict-fresh');
 const world={...cloneJson(old),simulationVersion:'0.10.0',runtimeProtocol:'management-v10-alchemy-upgrade.1',contentVersion:MANAGEMENT_V10_CONTENT_VERSION,contentIdentity:cloneJson(MANAGEMENT_V10_IDENTITY),sectExpansion:{...cloneJson(old.sectExpansion),schemaVersion:2,upgrade:createSectUpgradeStateV10()}} as WorldStateV10;
 if(inspectUnregisteredWorldV10Records(world).length) throw Error('invalid explicit record-test lift');
 return world;
}
export function run(){
 let state=fixture();const times:number[]=[];
 for(let i=0;i<23;i++){
  const expected=prepareNormalTickCandidateV10(state);const start=performance.now();const r=advanceCapacityLimitedTicksV10(state,1);const elapsed=performance.now()-start;
  if(r.stopped||canonicalStringify(r.world)!==canonicalStringify(expected)) throw Error('strict mismatch');state=r.world;if(i>=3)times.push(elapsed);
 }
 const sorted=times.toSorted((a,b)=>a-b);return {scope:'fresh four-disciple strict single tick, record-only lifted fixture; not migration or browser',samples:times.length,p50:sorted[9],p95:sorted[18],max:sorted.at(-1),allExact:true,rawMs:times};
}

export function runPrivate(active = false){
 let expected=fixture();
 if(active){const prepared=prepareUnregisteredCommandCandidateV10(expected,{kind:'production.start',commandId:'bench.active.gather',sequence:0,issuedTick:expected.clock.simulationTick,payload:{recipeId:'gather.wood',workerId:'entity:2'}});if(prepared.result.status!=='accepted')throw Error('active fixture failed');expected=prepared.world;for(let i=0;i<40;i++)expected=prepareNormalTickCandidateV10(expected);if(expected.activeProductionTransactionIds.length!==1)throw Error('active fixture missing');}
 const creationStart=performance.now();const made=createPrivateRuntimeV10(expected);const creationMs=performance.now()-creationStart;
 if(!made.ok) throw Error('private creation failed');const times:number[]=[];let metrics;
 try{for(let i=0;i<23;i++){expected=prepareNormalTickCandidateV10(expected);const start=performance.now();const result=made.instance.advance(1);const elapsed=performance.now()-start;const snapshot=made.instance.snapshot();
 if(!result.ok||result.advancedTicks!==1||!snapshot.ok||canonicalStringify(snapshot.world)!==canonicalStringify(expected)) throw Error('private exact mismatch');metrics=result.metrics;if(i>=3)times.push(elapsed);
 }const sorted=times.toSorted((a,b)=>a-b);return {scope:active?'four-disciple private owner with one real active gather; snapshots and oracle outside timing; no browser':'fresh four-disciple private owner single ticks; snapshots and oracle outside timing; no browser',samples:times.length,creationMs,p50:sorted[9],p95:sorted[18],max:sorted.at(-1),allExact:true,lastMetrics:metrics,rawMs:times};}finally{made.instance.close();}
}
