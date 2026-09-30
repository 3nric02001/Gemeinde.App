export type RepeatMode = 'off' | 'all' | 'one';

export interface QueueState<T> {
  items: T[];
  index: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

function shuffled<T>(items: T[], random: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

/**
 * Warteschlange wie bei Spotify/Apple Music: Zufallsmodus mischt alles nach dem
 * aktuellen Titel und stellt beim Ausschalten die ursprüngliche Reihenfolge wieder her.
 */
export class Queue<T extends object> {
  items: T[] = [];
  index = -1;
  shuffle = false;
  repeat: RepeatMode = 'off';
  /** Reihenfolge vor dem Mischen */
  private original: T[] = [];

  constructor(private readonly random: () => number = Math.random) {}

  get current(): T | undefined {
    return this.items[this.index];
  }

  get upcoming(): T[] {
    return this.items.slice(this.index + 1);
  }

  /** Ohne `start` beginnt die gemischte Liste mit einem zufälligen Titel, die geordnete mit dem ersten. */
  set(items: T[], start?: number, shuffle = this.shuffle): void {
    this.original = [...items];
    this.shuffle = shuffle;
    if (shuffle && items.length && start === undefined) {
      this.items = shuffled(items, this.random);
      this.index = 0;
    } else if (shuffle && items.length) {
      const first = items[Math.min(Math.max(start!, 0), items.length - 1)]!;
      this.items = [first, ...shuffled(items.filter((item) => item !== first), this.random)];
      this.index = 0;
    } else {
      this.items = [...items];
      this.index = items.length ? Math.min(Math.max(start ?? 0, 0), items.length - 1) : -1;
    }
  }

  /** Nächster Titel; `auto` heißt, der vorige ist zu Ende gelaufen (Wiederholen eines Titels greift nur dann). */
  next(auto = false): T | undefined {
    if (!this.items.length) return undefined;
    if (auto && this.repeat === 'one') return this.current;
    if (this.index < this.items.length - 1) {
      this.index++;
      return this.current;
    }
    if (this.repeat !== 'off') {
      this.index = 0;
      return this.current;
    }
    return undefined;
  }

  /** Was `next(auto)` liefern würde, ohne weiterzuschalten (zum Vorladen) */
  peekNext(auto = true): T | undefined {
    if (!this.items.length) return undefined;
    if (auto && this.repeat === 'one') return this.current;
    if (this.index < this.items.length - 1) return this.items[this.index + 1];
    return this.repeat !== 'off' ? this.items[0] : undefined;
  }

  previous(): T | undefined {
    if (!this.items.length) return undefined;
    if (this.index > 0) this.index--;
    else if (this.repeat === 'all') this.index = this.items.length - 1;
    return this.current;
  }

  jump(index: number): T | undefined {
    if (index < 0 || index >= this.items.length) return undefined;
    this.index = index;
    return this.current;
  }

  toggleShuffle(): void {
    const current = this.current;
    if (this.shuffle) {
      this.shuffle = false;
      // Hinzugefügte Titel, die es im Original nicht gab, hinten anhängen.
      const known = new Set(this.original);
      this.items = [...this.original, ...this.items.filter((item) => !known.has(item))];
      this.index = current ? this.items.indexOf(current) : -1;
    } else {
      this.shuffle = true;
      this.original = [...this.items];
      const rest = this.items.filter((item) => item !== current);
      this.items = current ? [current, ...shuffled(rest, this.random)] : shuffled(rest, this.random);
      this.index = current ? 0 : -1;
    }
  }

  cycleRepeat(): RepeatMode {
    this.repeat = this.repeat === 'off' ? 'all' : this.repeat === 'all' ? 'one' : 'off';
    return this.repeat;
  }

  /** Als Nächstes spielen */
  playNext(items: T[]): void {
    this.items.splice(this.index + 1, 0, ...items);
    this.insertOriginal(items, this.current);
    if (this.index < 0 && this.items.length) this.index = 0;
  }

  /** Ans Ende der Warteschlange */
  append(items: T[]): void {
    this.items.push(...items);
    this.original.push(...items);
    if (this.index < 0 && this.items.length) this.index = 0;
  }

  remove(index: number): void {
    if (index < 0 || index >= this.items.length || index === this.index) return;
    const [removed] = this.items.splice(index, 1);
    this.original = this.original.filter((item) => item !== removed);
    if (index < this.index) this.index--;
  }

  clearUpcoming(): void {
    const keep = new Set(this.items.slice(0, this.index + 1));
    this.items = this.items.slice(0, this.index + 1);
    this.original = this.original.filter((item) => keep.has(item));
  }

  snapshot(): QueueState<T> {
    return { items: [...this.items], index: this.index, shuffle: this.shuffle, repeat: this.repeat };
  }

  restore(state: QueueState<T>): void {
    this.items = [...state.items];
    this.original = [...state.items];
    this.index = state.items.length ? Math.min(Math.max(state.index, 0), state.items.length - 1) : -1;
    this.shuffle = state.shuffle;
    this.repeat = state.repeat;
  }

  private insertOriginal(items: T[], after: T | undefined): void {
    const at = after ? this.original.indexOf(after) + 1 : 0;
    this.original.splice(at, 0, ...items);
  }
}
