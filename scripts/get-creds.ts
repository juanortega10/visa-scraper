import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';

async function main() {
  for (const id of [22, 23]) {
    const [bot] = await db.select().from(bots).where(eq(bots.id, id));
    console.log(`Bot ${id}:`);
    console.log(`  Email: ${decrypt(bot.visaEmail)}`);
    console.log(`  Password: ${decrypt(bot.visaPassword)}`);
    console.log(`  Schedule: ${bot.scheduleId}`);
    console.log(`  Applicants: ${bot.applicantIds}`);
  }
  process.exit(0);
}
main();
