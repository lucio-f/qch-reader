import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The extension host API only exists inside VS Code; tests use an in-memory stand-in.
    alias: { vscode: fileURLToPath(new URL('./test/vscode-mock.ts', import.meta.url)) },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
