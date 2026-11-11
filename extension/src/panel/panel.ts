import browser from 'webextension-polyfill';
import { ApiClient } from '../shared/api';
import { ApiError, Cancelled, SolverError } from '../shared/errors';
import type { ContentRequest, ContentResponse, ImageResult, PanelMessage } from '../shared/messages';
import { loadSettings, saveSettings } from '../shared/settings';
import { clearSession, getSession, setSession, type Session } from '../shared/storage';
import type { Question, Settings } from '../shared/types';

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Не найден элемент ${id}.`);
  return element as T;
}

const logElement = byId<HTMLDivElement>('log');

let settings: Settings;
let session: Session | null = null;
let running = false;
let controller: AbortController | null = null;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(message: string, kind: 'info' | 'error' | 'warn' | 'ok' = 'info'): void {
  const line = document.createElement('div');
  line.className = kind;
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  line.textContent = `[${time}] ${message}`;
  logElement.append(line);
  logElement.scrollTop = logElement.scrollHeight;
}

function setStatus(text: string, tone: 'ok' | 'warn' | 'error' | 'idle' = 'idle'): void {
  byId('status').textContent = text;
  byId('dot').className = tone === 'idle' ? 'dot' : `dot ${tone}`;
}

function setTab(name: 'solve' | 'connect'): void {
  document.querySelectorAll<HTMLElement>('.tabs button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.querySelectorAll<HTMLElement>('.tab').forEach((section) => {
    section.classList.toggle('active', section.id === name);
  });
}

function fillForm(): void {
  byId<HTMLInputElement>('api-url').value = settings.api_url;
  byId<HTMLInputElement>('model').value = settings.groq_model;
  byId<HTMLInputElement>('max-questions').value = String(settings.max_questions);
  byId<HTMLInputElement>('min-confidence').value = String(settings.min_confidence);
  byId<HTMLInputElement>('timeout').value = String(settings.timeout);
  byId<HTMLInputElement>('num-predict').value = String(settings.num_predict);
  byId('threshold').textContent = `${Math.round(settings.min_confidence * 100)}%`;
}

async function readForm(): Promise<Settings> {
  settings = await saveSettings({
    ...settings,
    api_url: byId<HTMLInputElement>('api-url').value.trim(),
    groq_model: byId<HTMLInputElement>('model').value.trim(),
    max_questions: Number(byId<HTMLInputElement>('max-questions').value),
    min_confidence: Number(byId<HTMLInputElement>('min-confidence').value),
    timeout: Number(byId<HTMLInputElement>('timeout').value),
    num_predict: Number(byId<HTMLInputElement>('num-predict').value),
  });
  byId('threshold').textContent = `${Math.round(settings.min_confidence * 100)}%`;
  return settings;
}

function client(token = ''): ApiClient {
  return new ApiClient(settings, token || session?.token || '');
}

async function refreshAccount(): Promise<void> {
  if (!session) {
    byId('account').textContent = 'Не выполнен вход.';
    byId('groq-status').textContent = 'Ключ не подключён.';
    return;
  }
  try {
    const me = await client().me();
    byId('account').textContent = `Вход: ${me.email}`;
    byId('groq-status').textContent = me.groq_connected
      ? `Groq подключён: ${me.groq_hint}`
      : 'Ключ не подключён.';
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      await clearSession();
      session = null;
      byId('account').textContent = 'Сессия истекла. Войдите снова.';
      byId('groq-status').textContent = 'Ключ не подключён.';
      return;
    }
    byId('account').textContent = messageOf(error);
  }
}

async function authenticate(mode: 'login' | 'register'): Promise<void> {
  try {
    await readForm();
    const email = byId<HTMLInputElement>('email').value.trim();
    const password = byId<HTMLInputElement>('password').value;
    if (!email || !password) throw new SolverError('Введите email и пароль.');
    const api = new ApiClient(settings, '');
    const result = mode === 'register' ? await api.register(email, password) : await api.login(email, password);
    session = { token: result.token, email: result.user.email };
    await setSession(session);
    byId<HTMLInputElement>('password').value = '';
    log(mode === 'register' ? 'Аккаунт создан.' : 'Вход выполнен.', 'ok');
    await refreshAccount();
    setStatus('Готов', 'ok');
  } catch (error) {
    log(`Ошибка входа: ${messageOf(error)}`, 'error');
    setStatus('Ошибка входа', 'error');
  }
}

async function logout(): Promise<void> {
  if (session) {
    try {
      await client().logout();
    } catch {}
  }
  await clearSession();
  session = null;
  await refreshAccount();
  log('Вы вышли из аккаунта.', 'warn');
}

async function connectGroq(): Promise<void> {
  try {
    const input = byId<HTMLInputElement>('groq-key');
    const key = input.value.trim();
    if (!key) throw new SolverError('Вставьте API-ключ Groq.');
    if (!session) throw new SolverError('Сначала войдите в аккаунт.');
    const result = await client().connectGroq(key);
    input.value = '';
    log(`Groq подключён: ${result.hint}`, 'ok');
    await refreshAccount();
  } catch (error) {
    log(`Ошибка Groq: ${messageOf(error)}`, 'error');
  }
}

async function disconnectGroq(): Promise<void> {
  try {
    if (!session) throw new SolverError('Сначала войдите в аккаунт.');
    await client().disconnectGroq();
    log('Ключ Groq удалён.', 'warn');
    await refreshAccount();
  } catch (error) {
    log(`Ошибка Groq: ${messageOf(error)}`, 'error');
  }
}

async function openGroq(): Promise<void> {
  try {
    await readForm();
    const onboarding = await new ApiClient(settings, '').onboarding();
    await browser.tabs.create({ url: onboarding.keys_url });
    log(onboarding.note, 'warn');
  } catch {
    await browser.tabs.create({ url: 'https://console.groq.com/keys' });
    log('Открыта страница API-ключей Groq.', 'info');
  }
}

async function openBeyim(): Promise<void> {
  await readForm();
  await browser.tabs.create({ url: settings.url });
}

async function findBeyimTab(): Promise<number> {
  const tabs = await browser.tabs.query({ url: ['https://beyim.ai/*', 'https://*.beyim.ai/*'] });
  if (!tabs.length) throw new SolverError('Откройте Beyim и войдите в урок.');
  const tab = tabs.find((item) => item.active) ?? tabs[tabs.length - 1];
  if (tab.id === undefined) throw new SolverError('Не удалось определить вкладку Beyim.');
  return tab.id;
}

async function send<T>(tabId: number, request: ContentRequest): Promise<T> {
  const message: PanelMessage = { type: 'content', request };
  let response: ContentResponse;
  try {
    response = (await browser.tabs.sendMessage(tabId, message)) as ContentResponse;
  } catch {
    throw new SolverError('Не удалось связаться со страницей Beyim. Обновите вкладку.');
  }
  if (!response || !response.ok) {
    if (response && !response.ok && response.cancelled) throw new Cancelled(response.error);
    throw new SolverError(response && !response.ok ? response.error : 'Страница Beyim не ответила.');
  }
  return response.data as T;
}

function updateControls(): void {
  byId<HTMLButtonElement>('start').disabled = running;
  byId<HTMLButtonElement>('stop').disabled = !running;
}

async function run(): Promise<void> {
  if (running) return;
  const currentSession = await getSession();
  if (!currentSession) {
    setTab('connect');
    log('Войдите в аккаунт и подключите Groq.', 'error');
    return;
  }
  running = true;
  controller = new AbortController();
  const signal = controller.signal;
  updateControls();
  byId('solved').textContent = '0';
  setStatus('Работаю', 'warn');
  try {
    settings = await readForm();
    const api = new ApiClient(settings, currentSession.token);
    const tabId = await findBeyimTab();
    await send(tabId, { type: 'prepare' });
    let solved = 0;
    while (solved < settings.max_questions) {
      if (signal.aborted) throw new Cancelled('Остановлено.');
      if (await send<boolean>(tabId, { type: 'complete' })) {
        log('Урок завершён.', 'ok');
        break;
      }
      const question = await send<Question>(tabId, { type: 'extract' });
      log(`Задание ${solved + 1}: ${question.text.replace(/\s+/g, ' ').slice(0, 160)}`);
      let image: string | null = null;
      if (question.has_image) {
        const shot = await send<ImageResult>(tabId, { type: 'image', question, max: 1400 });
        image = shot.dataUrl;
        log(`Рисунок прочитан (${shot.width}×${shot.height}).`);
      }
      const answer = await api.solve(question, image, signal);
      const chosen = answer.answer_ids.length ? answer.answer_ids.join(', ') : answer.text_answer;
      log(`Ответ: ${chosen} · ${Math.round(answer.confidence * 100)}%`, 'ok');
      await send(tabId, { type: 'apply', question, answer });
      const result = await send<{ state: 'question' | 'complete'; question?: Question }>(tabId, {
        type: 'advance',
        question,
      });
      solved += 1;
      byId('solved').textContent = String(solved);
      if (result.state === 'complete') {
        log('Урок завершён.', 'ok');
        break;
      }
    }
    if (solved >= settings.max_questions) log(`Достигнут лимит ${settings.max_questions}.`, 'warn');
    setStatus('Готов', 'ok');
  } catch (error) {
    if (error instanceof Cancelled) {
      log('Остановлено.', 'warn');
      setStatus('Остановлено', 'warn');
    } else if (error instanceof ApiError && error.status === 401) {
      await clearSession();
      session = null;
      await refreshAccount();
      setTab('connect');
      log('Сессия истекла. Войдите снова.', 'error');
      setStatus('Требуется вход', 'error');
    } else {
      log(`Ошибка: ${messageOf(error)}`, 'error');
      setStatus('Ошибка', 'error');
    }
  } finally {
    running = false;
    controller = null;
    updateControls();
  }
}

function stop(): void {
  controller?.abort();
  setStatus('Останавливаю…', 'warn');
}

async function init(): Promise<void> {
  settings = await loadSettings();
  session = await getSession();
  fillForm();
  await refreshAccount();
  updateControls();
  setStatus('Готов', 'ok');
  if (!session) setTab('connect');
}

document.querySelectorAll<HTMLElement>('.tabs button').forEach((button) => {
  button.addEventListener('click', () => setTab(button.dataset.tab === 'connect' ? 'connect' : 'solve'));
});
byId('start').addEventListener('click', () => void run());
byId('stop').addEventListener('click', stop);
byId('open-beyim').addEventListener('click', () => void openBeyim());
byId('save-api').addEventListener('click', () => void readForm().then(() => log('Адрес API сохранён.', 'ok')));
byId('save-settings').addEventListener('click', () => void readForm().then(() => log('Параметры сохранены.', 'ok')));
byId('login').addEventListener('click', () => void authenticate('login'));
byId('register').addEventListener('click', () => void authenticate('register'));
byId('logout').addEventListener('click', () => void logout());
byId('groq-open').addEventListener('click', () => void openGroq());
byId('groq-save').addEventListener('click', () => void connectGroq());
byId('groq-disconnect').addEventListener('click', () => void disconnectGroq());

void init();
