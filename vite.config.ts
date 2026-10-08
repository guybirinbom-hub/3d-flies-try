import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  define: {
    // Set ARTIFACT=1 when building the self-contained page published as an artifact.
    __ARTIFACT__: JSON.stringify(process.env.ARTIFACT === '1'),
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});
