import { task } from '@trigger.dev/sdk/v3';

interface ProbePayload {
  url: string;
  count: number;
  delayMs: number;
  headers?: Record<string, string>;
}

interface ProbeResultItem {
  i: number;
  status: number;
  ok: boolean;
  latencyMs: number;
  bodyLen?: number;
  error?: string;
}

export const probeBlocking = task({
  id: 'probe-blocking',
  retry: { maxAttempts: 1 },
  run: async ({ url, count, delayMs, headers }: ProbePayload) => {
    const results: ProbeResultItem[] = [];

    for (let i = 0; i < count; i++) {
      const start = Date.now();
      try {
        const resp = await fetch(url, {
          headers: headers ?? {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
            Accept: 'text/html',
          },
          signal: AbortSignal.timeout(10000),
        });
        const body = await resp.text();
        results.push({
          i,
          status: resp.status,
          ok: resp.status === 200 && (body.includes('sign_in') || body.includes('Sign In') || body.includes('Iniciar')),
          latencyMs: Date.now() - start,
          bodyLen: body.length,
        });
      } catch (e) {
        results.push({
          i,
          status: 0,
          ok: false,
          latencyMs: Date.now() - start,
          error: String(e).slice(0, 100),
        });
      }
      if (i < count - 1) await new Promise((r) => setTimeout(r, delayMs));
    }

    const ip = await fetch('https://api.ipify.org?format=text', { signal: AbortSignal.timeout(5000) })
      .then((r) => r.text())
      .catch(() => 'unknown');

    return { ip, results };
  },
});
