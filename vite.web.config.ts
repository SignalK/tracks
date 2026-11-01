import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import checker from 'vite-plugin-checker'

const entry = (name: string) => resolve(import.meta.dirname, `web/src/${name}.ts`)

// The webapp: web/src compiled into public/, which the server mounts at
// /@signalk/tracks-plugin, with web/static copied in beside it as-is.
//
// Each module keeps its own file under its own name, as index.html loads
// them, and the exports another module imports from it. Unminified, so what
// the server serves reads like its source.
export default defineConfig({
  publicDir: resolve(import.meta.dirname, 'web/static'),
  build: {
    outDir: resolve(import.meta.dirname, 'public'),
    emptyOutDir: true,
    minify: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        tracks: entry('tracks'),
        bin: entry('bin'),
        import: entry('import'),
        history: entry('history'),
        danger: entry('danger'),
        upload: entry('upload'),
      },
      preserveEntrySignatures: 'exports-only',
      output: {
        preserveModules: true,
        entryFileNames: '[name].js',
      },
    },
  },
  // vite transpiles without typechecking; the checker fails the build on a
  // type error, as it does for the plugin.
  plugins: [checker({ typescript: { tsconfigPath: resolve(import.meta.dirname, 'web/tsconfig.json') } })],
})
