import type { DB } from '../../src/db.js';
import { DEFAULT_STRUCTURE, saveStructure } from '../../src/library/structure.js';

/**
 * Regelwerk mit "Tags bevorzugen" für Tests, deren Dateien sauber getaggt sind und die anderes prüfen
 * als die Zuordnung (eigene Alben, Beliebtheit, Suche). Ohne das gälte der Dateiname.
 */
export function preferTags(db: DB): void {
  saveStructure(db, { ...DEFAULT_STRUCTURE, kinds: DEFAULT_STRUCTURE.kinds.map((kind) => ({ ...kind, preferTags: true })) });
}
