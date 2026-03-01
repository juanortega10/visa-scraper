/**
 * One-off: Set Bot 7 proxyUrls to mixed direct + webshare pool.
 * "direct" entries use the host's own IP (RPi or cloud).
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const BOT_ID = 7;

const newProxyUrls = [
  'direct',
  'direct',
  'http://nfxniwxh:2zobtqlpwn1o@64.137.96.74:6641',   // Madrid — 100% reliable
  'http://nfxniwxh:2zobtqlpwn1o@45.38.107.97:6014',   // London — OK
  // Removed: 23.95.150.145 (Buffalo, 79% reliable, tcp_blocked)
  // Removed: 216.10.27.159 (Dallas, 69% reliable, tcp_blocked)
];

const [bot] = await db.select({ id: bots.id, proxyUrls: bots.proxyUrls, proxyProvider: bots.proxyProvider })
  .from(bots).where(eq(bots.id, BOT_ID));

if (!bot) { console.error('Bot 7 not found'); process.exit(1); }

console.log('Current proxyUrls:', bot.proxyUrls);
console.log('New proxyUrls:', newProxyUrls);

await db.update(bots).set({ proxyUrls: newProxyUrls, updatedAt: new Date() }).where(eq(bots.id, BOT_ID));
console.log('✓ Bot 7 proxyUrls updated');

process.exit(0);
