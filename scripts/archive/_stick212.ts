import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
for(let i=0;i<4;i++){
  const [b]=await db.select({s:bots.status,r:bots.activeRunId}).from(bots).where(eq(bots.id,212));
  console.log(`[${new Date().toISOString().slice(11,19)}Z] 212: status=${b?.s} run=${b?.r?b.r.slice(0,16):'null'} ${b?.s==='paused'?'✓':'⚠ REACTIVATED'}`);
  if(i<3)await sleep(180_000);
}
process.exit(0);
