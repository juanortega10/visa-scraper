import { Hono } from 'hono';
import { db } from '../db/client.js';
import { bots } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { pollVisaTask } from '../trigger/poll-visa.js';
import { loginVisaTask } from '../trigger/login-visa.js';

export const devRouter = new Hono();

// Manually trigger one poll
devRouter.post('/check-dates/:botId', async (c) => {
  const botId = parseInt(c.req.param('botId'));

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  const handle = await pollVisaTask.trigger(
    { botId },
    { tags: [`bot:${botId}`, 'dev-manual'] },
  );

  return c.json({ runId: handle.id });
});

// Manually trigger login
devRouter.post('/login/:botId', async (c) => {
  const botId = parseInt(c.req.param('botId'));

  const [bot] = await db.select().from(bots).where(eq(bots.id, botId));
  if (!bot) return c.json({ error: 'Bot not found' }, 404);

  const handle = await loginVisaTask.trigger(
    { botId },
    { tags: [`bot:${botId}`, 'dev-manual'] },
  );

  return c.json({ runId: handle.id });
});
