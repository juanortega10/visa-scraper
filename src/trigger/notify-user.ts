import { task, logger } from '@trigger.dev/sdk/v3';
import { visaNotifyQueue } from './queues.js';
import { db } from '../db/client.js';
import { bots, agencies } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { notifyUser } from '../services/notifications.js';
import { decrypt } from '../services/encryption.js';

interface NotifyPayload {
  botId: number;
  event: string;
  data: Record<string, unknown>;
}

export const notifyUserTask = task({
  id: 'notify-user',
  queue: visaNotifyQueue,
  machine: { preset: 'micro' },
  maxDuration: 30,

  run: async (payload: NotifyPayload) => {
    const { botId, event, data } = payload;
    logger.info('notify-user START', { botId, event, data });

    // SELECT only fields needed for notification delivery + visa account email
    // (decrypted) for account identification + agency name for co-branded header.
    const [row] = await db.select({
      id: bots.id,
      notificationEmail: bots.notificationEmail,
      ownerEmail: bots.ownerEmail,
      notificationPhone: bots.notificationPhone,
      webhookUrl: bots.webhookUrl,
      visaEmailEnc: bots.visaEmail,
      agencyName: agencies.name,
    }).from(bots).leftJoin(agencies, eq(bots.agencyId, agencies.id)).where(eq(bots.id, botId));
    if (!row) {
      logger.warn('Bot not found for notification', { botId });
      return;
    }

    let visaEmail: string | null = null;
    try { visaEmail = decrypt(row.visaEmailEnc); } catch { /* leave null on decrypt failure */ }

    logger.info('Sending notification', { botId, event, webhookUrl: row.webhookUrl ?? 'none', email: row.notificationEmail ?? 'none', agency: row.agencyName ?? 'none' });
    await notifyUser({ ...row, visaEmail }, event, data);
    logger.info('notify-user DONE', { botId, event });
  },
});
