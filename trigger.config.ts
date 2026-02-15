import { defineConfig } from '@trigger.dev/sdk';

export default defineConfig({
  project: 'proj_arasgpiqwdortxvguggk',
  runtime: 'node',
  logLevel: 'log',
  maxDuration: 300,
  retries: {
    enabledInDev: true,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 1000,
      maxTimeoutInMs: 10000,
      factor: 2,
    },
  },
  dirs: ['src/trigger'],
  build: {
    external: [],
  },
});
