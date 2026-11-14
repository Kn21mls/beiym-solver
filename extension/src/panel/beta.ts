import browser from 'webextension-polyfill';
import { betaApi, directGroq, safari } from '../shared/beta-config';
import { ApiError, Cancelled, SolverError, checkpoint } from '../shared/errors';
import { solveWithGroq, verifyGroqKey } from '../shared/groq';
import type { ContentRequest, ContentResponse, ImageResult, PanelMessage } from '../shared/messages';
import { isAssessment, selectorProfile } from '../shared/page';
import { validateAnswer } from '../shared/question';
import { DEFAULT_SELECTORS, loadSettings, savePageSelectors } from '../shared/settings';
import type { Answer, Question } from '../shared/types';

interface Session { token: string; expires_at: number }
interface Preview { question: Question; answer: Answer; tabId: number; url: string }
interface Operation { id: string; controller: AbortController; tabId?: number }

const sessionKey = 'betaSession';
const groqKeyName = 'groqApiKey';
const consentKey = directGroq ? 'groqConsentV1' : 'betaConsentV1';
const threshold = 0.8;
const hosts = ['https://beyim.ai/*', 'https://*.beyim.ai/*'];
const initialTab = new URLSearchParams(location.search).get('tab');
const selectorFields = ['root', 'question', 'options', 'input'] as const;
const byId = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let session: Session | undefined;
let groqKey = '';
let consent = false;
let preview: Preview | undefined;
let operation: Operation | undefined;
let editingProfile: string | undefined;

if (directGroq) {
  byId('create-key').hidden = false;
  byId('code-label').textContent = 'Ключ Groq';
  byId('activate').textContent = 'Подключить Groq';
  byId('logout').textContent = 'Удалить ключ Groq';
  byId('disclosure').querySelector('p')!.textContent =
    'Для разбора текст, варианты и при необходимости снимок задания отправляются в Groq.';
} else if (safari) {
  byId('local-server').hidden = false;
  byId('start-server').addEventListener('click', () => {
    byId('server-status').textContent = 'Открываем Beyim Server…';
  });
  byId('check-server').addEventListener('click', async () => {
    try {
      await allowApi();
      await refreshServerStatus();
    } catch {
      byId('server-status').textContent = 'Разрешите Safari доступ к адресу сервера.';
    }
  });
  void refreshServerStatus();
  window.setInterval(() => { void refreshServerStatus(); }, 3000);
}

if (safari) {
  byId('welcome').textContent = 'Откройте упражнение и снова выберите Beyim Solver в меню расширений Safari. Разрешите доступ к Beyim, если Safari спросит.';
}

async function refreshServerStatus(): Promise<void> {
  const label = byId('server-status');
  try {
    if (!await browser.permissions.contains({ origins: [betaApi + '/*'] })) {
      label.textContent = 'Safari проверит сервер после предоставления доступа к его адресу.';
      return;
    }
    const response = await fetch(betaApi + '/health', {
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(2500),
    });
    if (response.ok && (await response.json()).ok === true) {
      label.textContent = 'Сервер работает';
      return;
    }
  } catch {
    // An unreachable server has the same status as a failed health check.
  }
  label.textContent = 'Сервер недоступен по адресу API';
}

async function allowApi(): Promise<void> {
  if (safari && !directGroq && !await browser.permissions.request({ origins: [betaApi + '/*'] })) {
    throw new SolverError('Разрешите доступ к адресу сервера Beyim Solver в Safari и повторите.');
  }
}

function status(message: string, error = false): void {
  byId('status').textContent = message;
  byId('status').dataset.error = String(error);
}

function connected(): boolean {
  return directGroq ? !!groqKey : !!session;
}

function render(): void {
  byId('activation').hidden = connected();
  byId('workspace').hidden = !connected();
  byId('disclosure').hidden = consent;
  byId('actions').hidden = !consent;
  byId('result').hidden = !preview;
  byId('stop').hidden = !operation;
  for (const id of ['analyse', 'auto', 'logout']) byId<HTMLButtonElement>(id).disabled = !!operation;
  byId('submit').hidden = !preview || preview.answer.confidence < threshold;
  byId<HTMLButtonElement>('submit').disabled = !!operation;
}

async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    if (session) headers.set('Authorization', 'Bearer ' + session.token);
    const timeout = AbortSignal.timeout(55_000);
    response = await fetch(betaApi + path, {
      method: 'POST', headers, redirect: 'error', cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch {
    checkpoint(signal);
    throw new SolverError('Сервер Beyim Solver недоступен. Повторите попытку позже.');
  }
  const payload = await response.json().catch(() => null);
  checkpoint(signal);
  if (!response.ok) {
    const detail = typeof payload?.detail === 'string' ? payload.detail : 'Сервер не ответил. Повторите позже.';
    const delay = Number(response.headers.get('Retry-After'));
    const retry = response.status === 429 && delay > 0
      ? ' Повторите после ' + new Date(Date.now() + delay * 1000).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + '.'
      : '';
    throw new ApiError(response.status, detail + retry);
  }
  return payload as T;
}

async function showError(error: unknown): Promise<void> {
  if (error instanceof ApiError && error.status === 401) {
    session = undefined;
    preview = undefined;
    if (directGroq) {
      groqKey = '';
      await browser.storage.local.remove(groqKeyName);
    } else {
      await browser.storage.local.remove(sessionKey);
    }
  }
  status(error instanceof Error ? error.message : 'Повторите попытку.', !(error instanceof Cancelled));
  render();
}

async function currentTab(): Promise<{ id: number; url: string }> {
  const tabs = await browser.tabs.query(safari ? { active: true, currentWindow: true } : { url: hosts });
  const preferred = initialTab === null ? undefined : tabs.find((tab) => tab.id === Number(initialTab));
  const tab = preferred ?? tabs.find((entry) => entry.active) ?? tabs[0];
  if (tab?.id === undefined || !tab.url) throw new SolverError('Откройте упражнение Beyim и снова нажмите иконку расширения.');
  const url = new URL(tab.url);
  if (url.protocol !== 'https:' || (url.hostname !== 'beyim.ai' && !url.hostname.endsWith('.beyim.ai'))) {
    throw new SolverError('Откройте упражнение Beyim и снова нажмите иконку расширения.');
  }
  return { id: tab.id, url: tab.url };
}

async function send<T>(tabId: number, request: ContentRequest): Promise<T> {
  const message: PanelMessage = { type: 'content', request };
  let response: ContentResponse;
  try {
    response = await browser.tabs.sendMessage(tabId, message) as ContentResponse;
  } catch {
    throw new SolverError('Обновите вкладку Beyim и откройте расширение с этой вкладки.');
  }
  if (!response?.ok) {
    if (response?.cancelled) throw new Cancelled(response.error);
    throw new SolverError(response?.error || 'Откройте упражнение Beyim.');
  }
  return response.data as T;
}

async function analyse(tab: { id: number; url: string }, signal: AbortSignal): Promise<Preview> {
  status('Читаем задание…');
  const question = await send<Question>(tab.id, { type: 'extract' });
  checkpoint(signal);
  const image = question.has_image
    ? (await send<ImageResult>(tab.id, { type: 'image', question, max: 1400 })).dataUrl
    : null;
  checkpoint(signal);
  const current = await send<Question>(tab.id, { type: 'extract' });
  const latestTab = await browser.tabs.get(tab.id).catch(() => null);
  checkpoint(signal);
  if (latestTab?.url !== tab.url || JSON.stringify(current) !== JSON.stringify(question)) {
    throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
  }
  status('Готовим объяснение…');
  if (directGroq) {
    const answer = await solveWithGroq(groqKey, question, image, signal, (seconds) => {
      status(`Лимит Groq. Повторим разбор через ${seconds} с…`);
    });
    return { question, answer: validateAnswer(answer, question, 0), tabId: tab.id, url: tab.url };
  }
  const result = await api<{ answer: unknown }>('/v1/solve', {
    question: { text: question.text, kind: question.kind, options: question.options.map(({ text }) => ({ text })), image },
  }, signal);
  return { question, answer: validateAnswer(result?.answer, question, 0), tabId: tab.id, url: tab.url };
}

function showPreview(value: Preview): void {
  preview = value;
  byId('question').textContent = value.question.text;
  byId('answer').textContent = value.answer.text_answer ||
    value.answer.answer_ids.map((id) => value.question.options[id - 1].text).join('\n');
  byId('explanation').textContent = value.answer.explanation;
  byId('submit').textContent = isAssessment(value.url) ? 'Выбрать на странице' : 'Отправить ответ';
  render();
}

async function submit(value: Preview, work: Operation): Promise<void> {
  const tab = await browser.tabs.get(value.tabId).catch(() => null);
  checkpoint(work.controller.signal);
  if (tab?.url !== value.url) throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
  await send(value.tabId, {
    type: isAssessment(value.url) ? 'beta-select' : 'beta-submit', operation: work.id, question: value.question,
    answer: validateAnswer(value.answer, value.question, threshold),
  });
  checkpoint(work.controller.signal);
}

async function run(mode: 'analyse' | 'submit' | 'auto'): Promise<void> {
  if (operation || !connected() || !consent) return;
  const previous = preview;
  preview = undefined;
  const work: Operation = { id: crypto.randomUUID(), controller: new AbortController() };
  operation = work;
  const signal = work.controller.signal;
  render();
  try {
    if (mode === 'submit' && previous) {
      work.tabId = previous.tabId;
      await submit(previous, work);
      status(isAssessment(previous.url) ? 'Ответ выбран. Дальнейшие действия доступны на Beyim.'
        : previous.question.adapter === 'beyim-activity' ? 'Beyim подтвердил ответ.'
        : 'Ответ отправлен. Проверьте результат на странице.');
      return;
    }
    await allowApi();
    const tab = await currentTab();
    work.tabId = tab.id;
    checkpoint(signal);
    if (mode === 'auto') {
      if (isAssessment(tab.url)) {
        for (let processed = 0; processed < 100; processed += 1) {
          const value = await analyse(tab, signal);
          checkpoint(signal);
          const last = await send<boolean>(tab.id, {
            type: 'assessment-step', operation: work.id, question: value.question,
            answer: validateAnswer(value.answer, value.question, threshold),
          });
          checkpoint(signal);
          if (last) {
            status('Последний ответ выбран. Проверьте ответы и завершите оценивание на Beyim.');
            return;
          }
        }
        throw new SolverError('Обработано 100 вопросов. Проверьте страницу перед продолжением.');
      }
      if (!/\/topicFeed(?:\/|$)/i.test(new URL(tab.url).pathname)) {
        throw new SolverError('Откройте урок с упражнениями Beyim для автопрохождения.');
      }
      for (let solved = 0; solved < 10; solved += 1) {
        const complete = await send<boolean>(tab.id, { type: 'complete' });
        checkpoint(signal);
        if (complete) {
          status('Урок завершён. Подтверждено за этот запуск: ' + solved + '.');
          return;
        }
        await send(tab.id, { type: 'beta-prepare', operation: work.id });
        checkpoint(signal);
        const value = await analyse(tab, signal);
        if (value.question.adapter !== 'beyim-activity') throw new SolverError('Это упражнение поддерживает ручной разбор.');
        await submit(value, work);
        status('Beyim подтвердил заданий: ' + (solved + 1) + '.');
      }
      return;
    }
    const value = await analyse(tab, signal);
    checkpoint(signal);
    showPreview(value);
    status(value.answer.confidence < threshold
      ? 'Модель сомневается в ответе. Проверьте объяснение вручную.'
      : 'Разбор готов.');
    byId('question').focus();
  } catch (error) {
    await showError(signal.aborted ? new Cancelled('Остановлено. Проверьте текущее задание на странице.') : error);
  } finally {
    operation = undefined;
    render();
  }
}

function stop(): void {
  if (!operation) return;
  operation.controller.abort();
  if (operation.tabId !== undefined) {
    void send(operation.tabId, { type: 'beta-cancel', operation: operation.id }).catch(() => {});
  }
  status('Останавливаем…');
}

byId('activation').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = byId<HTMLButtonElement>('activate');
  if (button.disabled) return;
  button.disabled = true;
  const input = byId<HTMLInputElement>('code');
  try {
    await allowApi();
    if (directGroq) {
      status('Проверяем ключ Groq…');
      const key = input.value.trim();
      await verifyGroqKey(key);
      await browser.storage.local.set({ [groqKeyName]: key });
      groqKey = key;
    } else {
      status('Активируем приглашение…');
      session = await api<Session>('/v1/beta/activate', { code: input.value.trim() });
      await browser.storage.local.set({ [sessionKey]: session });
    }
    input.value = '';
    byId('welcome').hidden = false;
    status(directGroq ? 'Groq подключён.' : 'Приглашение активировано.');
    render();
    byId('open-beyim').focus();
  } catch (error) {
    await showError(error);
  } finally {
    button.disabled = false;
  }
});

byId('accept').addEventListener('click', async () => {
  try {
    await browser.storage.local.set({ [consentKey]: true });
    consent = true;
    render();
    byId('analyse').focus();
  } catch (error) {
    await showError(error);
  }
});
byId('open-beyim').addEventListener('click', () => void browser.tabs.create({ url: 'https://beyim.ai/ru/ai/feed' }));
byId('analyse').addEventListener('click', () => void run('analyse'));
byId('submit').addEventListener('click', () => void run('submit'));
byId('auto').addEventListener('click', () => void run('auto'));
byId('stop').addEventListener('click', stop);
byId<HTMLDetailsElement>('recognition').addEventListener('toggle', async (event) => {
  if (!(event.currentTarget as HTMLDetailsElement).open) return;
  editingProfile = undefined;
  const fields = byId<HTMLFieldSetElement>('selector-fields');
  fields.disabled = true;
  try {
    const tab = await currentTab();
    const { selectors } = await loadSettings(tab.url);
    editingProfile = selectorProfile(tab.url);
    for (const key of selectorFields) byId<HTMLInputElement>('selector-' + key).value = selectors[key];
    fields.disabled = false;
  } catch (error) {
    await showError(error);
  }
});
byId('selectors').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (operation) return;
  try {
    const tab = await currentTab();
    if (editingProfile !== selectorProfile(tab.url)) {
      throw new SolverError('Раздел Beyim изменился. Сверните и снова откройте настройки распознавания.');
    }
    const selectors = { ...DEFAULT_SELECTORS };
    for (const key of selectorFields) {
      const value = byId<HTMLInputElement>('selector-' + key).value.trim();
      if (value) {
        try {
          document.querySelector(value);
        } catch {
          const label = document.querySelector('label[for="selector-' + key + '"]')?.textContent;
          throw new SolverError('Проверьте синтаксис CSS в поле «' + label + '».');
        }
      }
      selectors[key] = value;
    }
    await savePageSelectors(tab.url, selectors);
    preview = undefined;
    render();
    status('Распознавание сохранено. Нажмите «Разобрать задание».');
  } catch (error) {
    await showError(error);
  }
});
byId('logout').addEventListener('click', async () => {
  if (operation || !connected()) return;
  try {
    if (!directGroq) {
      await allowApi();
      await api('/v1/auth/logout');
    }
    await browser.storage.local.remove([directGroq ? groqKeyName : sessionKey, consentKey]);
    groqKey = '';
    session = undefined;
    preview = undefined;
    consent = false;
    status(directGroq ? 'Ключ удалён.' : 'Доступ отключён. Для подключения понадобится новый код.');
    render();
    byId('code').focus();
  } catch (error) {
    await showError(error);
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') stop();
});
window.addEventListener('pagehide', stop);

void browser.storage.local.get([directGroq ? groqKeyName : sessionKey, consentKey]).then(async (stored) => {
  if (directGroq) {
    groqKey = typeof stored[groqKeyName] === 'string' ? stored[groqKeyName] : '';
  } else {
    const saved = stored[sessionKey] as Session | undefined;
    if (saved?.token && saved.expires_at > Date.now() / 1000) session = saved;
    else if (saved) await browser.storage.local.remove(sessionKey);
  }
  consent = stored[consentKey] === true;
  status(connected() ? 'Готово к разбору.' : directGroq
    ? 'Создайте ключ Groq и вставьте его сюда.'
    : 'Введите код, полученный от организатора беты.');
  render();
  if (!connected()) byId('code').focus();
}).catch(showError);
