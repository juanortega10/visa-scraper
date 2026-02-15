import { task, logger } from '@trigger.dev/sdk/v3';
import { visaNotifyQueue } from './queues.js';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { notifyUser } from '../services/notifications.js';

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

    // SELECT only fields needed for notification delivery
    const [bot] = await db.select({
      id: bots.id,
      notificationEmail: bots.notificationEmail,
      ownerEmail: bots.ownerEmail,
      webhookUrl: bots.webhookUrl,
    }).from(bots).where(eq(bots.id, botId));
    if (!bot) {
      logger.warn('Bot not found for notification', { botId });
      return;
    }

    logger.info('Sending notification', { botId, event, webhookUrl: bot.webhookUrl ?? 'none', email: bot.notificationEmail ?? 'none' });
    await notifyUser(bot, event, data);
    logger.info('notify-user DONE', { botId, event });
  },
});
