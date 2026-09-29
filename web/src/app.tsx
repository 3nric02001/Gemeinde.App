import { useEffect, useState } from 'preact/hooks';
import { Admin } from './admin/Admin';
import { loadAuth, useAuth } from './auth';
import { NowPlaying } from './components/NowPlaying';
import { Sidebar, TabBar } from './components/Nav';
import { PlayerBar } from './components/PlayerBar';
import { Album } from './pages/Album';
import { Albums } from './pages/Albums';
import { Artist } from './pages/Artist';
import { Artists } from './pages/Artists';
import { Category, CategoryEntry } from './pages/Category';
import { DateFolder } from './pages/DateFolder';
import { Dates } from './pages/Dates';
import { Empty, Loading } from './pages/common';
import { Home } from './pages/Home';
import { Login } from './pages/Login';
import { QueuePage } from './pages/Queue';
import { Search } from './pages/Search';
import { Tracks } from './pages/Tracks';
import { player } from './player';
import { match, navigate, onLinkClick, useLocation, type Location } from './router';

function Page({ location }: { location: Location }) {
  const { path, params } = location;
  if (path === '/') return <Home />;
  if (path === '/suche') return <Search params={params} />;
  if (path === '/alben') return <Albums params={params} />;
  if (path === '/titel') return <Tracks params={params} />;
  if (path === '/interpreten') return <Artists />;
  if (path === '/datum') return <Dates />;
  if (path === '/datum/ordner' && params.get('pfad')) return <DateFolder path={params.get('pfad')!} />;
  if (path === '/warteschlange') return <QueuePage />;
  if (path === '/admin' || path.startsWith('/admin/')) return <Admin location={location} />;
  const album = match('/album/:id', path);
  if (album && /^\d+$/.test(album.id!)) return <Album id={Number(album.id)} />;
  const category = match('/kategorie/:slug', path);
  if (category) return <Category key={category.slug} slug={category.slug!} />;
  const entry = match('/kategorie/:slug/:value', path);
  if (entry) return <CategoryEntry key={path} slug={entry.slug!} value={entry.value!} />;
  const artist = match('/interpret/:name', path);
  if (artist) return <Artist key={artist.name} name={artist.name!} />;
  return (
    <div class="page">
      <Empty title="Seite nicht gefunden">
        <a href="/">Zur Startseite</a>
      </Empty>
    </div>
  );
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)));
}

/** Ohne Anmeldung gibt es nur die Anmeldeseite; danach die App mit den Rechten der Rolle. */
export function App() {
  const auth = useAuth();
  useEffect(() => void loadAuth(), []);
  // Abgemeldet oder Sitzung abgelaufen: nicht im Hintergrund weiterspielen.
  useEffect(() => {
    if (auth.user === null && player.getState().playing) player.toggle();
  }, [auth.user]);

  if (auth.user === undefined) return <Loading />;
  if (auth.user === null) return <Login />;
  return <Shell />;
}

function Shell() {
  const location = useLocation();
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    // Tastatur: Leertaste spielt/pausiert, "/" springt in die Suche.
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === ' ' && !(event.target instanceof HTMLButtonElement)) {
        event.preventDefault();
        player.toggle();
      } else if (event.key === '/') {
        event.preventDefault();
        navigate('/suche');
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setExpanded(false), [location.path]);

  return (
    <div class="shell" onClick={onLinkClick}>
      <Sidebar path={location.path} />
      <main class="main" id="main">
        <Page key={location.path} location={location} />
      </main>
      <PlayerBar onExpand={() => setExpanded(true)} />
      <TabBar path={location.path} />
      {expanded && <NowPlaying onClose={() => setExpanded(false)} />}
    </div>
  );
}
