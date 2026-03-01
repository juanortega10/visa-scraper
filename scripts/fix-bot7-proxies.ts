/**
 * Fix Bot 7 proxy config: set proxyUrls in DB with best IPs + direct fallback.
 * This way it doesn't depend on WEBSHARE_PROXY_URLS env (which differs RPi vs cloud).
 *
 * Usage: npx tsx --env-file=.env scripts/fix-bot7-proxies.ts [--commit]
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const BOT_ID = 7;
const commit = process.argv.includes('--commit');

// Best Webshare IPs (validated 2026-02-25 against visa site):
// #1 Buffalo (886ms), #4 Dallas (1541ms), #9 Madrid (1573ms), #7 London (1541ms)
// Excluded: #5 LA (dead), #3 Bloomingdale (permanently blocked), #10 Tokyo (historically unreliable)
const BEST_PROXY_URLS = [
  'http://nfxniwxh:2zobtqlpwn1o@23.95.150.145:6114',   // #1 Buffalo — fastest, 100% reliable
  'http://nfxniwxh:2zobtqlpwn1o@216.10.27.159:6837',   // #4 Dallas — reliable
  'http://nfxniwxh:2zobtqlpwn1o@64.137.96.74:6641',    // #9 Madrid — reliable
  'http://nfxniwxh:2zobtqlpwn1o@45.38.107.97:6014',    // #7 London — reliable
  'direct',                                               // Fallback to RPi/cloud IP
];

const [bot] = await db.select().from(bots).where(eq(bots.id, BOT_ID));
if (!bot) throw new Error(`Bot ${BOT_ID} not found`);

console.log(`Bot ${BOT_ID} | proxyProvider: ${bot.proxyProvider}`);
console.log(`Current proxyUrls: ${JSON.stringify(bot.proxyUrls)}`);
console.log(`\nNew proxyUrls (${BEST_PROXY_URLS.length} entries):`);
for (const url of BEST_PROXY_URLS) {
  if (url === 'direct') {
    console.log(`  direct (fallback to RPi/cloud IP)`);
  } else {
    const host = new URL(url).hostname;
    console.log(`  ${host}`);
  }
}

if (!commit) {
  console.log('\n[DRY RUN] Pass --commit to apply changes');
} else {
  await db.update(bots).set({
    proxyUrls: BEST_PROXY_URLS,
    updatedAt: new Date(),
  }).where(eq(bots.id, BOT_ID));
  console.log('\n✓ Updated Bot 7 proxyUrls in DB');
}

process.exit(0);
