import { task, logger, runs } from '@trigger.dev/sdk/v3';
import { visaLoginQueue } from './queues.js';
import { db } from '../db/client.js';
import { bots, sessions } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { decrypt, encrypt } from '../services/encryption.js';
import { logAuth } from '../utils/auth-logger.js';
import { performLogin, InvalidCredentialsError } from '../services/login.js';
import { notifyUserTask } from './notify-user.js';
import { getPollingDelay } from '../services/scheduling.js';


interface LoginPayload {
  botId: number;
  chainId?: 'dev' | 'cloud';
}

/**
 * Login task — performs real login via pureFetchLogin from cloud.
 * On success: saves session, sets bot active, restarts poll chain.
 * On failure: sets login_required, notifies user.
 */
export const loginVisaTask = task({
  id: 'login-visa',
  queue: visaLoginQueue,
  machine: { preset: 'micro' },
  maxDuration: 30,

  run: async (payload: LoginPayload) => {
    const { botId, chainId = 'dev' } = payload;
    const isCloud = chainId === 'cloud';
    logger.info('login-visa START', { botId, chainId });

    const [bot] = await db.select({
      id: bots.id, visaEmail: bots.visaEmail, visaPassword: bots.visaPassword,
      scheduleId: bots.scheduleId, applicantIds: bots.applicantIds,
      locale: bots.locale,
      activeRunId: bots.activeRunId, activeCloudRunId: bots.activeCloudRunId,
    }).from(bots).where(eq(bots.id, botId));
    if (!bot) throw new Error(`Bot ${botId} not found`);

    let email: string, password: string;
    try {
      email = decrypt(bot.visaEmail);
      password = decrypt(bot.visaPassword);
    } catch (e) {
      logger.error('Failed to decrypt credentials', { botId, error: String(e) });
      throw new Error(`Failed to decrypt credentials for bot ${botId}`);
    }

    const creds = {
      email,
      password,
      scheduleId: bot.scheduleId,
      applicantIds: bot.applicantIds,
      locale: bot.locale ?? 'es-co',
    };

    try {
      logger.info('Attempting pureFetchLogin', { botId, email });
      const result = await performLogin(creds);
      logAuth({ email, action: 'login_visa', locale: creds.locale, result: 'ok', botId });
      // performLogin always fetches tokens (skipTokens=false)
      if (result.hasTokens) {
        logger.info('Login OK — cookie + tokens fresh', {
          botId,
          cookieLength: result.cookie.length,
          csrfPrefix: result.csrfToken.substring(0, 12),
          authPrefix: result.authenticityToken.substring(0, 12),
        });
      } else {
        logger.warn('Login OK but tokens MISSING (appointment page failed?)', {
          botId,
          cookieLength: result.cookie.length,
        });
      }

      // Load previous session to compare / fallback
      const [existing] = await db.select({
        id: sessions.id, yatriCookie: sessions.yatriCookie,
        csrfToken: sessions.csrfToken, authenticityToken: sessions.authenticityToken,
        createdAt: sessions.createdAt,
      }).from(sessions).where(eq(sessions.botId, botId));
      if (existing) {
        logger.info('Previous session in DB', {
          botId,
          hadCsrf: !!existing.csrfToken,
          hadAuth: !!existing.authenticityToken,
          createdAt: existing.createdAt?.toISOString(),
        });
      }

      // Tokens should come from fresh login; DB fallback only if appointment page 503'd
      let csrfToken = result.csrfToken || null;
      let authenticityToken = result.authenticityToken || null;

      if (!csrfToken || !authenticityToken) {
        if (existing?.csrfToken && existing?.authenticityToken) {
          csrfToken = csrfToken || existing.csrfToken;
          authenticityToken = authenticityToken || existing.authenticityToken;
          logger.warn('Using DB tokens as fallback — appointment page likely failed', {
            botId,
            csrfSource: result.csrfToken ? 'fresh' : 'db_fallback',
            authSource: result.authenticityToken ? 'fresh' : 'db_fallback',
          });
        } else {
          logger.error('No tokens from login AND no fallback in DB — poll will need refreshTokens()', { botId });
        }
      }

      // Upsert session
      const encryptedCookie = encrypt(result.cookie);
      const now = new Date();
      const sessionData = {
        yatriCookie: encryptedCookie,
        csrfToken,
        authenticityToken,
        lastUsedAt: now,
      };

      if (existing) {
        await db.update(sessions).set({ ...sessionData, createdAt: now }).where(eq(sessions.botId, botId));
      } else {
        await db.insert(sessions).values({ botId, ...sessionData });
      }

      logger.info('Session saved to DB', {
        botId,
        cookieChanged: existing ? encryptedCookie !== existing.yatriCookie : true,
        hasCsrf: !!csrfToken,
        hasAuth: !!authenticityToken,
      });

      // Set bot active + reset errors
      await db
        .update(bots)
        .set({ status: 'active', consecutiveErrors: 0, updatedAt: new Date() })
        .where(eq(bots.id, botId));

      logger.info('Bot set to active', { botId });

      // Cancel stale delayed poll-visa (prevents pile-up on version changes)
      const staleRunId = isCloud ? bot.activeCloudRunId : bot.activeRunId;
      if (staleRunId) {
        try { await runs.cancel(staleRunId); } catch { /* already done */ }
      }

      // Restart poll chain (dynamic import to avoid circular dep with poll-visa)
      const { pollVisaTask } = await import('./poll-visa.js');
      const concurrencyKey = isCloud ? `poll-cloud-${botId}` : `poll-${botId}`;
      const handle = await pollVisaTask.trigger(
        { botId, ...(isCloud ? { chainId: 'cloud' as const } : {}) },
        {
          delay: getPollingDelay(),
          concurrencyKey,
          tags: [`bot:${botId}`, ...(isCloud ? ['cloud'] : [])],
        },
      );

      const runIdField = isCloud ? { activeCloudRunId: handle.id } : { activeRunId: handle.id };
      await db.update(bots).set({ ...runIdField, updatedAt: new Date() }).where(eq(bots.id, botId));
      logger.info('Poll chain restarted', { botId, chainId, runId: handle.id });

      return { success: true, action: 'logged_in', pollRunId: handle.id };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (e instanceof InvalidCredentialsError) {
        logger.error('Invalid credentials', { botId });
        logAuth({ email, action: 'login_visa', locale: creds.locale, result: 'invalid', botId });
        await db.update(bots).set({ status: 'error', updatedAt: new Date() }).where(eq(bots.id, botId));
        await notifyUserTask.trigger({
          botId,
          event: 'invalid_credentials',
          data: { message: 'Login failed: invalid email or password. Update credentials and re-activate.' },
        }, { tags: [`bot:${botId}`] });
        return { success: false, action: 'invalid_credentials' };
      }

      logger.error('Login failed', { botId, error: errMsg });
      logAuth({ email, action: 'login_visa', locale: creds.locale, result: 'error', errorMessage: errMsg, botId });
      await db
        .update(bots)
        .set({ status: 'login_required', updatedAt: new Date() })
        .where(eq(bots.id, botId));

      await notifyUserTask.trigger({
        botId,
        event: 'session_expired',
        data: { message: `Login fallido: ${errMsg}. Reactiva con POST /api/bots/:id/activate.` },
      }, { tags: [`bot:${botId}`] });

      return { success: false, action: 'login_failed', error: errMsg };
    }
  },
});
