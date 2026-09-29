# Gemeinde.App

Minimalistischer Musikplayer für die Gemeinde, der seine Musik direkt aus einer Nextcloud liest.
Alben und Suchfilter entstehen automatisch aus Tags und Ordnerstruktur.

Dieser Stand enthält die **Musikbibliothek** (Backend) und die **Weboberfläche** zum Hören.
Login (OIDC), Benutzer- und Gruppenverwaltung folgen.

![Album in der Weboberfläche](docs/screenshots/desktop-album.png)

## Weboberfläche

Bedienung wie bei Spotify oder Apple Music, Farben schlicht schwarz auf weiß wie auf
mbg-bielefeld-brake.de (mit Dunkelmodus, der der Systemeinstellung folgt).

- **Start**: Genres als Kacheln, „Neu hinzugefügt“, Alben des häufigsten Genres, Jahrzehnte
- **Suche**: Treffer beim Tippen, gruppiert nach Interpreten, Titeln und Alben; ohne Suchbegriff
  Stöbern nach Genre
- **Alben, Titel**: Sortierung und Filter-Chips für Genre und Jahrzehnt, lädt beim Scrollen nach
- **Datum**: Jeder unterste Ordner, dessen Name ein Datum enthält, erscheint als eigenes „Album“ mit
  Wochentag und Datum, neueste zuerst und nach Monaten gruppiert. Erkannt werden z. B.
  `2026-09-27 Gottesdienst`, `20260927`, `27.09.2026`, `27.9.26` und `27. September 2026`. Das Datum
  kommt aus dem Ordnernamen, nicht aus den Tags; Ordner ohne Datum im Namen stehen nur unter Alben.
  Disc-Unterordner (`CD 1`, `CD 2`) zählen zum Elternordner. Interpreten sind weiter über Suche und
  Links erreichbar.
- **Album- und Interpretenseite**: Abspielen, Zufällig, Titelliste (Doppel-CDs getrennt), „Mehr von …“
- **Player**: Leiste unten mit Zufall, Wiederholen (alle/einen), Spulen und Lautstärke; Warteschlange
  mit „Als Nächstes spielen“ und „Zur Warteschlange hinzufügen“. Auf dem Handy Mini-Player über der
  Tab-Leiste, der sich zu „Jetzt läuft“ aufklappt.
- Steuerung über Sperrbildschirm und Medientasten (Media Session), Leertaste spielt/pausiert, `/`
  öffnet die Suche. Warteschlange und Position überstehen ein Neuladen.

Die Farben stehen als CSS-Variablen oben in `web/src/styles.css` und lassen sich dort zentral anpassen.
Die Oberfläche ist mit Vite und Preact gebaut (ca. 17 KB JavaScript, gzip) und wird vom selben Server
unter `/` ausgeliefert; es ist kein zweiter Container nötig.

## So funktioniert es

- Ein **Service-Account** in der Nextcloud (mit App-Passwort) liest genau den Ordner, der in
  `NEXTCLOUD_MUSIC_PATH` steht, samt Unterordnern; alles andere im Account bleibt unberührt.
  Ein mit dem Service-Account geteilter Ordner erscheint in dessen Dateien und kann direkt
  angegeben werden. Nutzer brauchen keinen Nextcloud-Zugang. Den genauen Pfad zeigt die
  Nextcloud-Weboberfläche des Service-Accounts in der Brotkrumen-Navigation.
- Der **Scan** läuft beim Start und danach im eingestellten Intervall. Er ist inkrementell:
  Nur neue Dateien und solche mit geändertem ETag werden gelesen, und davon nur der Anfang mit den
  Tags (256 KB, bei großen eingebetteten Covern etwas mehr). Nach dem Update auf diese Version
  liest der erste Scan alle Dateien einmal neu, um die Cover zu übernehmen. Gelöschte Dateien verschwinden aus der Bibliothek; Ordner, die gerade nicht lesbar
  sind, bleiben unangetastet.
- **Metadaten** kommen aus den Tags (MP3, FLAC, Ogg, Opus, …). Fehlt etwas, wird es aus dem Pfad
  abgeleitet, z. B. `Interpret/Album (2021)/CD 2/03 - Titel.mp3`.
- **Alben** werden pro Albumordner und Albumname gebildet. Disc-Ordner (`CD 1`, `Disc 2`) werden
  zusammengefasst, Sampler mit vielen Interpreten bleiben ein Album („Verschiedene Interpreten“),
  Sammelordner mit Titeln aus mehreren Alben werden aufgeteilt. Als Albumcover dient `cover.jpg`,
  `folder.jpg`, `front.jpg` o. ä. im Albumordner, sonst das in die Dateien eingebettete Bild.
- **Titelbilder**: In MP3 (ID3) und FLAC eingebettete Cover werden beim Scan gelesen und in der
  Datenbank abgelegt (gleiche Bilder nur einmal). Jeder Titel zeigt sein eigenes Bild, ohne eigenes
  Bild das Albumcover. Große Tag-Blöcke werden dafür bis 8 MB nachgeladen.
- **Suche und Filter**: Volltextsuche mit Präfix und ohne Rücksicht auf Umlaute/Akzente (SQLite FTS5),
  Filter nach Interpret, Genre, Jahr und Jahrzehnt.
- **Streaming** läuft über den Server mit Range-Unterstützung (Spulen im Browser), die
  Nextcloud-Zugangsdaten verlassen den Server nie.

Die Daten liegen in einer SQLite-Datenbank im WAL-Modus, ausgelegt auf viele gleichzeitige Leser
(Zielgröße: ca. 200 Nutzer auf einem Server).

## Betrieb mit Docker

```bash
cp .env.example .env    # Werte eintragen
docker compose up -d --build
curl localhost:3000/api/health
```

Die Datenbank liegt im Volume `gemeinde-data` (`/data` im Container). Sie lässt sich jederzeit
löschen; der nächste Scan baut sie aus der Nextcloud neu auf. Für den Betrieb im Internet gehört
ein Reverse Proxy mit TLS (Traefik, Caddy, nginx) davor.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `NEXTCLOUD_URL` | – | Basis-URL der Nextcloud |
| `NEXTCLOUD_USER` | – | Service-Account |
| `NEXTCLOUD_PASSWORD` | – | App-Passwort des Service-Accounts |
| `NEXTCLOUD_MUSIC_PATH` | – (Pflicht) | Ordner, der gescannt wird, relativ zu den Dateien des Service-Accounts, z. B. `/Gemeinde/Medien/Musik`. Nur dieser Ordner und seine Unterordner kommen in die Bibliothek. |
| `ADMIN_TOKEN` | – | Erlaubt `POST /api/scan`; ohne Token ist der manuelle Scan gesperrt |
| `SCAN_INTERVAL_MINUTES` | `60` | Automatischer Scan, `0` = aus |
| `SCAN_CONCURRENCY` | `4` | Parallele Zugriffe auf die Nextcloud beim Scan |
| `DATABASE_PATH` | `/data/library.db` | Pfad der SQLite-Datei |
| `WEB_DIR` | `/app/public` | Ordner der gebauten Weboberfläche; fehlt er, läuft nur die API |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Adresse des HTTP-Servers |
| `LOG_LEVEL` | `info` | Log-Level (JSON-Logs) |

## API

| Methode und Pfad | Zweck |
| --- | --- |
| `GET /api/albums?q=&artist=&genre=&year=&decade=&sort=artist\|title\|year\|recent&limit=&offset=` | Alben suchen und filtern |
| `GET /api/albums/:id` | Album mit Titelliste |
| `GET /api/albums/:id/cover` | Albumcover (Bild im Ordner, sonst eingebettet) |
| `GET /api/tracks/:id/cover` | Bild des Titels, sonst Albumcover |
| `GET /api/tracks?q=&artist=&genre=&year=&decade=&albumId=&limit=&offset=` | Titel suchen und filtern |
| `GET /api/tracks/:id/stream` | Audio streamen (unterstützt `Range`) |
| `GET /api/artists?q=` | Interpreten mit Anzahl Alben und Titel |
| `GET /api/dates?limit=&offset=` | Unterste Ordner mit Datum im Namen, neueste zuerst |
| `GET /api/dates/folder?path=` | Ein Datumsordner mit seinen Titeln |
| `GET /api/facets` | Genres, Jahrzehnte und Gesamtzahlen für die Filterleiste |
| `GET /api/scan` | Status des letzten Scans |
| `POST /api/scan` | Scan starten (`Authorization: Bearer <ADMIN_TOKEN>`) |
| `GET /api/health` | Healthcheck |

Alle Listen liefern `{ items, total, limit, offset }`.

## Entwicklung

```bash
cd server
npm install
npm test            # Vitest, inkl. simulierter Nextcloud
npm run typecheck
NEXTCLOUD_URL=… NEXTCLOUD_USER=… NEXTCLOUD_PASSWORD=… NEXTCLOUD_MUSIC_PATH=… npm run dev

cd web
npm install
npm test            # Warteschlange, Formatierung, Titelliste
npm run dev         # Oberfläche mit Hot Reload, /api geht an localhost:3000
```

Ohne Nextcloud ausprobieren: `cd web && npm run build && cd ../server && npm run demo` startet den
Server mit einer simulierten Nextcloud und ein paar Beispielalben unter http://localhost:3000.

Die Tests erzeugen winzige MP3- und FLAC-Dateien im Speicher und starten einen WebDAV-Server,
der sich wie Nextcloud verhält. Echte Musikdateien sind dafür nicht nötig.
