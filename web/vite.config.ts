import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [preact()],
  server: {
    // Im Entwicklungsmodus läuft die API getrennt (cd server && npm run dev).
    proxy: { '/api': process.env.API_URL ?? 'http://localhost:3000' },
  },
  build: { outDir: 'dist', assetsDir: 'assets' },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
  },
});
