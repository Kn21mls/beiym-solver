import browser from 'webextension-polyfill';
import type { Selectors, Settings } from './types';

export const SETTINGS_KEY = 'settings';

export const DEFAULT_SELECTORS: Selectors = {
  root: '',
  question: '',
  options: '',
  input: '',
  submit: '',
  next: '',
  complete: '',
};

export const DEFAULT_SETTINGS: Settings = {
  api_url: 'http://127.0.0.1:8787',
  groq_model: 'qwen/qwen3.8-27b',
  url: 'https://beyim.ai/ru/ai/feed',
  max_questions: 30,
  min_confidence: 0.8,
  timeout: 180,
  thinking: false,
  transition_timeout: 15,
  num_predict: 768,
  selectors: DEFAULT_SELECTORS,
};

function text(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeSettings(value: unknown): Settings {
  const source = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const rawSelectors =
    typeof source.selectors === 'object' && source.selectors !== null
      ? (source.selectors as Record<string, unknown>)
      : {};
  const selectors: Selectors = {
    root: text(rawSelectors.root, ''),
    question: text(rawSelectors.question, ''),
    options: text(rawSelectors.options, ''),
    input: text(rawSelectors.input, ''),
    submit: text(rawSelectors.submit, ''),
    next: text(rawSelectors.next, ''),
    complete: text(rawSelectors.complete, ''),
  };
  return {
    api_url: text(source.api_url, DEFAULT_SETTINGS.api_url),
    groq_model: text(source.groq_model, DEFAULT_SETTINGS.groq_model),
    url: text(source.url, DEFAULT_SETTINGS.url),
    max_questions: Math.round(number(source.max_questions, DEFAULT_SETTINGS.max_questions, 1, 500)),
    min_confidence: number(source.min_confidence, DEFAULT_SETTINGS.min_confidence, 0, 1),
    timeout: number(source.timeout, DEFAULT_SETTINGS.timeout, 10, 600),
    thinking: source.thinking === true,
    transition_timeout: number(
      source.transition_timeout,
      DEFAULT_SETTINGS.transition_timeout,
      1,
      120,
    ),
    num_predict: Math.round(number(source.num_predict, DEFAULT_SETTINGS.num_predict, 64, 8192)),
    selectors,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await browser.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(stored[SETTINGS_KEY]);
}

export async function saveSettings(value: unknown): Promise<Settings> {
  const settings = normalizeSettings(value);
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}
