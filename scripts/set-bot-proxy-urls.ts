/**
 * Set per-bot proxy URLs and switch proxyProvider to 'webshare'.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/set-bot-proxy-urls.ts <botId> "<url1>,<url2>,..."
 *   npx tsx --env-file=.env scripts/set-bot-proxy-urls.ts <botId> --clear
 *
 * Examples:
 *   npx tsx --env-file=.env scripts/set-bot-proxy-urls.ts 7 "http://u:p@ip1:port,http://u:p@ip2:port"
 *   npx tsx --env-file=.env scripts/set-bot-proxy-urls.ts 7 --clear
 */
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

const botId = parseInt(process.argv[2] || '', 10);
const urlsArg = process.argv[3] || '';

if (!botId || !urlsArg) {
  console.error('Usage: set-bot-proxy-urls.ts <botId> "<url1>,<url2>,..." | --clear');
  process.exit(1);
}

const [bot] = await db.select({
  id: bots.id,
  proxyProvider: bots.proxyProvider,
  proxyUrls: bots.proxyUrls,
}).from(bots).where(eq(bots.id, botId));

if (!bot) {
  console.error(`Bot ${botId} not found`);
  process.exit(1);
}

if (urlsArg === '--clear') {
  await db.update(bots).set({
    proxyUrls: null,
    proxyProvider: 'direct',
    updatedAt: new Date(),
  }).where(eq(bots.id, botId));
  console.log(`Bot ${botId}: cleared proxyUrls, set proxyProvider=direct`);
} else {
  const urls = urlsArg.split(',').map((u) => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    console.error('No valid URLs provided');
    process.exit(1);
  }

  // Validate URLs
  for (const url of urls) {
    try {
      new URL(url);
    } catch {
      console.error(`Invalid URL: ${url}`);
      process.exit(1);
    }
  }

  await db.update(bots).set({
    proxyUrls: urls,
    proxyProvider: 'webshare',
    updatedAt: new Date(),
  }).where(eq(bots.id, botId));

  console.log(`Bot ${botId}: set ${urls.length} proxy URLs, proxyProvider=webshare`);
  for (const [i, url] of urls.entries()) {
    const parsed = new URL(url);
    console.log(`  ${i + 1}. ${parsed.hostname}:${parsed.port}`);
  }
}

process.exit(0);
