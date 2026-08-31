import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath } from 'node:url';

/** Where the rig's control plane listens. Overridable to target a remote rig. */
const CONTROL_ORIGIN = process.env.SIL_CONTROL_ORIGIN ?? 'http://127.0.0.1:9114';

/**
 * Every path the control API owns.
 *
 * Listed explicitly rather than matched by a prefix because in production the
 * console is served *from* the control port, where these are siblings of the
 * console's own routes and not children of an `/api` namespace. The dev proxy
 * has to reproduce that layout exactly, or a path that works under Vite will
 * 404 from the built bundle.
 */
const CONTROL_PATHS = [
  '/control',
  '/events',
  '/clock',
  '/scenario',
  '/scenarios',
  '/fault',
  '/snapshot',
  '/state',
  '/spi',
  '/can',
];

export default defineConfig({
  // Vite's root defaults to the working directory, not the config file's
  // directory, and the config is invoked from the package root so that `vite`
  // resolves from the rig's own node_modules. Pin it explicitly.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 9115,
    strictPort: true,
    proxy: Object.fromEntries(
      CONTROL_PATHS.map((path) => [path, { target: CONTROL_ORIGIN, changeOrigin: true }]),
    ),
  },
  build: {
    // Served by the control server; see resolveWebRoot() in src/server.ts.
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
  },
});
