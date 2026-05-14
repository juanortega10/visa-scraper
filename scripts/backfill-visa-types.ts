/**
 * Backfill bots.visa_category, bots.visa_type_raw, and bots.applicant_visa_types
 * for existing bots by re-fetching the /groups/{userId} page.
 *
 * Safe & idempotent:
 *   - Skips bots that already have visa_category set (use --force to overwrite).
 *   - Reuses live session when fresh; falls back to a fresh login on 302/401.
 *   - Dry-run by default — show what would change. Add --commit to persist.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/backfill-visa-types.ts                # dry-run, all bots
 *   npx tsx --env-file=.env scripts/backfill-visa-types.ts --commit       # apply
 *   npx tsx --env-file=.env scripts/backfill-visa-types.ts --bot-id=6     # single bot
 *   npx tsx --env-file=.env scripts/backfill-visa-types.ts --force        # overwrite existing
 */
import 'dotenv/config';
import { db } from '../src/db/client.js';
import { bots, sessions } from '../src/db/schema.js';
import { decrypt } from '../src/services/encryption.js';
import { performLogin } from '../src/services/login.js';
import { extractGroups, extractScheduleApplicantPairs } from '../src/services/html-parsers.js';
import { enrichBotVisaType } from '../src/services/visa-enrichment.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../src/utils/constants.js';
import { eq } from 'drizzle-orm';

const args = process.argv.slice(2);
const commit = args.includes('--commit');
const force = args.includes('--force');
const withClassId = args.includes('--with-class-id');
const botIdArg = args.find((a) => a.startsWith('--bot-id='));
const onlyBotId = botIdArg ? parseInt(botIdArg.split('=')[1]!, 10) : null;

interface Plan {
  botId: number;
  primaryVisaCategory: string | null;
  primaryVisaTypeRaw: string | null;
  applicantVisaTypes: string[];
  reason: string;
}

async function fetchGroupsHtml(cookie: string, baseUrl: string, userId: string): Promise<{ status: number; html: string }> {
  const resp = await fetch(`${baseUrl}/groups/${userId}`, {
    headers: {
      Cookie: `_yatri_session=${cookie}`,
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...BROWSER_HEADERS,
    },
    redirect: 'follow',
  });
  return { status: resp.status, html: await resp.text() };
}

async function planForBot(bot: typeof bots.$inferSelect): Promise<Plan | { skip: string }> {
  if (!force && bot.visaCategory) {
    return { skip: `already has visa_category=${bot.visaCategory}` };
  }
  if (!bot.userId) {
    return { skip: 'no userId stored — cannot fetch /groups page' };
  }

  const baseUrl = getBaseUrl(bot.locale ?? 'es-co');

  // Try existing session first
  const [session] = await db.select().from(sessions).where(eq(sessions.botId, bot.id));
  let cookie = session ? decrypt(session.yatriCookie) : null;

  if (cookie) {
    try {
      const r = await fetchGroupsHtml(cookie, baseUrl, bot.userId);
      if (r.status === 200 && /\/groups\//.test(r.html)) {
        return parsePlan(bot.id, r.html, 'cached-session');
      }
    } catch {
      // fall through to fresh login
    }
  }

  // Fresh login
  console.log(`  bot ${bot.id}: stale session — re-login`);
  const email = decrypt(bot.visaEmail);
  const password = decrypt(bot.visaPassword);
  const r = await performLogin({
    email, password,
    scheduleId: bot.scheduleId,
    applicantIds: bot.applicantIds,
    locale: bot.locale ?? 'es-co',
  });
  cookie = r.cookie;
  const groupsResp = await fetchGroupsHtml(cookie, baseUrl, bot.userId);
  if (groupsResp.status !== 200) {
    return { skip: `groups page returned HTTP ${groupsResp.status} after fresh login` };
  }
  return parsePlan(bot.id, groupsResp.html, 'fresh-login');
}

function parsePlan(botId: number, groupsHtml: string, source: string): Plan {
  const groups = extractGroups(groupsHtml);
  const pairs = extractScheduleApplicantPairs(groupsHtml);

  // Match the same primary-group selection as discoverAccount
  const today = new Date().toISOString().slice(0, 10);
  const primary = groups.find(g => g.currentConsularDate != null && g.currentConsularDate > today)
    ?? groups[0];

  const applicantVisaTypes = primary?.applicantVisaTypes ?? [];
  const primaryVisaCategory = primary?.primaryVisaCategory ?? null;
  const primaryVisaTypeRaw = applicantVisaTypes.find(Boolean) ?? null;

  return {
    botId,
    primaryVisaCategory,
    primaryVisaTypeRaw,
    applicantVisaTypes,
    reason: `${source}; groups=${groups.length} schedules=${pairs.size}`,
  };
}

async function main() {
  const all = onlyBotId != null
    ? await db.select().from(bots).where(eq(bots.id, onlyBotId))
    : await db.select().from(bots);

  console.log(`mode=${commit ? 'COMMIT' : 'DRY-RUN'}  force=${force}  bots=${all.length}\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const bot of all) {
    process.stdout.write(`bot ${bot.id} (${bot.locale}, status=${bot.status})… `);
    try {
      const out = await planForBot(bot);
      if ('skip' in out) {
        console.log(`SKIP — ${out.skip}`);
        skipped++;
        continue;
      }
      console.log(
        `${out.primaryVisaCategory ?? '(unparsed)'}  raw="${out.primaryVisaTypeRaw?.slice(0, 60) ?? ''}"  applicants=${out.applicantVisaTypes.length}  [${out.reason}]`,
      );
      if (commit) {
        await db.update(bots)
          .set({
            visaCategory: out.primaryVisaCategory,
            visaTypeRaw: out.primaryVisaTypeRaw,
            applicantVisaTypes: out.applicantVisaTypes.length ? out.applicantVisaTypes : null,
          })
          .where(eq(bots.id, out.botId));
        updated++;

        // Optional canonical-class-id enrichment via the applicant edit page.
        if (withClassId) {
          const ok = await enrichBotVisaType(out.botId);
          console.log(`    └─ class_id enrichment: ${ok ? 'ok' : 'failed (see logs)'}`);
        }
      }
    } catch (e) {
      console.log(`FAIL — ${e instanceof Error ? e.message : String(e)}`);
      failed++;
    }
  }

  console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}${commit ? '' : '  (dry-run — pass --commit to apply)'}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
