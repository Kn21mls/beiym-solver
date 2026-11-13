import { SolverError } from '../shared/errors';
import { isAssessment } from '../shared/page';
import type { Option, Question, Selectors } from '../shared/types';
import { all, text, unique, visible } from './dom';

export const CONTROL = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]';
const TEXT_CONTROL = 'textarea,input[type=text],input[type=number],input:not([type])';
const QUESTION_CONTAINER = 'fieldset,[data-question],[data-question-id],[data-testid=question],[data-testid=assessment-question]';
const QUESTION_TEXT = '[data-question-text],[data-testid=question-text],.question-text,.question-title,legend';
const revisions = new WeakMap<Element, string>();

export function revision(root: Element): string {
  let id = revisions.get(root);
  if (!id) {
    id = crypto.randomUUID();
    revisions.set(root, id);
  }
  return location.href + '#' + id;
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

export function labelsOf(element: Element): HTMLLabelElement[] {
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

export function sameQuestion(left: Question, right: Question): boolean {
  return (
    left.text === right.text &&
    left.kind === right.kind &&
    left.options.length === right.options.length &&
    left.options.every((option, index) => option.text === right.options[index]?.text)
  );
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

export function extract(selectors: Selectors): Question {
  const assessment = isAssessment(location.href);
  let root: Element;
  let adapter: Question['adapter'] = 'generic';
  let submitSelector = '';
  let carouselSelector = '';

  if (selectors.root) {
    root = unique(document, selectors.root);
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
    : [...root.querySelectorAll(CONTROL)].filter(usable);
  if (inputs.length > 30) throw new SolverError('Найдено слишком много вариантов. Уточните блок задания.');

  const options: Option[] = inputs.map((element) => {
    const native = element.matches(CONTROL) ? element : element.querySelector(CONTROL);
    const label = native ? labelsOf(native).find(visible) : null;
    return {
      text: native ? labelFor(native) || text(element) : text(element),
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
    prompt = genericPrompt(root);
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
