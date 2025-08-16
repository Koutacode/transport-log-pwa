import { defineConfig } from 'vite';

// Vite configuration for the transport log PWA.
// The base is set to an empty string so that the app works both
// locally and when served from a subpath on GitHub Pages. If you
// know the repository name ahead of time, you can set base to
// `'/your-repo-name/'` to ensure correct asset resolution.
export default defineConfig({
  base: '',
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});