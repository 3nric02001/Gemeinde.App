import type { Artist } from '../api';
import { hashHue, initials, plural } from '../format';
import { usePaged } from '../hooks';
import { ErrorNote, Loading } from './common';

export function ArtistList({ artists }: { artists: Artist[] }) {
  return (
    <ul class="artist-list">
      {artists.map((artist) => (
        <li key={artist.name}>
          <a href={`/interpret/${encodeURIComponent(artist.name)}`}>
            <span class="avatar" style={{ '--hue': hashHue(artist.name) }} aria-hidden="true">
              {initials(artist.name)}
            </span>
            <span class="artist-text">
              <span class="artist-name">{artist.name}</span>
              <span class="artist-sub">
                {plural(artist.albumCount, 'Album', 'Alben')} · {plural(artist.trackCount, 'Titel', 'Titel')}
              </span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Artists() {
  const { items, total, loading, error, sentinel } = usePaged<Artist>('/api/artists', 100);
  return (
    <div class="page">
      <h1 class="page-title">Interpreten</h1>
      {total !== undefined && <p class="count">{plural(total, 'Interpret', 'Interpreten')}</p>}
      {error && <ErrorNote message={error} />}
      <ArtistList artists={items} />
      {loading && <Loading />}
      <div ref={sentinel} />
    </div>
  );
}
