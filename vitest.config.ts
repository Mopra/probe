import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/worker/src/**/*.test.ts',
      // apps/web is mostly server components, which are not worth unit testing.
      // The exception is app/lib: cf-access.ts is the gate on every screen that
      // holds a founder's address, and it cannot live in @probe/core because it
      // has to run on the edge runtime (Web Crypto, no node builtins).
      'apps/web/app/lib/**/*.test.ts',
    ],
    environment: 'node',
    passWithNoTests: true,
  },
});
