import { describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/shared/api';
import { ApiError } from '../src/shared/errors';
import type { Question, Settings } from '../src/shared/types';

const settings: Settings = {
  api_url: 'http://127.0.0.1:8787',
  groq_model: 'qwen/qwen3.8-27b',
  url: 'https://beyim.ai/ru/ai/feed',
  max_questions: 30,
  min_confidence: 0.8,
  timeout: 180,
  thinking: false,
  transition_timeout: 15,
  num_predict: 768,
  selectors: {
    root: '',
    question: '',
    options: '',
    input: '',
    submit: '',
    next: '',
    complete: '',
  },
};

const question: Question = {
  text: '2 + 2 = ?',
  options: [
    { text: '4', selector: '#a' },
    { text: '5', selector: '#b' },
  ],
  kind: 'single',
  root: '#root',
  input_selector: '',
  has_image: false,
  adapter: 'generic',
  submit_selector: '',
  carousel_selector: '',
};

describe('ApiClient', () => {
  it('sends the question and returns the answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify({
          answer: {
            answer_ids: [1],
            text_answer: '',
            explanation: 'ok',
            confidence: 0.95,
            needs_help: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const client = new ApiClient(settings, 'token', fetchMock as unknown as typeof fetch);
    const answer = await client.solve(question, null);
    expect(answer.answer_ids).toEqual([1]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:8787/v1/solve');
    const body = JSON.parse(init?.body as string);
    expect(body.question.options).toEqual([{ text: '4' }, { text: '5' }]);
    expect(body.min_confidence).toBe(0.8);
  });

  it('binds the fetch implementation to the global object', async () => {
    function strictFetch(this: unknown, _url: string, _init?: RequestInit): Promise<Response> {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 1,
            email: 'test@example.com',
            groq_connected: false,
            groq_hint: '',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
    }

    const client = new ApiClient(settings, 'token', strictFetch as typeof fetch);
    await expect(client.me()).resolves.toMatchObject({ email: 'test@example.com' });
  });

  it('maps API errors to ApiError', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ detail: 'Сессия истекла.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const client = new ApiClient(settings, 'bad', fetchMock as unknown as typeof fetch);
    await expect(client.me()).rejects.toBeInstanceOf(ApiError);
  });
});
