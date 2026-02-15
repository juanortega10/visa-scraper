/**
 * Test script for discoverAccount() function.
 * Validates that we can extract scheduleId, applicantIds, appointments, and facility IDs
 * from the embassy portal using only email + password.
 *
 * Usage: npx tsx --env-file=.env scripts/test-discover.ts [--bot-id=N]
 *
 * Uses credentials from the specified bot (default: 6) in the database.
 * Can also pass --email and --password directly.
 */

import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../src/services/encryption.js';
import { discoverAccount } from '../src/services/login.js';

const args = process.argv.slice(2);
const botIdArg = args.find(a => a.startsWith('--bot-id='));
const emailArg = args.find(a => a.startsWith('--email='));
const passwordArg = args.find(a => a.startsWith('--password='));
const localeArg = args.find(a => a.startsWith('--locale='));

async function main() {
  let email: string;
  let password: string;
  let locale = 'es-co';

  if (emailArg && passwordArg) {
    email = emailArg.split('=')[1]!;
    password = passwordArg.split('=')[1]!;
    if (localeArg) locale = localeArg.split('=')[1]!;
  } else {
    const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!) : 6;
    console.log(`Loading credentials from bot ${botId}...`);

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) {
      console.error(`Bot ${botId} not found`);
      process.exit(1);
    }

    email = decrypt(bot.visaEmail);
    password = decrypt(bot.visaPassword);
    locale = bot.locale;
    console.log(`Email: ${email}`);
    console.log(`Locale: ${locale}`);
  }

  console.log('\nRunning discoverAccount()...');
  const start = Date.now();

  try {
    const result = await discoverAccount(email, password, locale);
    const elapsed = Date.now() - start;

    console.log(`\nDiscovery completed in ${elapsed}ms\n`);
    console.log('Results:');
    console.log(`  scheduleId:         ${result.scheduleId}`);
    console.log(`  userId:             ${result.userId}`);
    console.log(`  applicantIds:       ${JSON.stringify(result.applicantIds)}`);
    console.log(`  applicantNames:     ${JSON.stringify(result.applicantNames)}`);
    console.log(`  consularDate:       ${result.currentConsularDate} ${result.currentConsularTime}`);
    console.log(`  casDate:            ${result.currentCasDate} ${result.currentCasTime}`);
    console.log(`  consularFacilityId: ${result.consularFacilityId}`);
    console.log(`  ascFacilityId:      ${result.ascFacilityId}`);
    console.log(`  cookie:             ${result.cookie.substring(0, 30)}... (${result.cookie.length} chars)`);
  } catch (e) {
    const elapsed = Date.now() - start;
    console.error(`\nDiscovery failed after ${elapsed}ms:`);
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  process.exit(0);
}

main();
