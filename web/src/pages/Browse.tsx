import type { Track } from '../api';
import { Icon } from '../components/Icon';
import { TrackList } from '../components/TrackList';
import { hashHue, initials, plural } from '../format';
import { useApi } from '../hooks';
import { Empty, ErrorNote, Loading } from './common';

/**
 * Stöbern von der Suchseite aus: Predigten nach Bibelbuch (in Bibel-Reihenfolge) und nach Sprecher. Grundlage sind
 * die Bibelstellen und Sprecher, die das Regelwerk je Titel erkennt.
 */

interface Book {
  name: string;
  testament: 'at' | 'nt';
  count: number;
}

export const bookUrl = (name: string) => `/stoebern/bibel/${encodeURIComponent(name)}`;
export const speakerUrl = (name: string) => `/stoebern/sprecher/${encodeURIComponent(name)}`;

export function BibleBooks() {
  const { data, error } = useApi<{ items: Book[] }>('/api/browse/books');
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  const testaments = [
    ['at', 'Altes Testament'],
    ['nt', 'Neues Testament'],
  ] as const;
  return (
    <div class="page">
      <span class="eyebrow">
        <a href="/suche">Stöbern</a>
      </span>
      <h1 class="page-title">Nach Bibelbuch</h1>
      {data.items.length === 0 && (
        <Empty title="Noch keine Bibelstellen">
          Sobald Predigten eine Bibelstelle im Namen tragen, z. B. „Predigt - Psalm 23 - Meier“, erscheinen hier die Bücher.
        </Empty>
      )}
      {testaments.map(([key, label]) => {
        const books = data.items.filter((book) => book.testament === key);
        if (!books.length) return null;
        return (
          <section key={key} class="shelf">
            <div class="section-head">
              <h2>{label}</h2>
            </div>
            <ul class="artist-list">
              {books.map((book) => (
                <li key={book.name}>
                  <a href={bookUrl(book.name)}>
                    <span class="avatar avatar-book" aria-hidden="true">
                      <Icon name="book" size={20} />
                    </span>
                    <span class="artist-text">
                      <span class="artist-name">{book.name}</span>
                      <span class="artist-sub">{plural(book.count, 'Aufnahme', 'Aufnahmen')}</span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function BibleBook({ name }: { name: string }) {
  const { data, error } = useApi<{ book: Book; items: Track[] }>(`/api/browse/books/${encodeURIComponent(name)}`);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <div class="page">
      <span class="eyebrow">
        <a href="/stoebern/bibel">Nach Bibelbuch · {data.book.testament === 'at' ? 'Altes Testament' : 'Neues Testament'}</a>
      </span>
      <h1 class="page-title">{data.book.name}</h1>
      <p class="count">{plural(data.items.length, 'Aufnahme', 'Aufnahmen')}, neueste zuerst</p>
      <TrackList tracks={data.items} />
    </div>
  );
}

interface Speaker {
  name: string;
  count: number;
}

export function Speakers() {
  const { data, error } = useApi<{ items: Speaker[] }>('/api/browse/speakers');
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  return (
    <div class="page">
      <span class="eyebrow">
        <a href="/suche">Stöbern</a>
      </span>
      <h1 class="page-title">Nach Sprecher</h1>
      {data.items.length === 0 && (
        <Empty title="Noch keine Sprecher">Sprecher kommen aus den Dateinamen („Predigt - Titel - Name“) oder aus der Verwaltung.</Empty>
      )}
      <ul class="artist-list">
        {data.items.map((speaker) => (
          <li key={speaker.name}>
            <a href={speakerUrl(speaker.name)}>
              <span class="avatar" style={{ '--hue': hashHue(speaker.name) }} aria-hidden="true">
                {initials(speaker.name)}
              </span>
              <span class="artist-text">
                <span class="artist-name">{speaker.name}</span>
                <span class="artist-sub">{plural(speaker.count, 'Aufnahme', 'Aufnahmen')}</span>
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SpeakerPage({ name }: { name: string }) {
  const { data, error } = useApi<{ name: string; items: Track[] }>(`/api/browse/speakers/${encodeURIComponent(name)}`);
  if (error) return <ErrorNote message={error} />;
  if (!data) return <Loading />;
  // Schreibweise wie in den Titeln, nicht wie in der Adresse
  const shown = data.items[0]?.speaker ?? name;
  return (
    <div class="page">
      <span class="eyebrow">
        <a href="/stoebern/sprecher">Nach Sprecher</a>
      </span>
      <h1 class="page-title">{shown}</h1>
      {data.items.length === 0 ? (
        <Empty title="Keine Aufnahmen">Zu diesem Namen gibt es keine Aufnahmen.</Empty>
      ) : (
        <>
          <p class="count">{plural(data.items.length, 'Aufnahme', 'Aufnahmen')}, neueste zuerst</p>
          <TrackList tracks={data.items} />
        </>
      )}
    </div>
  );
}
