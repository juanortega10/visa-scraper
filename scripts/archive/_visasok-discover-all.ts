/**
 * LIVE DISCOVER — read-only (no DB writes, no reschedule).
 * Logs in to each xlsx account, reports real scheduleId / applicants / current
 * appointment / CAS-only flag / multi-group / dedup. Validates passwords.
 */
import xlsx from 'xlsx';
import os from 'node:os';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const wb = xlsx.readFile(`${os.homedir()}/Downloads/Adelantamientos.xlsx`);
const rows = xlsx.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' });
const accounts = rows
  .filter(r => ['Familiar','Personal'].includes((r[0]||'').toString().trim()))
  .map(r => ({ tipo:(r[0]||'').toString().trim(), email:(r[2]||'').toString().trim().toLowerCase(), pass:(r[5]||'').toString().trim(), nota:(r[11]||'').toString().trim().toLowerCase() }));

const existing = await db.select().from(bots);
const byEmail = new Map<string,{id:number;status:string;cohort:string}>();
const bySchedule = new Map<string,number>();
for (const b of existing) {
  try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), { id:b.id, status:b.status, cohort:b.cohort }); } catch {}
  bySchedule.set(b.scheduleId, b.id);
}

console.log(`Discovering ${accounts.length} accounts...\n`);
for (const a of accounts) {
  process.stdout.write(`${a.email.padEnd(34)} `);
  try {
    const r = await discoverAccount(a.email, a.pass, 'es-co');
    const casOnly = !r.currentConsularDate && !!r.currentCasDate;
    const dupByEmail = byEmail.get(a.email);
    const dupBySched = bySchedule.get(r.scheduleId);
    const tags: string[] = [];
    if (casOnly) tags.push('CAS-ONLY-INVALID');
    if (dupByEmail) tags.push(`EXISTS#${dupByEmail.id}(${dupByEmail.status}/${dupByEmail.cohort})`);
    else if (dupBySched) tags.push(`DUP-SCHED#${dupBySched}`);
    if ((r.groups?.length ?? 1) > 1) tags.push(`MULTI-GROUP(${r.groups!.length})`);
    if (a.nota.includes('agosto')) tags.push('NOTE:agosto');
    console.log(`sched=${r.scheduleId} appls=${r.applicantIds.length} cat=${r.primaryVisaCategory ?? '?'} consular=${r.currentConsularDate ?? '-'} ${r.currentConsularTime ?? ''} cas=${r.currentCasDate ?? '-'} ${tags.length?'⚠ '+tags.join(','):''}`);
    console.log(`   names: ${r.applicantNames.join(', ')}`);
    if ((r.groups?.length ?? 1) > 1) for (const g of r.groups!) console.log(`     group sched=${g.scheduleId} consular=${g.currentConsularDate ?? '-'} ${g.currentConsularTime ?? ''} cas=${g.currentCasDate ?? '-'}`);
  } catch (e) {
    console.log(`❌ ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(0);
