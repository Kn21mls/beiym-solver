import { ApiError, Cancelled, SolverError, checkpoint } from './errors';
import type { Answer, Question, Settings } from './types';

export interface AuthResult {
  token: string;
  user: { id: number; email: string };
}

export interface Me {
  id: number;
  email: string;
  groq_connected: boolean;
  groq_hint: string;
}

export interface Onboarding {
  signup_url: string;
  keys_url: string;
  steps: string[];
  note: string;
}

export class ApiClient {
  private readonly base: string;
  private readonly token: string;
  private readonly settings: Settings;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: Settings, token = '', fetchImpl: typeof fetch = fetch) {
    this.base = settings.api_url.replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(this.base)) {
      throw new SolverError('Адрес API должен начинаться с http:// или https://.');
    }
    this.settings = settings;
    this.token = token;
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  private async request<T>(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<T> {
    checkpoint(signal);
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    let response: Response;
    try {
      response = await this.fetchImpl(this.base + path, { ...init, headers, signal });
    } catch (error) {
      if (signal?.aborted) throw new Cancelled('Остановлено.');
      if (error instanceof SolverError) throw error;
      console.error(`Beyim Solver API: ${this.base}${path}`, error);
      const detail = error instanceof Error ? error.message : String(error);
      throw new SolverError(
        `Не удалось связаться с API. Проверьте, что сервер запущен и адрес верный. (${detail})`,
      );
    }
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const message = typeof payload?.detail === 'string' ? payload.detail : `API вернул HTTP ${response.status}.`;
      throw new ApiError(response.status, message);
    }
    return payload as T;
  }

  register(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  login(email: string, password: string): Promise<AuthResult> {
    return this.request<AuthResult>('/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  }

  logout(): Promise<{ ok: boolean }> {
    return this.request('/v1/auth/logout', { method: 'POST' });
  }

  me(): Promise<Me> {
    return this.request<Me>('/v1/me');
  }

  connectGroq(apiKey: string): Promise<{ connected: boolean; hint: string }> {
    return this.request('/v1/groq', { method: 'PUT', body: JSON.stringify({ api_key: apiKey }) });
  }

  disconnectGroq(): Promise<{ connected: boolean }> {
    return this.request('/v1/groq', { method: 'DELETE' });
  }

  onboarding(): Promise<Onboarding> {
    return this.request<Onboarding>('/v1/onboarding/groq');
  }

  async solve(question: Question, image: string | null, signal?: AbortSignal): Promise<Answer> {
    const result = await this.request<{ answer: Answer }>(
      '/v1/solve',
      {
        method: 'POST',
        body: JSON.stringify({
          question: {
            text: question.text,
            kind: question.kind,
            options: question.options.map((option) => ({ text: option.text })),
            image,
          },
          model: this.settings.groq_model,
          min_confidence: this.settings.min_confidence,
          timeout: Math.min(180, Math.max(10, this.settings.timeout)),
          num_predict: Math.min(4096, Math.max(64, this.settings.num_predict)),
        }),
      },
      signal,
    );
    return result.answer;
  }
}
