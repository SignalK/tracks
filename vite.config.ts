import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import dts from 'vite-plugin-dts'

// The plugin is loaded by the Signal K server, not bundled into a browser app,
// so everything outside src/ stays external and is resolved at runtime from
// node_modules. Bundling rxjs or express in would duplicate them in memory
// alongside the server's own copies.
export default defineConfig({
  build: {
    target: 'node20.19',
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: 'index',
    },
    rollupOptions: {
      external: [/^node:/, 'rxjs', 'rxjs/operators', 'express'],
    },
    sourcemap: true,
    minify: false,
  },
  plugins: [dts({ rollupTypes: true, tsconfigPath: './tsconfig.json' })],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
