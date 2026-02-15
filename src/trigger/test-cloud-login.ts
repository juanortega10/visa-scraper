import { task, logger } from '@trigger.dev/sdk/v3';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt } from '../services/encryption.js';
import { pureFetchLogin, InvalidCredentialsError } from '../services/login.js';

interface TestCloudLoginPayload {
  botId: number;
}

/**
 * Test task to verify pureFetchLogin works from Trigger.dev cloud (datacenter IP).
 * Deploy to prod and trigger to check if hCaptcha blocks datacenter IPs.
 */
export const testCloudLoginTask = task({
  id: 'test-cloud-login',
  machine: { preset: 'micro' },
  maxDuration: 30,

  run: async (payload: TestCloudLoginPayload) => {
    const { botId } = payload;
    logger.info('test-cloud-login START', { botId });

    // Log public IP
    try {
      const ipResp = await fetch('https://api.ipify.org?format=json');
      const { ip } = await ipResp.json() as { ip: string };
      logger.info('Public IP', { ip });
    } catch {
      logger.warn('Could not determine public IP');
    }

    const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);

    const email = decrypt(bot.visaEmail);
    const password = decrypt(bot.visaPassword);
    const locale = bot.locale ?? 'es-co';

    const creds = {
      email,
      password,
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      locale,
    };

    // Test 1: pureFetchLogin with skipTokens (fast, ~970ms)
    logger.info('Test 1: pureFetchLogin (skipTokens=true, visaType=iv)');
    const t1 = Date.now();
    try {
      const result = await pureFetchLogin(creds, { skipTokens: true, visaType: 'iv' });
      logger.info('Test 1 SUCCESS', {
        ms: Date.now() - t1,
        cookieLen: result.cookie.length,
        hasTokens: result.hasTokens,
      });
    } catch (e) {
      logger.error('Test 1 FAILED', {
        ms: Date.now() - t1,
        error: e instanceof Error ? e.message : String(e),
        isInvalidCreds: e instanceof InvalidCredentialsError,
      });
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Test 2: pureFetchLogin with tokens (full, ~1.7s)
    logger.info('Test 2: pureFetchLogin (skipTokens=false, visaType=iv)');
    const t2 = Date.now();
    try {
      const result = await pureFetchLogin(creds, { skipTokens: false, visaType: 'iv' });
      logger.info('Test 2 SUCCESS', {
        ms: Date.now() - t2,
        cookieLen: result.cookie.length,
        hasTokens: result.hasTokens,
        hasCsrf: !!result.csrfToken,
        hasAuth: !!result.authenticityToken,
      });
    } catch (e) {
      logger.error('Test 2 FAILED', {
        ms: Date.now() - t2,
        error: e instanceof Error ? e.message : String(e),
      });
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }

    logger.info('test-cloud-login DONE — all tests passed');
    return { success: true };
  },
});
