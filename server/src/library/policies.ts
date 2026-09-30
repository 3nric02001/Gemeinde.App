import { foldValue } from './text.js';

/**
 * Policies: "Wenn … dann …"-Regeln im Regelwerk (Verwaltung → Zuordnung), z. B.
 *
 *   Wenn Art ist genau „Gottesdienst“ und Inhalt ist genau „Predigt“
 *   dann gilt als Predigt und spielt im Predigt-Player
 *
 * Die Liste gilt von oben nach unten; für jede Wirkung entscheidet die erste passende Policy, die sie setzt.
 * Der Inhalt wird zuerst entschieden: Bedingungen auf "Inhalt" sehen bei Predigt und Player schon den gesetzten Inhalt.
 * Dieselben Bedingungen (ohne Inhalt, Art und Dauer) bestimmen in "Art bestimmen" die Art eines Albumordners.
 */

export const POLICY_FIELDS = ['title', 'content', 'kind', 'artist', 'album', 'genre', 'folder', 'path', 'duration'] as const;
export const POLICY_OPS = ['contains', 'not_contains', 'starts', 'equals', 'at_least', 'less_than'] as const;
/**
 * Felder für "Art bestimmen": Pfad und Tags der Dateien. Inhalt und Titel aus dem Dateinamen stehen noch nicht fest,
 * denn die Art bestimmt erst, wie Dateinamen gelesen werden.
 */
export const KIND_FIELDS = ['folder', 'path', 'title', 'artist', 'album', 'genre'] as const;
const NUMBER_OPS = new Set<PolicyOp>(['at_least', 'less_than']);
export const MAX_POLICIES = 50;
const MAX_DEPTH = 4;
const MAX_CONDITIONS = 30;

export type PolicyField = (typeof POLICY_FIELDS)[number];
export type PolicyOp = (typeof POLICY_OPS)[number];
export type Player = 'sermon' | 'music';

export interface PolicyLeaf {
  field: PolicyField;
  op: PolicyOp;
  value: string;
}

/** "all" = UND, "any" = ODER; beliebig verschachtelbar */
export interface PolicyGroup {
  match: 'all' | 'any';
  conditions: PolicyCondition[];
}

export type PolicyCondition = PolicyLeaf | PolicyGroup;

export interface Policy {
  name: string;
  enabled: boolean;
  when: PolicyCondition;
  /** true: liefert Sprecher und Bibelstelle; false: ausdrücklich keine Predigt; fehlt: nicht entscheiden */
  sermon?: boolean;
  /** Predigt-Player (Sprünge, Tempo, Weiterhören) oder Musik-Player; fehlt: nicht entscheiden */
  player?: Player;
  /** Inhalt setzen ("Predigt", "Lied"), statt ihn aus dem Dateinamen zu lesen; fehlt: nicht entscheiden */
  content?: string;
}

export class PolicyError extends Error {}

export const isPolicyGroup = (condition: PolicyCondition): condition is PolicyGroup => 'match' in condition;

/** Prüft eine Bedingung und bringt sie in Normalform (Gruppen mit einem Eintrag aufgelöst). */
export function parsePolicyCondition(input: unknown, fields: readonly PolicyField[] = POLICY_FIELDS, label = 'Bedingung'): PolicyCondition {
  let count = 0;
  const walk = (node: unknown, depth: number): PolicyCondition => {
    if (!node || typeof node !== 'object') throw new PolicyError(`${label}: ungültig`);
    const obj = node as Record<string, unknown>;
    if ('match' in obj || 'conditions' in obj) {
      if (depth >= MAX_DEPTH) throw new PolicyError(`${label}: höchstens ${MAX_DEPTH} Ebenen verschachteln`);
      if (obj.match !== 'all' && obj.match !== 'any') throw new PolicyError(`${label}: Gruppe braucht UND oder ODER`);
      if (!Array.isArray(obj.conditions) || obj.conditions.length === 0) throw new PolicyError(`${label}: leere Gruppe`);
      const conditions = obj.conditions.map((child) => walk(child, depth + 1));
      return conditions.length === 1 ? conditions[0]! : { match: obj.match, conditions };
    }
    if (++count > MAX_CONDITIONS) throw new PolicyError(`${label}: höchstens ${MAX_CONDITIONS} Bedingungen`);
    const field = obj.field as PolicyField;
    if (!fields.includes(field)) throw new PolicyError(`${label}: unbekanntes Feld`);
    const op = (obj.op ?? (field === 'duration' ? 'at_least' : 'contains')) as PolicyOp;
    if (!POLICY_OPS.includes(op)) throw new PolicyError(`${label}: unbekannter Vergleich`);
    if ((field === 'duration') !== NUMBER_OPS.has(op)) {
      throw new PolicyError(field === 'duration' ? `${label}: Dauer braucht „mindestens“ oder „kürzer als“` : `${label}: „mindestens“ und „kürzer als“ gehen nur bei der Dauer`);
    }
    const value = typeof obj.value === 'number' ? String(obj.value) : typeof obj.value === 'string' ? obj.value.trim() : '';
    if (!value) throw new PolicyError(`${label}: Jede Bedingung braucht einen Wert`);
    if (value.length > 200) throw new PolicyError(`${label}: Wert ist zu lang`);
    if (field === 'duration') {
      const minutes = Number(value.replace(',', '.'));
      if (!Number.isFinite(minutes) || minutes < 0 || minutes > 100_000) throw new PolicyError(`${label}: Dauer in Minuten angeben`);
      return { field, op, value: String(minutes) };
    }
    return { field, op, value };
  };
  return walk(input, 0);
}

export function parsePolicies(input: unknown): Policy[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new PolicyError('Policies: Liste erwartet');
  if (input.length > MAX_POLICIES) throw new PolicyError(`Höchstens ${MAX_POLICIES} Policies`);
  return input.map((raw, index): Policy => {
    if (!raw || typeof raw !== 'object') throw new PolicyError('Ungültige Policy');
    const p = raw as Record<string, unknown>;
    const name = typeof p.name === 'string' ? p.name.trim().slice(0, 80) : '';
    const label = `Policy ${name ? `„${name}“` : index + 1}`;
    const policy: Policy = { name: name || `Policy ${index + 1}`, enabled: p.enabled !== false, when: parsePolicyCondition(p.when, POLICY_FIELDS, label) };
    if (typeof p.sermon === 'boolean') policy.sermon = p.sermon;
    else if (p.sermon !== undefined && p.sermon !== null) throw new PolicyError(`${label}: „gilt als Predigt“ ist ja oder nein`);
    if (p.player === 'sermon' || p.player === 'music') policy.player = p.player;
    else if (p.player !== undefined && p.player !== null && p.player !== '') throw new PolicyError(`${label}: unbekannter Player`);
    if (typeof p.content === 'string' && p.content.trim()) {
      if (p.content.trim().length > 60) throw new PolicyError(`${label}: Inhalt ist zu lang`);
      policy.content = p.content.trim();
    } else if (p.content !== undefined && p.content !== null && p.content !== '') throw new PolicyError(`${label}: Inhalt ist Text`);
    if (policy.sermon === undefined && policy.player === undefined && policy.content === undefined) {
      throw new PolicyError(`${label} bewirkt nichts`);
    }
    return policy;
  });
}

// ---------- Auswerten ----------

/** Was über eine Aufnahme bekannt ist; fehlende Werte zählen als leer. */
export interface PolicySubject {
  title?: string | null;
  content?: string | null;
  kind?: string | null;
  artist?: string | null;
  album?: string | null;
  genre?: string | null;
  /** Pfad der Datei oder des Ordners */
  path?: string | null;
  /** Sekunden */
  duration?: number | null;
}

export interface Decision {
  sermon?: boolean;
  player?: Player;
  /** Name der Policy, die "gilt als Predigt" entschieden hat */
  sermonBy?: string;
  /** Name der Policy, die den Player entschieden hat */
  playerBy?: string;
  /** Inhalt laut Policy (geht dem Dateinamen vor) */
  content?: string;
  contentBy?: string;
}

/** Korrektur je Titel aus der Verwaltung; null: nach den Policies */
export interface ManualDecision {
  sermon: boolean | null;
  player: Player | null;
}

/** Groß-/Kleinschreibung, Umlaute, Akzente und Satzzeichen spielen keine Rolle (wie bei den Playlist-Regeln). */
const fold = (value: string) => foldValue(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function compareText(text: string, op: PolicyOp, needle: string): boolean {
  switch (op) {
    case 'equals':
      return text === needle;
    case 'starts':
      return text.startsWith(needle);
    case 'not_contains':
      return !text.includes(needle);
    default:
      return text.includes(needle);
  }
}

export function policyMatcher(condition: PolicyCondition): (subject: PolicySubject) => boolean {
  if (isPolicyGroup(condition)) {
    const children = condition.conditions.map(policyMatcher);
    return condition.match === 'all' ? (s) => children.every((m) => m(s)) : (s) => children.some((m) => m(s));
  }
  const { field, op, value } = condition;
  if (field === 'duration') {
    const seconds = Number(value) * 60;
    // Unbekannte Dauer passt auf keinen Vergleich
    return (s) => s.duration != null && (op === 'at_least' ? s.duration >= seconds : s.duration < seconds);
  }
  const needle = fold(value);
  if (field === 'folder') {
    // Ein Ordner im Pfad: "ist genau" passt auf einen ganzen Ordnernamen, "enthält nicht" auf keinen
    return (s) => {
      const segments = (s.path ?? '').split('/').slice(0, -1).map(fold).filter(Boolean);
      if (op === 'not_contains') return !segments.some((seg) => seg.includes(needle));
      return segments.some((seg) => compareText(seg, op, needle));
    };
  }
  return (s) => compareText(fold(String(s[field] ?? '')), op, needle);
}

/** Wertet die Policies in ihrer Reihenfolge aus: Je Wirkung gilt die erste passende, die sie setzt. */
export function compilePolicies(policies: Policy[]): (subject: PolicySubject) => Decision {
  const active = policies.filter((p) => p.enabled).map((p) => ({ policy: p, matches: policyMatcher(p.when) }));
  const contentPolicies = active.filter(({ policy }) => policy.content !== undefined);
  return (input) => {
    const decision: Decision = {};
    // Zuerst der Inhalt; danach sehen Predigt und Player den gesetzten Inhalt
    const setsContent = contentPolicies.find(({ matches }) => matches(input));
    if (setsContent) {
      decision.content = setsContent.policy.content;
      decision.contentBy = setsContent.policy.name;
    }
    const subject = decision.content !== undefined ? { ...input, content: decision.content } : input;
    for (const { policy, matches } of active) {
      if (decision.sermon !== undefined && decision.player !== undefined) break;
      const wantsSermon = decision.sermon === undefined && policy.sermon !== undefined;
      const wantsPlayer = decision.player === undefined && policy.player !== undefined;
      if ((!wantsSermon && !wantsPlayer) || !matches(subject)) continue;
      if (wantsSermon) {
        decision.sermon = policy.sermon;
        decision.sermonBy = policy.name;
      }
      if (wantsPlayer) {
        decision.player = policy.player;
        decision.playerBy = policy.name;
      }
    }
    return decision;
  };
}

/** Bedingung "Ordner heißt …" aus dem früheren Feld "Erkennen am Ordner" */
export const folderCondition = (folder: string): PolicyCondition => ({ field: 'folder', op: 'equals', value: folder });
