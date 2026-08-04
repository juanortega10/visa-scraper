/**
 * One-shot login for bot 212. Attempts performLogin ONCE; on success persists a
 * fresh session so the sniper starts authenticated. Never retries (avoids re-locking).
 */
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';

const [b] = await db.select().from(bots).where(eq(bots.id, 212));
console.log('Attempting ONE login for', decrypt(b.visaEmail), '...');
try {
  const r = await performLogin({
    email: decrypt(b.visaEmail),
    password: decrypt(b.visaPassword),
    scheduleId: b.scheduleId,
    applicantIds: b.applicantIds,
    locale: b.locale,
  });
  const [s] = await db.select().from(sessions).where(eq(sessions.botId, 212));
  if (s) {
    await db.update(sessions).set({
      yatriCookie: encrypt(r.cookie), csrfToken: r.csrfToken,
      authenticityToken: r.authenticityToken, lastUsedAt: new Date(),
    }).where(eq(sessions.botId, 212));
  } else {
    await db.insert(sessions).values({
      botId: 212, yatriCookie: encrypt(r.cookie), csrfToken: r.csrfToken,
      authenticityToken: r.authenticityToken, lastUsedAt: new Date(),
    });
  }
  console.log('LOGIN_RESULT=OK hasTokens=' + !!r.csrfToken + ' cookieLen=' + (r.cookie?.length ?? 0));
} catch (e) {
  console.log('LOGIN_RESULT=FAIL ' + (e instanceof Error ? e.message : String(e)));
}
process.exit(0);
