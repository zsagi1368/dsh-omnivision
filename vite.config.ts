import { builtinModules } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * Node-only plugin library. Everything that is not first-party source is kept
 * external: node builtins (node:crypto, node:fs, ...) plus runtime deps and
 * optional peer deps, so Vite never resolves them against a browser target
 * (which would stub them with `__vite-browser-external`).
 */
const packageExternals = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/schemastery',
  'sharp',
  'puppeteer-core',
  'potrace',
];

const nodeExternals = new Set<string>([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
]);

function isExternal(id: string): boolean {
  if (nodeExternals.has(id)) return true;
  // Also cover subpath imports such as `potrace/lib/...`
  return packageExternals.some((name) => id === name || id.startsWith(`${name}/`));
}

export default defineConfig({
  build: {
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: {
      external: isExternal,
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
