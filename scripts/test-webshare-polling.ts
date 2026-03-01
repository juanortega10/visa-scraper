/**
 * Simulate sustained polling through Webshare proxy.
 * Logs: login → N consecutive polls with delay → detect bans/errors.
 *
 * Usage: npx tsx --env-file=.env scripts/test-webshare-polling.ts [--bot-id=6] [--polls=20] [--delay=30]
 */
import 'dotenv/config';
import { ProxyAgent } from 'undici';
import { db } from '../src/db/client.js';
import { bots } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { getBaseUrl, USER_AGENT } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const proxyUrls = (process.env.WEBSHARE_PROXY_URLS ?? process.env.WEBSHARE_PROXY_URL ?? '').split(',').map(u => u.trim()).filter(Boolean);
if (proxyUrls.length === 0) {
  console.error('WEBSHARE_PROXY_URLS not set in .env');
  process.exit(1);
}
const proxyUrl = proxyUrls[0]!;

const botIdArg = process.argv.find((a) => a.startsWith('--bot-id='));
const botId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : 6;

const pollsArg = process.argv.find((a) => a.startsWith('--polls='));
const totalPolls = pollsArg ? parseInt(pollsArg.split('=')[1]!, 10) : 20;

const delayArg = process.argv.find((a) => a.startsWith('--delay='));
const delaySec = delayArg ? parseInt(delayArg.split('=')[1]!, 10) : 30;

const agent = new ProxyAgent({ uri: proxyUrl });

function proxyFetchLocal(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, {
    ...options,
    // @ts-expect-error undici dispatcher works with global fetch
    dispatcher: agent,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface PollResult {
  index: number;
  status: number;
  datesCount: number;
  earliest: string | null;
  latencyMs: number;
  error?: string;
}

async function main() {
  console.log(`Proxy: ${proxyUrl.replace(/:([^@]+)@/, ':***@')}`);
  console.log(`Bot: ${botId} | Polls: ${totalPolls} | Delay: ${delaySec}s`);
  console.log(`Estimated duration: ~${Math.round(totalPolls * delaySec / 60)}min\n`);

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) { console.error(`Bot ${botId} not found`); process.exit(1); }

  const locale = bot.locale ?? 'es-co';
  const baseUrl = getBaseUrl(locale);
  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);

  // ── Login via proxy ──
  console.log('Logging in via proxy...');
  const signInUrl = `https://ais.usvisa-info.com/${locale}/niv/users/sign_in`;

  const getResp = await proxyFetchLocal(signInUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    redirect: 'manual',
  });
  const setCookies = getResp.headers.getSetCookie?.() ?? [];
  const yatriRaw = setCookies.find((c) => c.startsWith('_yatri_session='));
  if (!yatriRaw) { console.error('Login failed: no Set-Cookie'); process.exit(1); }

  const initCookie = yatriRaw.split(';')[0]!.split('=').slice(1).join('=');
  const html = await getResp.text();
  const csrf = html.match(/<meta\s+name="csrf-token"\s+content="([^"]+)"/)?.[1] ?? '';

  const loginResp = await proxyFetchLocal(`${baseUrl}/users/sign_in`, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: `_yatri_session=${initCookie}`,
      'X-CSRF-Token': csrf,
      'X-Requested-With': 'XMLHttpRequest',
      Referer: signInUrl,
    },
    body: new URLSearchParams({
      'user[email]': email,
      'user[password]': password,
      policy_agreed: '1',
      commit: locale.startsWith('es') ? 'Iniciar Sesión' : 'Sign In',
    }).toString(),
    redirect: 'manual',
  });

  const loginCookies = loginResp.headers.getSetCookie?.() ?? [];
  const newSessionRaw = loginCookies.find((c) => c.startsWith('_yatri_session='));
  if (!newSessionRaw) { console.error('Login failed: no session cookie after POST'); process.exit(1); }

  const sessionCookie = newSessionRaw.split(';')[0]!.split('=').slice(1).join('=');
  console.log(`Login OK (cookie length: ${sessionCookie.length})\n`);

  // ── Polling loop ──
  const daysUrl = `${baseUrl}/schedule/${bot.scheduleId}/appointment/days/${bot.consularFacilityId}.json?appointments[expedite]=false`;
  const headers: Record<string, string> = {
    Cookie: `_yatri_session=${sessionCookie}`,
    'X-CSRF-Token': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': USER_AGENT,
    Referer: `${baseUrl}/schedule/${bot.scheduleId}/appointment`,
  };

  const results: PollResult[] = [];
  let consecutiveEmpty = 0;
  const startTime = Date.now();

  for (let i = 1; i <= totalPolls; i++) {
    const pollStart = Date.now();
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const ts = new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/Bogota' });

    try {
      const resp = await proxyFetchLocal(daysUrl, { headers });
      const latencyMs = Date.now() - pollStart;

      if (resp.status === 302) {
        const loc = resp.headers.get('location') ?? '';
        const result: PollResult = { index: i, status: 302, datesCount: -1, earliest: null, latencyMs, error: `redirect → ${loc}` };
        results.push(result);
        console.log(`[${ts}] Poll ${i}/${totalPolls} (${elapsed}s) | 302 redirect → ${loc} (${latencyMs}ms)`);

        if (loc.includes('sign_in')) {
          console.log('\nSession expired. Stopping.');
          break;
        }
        continue;
      }

      const body = await resp.text();
      if (resp.status !== 200) {
        results.push({ index: i, status: resp.status, datesCount: -1, earliest: null, latencyMs, error: body.substring(0, 100) });
        console.log(`[${ts}] Poll ${i}/${totalPolls} (${elapsed}s) | HTTP ${resp.status} (${latencyMs}ms)`);
        continue;
      }

      const days = JSON.parse(body) as Array<{ date: string }>;
      const earliest = days.length > 0 ? days[0]!.date : null;
      results.push({ index: i, status: 200, datesCount: days.length, earliest, latencyMs });

      const datesStr = days.length > 0 ? `${days.length} dates, earliest: ${earliest}` : 'EMPTY';
      console.log(`[${ts}] Poll ${i}/${totalPolls} (${elapsed}s) | ${datesStr} (${latencyMs}ms)`);

      if (days.length === 0) {
        consecutiveEmpty++;
        if (consecutiveEmpty >= 3) {
          console.log('\n3 consecutive empty arrays — possible soft ban. Stopping.');
          break;
        }
      } else {
        consecutiveEmpty = 0;
      }
    } catch (e) {
      const latencyMs = Date.now() - pollStart;
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ index: i, status: 0, datesCount: -1, earliest: null, latencyMs, error: msg });
      console.log(`[${ts}] Poll ${i}/${totalPolls} (${elapsed}s) | ERROR: ${msg.substring(0, 100)} (${latencyMs}ms)`);
    }

    if (i < totalPolls) await sleep(delaySec * 1000);
  }

  // ── Summary ──
  const totalTime = Math.round((Date.now() - startTime) / 1000);
  const ok = results.filter((r) => r.status === 200);
  const errors = results.filter((r) => r.status !== 200);
  const avgLatency = ok.length > 0 ? Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length) : 0;
  const emptyCount = ok.filter((r) => r.datesCount === 0).length;

  console.log('\n' + '='.repeat(60));
  console.log('POLLING SUMMARY');
  console.log('='.repeat(60));
  console.log(`  Duration:        ${totalTime}s (~${Math.round(totalTime / 60)}min)`);
  console.log(`  Polls:           ${results.length}/${totalPolls}`);
  console.log(`  Success:         ${ok.length} (${Math.round(ok.length / results.length * 100)}%)`);
  console.log(`  Errors:          ${errors.length}`);
  console.log(`  Empty (ban?):    ${emptyCount}`);
  console.log(`  Avg latency:     ${avgLatency}ms`);
  console.log(`  Min latency:     ${ok.length > 0 ? Math.min(...ok.map((r) => r.latencyMs)) : 0}ms`);
  console.log(`  Max latency:     ${ok.length > 0 ? Math.max(...ok.map((r) => r.latencyMs)) : 0}ms`);

  if (errors.length > 0) {
    console.log('\n  Errors:');
    for (const r of errors) {
      console.log(`    Poll ${r.index}: HTTP ${r.status} — ${r.error?.substring(0, 80)}`);
    }
  }

  console.log('='.repeat(60));
  process.exit(errors.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
