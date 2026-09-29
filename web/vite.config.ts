import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import preact from '@preact/preset-vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

const here = fileURLToPath(new URL('.', import.meta.url));

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesIn(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/**
 * Baut den Service Worker (sw/sw.js) mit der Liste aller Dateien des Builds, damit die App
 * auch ohne Netz startet. Die Version ändert sich mit jedem Build, so lädt der Browser den neuen.
 */
function serviceWorker(): Plugin {
  return {
    name: 'gemeinde-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !file.endsWith('.map') && file !== 'index.html');
      const publicDir = join(here, 'public');
      const copied = filesIn(publicDir).map((file) => relative(publicDir, file).split(sep).join('/'));
      const files = ['/', ...[...built, ...copied].map((file) => `/${file}`).sort()];
      const version = createHash('sha256')
        .update(JSON.stringify(files))
        .update(String((bundle['index.html'] as { source?: string } | undefined)?.source ?? ''))
        .digest('hex')
        .slice(0, 12);
      const source = readFileSync(join(here, 'sw', 'sw.js'), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [preact(), serviceWorker()],
  server: {
    // Im Entwicklungsmodus läuft die API getrennt (cd server && npm run dev).
    proxy: {
      '/api': process.env.API_URL ?? 'http://localhost:3000',
      '/manifest.webmanifest': process.env.API_URL ?? 'http://localhost:3000',
    },
  },
  build: { outDir: 'dist', assetsDir: 'assets' },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'happy-dom',
  },
});
