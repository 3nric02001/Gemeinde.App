import { useEffect, useState } from 'preact/hooks';
import { albumTitle, formatCompactDate, plural } from '../format';
import { ErrorNote, Loading } from '../pages/common';
import { adminRequest } from './api';

interface AlbumRef {
  id: number;
  title: string;
  date: string | null;
  trackCount: number;
}

interface QualityReport {
  withoutCover: { total: number; items: AlbumRef[] };
  servicesWithoutSpeaker: { total: number; items: AlbumRef[] };
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
                {[album.date && formatCompactDate(album.date), plural(album.trackCount, 'Titel', 'Titel')]
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
        Hinweise, wo Ordner- oder Dateinamen nicht alles liefern. Am besten benennt man die Dateien in der Nextcloud um; der
        nächste Scan übernimmt das. Alternativ lässt sich jedes Album in der Verwaltung korrigieren.
      </p>

      <Section
        title="Gottesdienste ohne Sprecher"
        count={report.servicesWithoutSpeaker.total}
        hint="Der Sprecher kommt aus dem Dateinamen der Predigt („Predigt - Titel - Name“, Muster unter Verwaltung → Zuordnung) oder aus der Verwaltung am einzelnen Titel."
      >
        <AlbumLinks albums={report.servicesWithoutSpeaker.items} />
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
