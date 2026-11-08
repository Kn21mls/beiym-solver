(selectors) => {
  const visible = e => !!e && !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const all = (root, selector) => selector ? [...root.querySelectorAll(selector)].filter(visible) : [];
  // Keep table rows/cells and chemical subscripts meaningful for the language model.
  const text = e => (e?.innerText || e?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
  const unique = (root, selector) => {
    const found = all(root, selector);
    if (found.length !== 1) throw Error(`Селектор «${selector}»: найдено ${found.length}, нужен один элемент.`);
    return found[0];
  };
  const path = e => {
    if (e.id && document.querySelectorAll('#' + CSS.escape(e.id)).length === 1) return '#' + CSS.escape(e.id);
    const parts = [];
    while (e && e !== document.documentElement) {
      const tag = e.tagName.toLowerCase();
      const siblings = [...e.parentElement.children].filter(x => x.tagName === e.tagName);
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(e) + 1})`);
      e = e.parentElement;
    }
    return 'html > ' + parts.join(' > ');
  };
  const controlSelector = 'input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]';
  const labelFor = e => {
    if (e.labels?.length) return [...e.labels].map(text).join(' ');
    const labelled = e.getAttribute('aria-labelledby');
    if (labelled) return labelled.split(/\s+/).map(id => text(document.getElementById(id))).join(' ');
    return e.getAttribute('aria-label') || text(e.closest('label')) || text(e);
  };
  // Hidden native inputs may still have a visible associated label.
  const usable = e => visible(e) || [...(e.labels || [])].some(visible);
  let root, adapter = 'generic', submitSelector = '', carouselSelector = '';
  if (selectors.root) root = unique(document, selectors.root);
  else {
    const activities = all(document, 'div.activity.relative .swiper-slide-active')
      .filter(e => e.querySelector('form.activity input') && !e.querySelector('label.answerTrue'));
    if (activities.length) {
      root = activities[0];
      adapter = 'beyim-activity';
      const submit = root.querySelector('form.activity button[type=submit]');
      if (!submit) throw Error('Не найдена кнопка проверки упражнения Beyim.');
      submitSelector = path(submit);
      carouselSelector = path(root.closest('div.activity.relative'));
    } else {
    const groups = all(document, 'fieldset,[role=radiogroup],[data-question],[data-testid=question]')
      .filter(e => [...e.querySelectorAll(controlSelector)].filter(usable).length >= 2);
    const outer = groups.filter(e => !groups.some(other => other !== e && other.contains(e)));
    if (outer.length !== 1) throw Error('Не найден единственный блок задания. Настройте CSS-селектор «Блок задания».');
    root = outer[0];
    }
  }
  const inputs = selectors.options ? all(root, selectors.options)
    : [...root.querySelectorAll(controlSelector)].filter(usable);
  if (inputs.length > 30) throw Error('Найдено слишком много вариантов. Уточните блок задания.');
  let options = inputs.map(e => {
    const native = e.matches(controlSelector) ? e : e.querySelector(controlSelector);
    const label = native?.labels && [...native.labels].find(visible);
    return {text: native ? labelFor(native) || text(e) : text(e), selector: path(e), label_selector: label ? path(label) : '',
      kind: native?.getAttribute('type') || native?.getAttribute('role') || 'custom',
      group: native?.getAttribute('name') || '',
      disabled: !!native?.disabled || e.getAttribute('aria-disabled') === 'true'};
  });
  if (options.some(o => !o.text)) throw Error('У вариантов нет читаемого текста. Нужна настройка селектора вариантов.');
  if (options.some(o => o.disabled)) throw Error('Варианты ответа заблокированы. Откройте неотвеченное задание.');
  const kinds = new Set(options.map(o => o.kind));
  if (kinds.size > 1) throw Error('В блоке смешаны разные типы вариантов. Нужен более точный селектор.');
  const groups = new Set(options.map(o => o.group).filter(Boolean));
  if (groups.size > 1) throw Error('В блоке несколько вопросов. Выберите один вопрос.');
  let prompt;
  if (selectors.question) prompt = text(unique(root, selectors.question));
  else if (adapter === 'beyim-activity') {
    const form = root.querySelector('form.activity');
    const questionBlock = form.previousElementSibling;
    if (!questionBlock) throw Error('Не найден текст упражнения Beyim.');
    prompt = text(questionBlock);
  } else {
    const headings = all(root, 'legend,[data-question-text],[data-testid=question-text],h1,h2,h3,h4');
    if (headings.length !== 1) throw Error('Не найден однозначный текст вопроса. Укажите CSS-селектор «Текст вопроса».');
    prompt = text(headings[0]);
  }
  if (!prompt || prompt.length > 16000) throw Error('Текст вопроса пустой или слишком длинный.');
  let kind = kinds.has('checkbox') ? 'multiple' : 'single';
  let inputSelector = '';
  if (selectors.input) {
    if (options.length) throw Error('В блоке одновременно текстовое поле и варианты. Уточните настройки.');
    const field = unique(root, selectors.input);
    if (!field.matches('textarea,input[type=text],input[type=number],input:not([type])'))
      throw Error('Селектор текстового ответа должен указывать на обычное текстовое/числовое поле.');
    if (field.disabled || field.readOnly) throw Error('Поле ответа недоступно.');
    kind = 'text'; inputSelector = path(field);
  } else if (options.length < 2) throw Error('Нужно хотя бы два варианта или настроенное поле текстового ответа.');
  const hasImage = all(root, 'img,canvas,svg').some(e => {
    const rect = e.getBoundingClientRect();
    return rect.width >= 80 && rect.height >= 60;
  });
  return {text: prompt, options, kind, root: path(root), input_selector: inputSelector, has_image: hasImage,
    adapter, submit_selector: submitSelector, carousel_selector: carouselSelector};
}
