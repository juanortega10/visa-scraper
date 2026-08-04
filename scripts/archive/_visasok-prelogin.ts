/**
 * Pre-create sessions from LOCAL (bypasses RPi login IP). Sessions are schedule/locale-bound, not IP-bound.
 * Usage: npx tsx --env-file=.env scripts/_visasok-prelogin.ts <ids...> [--write] [--activate]
 *   no flags  -> dry: just login + report hasTokens
 *   --write   -> upsert session row
 *   --activate-> also set status=active (only with --write)
 * Spaces ~12s between accounts.
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { pureFetchLogin } from '../src/services/login.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const ACTIVATE = args.includes('--activate');
const ids = args.filter((a) => /^\d+$/.test(a)).map(Number);

let ok = 0, tokenFail = 0, loginFail = 0;
for (let i = 0; i < ids.length; i++) {
  const id = ids[i]!;
  const [b] = await db.select().from(bots).where(eq(bots.id, id));
  if (!b) { console.log(`bot ${id}: NOT FOUND`); continue; }
  const email = decrypt(b.visaEmail); const password = decrypt(b.visaPassword);
  try {
    const r = await pureFetchLogin({ email, password, scheduleId: b.scheduleId, applicantIds: b.applicantIds, locale: b.locale ?? 'es-co' }, { visaType: 'iv' });
    if (!r.hasTokens) tokenFail++; else ok++;
    console.log(`bot ${id} (${email}): hasTokens=${r.hasTokens} csrf=${r.csrfToken ? 'y' : 'n'} auth=${r.authenticityToken ? 'y' : 'n'}`);
    if (WRITE && r.cookie) {
      const row = { botId: id, yatriCookie: encrypt(r.cookie), csrfToken: r.csrfToken || null, authenticityToken: r.authenticityToken || null, lastUsedAt: new Date(), createdAt: new Date() };
      await db.insert(sessions).values(row).onConflictDoUpdate({ target: sessions.botId, set: { yatriCookie: row.yatriCookie, csrfToken: row.csrfToken, authenticityToken: row.authenticityToken, lastUsedAt: row.lastUsedAt, createdAt: row.createdAt } });
      if (ACTIVATE) await db.update(bots).set({ status: 'active', activeRunId: null, activeCloudRunId: null, consecutiveErrors: 0, updatedAt: new Date() }).where(eq(bots.id, id));
      console.log(`   -> session written${ACTIVATE ? ' + activated' : ''}`);
    }
  } catch (e) {
    loginFail++;
    console.log(`bot ${id} (${email}): LOGIN FAILED ${e instanceof Error ? e.message : e}`);
  }
  if (i < ids.length - 1) await sleep(12_000);
}
console.log(`\nok(tokens)=${ok} tokenFail=${tokenFail} loginFail=${loginFail}`);
process.exit(0);
