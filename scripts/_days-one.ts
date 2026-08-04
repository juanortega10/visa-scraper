/** Targeted READ-ONLY consular-days check for one schedule, many retries. */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';
import { VisaClient } from '../src/services/visa-client.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '231', 10);
const schedule = process.argv[3];
const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot || !schedule) { console.error('uso: _days-one.ts <botId> <scheduleId>'); process.exit(1); }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const result = await pureFetchLogin({ email: decrypt(bot.visaEmail), password: decrypt(bot.visaPassword), scheduleId: schedule, applicantIds: bot.applicantIds, locale: bot.locale ?? 'es-co' }, {});
console.log('login ok', !!result.cookie);
const client = new VisaClient(
  { cookie: result.cookie, csrfToken: result.csrfToken ?? '', authenticityToken: result.authenticityToken ?? '' },
  { scheduleId: schedule, applicantIds: bot.applicantIds, consularFacilityId: bot.consularFacilityId, ascFacilityId: bot.ascFacilityId, proxyProvider: 'direct', userId: bot.userId!, locale: bot.locale ?? 'es-co' },
);
for (let i = 1; i <= 12; i++) {
  try {
    const days = await client.getConsularDays();
    const sorted = days.map((x: any) => x.date).sort();
    console.log(`\n✅ schedule ${schedule}: ${sorted.length} fechas. Más temprana: ${sorted[0] ?? 'ninguna'}`);
    console.log('   primeras 12:', sorted.slice(0, 12).join(', '));
    const cur = bot.currentConsularDate;
    if (cur) console.log(`   actual ${cur} → ${sorted[0] && sorted[0] < cur ? `✅ HAY antes (${sorted[0]})` : `❌ nada antes de ${cur} (más temprana ${sorted[0]})`}`);
    process.exit(0);
  } catch (e) { console.log(`  intento ${i}/12: ${(e as Error).message.slice(0, 50)}`); await sleep(2000); }
}
console.log('❌ tcp block persistente, no se pudo leer disponibilidad');
process.exit(1);
