/**
 * DRY RUN ONLY — no DB writes, no portal calls.
 * Reads ~/Downloads/Adelantamientos.xlsx, applies the VisasOK paid-onboarding plan:
 *   - agency 5 (VisasOK), cohort=paid, owner neiloswaldo@gmail.com
 *   - floor: only schedule AFTER Jun 22 2026  -> first acceptable 2026-06-23
 *     (block excluded_dates 2026-01-01..2026-06-22)
 *   - advancement only: target window [floor, currentConsular)
 *   - "dejar para agosto" -> floor 2026-08-01
 * Flags: dedup vs existing bots, current<=floor (no window), missing data.
 */
import xlsx from 'xlsx';
import os from 'node:os';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';

const MONTHS: Record<string, string> = { ene:'01',feb:'02',mar:'03',abr:'04',may:'05',jun:'06',jul:'07',ago:'08',sep:'09',oct:'10',nov:'11',dic:'12' };
function toIso(s: string): string | null {
  if (!s) return null;
  const m = s.trim().toLowerCase().match(/^([a-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (!m) return null;
  let [, mon, day, year] = m;
  const mm = MONTHS[mon]; if (!mm) return null;
  // fix obvious typo: 2017 -> 2027 for far-future visa dates
  if (year === '2017') year = '2027';
  return `${year}-${mm}-${day.padStart(2,'0')}`;
}

const FLOOR_DEFAULT = '2026-06-23';      // first acceptable (after Jun 22)
const FLOOR_AGOSTO  = '2026-08-01';
const EXCL_START = '2026-01-01';
const EXCL_END_DEFAULT = '2026-06-22';
const EXCL_END_AGOSTO  = '2026-07-31';

const wb = xlsx.readFile(`${os.homedir()}/Downloads/Adelantamientos.xlsx`);
const rows = xlsx.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]!]!, { header: 1, defval: '' });

// existing bots by decrypted email
const existing = await db.select().from(bots);
const byEmail = new Map<string, { id: number; status: string; cohort: string; current: string | null }>();
for (const b of existing) {
  try { byEmail.set(decrypt(b.visaEmail).toLowerCase(), { id: b.id, status: b.status, cohort: b.cohort, current: b.currentConsularDate }); } catch {}
}

interface Plan { tipo: string; email: string; pass: string; casIso: string|null; consulIso: string|null; posterior: string; nota: string; }
const plans: Plan[] = [];
for (const r of rows) {
  const tipo = (r[0]||'').toString().trim();
  if (tipo !== 'Familiar' && tipo !== 'Personal') continue;        // skip header/blank
  plans.push({
    tipo,
    email: (r[2]||'').toString().trim().toLowerCase(),
    pass: (r[5]||'').toString().trim(),
    casIso: toIso((r[8]||'').toString()),
    consulIso: toIso((r[9]||'').toString()),
    posterior: (r[10]||'').toString().trim().toLowerCase(),
    nota: (r[11]||'').toString().trim().toLowerCase(),
  });
}

console.log(`\n=== VisasOK PAID onboarding — DRY RUN (${plans.length} accounts) ===`);
console.log(`Agency 5 (VisasOK) · cohort=paid · owner=neiloswaldo@gmail.com · locale=es-co · proxy=direct · status=paused`);
console.log(`Floor: schedule only AFTER Jun 22 -> first acceptable ${FLOOR_DEFAULT} (excl ${EXCL_START}..${EXCL_END_DEFAULT})\n`);

let nNew = 0, nExist = 0, nFlag = 0;
for (const p of plans) {
  const agosto = p.nota.includes('agosto');
  const floor = agosto ? FLOOR_AGOSTO : FLOOR_DEFAULT;
  const ex = byEmail.get(p.email);
  const flags: string[] = [];
  if (p.tipo === 'Familiar') flags.push('FAMILIAR→verify CAS-only/multi-group on discover');
  if (!p.consulIso) flags.push('no current consular in xlsx');
  if (p.consulIso && p.consulIso <= floor) flags.push(`current ${p.consulIso} <= floor ${floor} → NO advancement window`);
  if (ex) { flags.push(`EXISTS bot ${ex.id} (${ex.status}, cohort=${ex.cohort}, DB current=${ex.current}) → update cohort→paid`); nExist++; }
  else nNew++;
  if (agosto) flags.push(`NOTE "dejar para agosto" → floor ${FLOOR_AGOSTO}`);
  if (p.nota.includes('cataleya')) flags.push('NOTE "cataleya" (unclear — confirm)');
  if (flags.length) nFlag++;

  const window = p.consulIso ? `[${floor} .. ${p.consulIso})` : `[${floor} .. ?)`;
  const action = ex ? `UPDATE #${ex.id}` : 'CREATE';
  console.log(`${action.padEnd(10)} ${p.tipo.padEnd(8)} ${p.email.padEnd(34)} post=${p.posterior.padEnd(2)} cur=${p.consulIso ?? '?'}  target=${window}`);
  if (flags.length) console.log(`           ⚠ ${flags.join(' | ')}`);
}
console.log(`\nSummary: ${nNew} new · ${nExist} existing · ${nFlag} with flags`);
console.log(`Counts by "Adelantamiento posterior": si=${plans.filter(p=>p.posterior==='si').length} no=${plans.filter(p=>p.posterior==='no').length}`);
process.exit(0);
