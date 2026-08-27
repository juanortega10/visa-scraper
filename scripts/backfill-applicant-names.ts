/**
 * Rellena bots.applicant_names para bots viejos (onboardeados antes de que la
 * columna se poblara). Los bots ACTIVOS se auto-rellenan solos en su siguiente
 * poll (poll-visa lee los nombres de la página /groups que ya descarga), así que
 * este script existe sólo para los PAUSADOS, que nunca pollean.
 *
 * Cada bot cuesta un login real contra el portal → va throttled a propósito.
 * Un login masivo desde una sola IP la bloquea por TCP (ver memoria
 * "login-storm-onboarding"). Default: 1 bot cada 20s, tanda de 10.
 *
 *   npx tsx --env-file=.env scripts/backfill-applicant-names.ts            # dry-run
 *   npx tsx --env-file=.env scripts/backfill-applicant-names.ts --commit
 *   npx tsx --env-file=.env scripts/backfill-applicant-names.ts --commit --limit=25 --delay=30
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq, sql } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const argOf = (name: string, def: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const COMMIT = process.argv.includes('--commit');
const LIMIT = argOf('limit', 10);
const DELAY_S = argOf('delay', 20);

const rows = await db.execute(sql`
  SELECT id, visa_email, visa_password, locale, schedule_id
  FROM bots
  WHERE (applicant_names IS NULL OR jsonb_array_length(applicant_names) = 0)
    AND status IN ('active', 'paused')
  ORDER BY id
  LIMIT ${LIMIT}`);

console.log(`${rows.rows.length} bots a procesar (${COMMIT ? 'COMMIT' : 'dry-run'}), ${DELAY_S}s entre logins\n`);

let ok = 0, fail = 0;
for (const [i, r] of rows.rows.entries()) {
  const id = r.id as number;
  try {
    const res = await discoverAccount(
      decrypt(r.visa_email as string),
      decrypt(r.visa_password as string),
      r.locale as string,
      {},
    );
    // discoverAccount devuelve los nombres del grupo primario; si el bot apunta a
    // otro schedule del mismo login, no aplicamos nada antes que un nombre errado.
    const sameSchedule = String(res.scheduleId) === String(r.schedule_id);
    const names = sameSchedule ? res.applicantNames.filter(Boolean) : [];

    if (!names.length) {
      console.log(`#${id} — sin nombres${sameSchedule ? '' : ` (schedule distinto: ${res.scheduleId} vs ${r.schedule_id})`}`);
      fail++;
    } else {
      console.log(`#${id} → ${names.join(', ')}`);
      if (COMMIT) {
        await db.update(bots).set({ applicantNames: names, updatedAt: new Date() }).where(eq(bots.id, id));
      }
      ok++;
    }
  } catch (e) {
    console.log(`#${id} — ERROR: ${e instanceof Error ? e.message : String(e)}`);
    fail++;
  }
  if (i < rows.rows.length - 1) await new Promise((r) => setTimeout(r, DELAY_S * 1000));
}

console.log(`\nok=${ok} fail=${fail}${COMMIT ? '' : ' (dry-run, nada escrito)'}`);
process.exit(0);
