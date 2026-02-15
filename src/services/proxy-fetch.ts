import { Agent, ProxyAgent } from 'undici';

export type ProxyProvider = 'direct' | 'brightdata' | 'firecrawl';

// Singleton agents — reuse TCP+TLS connections across requests.
// Creating a new connection per request costs ~200ms (TLS handshake).
// With shared agents, subsequent requests reuse warm connections.
let sharedProxyAgent: ProxyAgent | null = null;
let sharedDirectAgent: Agent | null = null;

function getDirectAgent(): Agent {
  if (!sharedDirectAgent) {
    sharedDirectAgent = new Agent({
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 60_000,
      connections: 10,
    });
  }
  return sharedDirectAgent;
}

function getBrightDataAgent(): ProxyAgent {
  const proxyUrl = process.env.BRIGHT_DATA_PROXY_URL;
  if (!proxyUrl) throw new Error('BRIGHT_DATA_PROXY_URL not configured');

  if (!sharedProxyAgent) {
    sharedProxyAgent = new ProxyAgent({
      uri: proxyUrl,
      requestTls: { rejectUnauthorized: false },
    });
  }
  return sharedProxyAgent;
}

export async function proxyFetch(
  url: string,
  options: RequestInit,
  provider: ProxyProvider = 'direct',
): Promise<Response> {
  switch (provider) {
    case 'direct':
      return fetch(url, {
        ...options,
        // @ts-expect-error undici dispatcher works with global fetch
        dispatcher: getDirectAgent(),
      });
    case 'brightdata':
      return fetchViaBrightData(url, options);
    case 'firecrawl':
      return fetchViaFirecrawl(url, options);
  }
}

async function fetchViaBrightData(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const agent = getBrightDataAgent();
  return fetch(url, {
    ...options,
    // @ts-expect-error undici dispatcher works with global fetch
    dispatcher: agent,
  });
}

async function fetchViaFirecrawl(
  url: string,
  options: RequestInit,
): Promise<Response> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured');

  // Pass original request headers to Firecrawl so it forwards them
  const headers = options.headers instanceof Headers
    ? Object.fromEntries(options.headers.entries())
    : (options.headers as Record<string, string>) ?? {};

  const resp = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['rawHtml'],
      headers,
      waitFor: 0,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Firecrawl API error ${resp.status}: ${text}`);
  }

  const json = (await resp.json()) as { success: boolean; data?: { rawHtml?: string } };
  if (!json.success || !json.data?.rawHtml) {
    throw new Error('Firecrawl returned no rawHtml');
  }

  // Wrap the raw content in a synthetic Response so callers can use it normally
  return new Response(json.data.rawHtml, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}
