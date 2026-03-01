import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const [bot] = await db.select({ userId: bots.userId }).from(bots).where(eq(bots.id, 7));
const [session] = await db.select({
  csrfToken: sessions.csrfToken,
  authenticityToken: sessions.authenticityToken,
  createdAt: sessions.createdAt,
}).from(sessions).where(eq(sessions.botId, 7));

console.log('userId:', bot?.userId);
console.log('csrfToken:', session?.csrfToken ? `${session.csrfToken.substring(0, 20)}... (${session.csrfToken.length} chars)` : 'NULL');
console.log('authenticityToken:', session?.authenticityToken ? `${session.authenticityToken.substring(0, 20)}... (${session.authenticityToken.length} chars)` : 'NULL');
console.log('sessionAge:', session?.createdAt ? `${Math.round((Date.now() - session.createdAt.getTime()) / 60000)} min` : 'unknown');
const needsRefresh = !bot?.userId || !session?.csrfToken || !session?.authenticityToken;
console.log('needsRefresh:', needsRefresh, { userId: !!bot?.userId, csrf: !!session?.csrfToken, auth: !!session?.authenticityToken });
process.exit(0);
