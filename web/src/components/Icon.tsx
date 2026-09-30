const paths = {
  play: 'M8 5.5v13a1 1 0 0 0 1.5.86l11-6.5a1 1 0 0 0 0-1.72l-11-6.5A1 1 0 0 0 8 5.5Z',
  pause: 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z',
  next: 'M5 5.8v12.4a.8.8 0 0 0 1.2.7L15 13.4V18h2.5V6H15v4.6L6.2 5.1a.8.8 0 0 0-1.2.7Z',
  previous: 'M19 5.8v12.4a.8.8 0 0 1-1.2.7L9 13.4V18H6.5V6H9v4.6l8.8-5.5a.8.8 0 0 1 1.2.7Z',
  shuffle:
    'M16 4l4 3.5-4 3.5V8.5h-1.6c-1 0-1.9.5-2.5 1.3l-5 6.9A5 5 0 0 1 2.9 18.8H2v-2h.9c1 0 1.9-.5 2.5-1.3l5-6.9a5 5 0 0 1 4-2.1H16V4Zm0 9l4 3.5-4 3.5v-2.5h-1.6a5 5 0 0 1-4-2.1l-.5-.7 1.2-1.7 1 1.3c.5.8 1.4 1.2 2.3 1.2H16V13ZM2 5.2h.9a5 5 0 0 1 4 2.1l.6.8-1.2 1.7-1-1.3c-.5-.8-1.5-1.3-2.4-1.3H2v-2Z',
  repeat:
    'M17 2l4 3.5L17 9V6.5H7a2 2 0 0 0-2 2V11H3V8.5a4 4 0 0 1 4-4h10V2ZM7 22l-4-3.5L7 15v2.5h10a2 2 0 0 0 2-2V13h2v2.5a4 4 0 0 1-4 4H7V22Z',
  home: 'M12 3.2 3 10.4V20a1 1 0 0 0 1 1h5.5v-6h5v6H20a1 1 0 0 0 1-1v-9.6l-9-7.2Z',
  search:
    'M10.5 3a7.5 7.5 0 0 1 5.96 12.05l4.74 4.74-1.41 1.41-4.74-4.74A7.5 7.5 0 1 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z',
  albums: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  tracks:
    'M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7.3l-8 1.6v8.6A3.5 3.5 0 1 1 8 14.34V5.2L20 3Z',
  queue: 'M3 5h13v2H3zM3 10h13v2H3zM3 15h8v2H3zM15 14.5v6l5-3z',
  calendar:
    'M7 2h2v2h6V2h2v2h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2V2ZM5 9v10h14V9H5Zm2 2h4v4H7v-4Z',
  volume:
    'M4 9h3.5L12 5v14l-4.5-4H4V9Zm11.5-1.8a6 6 0 0 1 0 9.6l-1.2-1.6a4 4 0 0 0 0-6.4l1.2-1.6Zm2.4-3.2a10 10 0 0 1 0 16l-1.2-1.6a8 8 0 0 0 0-12.8L17.9 4Z',
  mute: 'M4 9h3.5L12 5v14l-4.5-4H4V9Zm11.3.1L17 10.8l1.7-1.7 1.4 1.4-1.7 1.7 1.7 1.7-1.4 1.4-1.7-1.7-1.7 1.7-1.4-1.4 1.7-1.7-1.7-1.7 1.4-1.4Z',
  back: 'M15.4 4.6 16.8 6l-6 6 6 6-1.4 1.4L8 12z',
  forward: 'M8.6 4.6 7.2 6l6 6-6 6 1.4 1.4L16 12z',
  edit: 'M4 16.6V20h3.4l9.9-9.9-3.4-3.4L4 16.6Zm15.7-9.2a1 1 0 0 0 0-1.4l-1.7-1.7a1 1 0 0 0-1.4 0l-1.5 1.5 3.4 3.4 1.2-1.8Z',
  down: 'M4.6 8.6 6 7.2l6 6 6-6 1.4 1.4L12 16z',
  close: 'm6.4 5 5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4z',
  more: 'M5 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Zm7 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z',
  cross: 'M10.5 2h3v6H19v3h-5.5v11h-3V11H5V8h5.5z',
  settings:
    'M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5-2.1-1.6ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z',
  tag: 'M3 4a1 1 0 0 1 1-1h7.6l9.4 9.4-8.6 8.6L3 11.6V4Zm4.5 1.8a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z',
  logout: 'M5 3h8v2H5v14h8v2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm11 4.6 4.4 4.4-4.4 4.4-1.4-1.4 2-2H9v-2h7.6l-2-2L16 7.6Z',
  heart:
    'M12 20.3 10.6 19C5.6 14.5 2.5 11.7 2.5 8.2 2.5 5.4 4.7 3.2 7.5 3.2c1.6 0 3.1.7 4.1 1.9l.4.5.4-.5a5.3 5.3 0 0 1 4.1-1.9c2.8 0 5 2.2 5 5 0 3.5-3.1 6.3-8.1 10.8L12 20.3Z',
  heartOutline:
    'M16.5 3.2c2.8 0 5 2.2 5 5 0 3.5-3.1 6.3-8.1 10.8L12 20.3 10.6 19C5.6 14.5 2.5 11.7 2.5 8.2c0-2.8 2.2-5 5-5 1.6 0 3.1.7 4.1 1.9l.4.5.4-.5a5.3 5.3 0 0 1 4.1-1.9Zm0 2c-1.2 0-2.3.6-3 1.5L12 8.5l-1.5-1.8c-.7-.9-1.8-1.5-3-1.5-1.7 0-3 1.3-3 3 0 2.6 2.6 5 7.5 9.4 4.9-4.4 7.5-6.8 7.5-9.4 0-1.7-1.3-3-3-3Z',
  user: 'M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9Zm0 11c4.4 0 8 2.2 8 5v2H4v-2c0-2.8 3.6-5 8-5Z',
  menu: 'M4 6h16v2H4zM4 11h16v2H4zM4 16h16v2H4z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3ZM5 18h14v2H5z',
  downloaded: 'M9.8 15.2 5.2 10.6l1.4-1.4 3.2 3.2 7.6-7.6 1.4 1.4-9 9ZM5 18h14v2H5z',
  textSize: 'M3 19 8.3 5h2.4L16 19h-2.3l-1.3-3.6H6.6L5.3 19H3Zm4.3-5.6h4.4L9.5 7.3l-2.2 6.1ZM17 19l2.6-7h1.6l2.6 7h-1.6l-.6-1.7h-2.4l-.6 1.7H17Zm2.6-3h1.6l-.8-2.4-.8 2.4Z',
  music: 'M20 3v12.5a3.5 3.5 0 1 1-2-3.16V7.3l-8 1.6v8.6A3.5 3.5 0 1 1 8 14.34V5.2L20 3Z',
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 24, class: className }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg class={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}

/** Kreispfeil mit Sekundenzahl: 15 s zurück bzw. 30 s vor */
export function SkipIcon({ seconds, size = 24 }: { seconds: number; size?: number }) {
  const back = seconds < 0;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={back ? 'M4.6 9.2A8 8 0 1 1 4 12' : 'M19.4 9.2A8 8 0 1 0 20 12'}
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
      />
      <path
        d={back ? 'M3.6 4.6v5h5' : 'M20.4 4.6v5h-5'}
        stroke="currentColor"
        stroke-width="1.9"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
      <text x="12" y="15.3" text-anchor="middle" font-size="8" font-weight="800" fill="currentColor">
        {Math.abs(seconds)}
      </text>
    </svg>
  );
}
