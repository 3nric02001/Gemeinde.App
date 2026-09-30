import { useEffect, useState } from 'preact/hooks';
import { albumTitle, formatCompactDate, plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

interface AlbumRef {
  id: number;
  title: string;
  artist: string;
  date: string | null;
  trackCount: number;
}

interface QualityReport {
  splitFolders: Array<{ folder: string; albums: AlbumRef[] }>;
  withoutCover: { total: number; items: AlbumRef[] };
  servicesWithoutSpeaker: { total: number; items: AlbumRef[] };
  suspiciousArtists: Array<{ name: string; trackCount: number }>;
  artistVariants: Array<{ names: string[]; trackCount: number }>;
}

function AlbumLinks({ albums }: { albums: AlbumRef[] }) {
  return (
    <ul class="admin-list">
      {albums.map((album) => (
        <li key={album.id}>
          <a href={`/admin/album/${album.id}`} class="admin-row admin-row-plain admin-row-wrap">
            <span class="track-main">
              <span class="track-title">{albumTitle(album.title, album.date)}</span>
              <span class="track-sub">
                {[album.date && formatCompactDate(album.date), album.artist, plural(album.trackCount, 'Titel', 'Titel')]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Section({ title, hint, count, children }: { title: string; hint: string; count: number; children: preact.ComponentChildren }) {
  return (
    <section class="shelf">
      <div class="section-head">
        <h2>
          {title} <span class="badge badge-muted">{count}</span>
        </h2>
      </div>
      <p class="admin-hint">{hint}</p>
      {count === 0 ? <p class="count">Alles in Ordnung.</p> : children}
    </section>
  );
}

/** Verwaltung → Prüfen: wo die automatische Zuordnung vermutlich nicht das zeigt, was gemeint ist */
export function QualityPanel() {
  const [report, setReport] = useState<QualityReport | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    adminRequest<QualityReport>('GET', '/api/admin/quality')
      .then(setReport)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <ErrorNote message={error} />;
  if (!report) return <Loading />;
  return (
    <>
      <h1 class="page-title">Bibliothek prüfen</h1>
      <p class="admin-hint">
        Hinweise, wo Tags oder Ordner nicht zusammenpassen. Am besten korrigiert man sie in den Dateien in der Nextcloud; der
        nächste Scan übernimmt das. Alternativ lässt sich jedes Album in der Verwaltung korrigieren.
      </p>

      <Section
        title="Aufgeteilte Ordner"
        count={report.splitFolders.length}
        hint="Die Titel dieser Ordner tragen verschiedene Album-Tags und erscheinen deshalb als mehrere Alben. Gewollt bei Sammelordnern, sonst den Album-Tag angleichen."
      >
        {report.splitFolders.map((entry) => (
          <div key={entry.folder}>
            <p class="count">{entry.folder}</p>
            <AlbumLinks albums={entry.albums} />
          </div>
        ))}
      </Section>

      <Section
        title="Gottesdienste ohne Sprecher"
        count={report.servicesWithoutSpeaker.total}
        hint="Sprecher kommt aus dem Tag „Sprecher“ (oder Speaker, Prediger, Referent), aus Dateinamen wie „2026-09-27 Meier - Psalm 23“ oder aus der Verwaltung am Album."
      >
        <AlbumLinks albums={report.servicesWithoutSpeaker.items} />
      </Section>

      <Section
        title="Auffällige Interpreten"
        count={report.suspiciousArtists.length}
        hint="Interpreten, die wie ein Datum oder Jahr aussehen oder ganz fehlen. Meist steht im Tag etwas anderes als gemeint."
      >
        <ul class="admin-list">
          {report.suspiciousArtists.map((artist) => (
            <li key={artist.name} class="admin-row admin-row-plain admin-row-wrap">
              <span class="track-main">
                <a class="track-title" href={`/interpret/${encodeURIComponent(artist.name)}`}>
                  {artist.name}
                </a>
                <span class="track-sub">{plural(artist.trackCount, 'Titel', 'Titel')}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Interpreten in mehreren Schreibweisen"
        count={report.artistVariants.length}
        hint="Die App fasst sie schon zusammen; einheitliche Tags sehen aber auch in anderen Programmen besser aus."
      >
        <ul class="admin-list">
          {report.artistVariants.map((variant) => (
            <li key={variant.names.join('|')} class="admin-row admin-row-plain admin-row-wrap">
              <span class="track-main">
                <span class="track-title">{variant.names.join(' · ')}</span>
                <span class="track-sub">{plural(variant.trackCount, 'Titel', 'Titel')}</span>
              </span>
            </li>
          ))}
        </ul>
      </Section>

      <Section
        title="Musikalben ohne Bild"
        count={report.withoutCover.total}
        hint="Ein Bild „cover.jpg“ oder „folder.jpg“ im Albumordner oder ein in die Dateien eingebettetes Cover genügt."
      >
        <AlbumLinks albums={report.withoutCover.items} />
      </Section>
    </>
  );
}
