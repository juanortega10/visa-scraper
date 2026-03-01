import { db } from '../src/db/client.js';
import { sessions } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const [s] = await db.select({ createdAt: sessions.createdAt, botId: sessions.botId }).from(sessions).where(eq(sessions.botId, 7));

if (!s) {
  console.log('No session for bot 7');
  process.exit(0);
}

const now = new Date();
const createdAt = s.createdAt;
const ageMs = now.getTime() - createdAt.getTime();
const ageMin = Math.round(ageMs / 60000);

console.log('Now (local):', now.toISOString());
console.log('createdAt raw:', createdAt);
console.log('createdAt ISO:', createdAt.toISOString());
console.log('createdAt getTime():', createdAt.getTime());
console.log('Age ms:', ageMs);
console.log('Age min:', ageMin);
console.log('');
console.log('TZ env:', process.env.TZ || '(not set)');
console.log('Offset minutes:', now.getTimezoneOffset());

process.exit(0);
