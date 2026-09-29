import { useEffect, useRef, useState } from 'preact/hooks';
import { getJson, peekJson, type CategoryInfo, type Page } from './api';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
}

export function useApi<T>(url: string | undefined): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>(() => ({
    data: url ? peekJson<T>(url) : undefined,
    error: undefined,
    loading: Boolean(url),
  }));
  useEffect(() => {
    if (!url) {
      setState({ data: undefined, error: undefined, loading: false });
      return;
    }
    const controller = new AbortController();
    setState((prev) => ({ data: peekJson<T>(url) ?? prev.data, error: undefined, loading: true }));
    getJson<T>(url, controller.signal)
      .then((data) => setState({ data, error: undefined, loading: false }))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ data: undefined, error: error.message, loading: false });
      });
    return () => controller.abort();
  }, [url]);
  return state;
}

/** Endlos-Liste: lädt weitere Seiten, sobald `sentinel` sichtbar wird. */
export function usePaged<T>(baseUrl: string, pageSize = 60) {
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const state = useRef({ baseUrl, offset: 0, busy: false, done: false });

  const loadMore = async () => {
    const s = state.current;
    if (s.busy || s.done) return;
    s.busy = true;
    setLoading(true);
    const url = `${s.baseUrl}${s.baseUrl.includes('?') ? '&' : '?'}limit=${pageSize}&offset=${s.offset}`;
    try {
      const page = await getJson<Page<T>>(url);
      if (state.current !== s) return;
      s.offset += page.items.length;
      s.done = s.offset >= page.total || page.items.length === 0;
      setItems((prev) => [...prev, ...page.items]);
      setTotal(page.total);
      setError(undefined);
    } catch (e) {
      if (state.current === s) {
        setError((e as Error).message);
        s.done = true;
      }
    } finally {
      s.busy = false;
      if (state.current === s) setLoading(false);
    }
  };

  useEffect(() => {
    state.current = { baseUrl, offset: 0, busy: false, done: false };
    setItems([]);
    setTotal(undefined);
    void loadMore();
  }, [baseUrl]);

  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void loadMore();
    }, { rootMargin: '600px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, [baseUrl, items.length]);

  return { items, total, loading, error, sentinel, done: state.current.done };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Die Verwaltung meldet damit geänderte Kategorien, damit das Menü sofort nachzieht. */
export const CATEGORIES_CHANGED = 'gemeinde:categories';

/** Kategorien fürs Menü; lädt beim Seitenwechsel (Cache 60 s) und nach Änderungen in der Verwaltung neu. */
export function useCategories(path?: string): CategoryInfo[] {
  const url = '/api/categories';
  const [items, setItems] = useState<CategoryInfo[]>(() => peekJson<{ items: CategoryInfo[] }>(url)?.items ?? []);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(CATEGORIES_CHANGED, bump);
    return () => window.removeEventListener(CATEGORIES_CHANGED, bump);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    getJson<{ items: CategoryInfo[] }>(url, controller.signal)
      .then((data) => setItems(data.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, [path, version]);
  return items;
}
