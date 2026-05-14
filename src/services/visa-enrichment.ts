// Async, non-blocking enrichment of bot visa-type metadata using the canonical
// server-side ID from the applicant edit page (the most robust source).
//
// Discovery and bot creation NEVER wait for this. Called fire-and-forget after
// /api/bots returns so the user-facing latency stays unchanged. Failures are
// logged but never surface — `enrichBotVisaType` always resolves.

import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { bots, sessions } from '../db/schema.js';
import { decrypt } from './encryption.js';
import { performLogin } from './login.js';
import {
  extractVisaClassFromEditPage,
  normalizeVisaCategory,
} from './html-parsers.js';
import { USER_AGENT, BROWSER_HEADERS, getBaseUrl } from '../utils/constants.js';

interface FetchEditOptions {
  cookie: string;
  scheduleId: string;
  applicantId: string;
  locale: string;
}

async function fetchEditHtml({ cookie, scheduleId, applicantId, locale }: FetchEditOptions): Promise<{ status: number; html: string }> {
  const url = `${getBaseUrl(locale)}/schedule/${scheduleId}/applicants/${applicantId}/edit`;
  const resp = await fetch(url, {
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

/**
 * Fetch the canonical visa class ID from the applicant edit page and update the bot.
 *
 * Strategy:
 *   1. Try the cached session cookie if fresh (no extra login).
 *   2. On 302/non-200, fall back to a fresh login.
 *   3. Parse the <select name="applicant[visa_class_id]"> selected option.
 *   4. UPDATE bots.visa_class_id (+ reconcile visa_category/visa_type_raw if more accurate).
 *
 * Always resolves — never throws. Returns true when the bot row was updated.
 */
export async function enrichBotVisaType(botId: number): Promise<boolean> {
  try {
    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) return false;
    if (!bot.applicantIds || bot.applicantIds.length === 0) return false;
    const applicantId = bot.applicantIds[0]!;
    const locale = bot.locale ?? 'es-co';

    let cookie: string | null = null;
    const [session] = await db.select().from(sessions).where(eq(sessions.botId, bot.id));
    if (session) {
      try { cookie = decrypt(session.yatriCookie); } catch { /* fall through */ }
    }

    let parsed: ReturnType<typeof extractVisaClassFromEditPage> = null;

    if (cookie) {
      try {
        const r = await fetchEditHtml({ cookie, scheduleId: bot.scheduleId, applicantId, locale });
        if (r.status === 200) parsed = extractVisaClassFromEditPage(r.html);
      } catch { /* network blip — fall through to fresh login */ }
    }

    if (!parsed) {
      try {
        const email = decrypt(bot.visaEmail);
        const password = decrypt(bot.visaPassword);
        const loginResult = await performLogin({
          email, password,
          scheduleId: bot.scheduleId,
          applicantIds: bot.applicantIds,
          locale,
        });
        const r = await fetchEditHtml({ cookie: loginResult.cookie, scheduleId: bot.scheduleId, applicantId, locale });
        if (r.status === 200) parsed = extractVisaClassFromEditPage(r.html);
      } catch (e) {
        console.warn(`[enrich-visa-type] bot=${botId} fresh-login failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    }

    if (!parsed) {
      console.warn(`[enrich-visa-type] bot=${botId} could not parse visa_class_id select`);
      return false;
    }

    const normalized = normalizeVisaCategory(parsed.label);
    await db.update(bots)
      .set({
        visaClassId: parsed.classId,
        // Edit-page label is more authoritative than groups-page td. Reconcile.
        visaTypeRaw: parsed.label,
        visaCategory: normalized ?? bot.visaCategory ?? null,
      })
      .where(eq(bots.id, bot.id));

    console.log(`[enrich-visa-type] bot=${botId} classId=${parsed.classId} category=${normalized} label="${parsed.label.slice(0, 60)}"`);
    return true;
  } catch (e) {
    console.warn(`[enrich-visa-type] bot=${botId} unexpected error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
