/* A10: cart (metamorphic) relations that held during a PASSING run are kept in
 * `.spike/relations.json`, keyed by host, and re-checked on every later run of
 * that host — "propose once, then run forever". Evidence-only unless
 * strictOracles gates it (the loop decides; this module is just storage).
 * A missing/corrupt file means "nothing saved", never a failed run. */

import fs from 'node:fs';
import path from 'node:path';
import { RELATIONS, type Relation, type RelationParams } from './metamorphic.js';

export interface StoredRelation {
  relation: string;
  params?: RelationParams;
  savedAt: string;
}
type Store = Record<string, StoredRelation[]>;

export const RELATIONS_FILE = path.join('.spike', 'relations.json');

export function hostKey(url: string): string | undefined {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

function readStore(root: string): Store {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(path.join(root, RELATIONS_FILE), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Store) : {};
  } catch {
    return {};
  }
}

/** Saved relations for this URL's host, resolved to library relations (an id
 * the library no longer knows is dropped). */
export function loadRelationsFor(url: string, root = process.cwd()): { relation: Relation; params?: RelationParams }[] {
  const host = hostKey(url);
  if (!host) return [];
  const byId = new Map(RELATIONS.map((r) => [r.id, r]));
  const out: { relation: Relation; params?: RelationParams }[] = [];
  for (const e of readStore(root)[host] ?? []) {
    const relation = byId.get(e.relation);
    if (relation) out.push({ relation, ...(e.params && { params: e.params }) });
  }
  return out;
}

/** Adds (never removes) relations for the host; returns the ids newly saved. */
export function saveRelationsFor(url: string, items: { id: string; params?: RelationParams }[], root = process.cwd()): string[] {
  const host = hostKey(url);
  if (!host || !items.length) return [];
  const store = readStore(root);
  const list = store[host] ?? [];
  const added: string[] = [];
  for (const it of items) {
    if (list.some((e) => e.relation === it.id)) continue;
    list.push({ relation: it.id, ...(it.params && { params: it.params }), savedAt: new Date().toISOString() });
    added.push(it.id);
  }
  if (!added.length) return [];
  store[host] = list;
  fs.mkdirSync(path.join(root, '.spike'), { recursive: true });
  fs.writeFileSync(path.join(root, RELATIONS_FILE), JSON.stringify(store, null, 2));
  return added;
}

export function savedRelationIds(url: string, root = process.cwd()): Set<string> {
  return new Set(loadRelationsFor(url, root).map((r) => r.relation.id));
}
