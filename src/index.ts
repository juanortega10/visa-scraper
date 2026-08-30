import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { botsRouter } from './api/bots.js';
import { agenciesRouter } from './api/agencies.js';
import { logsRouter } from './api/logs.js';
import { devRouter } from './api/dev.js';
import { dashboardRouter } from './api/dashboard.js';
import { blockIntelRouter } from './api/block-intelligence.js';
import { apiAuth } from './middleware/api-auth.js';
import { requestLog } from './middleware/request-log.js';
import { db } from './db/client.js';
import { sql } from 'drizzle-orm';

const app = new Hono();

app.use('/api/*', cors({
  origin: ['https://visagente.com', 'https://www.visagente.com', 'http://localhost:3001'],
  // X-Request-Id va en los dos sentidos: el navegador lo propone y el servidor
  // lo devuelve. Sin `exposeHeaders` el navegador no puede leerlo, y sin
  // `allowHeaders` el preflight rechaza la llamada entera.
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Request-Id'],
  exposeHeaders: ['X-Request-Id'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
}));

// Va ANTES de apiAuth y de todo router, para que tambien cubra los 401 de auth
// y cualquier ruta que se monte despues. Un error sin log es un incidente ciego.
app.use('/api/*', requestLog());

app.onError((err, c) => {
  console.error('Unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/dashboard', dashboardRouter);

app.use('/api/*', apiAuth());

app.route('/api/bots', botsRouter);
app.route('/api/agencies', agenciesRouter);
app.route('/api', logsRouter);
app.route('/api/dev', devRouter);
app.route('/api/blocks', blockIntelRouter);

const port = parseInt(process.env.PORT || '3000', 10);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Visa Bot API running on http://localhost:${port}`);
  // Warm up the DB connection pool so first real request doesn't cold-start
  db.execute(sql`SELECT 1`).catch(() => {});
});

export default app;
