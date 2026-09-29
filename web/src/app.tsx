import { useEffect, useState } from 'preact/hooks';
import { Admin } from './admin/Admin';
import { NowPlaying } from './components/NowPlaying';
import { Sidebar, TabBar } from './components/Nav';
import { PlayerBar } from './components/PlayerBar';
import { Album } from './pages/Album';
import { Albums } from './pages/Albums';
import { Artist } from './pages/Artist';
import { Artists } from './pages/Artists';
import { Empty } from './pages/common';
import { Home } from './pages/Home';
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
  if (path === '/warteschlange') return <QueuePage />;
  if (path === '/admin' || path.startsWith('/admin/')) return <Admin location={location} />;
  const album = match('/album/:id', path);
  if (album && /^\d+$/.test(album.id!)) return <Album id={Number(album.id)} />;
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

export function App() {
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
