# Gemeinde.App

Minimalistischer Musikplayer für die Gemeinde, der seine Musik direkt aus einer Nextcloud liest.
Alben und Suchfilter entstehen automatisch aus Tags und Ordnerstruktur.

Dieser Stand enthält die **Musikbibliothek** (Backend), die **Weboberfläche** zum Hören, eine
**Verwaltung** für Alben und die **Anmeldung** über einen lokalen Admin oder OIDC mit den Rollen
Admin, Manager und Hörer.

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

## Verwaltung: Alben zusammenstellen und korrigieren

Unter `/admin` (Link „Verwaltung“ in der Seitenleiste bzw. unten auf der Startseite) lassen sich Alben
von Hand pflegen. Die Verwaltung sehen nur Manager und Admins.

- **Eigene Alben**, z. B. „Predigten 2024“: Titel über die Suche hinzufügen, per Pfeil umsortieren,
  entfernen. Ein Titel kann in beliebig vielen Alben stehen. Interpret, Jahr, Genre und Cover
  ergeben sich aus den Titeln, lassen sich aber überschreiben.
- **Automatische Alben korrigieren**: Titel, Interpret, Jahr und Genre ändern (und wieder auf
  „automatisch“ zurücksetzen), einzelne Titel herausnehmen und zurückholen oder das ganze Album
  für Hörer ausblenden.
- **Regeln** füllen eigene Alben automatisch, z. B. „Titel enthält Predigt“ oder „Ordner/Dateiname
  enthält Gottesdienste/2024“. Möglich sind Titel, Interpret, Album, Genre und Ordner/Dateiname mit
  „enthält“, „enthält nicht“, „beginnt mit“ oder „ist genau“; Groß-/Kleinschreibung und Umlaute
  spielen keine Rolle. Bedingungen lassen sich in Gruppen mit UND/ODER verschachteln (bis zu 4 Ebenen),
  z. B. „Titel enthält Predigt UND (Interpret ist Meier ODER Interpret ist Schulz)“. Mehrere Regeln
  eines Albums gelten mit ODER; bestehende Regeln lassen sich bearbeiten. Neue passende Titel kommen beim nächsten Scan von
  selbst dazu, neueste zuerst (nach Datum im Ordnernamen). Vor dem Speichern zeigt eine Vorschau, wie
  viele Titel die Regel trifft. Einen Titel, den man aus so einem Album entfernt, fügt die Regel nicht
  wieder hinzu.
- **Verschieben statt kopieren**: Titel in einem automatischen Album auswählen und „Zu eigenem Album
  hinzufügen“. Mit „herausnehmen“ verschwinden sie aus dem bisherigen Album, sonst stehen sie in beiden.
  Dasselbe gibt es für Regeln („verschieben“).

![Regeln in der Verwaltung](docs/screenshots/admin-rules.png)

Alle Eingriffe werden getrennt von den gescannten Daten gespeichert (nach Dateipfad bzw. Album) und
bei jedem Scan wieder angewendet. Fehlt eine Datei eines eigenen Albums zeitweise in der Nextcloud,
erscheint sie nach dem nächsten Scan wieder an ihrem Platz. Wird eine Datei umbenannt oder
verschoben, muss sie im eigenen Album neu eingetragen werden.

## Verwaltung: Kategorien

Unter **Verwaltung → Kategorien** legt man eigene Kategorien an, benennt sie um, ordnet sie oder löscht sie.
Jede Kategorie mit „Im Menü anzeigen“ steht in der Seitenleiste und unter Suche, mit einer Seite aller Werte
(`/kategorie/<name>`) und je Wert einer Seite mit Alben und Titeln zum Abspielen.

- **Tag-Felder**: Eine Kategorie nimmt ihre Werte aus einem oder mehreren Feldern der Musikdateien, z. B.
  „Interpreten“ aus Interpret und Album-Interpret. Zur Auswahl stehen alle Felder, die in der Bibliothek vorkommen,
  auch eigene ID3-Felder (TXXX, etwa „Kategorie“ oder „Sprecher“) und eigene Vorbis-Kommentare in FLAC/Ogg.
  Mehrere Werte in einem Feld („Chor; Gemeinde“) werden einzeln geführt.
- **Werte zusammenfassen**: Mehrere Tag-Werte erscheinen unter einem Namen, z. B. „Musik“ aus Musik, Lied.
  Groß-/Kleinschreibung und Akzente spielen dabei keine Rolle. Wahlweise zeigt die Kategorie nur die
  zusammengefassten Werte.
- **Vorschau**: Beim Einrichten zeigt die Verwaltung sofort, welche Werte mit wie vielen Titeln entstehen.

Vorgegeben sind „Interpreten“ (im Menü) und „Genre“ (nicht im Menü). Die Filter nach Genre und Jahrzehnt
sowie der Reiter „Datum“ bleiben davon unberührt. Beim ersten Start mit dieser Version liest der Scan alle
Dateien einmal neu, um auch die übrigen Tag-Felder zu erfassen.

![Kategorie in der Verwaltung](docs/screenshots/admin-categories.png)

## Anmeldung, Benutzer und Rollen

Die ganze App (auch der Player) ist nur nach Anmeldung erreichbar.

- **Lokaler Admin** `admin`: Er wird beim ersten Start angelegt. Das Passwort kommt aus
  `ADMIN_PASSWORD`; fehlt die Variable, wird eines erzeugt und einmal ins Log geschrieben
  (`docker compose logs gemeinde-app`). Danach ändert man es unter Verwaltung → Anmeldung.
  Passwort vergessen: `RESET_ADMIN_PASSWORD=true` setzen und neu starten, danach die Variable wieder
  entfernen.
- **Alle anderen** melden sich über OIDC mit ihrem Gemeinde-Konto an (Keycloak, Authentik, Nextcloud,
  Entra ID u. a.). Eingerichtet wird das unter Verwaltung → Anmeldung: Issuer-URL, Client-ID,
  Client-Secret und der Claim mit den Gruppen (Standard `groups`, verschachtelt z. B.
  `realm_access.roles`). Die Weiterleitungs-URL für den Client im Identity Provider steht dort zum
  Kopieren. Anmeldung mit Authorization Code und PKCE; Gruppen, die nicht im ID-Token stehen,
  werden über den Userinfo-Endpunkt gelesen.
- **Gruppen** (Verwaltung → Gruppen): Jede Gruppe, die beim Login mitkommt, erscheint dort; man
  kann Gruppen auch vorab eintragen. Nur Gruppen mit Haken sind freigeschaltet, und nur wer in einer
  freigeschalteten Gruppe ist, wird als Benutzer angelegt. Jede Gruppe bekommt eine Rolle; wer in
  mehreren ist, erhält die höchste. Änderungen gelten sofort, auch für bereits angemeldete Benutzer.
- **Benutzer** (Verwaltung → Benutzer): Liste mit Rolle, Gruppen und letzter Anmeldung. Einzelne
  Benutzer lassen sich sperren oder entfernen.

| Rolle | Darf |
| --- | --- |
| Admin | alles: Alben und Titel, Scan, Benutzer, Gruppen, OIDC-Schnittstelle |
| Manager | Alben, Titel und Regeln bearbeiten, Scan starten |
| Hörer | nur den Player nutzen; die Verwaltung ist ausgeblendet |

Sitzungen laufen über ein HttpOnly-Cookie (SameSite=Lax, bei https mit Secure) und bleiben 30 Tage
nach der letzten Nutzung gültig. In der Datenbank steht nur ein Hash der Sitzungs-ID, das Passwort
des lokalen Admins als scrypt-Hash. Nach zehn Fehlversuchen ist die Passwort-Anmeldung je IP für
15 Minuten gesperrt.

![Gruppen in der Verwaltung](docs/screenshots/admin-groups.png)

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

Die Datenbank liegt im Volume `gemeinde-data` (`/data` im Container). Die Bibliothek selbst baut
jeder Scan aus der Nextcloud neu auf, eigene Alben und Korrekturen aus der Verwaltung gibt es aber
nur in dieser Datenbank: Das Volume gehört deshalb ins Backup. Für den Betrieb im Internet gehört
ein Reverse Proxy mit TLS (Traefik, Caddy, nginx) davor.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `NEXTCLOUD_URL` | – | Basis-URL der Nextcloud |
| `NEXTCLOUD_USER` | – | Service-Account |
| `NEXTCLOUD_PASSWORD` | – | App-Passwort des Service-Accounts |
| `NEXTCLOUD_MUSIC_PATH` | – (Pflicht) | Ordner, der gescannt wird, relativ zu den Dateien des Service-Accounts, z. B. `/Gemeinde/Medien/Musik`. Nur dieser Ordner und seine Unterordner kommen in die Bibliothek. |
| `ADMIN_PASSWORD` | – | Startpasswort des lokalen Admins `admin`; ohne Angabe wird eines erzeugt und geloggt |
| `RESET_ADMIN_PASSWORD` | `false` | `true` setzt das Passwort des lokalen Admins beim Start auf `ADMIN_PASSWORD` (bzw. ein neues) zurück |
| `PUBLIC_URL` | – | Öffentliche Adresse, z. B. `https://musik.gemeinde.de`; ergibt die OIDC-Weiterleitungs-URL. Ohne Angabe aus der Anfrage (Reverse Proxy mit `X-Forwarded-Proto`/`-Host`) |
| `SCAN_INTERVAL_MINUTES` | `60` | Automatischer Scan, `0` = aus |
| `SCAN_CONCURRENCY` | `4` | Parallele Zugriffe auf die Nextcloud beim Scan |
| `DATABASE_PATH` | `/data/library.db` | Pfad der SQLite-Datei |
| `WEB_DIR` | `/app/public` | Ordner der gebauten Weboberfläche; fehlt er, läuft nur die API |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Adresse des HTTP-Servers |
| `LOG_LEVEL` | `info` | Log-Level (JSON-Logs) |

## API

Alle Pfade außer `/api/health` und `/api/auth/*` brauchen eine Sitzung (Cookie `gemeinde_session`),
sonst antworten sie mit 401; fehlt die Rolle, mit 403.

| Methode und Pfad | Zweck |
| --- | --- |
| `GET /api/albums?q=&artist=&genre=&year=&decade=&sort=artist\|title\|year\|recent&limit=&offset=` | Alben suchen und filtern |
| `GET /api/albums/:id` | Album mit Titelliste |
| `GET /api/albums/:id/cover` | Albumcover (Bild im Ordner, sonst eingebettet) |
| `GET /api/tracks/:id/cover` | Bild des Titels, sonst Albumcover |
| `GET /api/tracks?q=&artist=&genre=&year=&decade=&albumId=&limit=&offset=` | Titel suchen und filtern |
| `GET /api/categories` | Kategorien in der eingestellten Reihenfolge (`{ id, name, slug, inNav }`) |
| `GET /api/categories/:slug/values?q=` | Werte einer Kategorie mit Anzahl Titel |
| `GET /api/tracks/:id/stream` | Audio streamen (unterstützt `Range`) |
| `GET /api/artists?q=` | Interpreten mit Anzahl Alben und Titel |
| `GET /api/dates?limit=&offset=` | Unterste Ordner mit Datum im Namen, neueste zuerst |
| `GET /api/dates/folder?path=` | Ein Datumsordner mit seinen Titeln |
| `GET /api/facets` | Genres, Jahrzehnte und Gesamtzahlen für die Filterleiste |
| `GET /api/scan` | Status des letzten Scans |
| `POST /api/scan` | Scan starten (Manager, Admin) |
| `GET /api/health` | Healthcheck |

Alle Listen liefern `{ items, total, limit, offset }`. Alben haben `kind: "auto" | "manual"`.
`/api/albums` und `/api/tracks` filtern mit `category=<slug>&value=<Wert>` nach dem Wert einer Kategorie.

Verwaltung (Manager und Admins):

| Methode und Pfad | Zweck |
| --- | --- |
| `GET /api/admin/albums?q=&kind=auto\|manual` | Alle Alben inkl. ausgeblendeter |
| `POST /api/admin/albums` | Eigenes Album anlegen: `{ title, artist?, year?, genre?, trackIds?, move? }` |
| `GET /api/admin/albums/:id` | Album mit Korrekturen, herausgenommenen und fehlenden Titeln |
| `PATCH /api/admin/albums/:id` | `{ title?, artist?, year?, genre?, hidden? }`; `null` setzt auf automatisch zurück |
| `DELETE /api/admin/albums/:id` | Eigenes Album löschen (die Titel bleiben) |
| `POST /api/admin/albums/:id/tracks` | Titel anhängen: `{ trackIds, move? }`; `move` nimmt sie aus ihrem automatischen Album |
| `PUT /api/admin/albums/:id/tracks` | Inhalt und Reihenfolge eines eigenen Albums setzen: `{ trackIds }` |
| `DELETE /api/admin/albums/:id/tracks/:trackId` | Titel entfernen (bei automatischen Alben: herausnehmen) |
| `POST /api/admin/albums/:id/tracks/:trackId/restore` | Herausgenommenen Titel zurückholen |
| `POST /api/admin/albums/:id/rules` | Regel anlegen: `{ condition, move? }` (siehe unten) |
| `PUT /api/admin/albums/:id/rules/:ruleId` | Regel ändern, gleicher Aufbau |
| `DELETE /api/admin/albums/:id/rules/:ruleId` | Regel löschen |
| `POST /api/admin/rules/preview` | `{ condition }`: wie viele und welche Titel eine Regel treffen würde |
| `GET /api/admin/track-albums?ids=1,2` | In welchen Alben die Titel stehen |
| `GET /api/admin/categories` | Alle Kategorien mit Tag-Feldern und zusammengefassten Werten |
| `POST /api/admin/categories` | Kategorie anlegen: `{ name, fields, groups?, inNav?, groupedOnly? }` |
| `PATCH /api/admin/categories/:id` | Umbenennen oder Zuordnung ändern, gleiche Felder, alle optional |
| `DELETE /api/admin/categories/:id` | Kategorie löschen |
| `PUT /api/admin/categories/order` | Reihenfolge: `{ ids }` |
| `POST /api/admin/categories/preview` | `{ fields, groups?, groupedOnly? }`: welche Werte entstehen würden |
| `GET /api/admin/tag-fields` | Alle Tag-Felder der Bibliothek mit Anzahl Titel und Beispielwerten |

Eine `condition` ist entweder eine Bedingung `{ field: title|artist|album|genre|path, op: contains|not_contains|starts|equals, value }`
oder eine Gruppe `{ match: "all" | "any", conditions: [...] }` (UND bzw. ODER, beliebig verschachtelt, bis zu 4 Ebenen
und 30 Bedingungen). Statt `condition` geht für eine einzelne Bedingung auch `{ field, op, value }` direkt.

`groups` einer Kategorie ist eine Liste `{ label, values }`, z. B. `{ "label": "Musik", "values": ["Musik", "Lied"] }`.

Anmeldung und Benutzer:

| Methode und Pfad | Zweck |
| --- | --- |
| `GET /api/auth/status` | Angemeldeter Benutzer (oder `null`) und ob OIDC eingerichtet ist |
| `POST /api/auth/login` | Lokaler Admin: `{ username, password }` |
| `POST /api/auth/logout` | Abmelden |
| `POST /api/auth/password` | Passwort des lokalen Admins ändern: `{ current, next }` |
| `GET /api/auth/oidc/start?returnTo=` | Weiter zum Identity Provider |
| `GET /api/auth/oidc/callback` | Rückkehr vom Identity Provider |
| `GET /api/admin/users` | Benutzer (nur Admin) |
| `PATCH /api/admin/users/:id` | `{ disabled }` sperren oder entsperren (nur Admin) |
| `DELETE /api/admin/users/:id` | OIDC-Benutzer entfernen (nur Admin) |
| `GET /api/admin/groups` | Gesehene und eingetragene Gruppen (nur Admin) |
| `PUT /api/admin/groups/:name` | `{ enabled?, role?: listener\|manager\|admin }`, legt die Gruppe bei Bedarf an (nur Admin) |
| `DELETE /api/admin/groups/:name` | Gruppe entfernen (nur Admin) |
| `GET/PUT /api/admin/oidc` | OIDC-Einstellungen; das Secret wird nie ausgeliefert (nur Admin) |
| `POST /api/admin/oidc/test` | Discovery des Identity Providers testen (nur Admin) |

## Entwicklung

```bash
cd server
npm install
npm test            # Vitest, inkl. simulierter Nextcloud und simuliertem Identity Provider
npm run typecheck
NEXTCLOUD_URL=… NEXTCLOUD_USER=… NEXTCLOUD_PASSWORD=… NEXTCLOUD_MUSIC_PATH=… npm run dev

cd web
npm install
npm test            # Warteschlange, Formatierung, Titelliste, Verwaltung, Anmeldung
npm run dev         # Oberfläche mit Hot Reload, /api geht an localhost:3000
```

Ohne Nextcloud ausprobieren: `cd web && npm run build && cd ../server && npm run demo` startet den
Server mit einer simulierten Nextcloud und ein paar Beispielalben unter http://localhost:3000
(lokaler Admin `admin` / `demo`; „Mit Gemeinde-Konto anmelden“ meldet über einen simulierten Identity
Provider Anna mit der Rolle Manager an).

Die Tests erzeugen winzige MP3- und FLAC-Dateien im Speicher und starten einen WebDAV-Server,
der sich wie Nextcloud verhält. Echte Musikdateien sind dafür nicht nötig.
