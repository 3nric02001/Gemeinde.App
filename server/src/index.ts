import { buildApp } from './app.js';
import { DatabaseBackup } from './backup.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, db, scanner } = await buildApp(config);

let timer: NodeJS.Timeout | undefined;
if (config.scanIntervalMinutes > 0) {
  timer = setInterval(() => void scanner.scan(), config.scanIntervalMinutes * 60_000);
  timer.unref();
}

// Tägliche Sicherung: stündlich prüfen, ob es die von heute schon gibt (übersteht so auch Neustarts).
let backupTimer: NodeJS.Timeout | undefined;
if (config.backupKeep > 0 && config.databasePath !== ':memory:') {
  const backup = new DatabaseBackup(db, config.backupDir, config.backupKeep, app.log);
  backupTimer = setInterval(() => void backup.ensureToday(), 60 * 60_000);
  backupTimer.unref();
  setTimeout(() => void backup.ensureToday(), 60_000).unref();
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Server wird beendet');
  clearInterval(timer);
  clearInterval(backupTimer);
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
