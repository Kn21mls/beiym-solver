import { all, text, visible, wait } from './dom';
import { captureImage } from './images';
import { CONTROL, extract, labelsOf, revision, sameQuestion } from './questions';
import browser from 'webextension-polyfill';
import { Cancelled, SolverError } from '../shared/errors';
import type {
  ContentRequest,
  ContentResponse,
  PanelMessage,
} from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { isAssessment } from '../shared/page';
import type { Answer, Question, Selectors, Settings } from '../shared/types';

const SUBMIT = /^(Проверить|Проверить ответ|Ответить|Отправить ответ|Тексеру|Жауап беру|Check|Check answer|Submit)$/i;
const NEXT = /^(Далее|Следующий вопрос|Следующее задание|Продолжить|Келесі|Жалғастыру|Next|Continue)$/i;
const COMPLETE = /^(Тест заверш[её]н|Урок заверш[её]н|Вы завершили тест|Тестілеу аяқталды|Test completed|Lesson completed)[.!]?$/i;
const submitted = new WeakMap<Element, Set<string>>();
const cancelled = new Map<string, AbortController>();

function findButton(selector: string, pattern: RegExp): HTMLElement | null {
  if (selector) {
    const found = all(document, selector);
    if (found.length > 1) throw new SolverError('Найдено несколько одинаковых кнопок. Уточните CSS-селектор.');
    return (found[0] as HTMLElement) ?? null;
  }
  const buttons = all(document, 'button,[role=button]').filter((element) => pattern.test(text(element).trim()));
  if (buttons.length > 1) throw new SolverError('Найдено несколько одинаковых кнопок. Уточните CSS-селектор.');
  return (buttons[0] as HTMLElement) ?? null;
}

function isComplete(selectors: Selectors): boolean {
  if (selectors.complete) {
    const found = all(document, selectors.complete);
    if (found.length > 1) throw new SolverError('Селектор завершения указывает на несколько элементов.');
    return found.length === 1;
  }
  const forms = all(document, 'div.activity.relative')
    .flatMap((carousel) => [...carousel.querySelectorAll('form.activity')]);
  if (!selectors.root && forms.length) {
    return forms.every((form) => !!form.querySelector('label.answerTrue'));
  }
  return document.body.innerText.split('\n').some((line) => COMPLETE.test(line.trim()));
}

async function prepare(check = () => {}): Promise<void> {
  const settings = await loadSettings(location.href);
  if (settings.selectors.root) return;
  const carousels = all(document, 'div.activity.relative');
  for (const carousel of carousels) {
    const slides = [...carousel.querySelectorAll('.swiper-slide')];
    const pending = slides
      .map((slide, index) => ({ slide, index }))
      .filter(({ slide }) => slide.querySelector('form.activity input') && !slide.querySelector('label.answerTrue'));
    if (!pending.length) continue;
    const desired = pending[0].index;
    for (let attempt = 0; attempt <= slides.length; attempt += 1) {
      const current = slides.findIndex((slide) => slide.classList.contains('swiper-slide-active'));
      if (current === desired) {
        slides[desired].scrollIntoView({ block: 'nearest' });
        return;
      }
      if (current < 0) throw new SolverError('Не найдено активное упражнение карусели.');
      const direction = current < desired ? '.swiper-button-next' : '.swiper-button-prev';
      const arrow = carousel.querySelector<HTMLElement>(direction);
      if (!arrow || arrow.classList.contains('swiper-button-disabled')) {
        throw new SolverError('Стрелка карусели недоступна.');
      }
      check();
      arrow.click();
      const deadline = performance.now() + settings.transition_timeout * 1000;
      let moved = false;
      while (performance.now() < deadline) {
        const next = slides.findIndex((slide) => slide.classList.contains('swiper-slide-active'));
        if (next !== current) {
          moved = true;
          break;
        }
        await wait(100);
      }
      if (!moved) throw new SolverError('Карусель не переключилась.');
      await wait(350);
    }
    throw new SolverError('Не удалось открыть упражнение карусели.');
  }
}

async function apply(question: Question, answer: Answer, settings?: Settings): Promise<void> {
  settings ??= await loadSettings(location.href);
  const current = extract(settings.selectors);
  if (!sameQuestion(question, current)) {
    throw new SolverError('Задание изменилось во время решения. Старый ответ не отправлен.');
  }
  if (question.kind === 'text') {
    const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(question.input_selector);
    if (!field) throw new SolverError('Не найдено поле текстового ответа.');
    field.focus();
    field.value = answer.text_answer;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }
  const selected = new Set(answer.answer_ids);
  question.options.forEach((option, index) => {
    const id = index + 1;
    const target = document.querySelector<HTMLElement>(option.selector);
    if (!target) throw new SolverError('Вариант ответа исчез со страницы.');
    const native = target.matches(CONTROL) ? target : target.querySelector<HTMLElement>(CONTROL);
    if (native instanceof HTMLInputElement) {
      const desired = selected.has(id);
      if (native.checked !== desired) {
        const label = option.label_selector ? document.querySelector<HTMLElement>(option.label_selector) : null;
        if (label && !visible(native)) label.click();
        else native.click();
      }
      if (native.checked !== desired) throw new SolverError('Не удалось подтвердить выбор варианта.');
    } else {
      const control = native ?? target;
      const checked = () => control.getAttribute('aria-checked') === 'true' ||
        control.getAttribute('aria-selected') === 'true' ||
        control.getAttribute('aria-pressed') === 'true' ||
        control.getAttribute('data-state') === 'checked';
      const desired = selected.has(id);
      if (checked() !== desired && (question.kind === 'multiple' || desired)) (control as HTMLElement).click();
      if (desired && !checked()) throw new SolverError('Не удалось проверить выбор нестандартного варианта.');
      if (question.kind === 'multiple' && checked() !== desired) throw new SolverError('Не удалось снять лишний вариант.');
    }
  });
}

async function betaSubmit(question: Question, answer: Answer, check: () => void, selectOnly = false): Promise<void> {
  const settings = await loadSettings(location.href);
  const current = extract(settings.selectors);
  const root = document.querySelector(question.root);
  if (!root || current.revision !== question.revision || !sameQuestion(question, current)) {
    throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
  }
  if (selectOnly) {
    check();
    await apply(question, answer, settings);
    return;
  }
  if (isAssessment(location.href)) throw new SolverError('В тесте можно выбрать ответ. Переход и сдача выполняются на Beyim.');
  const button = question.adapter === 'beyim-activity'
    ? root.querySelector<HTMLButtonElement>('form.activity button[type=submit]')
    : findButton(settings.selectors.submit, SUBMIT);
  if (!button) throw new SolverError('Кнопка проверки недоступна. Проверьте задание вручную.');
  const identity = JSON.stringify([question.revision, question.text, question.options.map((option) => option.text)]);
  const attempts = submitted.get(root) ?? new Set<string>();
  if (attempts.has(identity)) throw new SolverError('Ответ уже отправлен. Проверьте результат на странице.');
  check();
  await apply(question, answer, settings);
  check();
  const selectedQuestion = extract(settings.selectors);
  if (selectedQuestion.revision !== question.revision || !sameQuestion(question, selectedQuestion)) {
    throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
  }
  if (!button.isConnected || (button as HTMLButtonElement).disabled) {
    throw new SolverError('Кнопка проверки недоступна. Проверьте выбранный ответ на странице.');
  }
  attempts.add(identity);
  submitted.set(root, attempts);
  button.click();
  if (question.adapter !== 'beyim-activity') return;
  const deadline = performance.now() + settings.transition_timeout * 1000;
  while (performance.now() < deadline) {
    check();
    if (root.querySelector('form.activity label.answerTrue')) return;
    await wait(150);
  }
  throw new SolverError('Beyim не подтвердил правильный ответ. Посмотрите результат на странице.');
}

async function betaOperation(operation: string, work: (check: () => void) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  cancelled.set(operation, controller);
  try {
    await work(() => {
      if (controller.signal.aborted) throw new Cancelled('Остановлено.');
    });
  } finally {
    cancelled.delete(operation);
  }
}

async function waitForChange(
  question: Question,
  settings: Settings,
): Promise<{ state: 'question' | 'complete'; question?: Question }> {
  const deadline = performance.now() + settings.transition_timeout * 1000;
  let nextClicked = false;
  while (performance.now() < deadline) {
    if (isComplete(settings.selectors)) return { state: 'complete' };
    try {
      const current = extract(settings.selectors);
      if (!sameQuestion(question, current)) return { state: 'question', question: current };
    } catch {}
    if (!nextClicked) {
      const next = findButton(settings.selectors.next, NEXT);
      if (next && !(next as HTMLButtonElement).disabled) {
        next.click();
        nextClicked = true;
      }
    }
    await wait(150);
  }
  throw new SolverError('Новое задание не появилось. Повторная отправка запрещена; проверьте страницу.');
}

async function advance(question: Question): Promise<{ state: 'question' | 'complete'; question?: Question }> {
  if (isAssessment(location.href)) throw new SolverError('Сдайте тест вручную на Beyim.');
  const settings = await loadSettings(location.href);
  if (question.adapter === 'beyim-activity') {
    const button = document.querySelector<HTMLElement>(question.submit_selector);
    if (!button) throw new SolverError('Не найдена кнопка проверки упражнения Beyim.');
    if ((button as HTMLButtonElement).disabled) {
      throw new SolverError('Кнопка проверки упражнения недоступна. Ответ не отправлен.');
    }
    button.click();
    return waitForChange(question, settings);
  }

  const submit = findButton(settings.selectors.submit, SUBMIT);
  const next = findButton(settings.selectors.next, NEXT);
  if (submit && !(submit as HTMLButtonElement).disabled) submit.click();
  else if (next && !(next as HTMLButtonElement).disabled) next.click();
  else throw new SolverError('Нет доступной кнопки проверки/перехода. Ответ выбран, но не отправлен.');
  return waitForChange(question, settings);
}

async function handle(request: ContentRequest): Promise<unknown> {
  switch (request.type) {
    case 'extract': {
      const settings = await loadSettings(location.href);
      return extract(settings.selectors);
    }
    case 'apply':
      await apply(request.question, request.answer);
      return true;
    case 'advance':
      return advance(request.question);
    case 'prepare':
      await prepare();
      return true;
    case 'beta-prepare':
      return betaOperation(request.operation, prepare);
    case 'beta-submit':
      return betaOperation(request.operation, (check) => betaSubmit(request.question, request.answer, check));
    case 'beta-select':
      return betaOperation(request.operation, (check) => betaSubmit(request.question, request.answer, check, true));
    case 'beta-cancel':
      cancelled.get(request.operation)?.abort();
      return true;
    case 'complete': {
      const settings = await loadSettings(location.href);
      return isComplete(settings.selectors);
    }
    case 'image': {
      const root = document.querySelector(request.question.root);
      if (!root) throw new SolverError('Блок задания исчез со страницы.');
      if (request.question.revision && request.question.revision !== revision(root)) {
        throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
      }
      return captureImage(root, request.max);
    }
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const incoming = message as PanelMessage;
  if (!incoming || incoming.type !== 'content') return undefined;
  return handle(incoming.request)
    .then((data): ContentResponse => ({ ok: true, data }))
    .catch((error): ContentResponse => {
      const cancelled = error instanceof Cancelled;
      return { ok: false, error: error instanceof Error ? error.message : String(error), cancelled };
    });
});
