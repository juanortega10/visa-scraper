import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { botsRouter } from './api/bots.js';
import { logsRouter } from './api/logs.js';
import { devRouter } from './api/dev.js';
import { dashboardRouter } from './api/dashboard.js';
import { blockIntelRouter } from './api/block-intelligence.js';
import { apiAuth } from './middleware/api-auth.js';

const app = new Hono();

app.use('/api/*', cors({
  origin: ['https://visagente.com', 'https://www.visagente.com', 'http://localhost:3001'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE'],
}));

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/dashboard', dashboardRouter);

app.use('/api/*', apiAuth());

app.route('/api/bots', botsRouter);
app.route('/api', logsRouter);
app.route('/api/dev', devRouter);
app.route('/api/blocks', blockIntelRouter);

const port = parseInt(process.env.PORT || '3000', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Visa Bot API running on http://localhost:${port}`);
});

export default app;
