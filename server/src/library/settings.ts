/**
 * Einstellungen für Albumbildung und Namen (Verwaltung → Zuordnung, Abschnitt „Albumbildung und Namen“).
 * Sie stehen im Regelwerk (structure.ts) und gelten für den Scan, die Zuordnung und die Anzeige.
 *
 * Die gerade gültigen Werte hält dieses Modul, damit Hilfsfunktionen wie albumFolderOf oder findPassage sie
 * ohne Datenbank kennen. structure.ts setzt sie beim Öffnen der Datenbank, beim Speichern und vor jedem Neuaufbau.
 */
export interface LibrarySettings {
  /** Unterordner mit Nummer, die zum Album darüber zählen: "CD 1", "Disc 2", "Seite A" nicht (keine Zahl) */
  discFolders: string[];
  /** Unterordner eines Ordners mit Datum ("2026-09-27/Predigt") gehören zu dessen Album */
  mergeDatedSubfolders: boolean;
  /** Ordner ohne Datum, in dem die meisten Dateien ein Datum im Namen tragen: je Datum ein eigenes Album */
  splitByFileDate: boolean;
  /** Musik und Sonstiges: Vorlage für den Namen des Albums */
  albumTitle: string;
  /** Musik und Sonstiges: Vorlage für den Titel */
  trackTitle: string;
  /** Name des Albums für Dateien direkt im Musikordner */
  looseTitle: string;
  /** Ohne passende Policy bekommen Titel ab so vielen Minuten den Predigt-Player */
  sermonMinutes: number;
  /** Wörter vor einer Bibelstelle im Dateinamen, die wegfallen: "Text_Richter 7,1-4" -> "Richter 7,1-4" */
  passagePrefixes: string[];
  /** Weitere Schreibweisen von Bibelbüchern, die als Bibelstelle erkannt werden ("Kollosser") */
  bookSpellings: string[];
  /** Übersetzung, in der ein Tipp auf eine Bibelstelle den Text bei bibleserver.com öffnet */
  bibleTranslation: string;
}

/** Übersetzungen bei bibleserver.com (Kürzel in der Adresse) */
export const BIBLE_TRANSLATIONS: Record<string, string> = {
  LUT: 'Luther 2017',
  ELB: 'Elberfelder',
  SLT: 'Schlachter 2000',
  HFA: 'Hoffnung für alle',
  NGU: 'Neue Genfer Übersetzung',
  EU: 'Einheitsübersetzung',
  GNB: 'Gute Nachricht',
  NLB: 'Neues Leben',
};

/** Platzhalter für Musik und Sonstiges */
export const LIBRARY_PLACEHOLDERS = ['ordner', 'jahr', 'titel', 'datei', 'nr'] as const;

export const DEFAULT_LIBRARY: LibrarySettings = {
  discFolders: ['CD', 'Disc', 'Disk', 'DVD', 'Seite', 'Side'],
  mergeDatedSubfolders: true,
  splitByFileDate: true,
  albumTitle: '{ordner}',
  trackTitle: '{titel}',
  looseTitle: 'Einzeltitel',
  sermonMinutes: 10,
  passagePrefixes: ['Text', 'Predigttext', 'Bibeltext'],
  bookSpellings: ['Kollosser'],
  bibleTranslation: 'LUT',
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternatives = (words: string[]) =>
  [...words].sort((a, b) => b.length - a.length).map((word) => escape(word).replace(/\s+/g, '\\s+')).join('|');

function compile(settings: LibrarySettings) {
  const disc = alternatives(settings.discFolders);
  const prefix = alternatives(settings.passagePrefixes);
  return {
    settings,
    discFolder: disc ? new RegExp(`^(?:${disc})[\\s._-]*(\\d{1,2})$`, 'i') : undefined,
    /** "Text_Richter 7" am Anfang */
    leadingPrefix: prefix ? new RegExp(`^\\s*(?:${prefix})_\\s*`, 'i') : undefined,
    /** "Bergpredigt Text_Matthäus 7" mittendrin */
    innerPrefix: prefix ? new RegExp(`^(.+?)\\s+(?:${prefix})_\\s*(.+)$`, 'i') : undefined,
  };
}

let current = compile(DEFAULT_LIBRARY);
const listeners = new Set<() => void>();

/** Gültige Einstellungen setzen; Module mit abgeleiteten Werten (Bibelbücher) rechnen neu. */
export function useLibrarySettings(settings: LibrarySettings): void {
  if (settings === current.settings) return;
  current = compile(settings);
  for (const listener of listeners) listener();
}

export const librarySettings = (): LibrarySettings => current.settings;
export const compiledLibrary = () => current;

/** Für Module, die aus den Einstellungen etwas vorberechnen */
export function onLibrarySettings(listener: () => void): void {
  listeners.add(listener);
}

/** Predigt-Player ohne Policy ab dieser Länge (Sekunden) */
export const sermonSeconds = () => current.settings.sermonMinutes * 60;
