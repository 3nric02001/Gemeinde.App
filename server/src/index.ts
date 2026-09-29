import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, scanner } = await buildApp(config);

let timer: NodeJS.Timeout | undefined;
if (config.scanIntervalMinutes > 0) {
  timer = setInterval(() => void scanner.scan(), config.scanIntervalMinutes * 60_000);
  timer.unref();
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Server wird beendet');
  clearInterval(timer);
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ host: config.host, port: config.port });
app.log.info(
  { nextcloud: config.nextcloud.url, user: config.nextcloud.user, musicPaths: config.nextcloud.musicPaths.map((p) => p || '/') },
  config.nextcloud.musicPaths.length > 1 ? 'Gescannte Musikordner' : 'Gescannter Musikordner',
);
// Beim Start einmal abgleichen, damit neue Dateien seit dem letzten Lauf sofort da sind.
void scanner.scan();
