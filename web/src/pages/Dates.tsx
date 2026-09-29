import { Fragment } from 'preact';
import type { DatedFolder, DatedFolderDetail } from '../api';
import { getJson, query, trackCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { formatLongDate, formatMonth, formatShortDate, plural } from '../format';
import { usePaged } from '../hooks';
import { player } from '../player';
import { Empty, ErrorNote, Loading } from './common';

export const folderHref = (folder: string) => `/datum/ordner${query({ pfad: folder })}`;

export async function playFolder(folder: string, shuffle = false) {
  const detail = await getJson<DatedFolderDetail>(`/api/dates/folder${query({ path: folder })}`);
  player.playList(detail.tracks, 0, { shuffle });
}

/** Zusatzzeile unter dem Datum: Ordnername ohne das Datum, sonst die Anzahl Titel */
export function folderSubtitle(folder: DatedFolder): string {
  const rest = folder.name
    .replace(/(?:19|20)\d{2}[-_.\s]?\d{2}[-_.\s]?\d{2}|\d{1,2}\.\s?\d{1,2}\.\s?(?:19|20)?\d{2}/, '')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');
  return rest || plural(folder.trackCount, 'Titel', 'Titel');
}

function DateCard({ folder }: { folder: DatedFolder }) {
  return (
    <div class="card">
      <a class="card-link" href={folderHref(folder.folder)}>
        <Cover
          src={folder.coverTrackId ? trackCoverUrl({ id: folder.coverTrackId }) : undefined}
          title={String(Number(folder.date.slice(8)))}
        />
        <span class="card-title">{formatShortDate(folder.date)}</span>
        <span class="card-sub">{folderSubtitle(folder)}</span>
      </a>
      <button
        class="card-play"
        type="button"
        aria-label={`${formatLongDate(folder.date)} abspielen`}
        onClick={() => void playFolder(folder.folder)}
      >
        <Icon name="play" size={22} />
      </button>
    </div>
  );
}

/** Alle Aufnahmen nach Datum, neueste zuerst, mit Monatsüberschriften */
export function Dates() {
  const { items, total, loading, error, sentinel } = usePaged<DatedFolder>('/api/dates', 200);
  const months: Array<{ label: string; folders: DatedFolder[] }> = [];
  for (const folder of items) {
    const label = formatMonth(folder.date);
    if (months.at(-1)?.label !== label) months.push({ label, folders: [] });
    months.at(-1)!.folders.push(folder);
  }

  return (
    <div class="page">
      <h1 class="page-title">Datum</h1>
      {error && <ErrorNote message={error} />}
      {total === 0 && (
        <Empty title="Noch keine Ordner mit Datum">
          Hier erscheinen Ordner, deren Name ein Datum enthält, z. B. „2026-09-27 Gottesdienst“ oder „27.09.2026“.
        </Empty>
      )}
      {months.map((month) => (
        <Fragment key={month.label}>
          <section class="shelf">
            <div class="section-head">
              <h2>{month.label}</h2>
            </div>
            <div class="grid">
              {month.folders.map((folder) => (
                <DateCard key={folder.folder} folder={folder} />
              ))}
            </div>
          </section>
        </Fragment>
      ))}
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
