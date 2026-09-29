import { defineConfig } from 'vite';

// The 2019 content (servo animations, glasses, sounds) is read in place from electron/app/media. Vite already
// serves files anywhere in the workspace root (this repo), so no extra server.fs.allow entry is needed.
export default defineConfig({
  build: {
    target: 'es2022',
    // three.js alone is ~700 kB; this is a local tool, not a website.
    chunkSizeWarningLimit: 1500,
  },
});
