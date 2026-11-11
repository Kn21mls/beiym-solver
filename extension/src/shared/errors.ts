export class SolverError extends Error {
  override name = 'SolverError';
}

export class Cancelled extends SolverError {
  override name = 'Cancelled';
}

export class AnswerFormatError extends SolverError {
  override name = 'AnswerFormatError';
}

export class ApiError extends SolverError {
  override name = 'ApiError';
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class RateLimited extends SolverError {
  override name = 'RateLimited';
  readonly delay: number;

  constructor(delay: number, label: string) {
    super(`Достигнут лимит ${label}. Подождите и запустите решение снова.`);
    this.delay = delay;
  }
}

export function checkpoint(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Cancelled('Остановлено. Новые ответы не отправляются.');
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Cancelled('Остановлено. Новые ответы не отправляются.'));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Cancelled('Остановлено. Новые ответы не отправляются.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
