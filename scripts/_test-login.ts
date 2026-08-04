/**
 * ONE controlled DIRECT login test with a provided password. Writes NOTHING to DB.
 * Usage: npx tsx --env-file=.env scripts/_test-login.ts <botId> '<password>'
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { pureFetchLogin, InvalidCredentialsError, AccountLockedError } from '../src/services/login.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] ?? '231', 10);
const password = process.argv[3];
if (!password) { console.error("falta password: _test-login.ts <botId> '<pass>'"); process.exit(1); }

const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
if (!bot) { console.error(`bot ${botId} no existe`); process.exit(1); }

const email = decrypt(bot.visaEmail);
console.log(`Probando login DIRECTO (IP limpia, sin proxy) para ${email}`);
console.log(`  password probada: ${JSON.stringify(password)}  (NO se guarda en DB)`);

try {
  const r = await pureFetchLogin(
    { email, password, scheduleId: bot.scheduleId, applicantIds: bot.applicantIds, locale: bot.locale ?? 'es-co' },
    {}, // no proxyUrl → direct
  );
  console.log(`\n✅ LOGIN EXITOSO — la contraseña SIRVE.`);
  console.log(`   cookie=${r.cookie ? 'sí' : 'no'} hasTokens=${r.hasTokens} userId=${r.userId ?? '—'}`);
} catch (e) {
  if (e instanceof InvalidCredentialsError) {
    console.log(`\n❌ CREDENCIALES INVÁLIDAS — esta contraseña tampoco sirve.`);
  } else if (e instanceof AccountLockedError) {
    console.log(`\n⏳ CUENTA BLOQUEADA hasta ${e.lockedUntil?.toISOString() ?? '?'} — no se puede validar la clave ahora (lock activo).`);
  } else {
    console.log(`\n⚠️ Otro error: ${(e as Error).name}: ${(e as Error).message}`);
  }
}
process.exit(0);
