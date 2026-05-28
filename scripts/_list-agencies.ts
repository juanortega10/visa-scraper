import { db } from '../src/db/client.js';
import { agencies, bots, botCredentialAttempts } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const all = await db.select().from(agencies);
  console.log(`Total agencies: ${all.length}\n`);
  for (const a of all) {
    const ab = await db
      .select({
        id: bots.id,
        status: bots.status,
        testMode: bots.testMode,
        currentConsularDate: bots.currentConsularDate,
      })
      .from(bots)
      .where(eq(bots.agencyId, a.id));
    const attempts = await db
      .select({ id: botCredentialAttempts.id, status: botCredentialAttempts.status })
      .from(botCredentialAttempts)
      .where(eq(botCredentialAttempts.agencyId, a.id));
    console.log(
      JSON.stringify(
        {
          id: a.id,
          name: a.name,
          clerkUserId: a.clerkUserId,
          contactEmail: a.contactEmail,
          billingMode: a.billingMode,
          testMode: a.testMode,
          createdAt: a.createdAt,
          bots: ab,
          attemptsCount: attempts.length,
        },
        null,
        2,
      ),
    );
    console.log('---');
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
