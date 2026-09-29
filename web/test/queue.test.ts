import { describe, expect, it } from 'vitest';
import { Queue } from '../src/queue';

type Item = { id: number };
const items = (n: number): Item[] => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
const ids = (q: Queue<Item>) => q.items.map((i) => i.id);
// Deterministischer "Zufall", damit die Tests stabil sind
const seeded = () => {
  let x = 42;
  return () => ((x = (x * 16807) % 2147483647) / 2147483647);
};

describe('Warteschlange', () => {
  it('spielt der Reihe nach und hört am Ende auf', () => {
    const q = new Queue<Item>();
    q.set(items(3), 1);
    expect(q.current?.id).toBe(2);
    expect(q.next()?.id).toBe(3);
    expect(q.next()).toBeUndefined();
    expect(q.current?.id).toBe(3);
  });

  it('wiederholt alles oder einen Titel', () => {
    const q = new Queue<Item>();
    q.set(items(2), 1);
    q.cycleRepeat(); // alle
    expect(q.next()?.id).toBe(1);
    q.cycleRepeat(); // einen
    expect(q.next(true)?.id).toBe(1);
    // Manuelles Weiter springt trotzdem zum nächsten
    expect(q.next(false)?.id).toBe(2);
    q.cycleRepeat();
    expect(q.repeat).toBe('off');
  });

  it('mischt ab dem aktuellen Titel und stellt die Reihenfolge wieder her', () => {
    const q = new Queue<Item>(seeded());
    q.set(items(10), 3);
    q.toggleShuffle();
    expect(q.current?.id).toBe(4);
    expect(q.index).toBe(0);
    expect(ids(q).sort((a, b) => a - b)).toEqual(items(10).map((i) => i.id));
    expect(ids(q)).not.toEqual([4, 1, 2, 3, 5, 6, 7, 8, 9, 10]);
    q.next();
    const now = q.current!.id;
    q.toggleShuffle();
    expect(ids(q)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(q.current?.id).toBe(now);
  });

  it('startet gemischt mit dem angeklickten Titel', () => {
    const q = new Queue<Item>(seeded());
    q.set(items(5), 2, true);
    expect(q.current?.id).toBe(3);
    expect(q.items).toHaveLength(5);
  });

  it('fügt als Nächstes und am Ende ein, auch denselben Titel mehrfach', () => {
    const q = new Queue<Item>();
    q.set(items(3), 0);
    const extra = { id: 9 };
    q.playNext([extra]);
    q.append([{ id: 9 }]);
    expect(ids(q)).toEqual([1, 9, 2, 3, 9]);
    q.remove(4);
    expect(ids(q)).toEqual([1, 9, 2, 3]);
    q.remove(0); // aktueller Titel bleibt
    expect(ids(q)).toEqual([1, 9, 2, 3]);
  });

  it('behält den aktuellen Titel beim Entfernen davor und beim Leeren', () => {
    const q = new Queue<Item>();
    q.set(items(5), 2);
    q.remove(0);
    expect(q.current?.id).toBe(3);
    q.clearUpcoming();
    expect(ids(q)).toEqual([2, 3]);
    expect(q.upcoming).toEqual([]);
  });

  it('springt mit Zurück an den Anfang oder bei Wiederholen ans Ende', () => {
    const q = new Queue<Item>();
    q.set(items(3), 0);
    expect(q.previous()?.id).toBe(1);
    q.cycleRepeat();
    expect(q.previous()?.id).toBe(3);
  });

  it('lässt sich speichern und wiederherstellen', () => {
    const q = new Queue<Item>();
    q.set(items(4), 2);
    q.cycleRepeat();
    const copy = new Queue<Item>();
    copy.restore(JSON.parse(JSON.stringify(q.snapshot())));
    expect(copy.current?.id).toBe(3);
    expect(copy.repeat).toBe('all');
  });
});
