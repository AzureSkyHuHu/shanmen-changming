import { performance } from 'node:perf_hooks';
import { createUnregisteredWorldV9 } from '../src/core/world/create-world-v9';
import { MANAGEMENT_V10_IDENTITY, MANAGEMENT_V10_CONTENT_VERSION } from '../src/content/sect-v10/world-content';
import { createSectUpgradeStateV10 } from '../src/core/sect-expansion/upgrade-validation';
import { cloneJson, canonicalStringify } from '../src/core/kernel/serialization';
import { inspectUnregisteredWorldV10Records } from '../src/core/kernel/validation';
import { prepareNormalTickCandidateV10 } from '../src/core/kernel/simulation-v10';
import { advanceCapacityLimitedTicksV10 } from '../src/core/world/runtime-capacity-v10';
import type { WorldStateV10 } from '../src/core/sect-expansion/upgrade-types';
export function run(){
 const old=createUnregisteredWorldV9('bench-v10-strict-fresh');
 const world={...cloneJson(old),simulationVersion:'0.10.0',runtimeProtocol:'management-v10-alchemy-upgrade.1',contentVersion:MANAGEMENT_V10_CONTENT_VERSION,contentIdentity:cloneJson(MANAGEMENT_V10_IDENTITY),sectExpansion:{...cloneJson(old.sectExpansion),schemaVersion:2,upgrade:createSectUpgradeStateV10()}} as WorldStateV10;
 if(inspectUnregisteredWorldV10Records(world).length) throw Error('invalid explicit record-test lift');
 let state=world;const times:number[]=[];
 for(let i=0;i<23;i++){
  const expected=prepareNormalTickCandidateV10(state);const start=performance.now();const r=advanceCapacityLimitedTicksV10(state,1);const elapsed=performance.now()-start;
  if(r.stopped||canonicalStringify(r.world)!==canonicalStringify(expected)) throw Error('strict mismatch');state=r.world;if(i>=3)times.push(elapsed);
 }
 const sorted=times.toSorted((a,b)=>a-b);return {scope:'fresh four-disciple strict single tick, record-only lifted fixture; not migration or browser',samples:times.length,p50:sorted[9],p95:sorted[18],max:sorted.at(-1),allExact:true,rawMs:times};
}
