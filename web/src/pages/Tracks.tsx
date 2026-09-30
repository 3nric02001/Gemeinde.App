import type { Page, Track } from '../api';
import { getJson, query } from '../api';
import { Filters, readFilter } from '../components/Filters';
import { Icon } from '../components/Icon';
import { TrackList } from '../components/TrackList';
import { plural } from '../format';
import { usePaged } from '../hooks';
import { player } from '../player';
import { navigate } from '../router';
import { Empty, ErrorNote, Loading } from './common';

/** Die Warteschlange bekommt höchstens so viele Titel auf einmal (Grenze der API). */
const QUEUE_LIMIT = 500;

export function Tracks({ params }: { params: URLSearchParams }) {
  const filter = readFilter(params);
  const q = params.get('q') ?? undefined;
  const base = `/api/tracks${query({ ...filter, q })}`;
  const { items, total, loading, error, sentinel } = usePaged<Track>(base, 100);

  const playFrom = async (index: number, shuffle = false) => {
    // Ab dem angeklickten Titel die nächsten Treffer laden, auch die noch nicht sichtbaren.
    const offset = Math.max(0, index - 50);
    const page = await getJson<Page<Track>>(`${base}${base.includes('?') ? '&' : '?'}limit=${QUEUE_LIMIT}&offset=${offset}`);
    player.playList(page.items, index - offset, { shuffle });
  };

  return (
    <div class="page">
      <div class="page-head">
        <h1 class="page-title">{q ? `Titel zu „${q}“` : 'Titel'}</h1>
      </div>
      <Filters value={filter} onChange={(next) => navigate(`/titel${query({ q, ...next })}`, { replace: true })} />
      {total !== undefined && total > 0 && (
        <div class="actions">
          <button type="button" class="button-primary" onClick={() => void playFrom(0)}>
            <Icon name="play" size={20} /> Abspielen
          </button>
          <button
            type="button"
            class="button-secondary"
            onClick={() => void getJson<Page<Track>>(`${base}${base.includes('?') ? '&' : '?'}limit=${QUEUE_LIMIT}`).then((p) =>
              player.playShuffled(p.items),
            )}
          >
            <Icon name="shuffle" size={18} /> Zufällig
          </button>
          <span class="count">{plural(total, 'Titel', 'Titel')}</span>
        </div>
      )}
      {error && <ErrorNote message={error} />}
      {total === 0 && <Empty title="Keine Titel gefunden">Entferne einen Filter, um mehr zu sehen.</Empty>}
      <TrackList tracks={items} onPlay={(index) => void playFrom(index)} />
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
