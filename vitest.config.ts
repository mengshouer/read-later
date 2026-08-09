import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  // Resolves imports exactly the way the extension build does, so the tests
  // exercise the real module graph instead of a re-resolved copy of it.
  plugins: [WxtVitest()],
  test: {
    include: ['tests/**/*.test.ts'],
    // Supplies the one storage method the fake browser declares but does not implement.
    setupFiles: ['tests/setup.ts'],
    environment: 'node',
  },
});
