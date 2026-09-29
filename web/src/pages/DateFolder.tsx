import { useEffect } from 'preact/hooks';
import { query } from '../api';
import { useApi } from '../hooks';
import { navigate } from '../router';
import { ErrorNote, Loading } from './common';

/**
 * Ältere Links auf einen Datumsordner (/datum/ordner?pfad=…): Gottesdienste sind jetzt Alben,
 * daher geht es zum passenden Album weiter.
 */
export function DateFolder({ path }: { path: string }) {
  const { data, error } = useApi<{ albumId: number }>(`/api/dates/folder${query({ path })}`);
  useEffect(() => {
    if (data) navigate(`/album/${data.albumId}`, { replace: true });
  }, [data]);
  if (error) return <ErrorNote message={error} />;
  return <Loading />;
}
