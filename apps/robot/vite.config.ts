import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const web = fileURLToPath(new URL('./web/', import.meta.url));

/** The robot's pages (panel, face screen, setup), built into dist/web for the robot's web server. */
export default defineConfig({
  root: web,
  base: '/',
  build: {
    outDir: fileURLToPath(new URL('./dist/web/', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: { input: { index: `${web}index.html`, face: `${web}face.html`, setup: `${web}setup.html` } },
  },
});
