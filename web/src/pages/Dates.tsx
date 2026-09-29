import { Fragment } from 'preact';
import type { DatedFolder, DatedFolderDetail } from '../api';
import { getJson, query, trackCoverUrl } from '../api';
import { Cover } from '../components/Cover';
import { Icon } from '../components/Icon';
import { albumTitle, formatLongDate, formatMonth, serviceLine } from '../format';
import { usePaged } from '../hooks';
import { player } from '../player';
import { Empty, ErrorNote, Loading } from './common';

export const folderHref = (folder: string) => `/datum/ordner${query({ pfad: folder })}`;

export async function playFolder(folder: string, shuffle = false) {
  const detail = await getJson<DatedFolderDetail>(`/api/dates/folder${query({ path: folder })}`);
  player.playList(detail.tracks, 0, { shuffle });
}

/** Zeile unter dem Anlass: Datum und Sprecher */
export function folderSubtitle(folder: DatedFolder): string {
  return serviceLine(folder.date, folder.speaker);
}

function DateCard({ folder }: { folder: DatedFolder }) {
  return (
    <div class="card">
      <a class="card-link" href={folderHref(folder.folder)}>
        <Cover
          src={folder.coverTrackId ? trackCoverUrl({ id: folder.coverTrackId }) : undefined}
          title={folder.name}
          date={folder.date}
        />
        <span class="card-title">{albumTitle(folder.title ?? folder.name, folder.date)}</span>
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
