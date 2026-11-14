import browser from 'webextension-polyfill';
import { Cancelled, SolverError } from '../shared/errors';
import type {
  CaptureResponse,
  ContentRequest,
  ContentResponse,
  ImageResult,
  PanelMessage,
} from '../shared/messages';
import { loadSettings } from '../shared/settings';
import { isAssessment } from '../shared/page';
import type { Answer, Option, Question, Selectors, Settings } from '../shared/types';

const SUBMIT = /^(Проверить|Проверить ответ|Ответить|Отправить ответ|Тексеру|Жауап беру|Check|Check answer|Submit)$/i;
const NEXT = /^(Далее|Следующий вопрос|Следующее задание|Продолжить|Келесі|Жалғастыру|Next|Continue)$/i;
const COMPLETE = /^(Тест заверш[её]н|Урок заверш[её]н|Вы завершили тест|Тестілеу аяқталды|Test completed|Lesson completed)[.!]?$/i;
const CONTROL = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]';
const TEXT_CONTROL = 'textarea,input[type=text],input[type=number],input:not([type])';
const QUESTION_CONTAINER = 'fieldset,[data-question],[data-question-id],[data-testid=question],[data-testid=assessment-question]';
const QUESTION_TEXT = '[data-question-text],[data-testid=question-text],.question-text,.question-title,legend';
const revisions = new WeakMap<Element, string>();
const submitted = new WeakMap<Element, Set<string>>();
const cancelled = new Map<string, AbortController>();

function revision(root: Element): string {
  let id = revisions.get(root);
  if (!id) {
    id = crypto.randomUUID();
    revisions.set(root, id);
  }
  return location.href + '#' + id;
}

function visible(element: Element | null): boolean {
  return !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
}

function all(root: ParentNode, selector: string): Element[] {
  return selector ? [...root.querySelectorAll(selector)].filter(visible) : [];
}

function text(element: Element | null | undefined): string {
  const value = (element as HTMLElement | null)?.innerText || element?.textContent || '';
  return value.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

function unique(root: ParentNode, selector: string): Element {
  const found = all(root, selector);
  if (found.length !== 1) {
    throw new SolverError(`Селектор «${selector}»: найдено ${found.length}, нужен один элемент.`);
  }
  return found[0];
}

function path(element: Element): string {
  if (element.id && document.querySelectorAll('#' + CSS.escape(element.id)).length === 1) {
    return '#' + CSS.escape(element.id);
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement) {
    const node: Element = current;
    const tag = node.tagName.toLowerCase();
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) break;
    const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
    parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(node) + 1})`);
    current = parent;
  }
  return 'html > ' + parts.join(' > ');
}

function labelsOf(element: Element): HTMLLabelElement[] {
  if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
    return element.labels ? [...element.labels] : [];
  }
  return [];
}

function labelFor(element: Element): string {
  const labels = labelsOf(element);
  if (labels.length) return labels.map(text).join(' ');
  const labelled = element.getAttribute('aria-labelledby');
  if (labelled) {
    return labelled
      .split(/\s+/)
      .map((id) => text(document.getElementById(id)))
      .join(' ');
  }
  return element.getAttribute('aria-label') || text(element.closest('label')) || text(element);
}

function usable(element: Element): boolean {
  return visible(element) || labelsOf(element).some(visible);
}

function sameQuestion(left: Question, right: Question): boolean {
  return (
    left.text === right.text &&
    left.kind === right.kind &&
    left.options.length === right.options.length &&
    left.options.every((option, index) => option.text === right.options[index]?.text)
  );
}

function assessmentCard(): { root: Element; heading: Element; options: Element[] } | undefined {
  const heading = all(document, 'h1,h2,h3,h4,h5,h6,p,div,span').find((node) =>
    node.children.length === 0 && /^Вопрос\s+\d+$/i.test(text(node)),
  );
  if (!heading) return;
  for (let root = heading.parentElement; root && root !== document.body; root = root.parentElement) {
    const options = Array.from(root.querySelectorAll(CONTROL)).filter((node) =>
      usable(node) || visible(node.parentElement),
    );
    if (options.length >= 2) return { root, heading, options };
  }
}

function assessmentPrompt(root: Element, heading: Element, option: Element): string {
  const range = document.createRange();
  range.setStartAfter(heading);
  range.setEndBefore(option.closest('label,[role=radio],[role=checkbox]') ?? option);
  return root.contains(option) ? range.toString().trim() : '';
}

function genericRoot(assessment: boolean): Element {
  const controls = (element: Element) => [...element.querySelectorAll(CONTROL)].filter(usable);
  const candidates = all(document, QUESTION_CONTAINER).filter((element) =>
    controls(element).length >= 2 || (assessment && all(element, TEXT_CONTROL).length === 1),
  );
  const roots = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  const groups = all(document, '[role=radiogroup],[role=group]').filter((element) =>
    controls(element).length >= 2 && !roots.some((root) => root.contains(element)),
  );
  for (const group of groups) {
    if (group.hasAttribute('aria-labelledby') || group.hasAttribute('aria-label') || all(group, QUESTION_TEXT).length) {
      roots.push(group);
      continue;
    }
    const parent = group.parentElement;
    roots.push(parent && all(parent, QUESTION_TEXT + ',h1,h2,h3,h4').length === 1 && controls(parent).length === controls(group).length
      ? parent : group);
  }
  const active = roots.filter((root) => root.matches('[data-active=true],[aria-current=true]'));
  if (active.length === 1) return active[0];
  if (roots.length === 1) return roots[0];
  throw new SolverError(roots.length
    ? 'На странице несколько вопросов. Укажите CSS-селектор одного вопроса в настройках распознавания.'
    : 'Не найден блок задания. Откройте вопрос или укажите его CSS-селектор в настройках распознавания.');
}

function genericPrompt(root: Element): string {
  const labelled = root.getAttribute('aria-labelledby');
  if (labelled) {
    const labels = labelled.trim().split(/\s+/).map((id) => document.getElementById(id));
    if (labels.every(Boolean)) return labels.map(text).join('\n');
  }
  const prompts = all(root, QUESTION_TEXT);
  const headings = prompts.length ? prompts : all(root, 'h1,h2,h3,h4');
  if (headings.length === 1) return text(headings[0]);
  if (!headings.length && root.hasAttribute('aria-label')) return root.getAttribute('aria-label') ?? '';
  throw new SolverError('Не найден однозначный текст вопроса. Укажите CSS-селектор текста.');
}

function extract(selectors: Selectors): Question {
  const assessment = isAssessment(location.href);
  const card = assessment && !selectors.root ? assessmentCard() : undefined;
  let root: Element;
  let adapter: Question['adapter'] = 'generic';
  let submitSelector = '';
  let carouselSelector = '';

  if (selectors.root) {
    root = unique(document, selectors.root);
  } else if (card) {
    root = card.root;
  } else {
    const activities = assessment ? [] : all(document, 'div.activity.relative .swiper-slide-active').filter(
      (element) => element.querySelector('form.activity input') && !element.querySelector('label.answerTrue'),
    );
    if (activities.length) {
      root = activities[0];
      adapter = 'beyim-activity';
      const submit = root.querySelector<HTMLElement>('form.activity button[type=submit]');
      if (!submit) throw new SolverError('Не найдена кнопка проверки упражнения Beyim.');
      submitSelector = path(submit);
      const carousel = root.closest('div.activity.relative');
      carouselSelector = carousel ? path(carousel) : '';
    } else {
      root = genericRoot(assessment);
    }
  }

  const inputs = selectors.options
    ? all(root, selectors.options)
    : card?.options ?? [...root.querySelectorAll(CONTROL)].filter(usable);
  if (inputs.length > 30) throw new SolverError('Найдено слишком много вариантов. Уточните блок задания.');

  const options: Option[] = inputs.map((element, index) => {
    const native = element.matches(CONTROL) ? element : element.querySelector(CONTROL);
    const label = native ? labelsOf(native).find(visible) : null;
    return {
      text: native ? labelFor(native) || text(element) || (card ? String.fromCharCode(65 + index) : '') : text(element),
      selector: path(element),
      label_selector: label ? path(label) : '',
      kind: native?.getAttribute('type') || native?.getAttribute('role') || 'custom',
      group: native?.getAttribute('name') || '',
      disabled: (native as HTMLInputElement | null)?.disabled || element.getAttribute('aria-disabled') === 'true',
    };
  });
  if (options.some((option) => !option.text)) {
    throw new SolverError('У вариантов нет читаемого текста. Нужна настройка селектора вариантов.');
  }
  if (options.some((option) => option.disabled)) {
    throw new SolverError('Варианты ответа заблокированы. Откройте неотвеченное задание.');
  }
  const kinds = new Set(options.map((option) => option.kind));
  if (kinds.size > 1) throw new SolverError('В блоке смешаны разные типы вариантов. Нужен более точный селектор.');
  const groups = new Set(options.map((option) => option.group).filter(Boolean));
  if (groups.size > 1) throw new SolverError('В блоке несколько вопросов. Выберите один вопрос.');

  let prompt: string;
  if (selectors.question) {
    prompt = text(unique(root, selectors.question));
  } else if (adapter === 'beyim-activity') {
    const form = root.querySelector('form.activity');
    const questionBlock = form?.previousElementSibling;
    if (!questionBlock) throw new SolverError('Не найден текст упражнения Beyim.');
    prompt = text(questionBlock);
  } else {
    prompt = card && inputs.length ? assessmentPrompt(root, card.heading, inputs[0]) || genericPrompt(root) : genericPrompt(root);
  }
  if (!prompt || prompt.length > 16000) throw new SolverError('Текст вопроса пустой или слишком длинный.');

  let kind: Question['kind'] = kinds.has('checkbox') ? 'multiple' : 'single';
  let inputSelector = '';
  const inferredFields = assessment && !options.length ? all(root, TEXT_CONTROL) : [];
  if (selectors.input || inferredFields.length === 1) {
    if (options.length) throw new SolverError('В блоке одновременно текстовое поле и варианты. Уточните настройки.');
    const field = selectors.input ? unique(root, selectors.input) : inferredFields[0];
    if (!field.matches(TEXT_CONTROL)) {
      throw new SolverError('Селектор текстового ответа должен указывать на текстовое/числовое поле.');
    }
    if ((field as HTMLInputElement).disabled || (field as HTMLInputElement).readOnly) {
      throw new SolverError('Поле ответа недоступно.');
    }
    kind = 'text';
    inputSelector = path(field);
  } else if (options.length < 2) {
    throw new SolverError('Нужно хотя бы два варианта или настроенное поле текстового ответа.');
  }

  const hasImage = all(root, 'img,canvas,svg').some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 60;
  });

  return {
    text: prompt,
    options,
    kind,
    root: path(root),
    input_selector: inputSelector,
    has_image: hasImage,
    adapter,
    submit_selector: submitSelector,
    carousel_selector: carouselSelector,
    revision: revision(root),
  };
}

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function assessmentProgress(): { index: number; total: number } {
  const text = document.body.innerText;
  const progress = text.match(/Вопросы\s+(\d+)\s+из\s+(\d+)/i);
  const index = Number(progress?.[1]);
  const total = Number(progress?.[2]);
  if (!isAssessment(location.href) || !/Оценивание за тему/i.test(text) ||
      !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index < 1 || index > total) {
    throw new SolverError('Не удалось определить номер вопроса оценивания за тему.');
  }
  return { index, total };
}

async function assessmentStep(question: Question, answer: Answer, check: () => void): Promise<boolean> {
  const { index, total } = assessmentProgress();
  await betaSubmit(question, answer, check, true);
  check();
  if (index === total) return true;

  const settings = await loadSettings(location.href);
  const current = extract(settings.selectors);
  const progress = assessmentProgress();
  if (progress.index !== index || progress.total !== total ||
      current.revision !== question.revision || !sameQuestion(question, current)) {
    throw new SolverError('Вопрос изменился. Проверьте страницу перед повторным запуском.');
  }
  const buttons = Array.from(document.querySelectorAll('button')).filter((button) =>
    visible(button) && !button.disabled && button.getAttribute('aria-disabled') !== 'true' &&
    /^(Далее|Следующий вопрос)$/i.test(button.innerText.trim()),
  );
  if (buttons.length !== 1) throw new SolverError('Не найдена однозначная кнопка «Далее».');
  check();
  buttons[0].click();

  const deadline = performance.now() + settings.transition_timeout * 1000;
  while (performance.now() < deadline) {
    check();
    try {
      const next = assessmentProgress();
      if (next.total === total && next.index === index + 1) return false;
    } catch {
      // The next question may still be loading.
    }
    await wait(150);
  }
  throw new SolverError('Beyim не подтвердил переход. Проверьте текущий вопрос.');
}

async function betaOperation<T>(operation: string, work: (check: () => void) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  cancelled.set(operation, controller);
  try {
    return await work(() => {
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

function waitForImage(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new SolverError('Изображение задания ещё не загрузилось.'));
    }, 10000);
    const done = () => {
      cleanup();
      if (image.naturalWidth > 0) resolve();
      else reject(new SolverError('Не удалось загрузить изображение задания.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      image.removeEventListener('load', done);
      image.removeEventListener('error', done);
    };
    image.addEventListener('load', done, { once: true });
    image.addEventListener('error', done, { once: true });
  });
}

async function sourceOf(element: Element, max: number): Promise<{ source: CanvasImageSource; width: number; height: number }> {
  if (element instanceof HTMLImageElement) {
    await waitForImage(element);
    return { source: element, width: element.naturalWidth, height: element.naturalHeight };
  }
  if (element instanceof HTMLCanvasElement) {
    return { source: element, width: element.width, height: element.height };
  }
  if (element instanceof SVGSVGElement) {
    const markup = new XMLSerializer().serializeToString(element);
    const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }));
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { source: image, width: image.naturalWidth, height: image.naturalHeight };
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  throw new SolverError('Не найден рисунок задания.');
}

function draw(source: CanvasImageSource, width: number, height: number, max: number): ImageResult {
  const ratio = Math.min(1, max / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new SolverError('Не удалось подготовить изображение.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  try {
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  } catch (error) {
    console.error('Beyim Solver image draw', error);
    throw new SolverError('Не удалось прочитать изображение задания. Попробуйте выделить блок через селектор.');
  }
}

function drawRegion(
  source: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  max: number,
): ImageResult {
  const ratio = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * ratio));
  canvas.height = Math.max(1, Math.round(sh * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new SolverError('Не удалось подготовить изображение.');
  context.fillStyle = 'white';
  context.fillRect(0, 0, canvas.width, canvas.height);
  try {
    context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  } catch (error) {
    console.error('Beyim Solver image crop', error);
    throw new SolverError('Не удалось обрезать снимок задания.');
  }
}

async function screenshot(element: Element, max: number): Promise<ImageResult> {
  element.scrollIntoView({ block: 'center', inline: 'center' });
  await wait(350);
  const rect = element.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  if (rect.width < 1 || rect.height < 1) throw new SolverError('Рисунок имеет нулевой размер.');
  if (rect.left < 0 || rect.top < 0 || rect.right > viewport.width || rect.bottom > viewport.height) {
    throw new SolverError('Рисунок не помещается в окно. Уменьшите масштаб Beyim и повторите разбор.');
  }
  const response = (await browser.runtime.sendMessage({ type: 'capture' })) as CaptureResponse;
  if (!response?.ok) {
    throw new SolverError(response?.error || 'Не удалось сделать снимок задания.');
  }
  const after = element.getBoundingClientRect();
  const bounds = ['left', 'top', 'width', 'height'] as const;
  if (!element.isConnected || bounds.some((key) => Math.abs(after[key] - rect[key]) > 1)) {
    throw new SolverError('Рисунок сместился. Остановите прокрутку и повторите разбор.');
  }
  const image = new Image();
  image.src = response.dataUrl;
  await image.decode();
  const scaleX = image.naturalWidth / viewport.width;
  const scaleY = image.naturalHeight / viewport.height;
  const sx = Math.max(0, Math.min(image.naturalWidth - 1, rect.left * scaleX));
  const sy = Math.max(0, Math.min(image.naturalHeight - 1, rect.top * scaleY));
  const sw = Math.min(image.naturalWidth - sx, rect.width * scaleX);
  const sh = Math.min(image.naturalHeight - sy, rect.height * scaleY);
  if (sw < 1 || sh < 1) throw new SolverError('Рисунок находится вне видимой области.');
  return drawRegion(image, sx, sy, sw, sh, max);
}

async function captureImage(question: Question, max: number): Promise<ImageResult> {
  const root = document.querySelector(question.root);
  if (!root) throw new SolverError('Блок задания исчез со страницы.');
  if (question.revision && question.revision !== revision(root)) {
    throw new SolverError('Задание изменилось. Нажмите «Разобрать задание» ещё раз.');
  }
  const images = all(root, 'img,canvas,svg')
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width >= 80 && rect.height >= 60;
    })
    .sort((left, right) => {
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      return b.width * b.height - a.width * a.height;
    });
  if (!images.length) throw new SolverError('В задании не найден рисунок.');
  const limit = Math.min(2000, Math.max(256, max));
  if (isAssessment(location.href) && images.length > 1) {
    const ordered = all(root, 'img,canvas,svg').filter((element) => images.includes(element));
    const tiles: ImageResult[] = [];
    for (const element of ordered) {
      try {
        const { source, width, height } = await sourceOf(element, limit);
        tiles.push(draw(source, width, height, limit));
      } catch {
        tiles.push(await screenshot(element, limit));
      }
    }
    const canvas = document.createElement('canvas');
    const width = Math.max(...tiles.map((tile) => tile.width));
    const height = tiles.reduce((sum, tile) => sum + tile.height, 0);
    const scale = Math.min(1, limit / Math.max(width, height));
    canvas.width = Math.ceil(width * scale);
    canvas.height = Math.ceil(height * scale);
    const context = canvas.getContext('2d');
    if (!context) throw new SolverError('Не удалось собрать изображения вариантов.');
    context.fillStyle = 'white';
    context.fillRect(0, 0, canvas.width, canvas.height);
    let offset = 0;
    for (const tile of tiles) {
      const image = new Image();
      image.src = tile.dataUrl;
      await image.decode();
      context.drawImage(image, 0, offset, tile.width * scale, tile.height * scale);
      offset += tile.height * scale;
    }
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.9), width: canvas.width, height: canvas.height };
  }
  try {
    const { source, width, height } = await sourceOf(images[0], limit);
    return draw(source, width, height, limit);
  } catch (error) {
    console.warn('Beyim Solver image fallback', error);
    try {
      return await screenshot(images[0], limit);
    } catch (fallbackError) {
      console.error('Beyim Solver screenshot fallback', fallbackError);
      const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new SolverError(`Не удалось прочитать изображение задания. ${detail}`);
    }
  }
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
    case 'assessment-step':
      return betaOperation(request.operation, (check) => assessmentStep(request.question, request.answer, check));
    case 'beta-select':
      return betaOperation(request.operation, (check) => betaSubmit(request.question, request.answer, check, true));
    case 'beta-cancel':
      cancelled.get(request.operation)?.abort();
      return true;
    case 'complete': {
      const settings = await loadSettings(location.href);
      return isComplete(settings.selectors);
    }
    case 'image':
      return captureImage(request.question, request.max);
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
