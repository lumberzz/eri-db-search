import type { SearchHit } from "../types/searchHit.js";
import { SEARCH_CACHE_MAX } from "../config.js";

type Entry = {
  items: SearchHit[];
  count: number;
  at: number;
};

let generation = 0;

export function bumpSearchCacheGeneration(): void {
  generation += 1;
  store.clear();
  order = [];
}

export function currentSearchCacheGeneration(): number {
  return generation;
}

const store = new Map<string, Entry>();
let order: string[] = [];

function touch(key: string): void {
  const i = order.indexOf(key);
  if (i >= 0) order.splice(i, 1);
  order.push(key);
  while (order.length > SEARCH_CACHE_MAX) {
    const drop = order.shift();
    if (drop) store.delete(drop);
  }
}

export function searchCacheGet(
  gen: number,
  key: string
): { items: SearchHit[]; count: number } | null {
  if (gen !== generation) return null;
  const e = store.get(key);
  if (!e) return null;
  touch(key);
  return { items: e.items, count: e.count };
}

export function searchCacheSet(
  gen: number,
  key: string,
  items: SearchHit[],
  count: number
): void {
  if (gen !== generation) return;
  store.set(key, { items, count, at: Date.now() });
  touch(key);
}

export function searchCacheStats(): { size: number; generation: number } {
  return { size: store.size, generation };
}
