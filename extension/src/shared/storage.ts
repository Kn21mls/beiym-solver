import browser from 'webextension-polyfill';
import type { Answer } from './types';

const CACHE_KEY = 'answer_cache';
const SESSION_KEY = 'api_session';
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_LIMIT = 200;

export interface Session {
  token: string;
  email: string;
}

export async function getSession(): Promise<Session | null> {
  const stored = await browser.storage.local.get(SESSION_KEY);
  const value = stored[SESSION_KEY];
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Session).token === 'string' &&
    typeof (value as Session).email === 'string'
  ) {
    return value as Session;
  }
  return null;
}

export async function setSession(session: Session): Promise<void> {
  await browser.storage.local.set({ [SESSION_KEY]: session });
}

export async function clearSession(): Promise<void> {
  await browser.storage.local.remove(SESSION_KEY);
}

type CacheEntry = { answer: Answer; ts: number };
type Cache = Record<string, CacheEntry>;

async function readCache(): Promise<Cache> {
  const stored = await browser.storage.local.get(CACHE_KEY);
  const value = stored[CACHE_KEY];
  return typeof value === 'object' && value !== null ? (value as Cache) : {};
}

export async function loadCached(key: string, now = Date.now()): Promise<Answer | null> {
  const cache = await readCache();
  const entry = cache[key];
  if (!entry || now - entry.ts > CACHE_TTL) return null;
  return entry.answer;
}

export async function saveCached(key: string, answer: Answer, now = Date.now()): Promise<void> {
  const cache = await readCache();
  cache[key] = { answer, ts: now };
  const entries = Object.entries(cache).sort((a, b) => b[1].ts - a[1].ts).slice(0, CACHE_LIMIT);
  await browser.storage.local.set({ [CACHE_KEY]: Object.fromEntries(entries) });
}

export async function clearCache(): Promise<void> {
  await browser.storage.local.remove(CACHE_KEY);
}
