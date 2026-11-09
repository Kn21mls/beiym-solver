from __future__ import annotations

import base64
import os
import re
import time
from pathlib import Path
from urllib.parse import urlsplit

from .core import ROOT, Question, SolverError, checkpoint, is_beyim

EXTRACT = (Path(__file__).with_name("extract.js")).read_text(encoding="utf-8")
SUBMIT = re.compile(r"^(Проверить|Проверить ответ|Ответить|Отправить ответ|Тексеру|Жауап беру|Check|Check answer|Submit)$", re.I)
NEXT = re.compile(r"^(Далее|Следующий вопрос|Следующее задание|Продолжить|Келесі|Жалғастыру|Next|Continue)$", re.I)
COMPLETE = re.compile(r"^(Тест заверш[её]н|Урок заверш[её]н|Вы завершили тест|Тестілеу аяқталды|Test completed|Lesson completed)[.!]?$", re.I)


class Browser:
    def __init__(self, settings, log=print):
        self.settings, self.log = settings, log
        self.context = None
        self.playwright = None
        self.page = None

    def open(self):
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as exc:
            installer, starter = (("Install.cmd", "Start.cmd") if os.name == "nt"
                                  else ("Install.command", "Start.command"))
            raise SolverError(f"Не удалось загрузить библиотеку браузера. Закройте решатель, "
                              f"запустите {installer}, затем {starter}. Требуется Python 3.14.") from exc
        if self.context:
            pages = [p for p in self.context.pages if not p.is_closed()]
            if not pages:
                self.close()
                return self.open()
            pages[-1].bring_to_front()
            return
        self.playwright = sync_playwright().start()
        try:
            self.context = self.playwright.chromium.launch_persistent_context(
                str(ROOT / ".state" / "browser"), channel=self.settings.browser or None,
                headless=False, viewport={"width": 1280, "height": 850},
                accept_downloads=False,
            )
            self.context.set_default_timeout(3500)
            self.page = self.context.pages[0] if self.context.pages else self.context.new_page()
            self.page.goto(self.settings.url, wait_until="domcontentloaded", timeout=45000)
            self.log("Браузер открыт. Войдите в Beyim и откройте задание. Вход сохраняется в профиле бота.")
        except Exception:
            self.close()
            raise

    def choose_page(self):
        if not self.context:
            raise SolverError("Сначала нажмите «Открыть Beyim».")
        pages = [p for p in self.context.pages if not p.is_closed() and is_beyim(urlsplit(p.url).hostname)]
        if len(pages) != 1:
            raise SolverError("Оставьте в браузере бота одну вкладку Beyim с нужным заданием.")
        self.page = pages[0]
        if "/login" in urlsplit(self.page.url).path:
            raise SolverError("Сначала войдите в Beyim и откройте задание.")
        return self.page

    def assert_site(self):
        if not self.page or self.page.is_closed() or not is_beyim(urlsplit(self.page.url).hostname):
            raise SolverError("Страница Beyim закрыта или адрес изменился. Автопрохождение остановлено.")

    def read(self):
        self.assert_site()
        try:
            return Question(**self.page.evaluate(EXTRACT, self.settings.selectors))
        except SolverError:
            raise
        except Exception as exc:
            raise SolverError(f"Не удалось прочитать задание: {exc}") from exc

    def unique(self, locator):
        visible = [e for e in locator.all() if e.is_visible()]
        if len(visible) > 1:
            raise SolverError("Найдено несколько одинаковых кнопок. Уточните CSS-селектор.")
        return visible[0] if visible else None

    def button(self, kind):
        self.assert_site()
        selector = self.settings.selectors.get(kind)
        locator = self.page.locator(selector) if selector else self.page.get_by_role(
            "button", name=SUBMIT if kind == "submit" else NEXT)
        return self.unique(locator)

    def complete(self):
        self.assert_site()
        selector = self.settings.selectors.get("complete")
        if selector:
            return self.unique(self.page.locator(selector)) is not None
        forms = self.page.locator('div.activity.relative form.activity')
        if not self.settings.selectors.get("root") and forms.count():
            return forms.evaluate_all("es => es.every(e => e.querySelector('label.answerTrue'))")
        return self.unique(self.page.get_by_text(COMPLETE)) is not None

    def prepare(self, stop):
        """Bring the first unfinished exercise into its carousel's active slide."""
        self.assert_site()
        if self.settings.selectors.get("root"):
            return
        carousels = self.page.locator('div.activity.relative').all()
        for carousel in carousels:
            slides = carousel.locator('.swiper-slide').all()
            pending = [i for i, slide in enumerate(slides)
                       if slide.locator('form.activity input').count() and not slide.locator('label.answerTrue').count()]
            if not pending:
                continue
            desired = pending[0]
            for _ in range(len(slides) + 1):
                checkpoint(stop)
                current = carousel.locator('.swiper-slide').evaluate_all(
                    "es => es.findIndex(e => e.classList.contains('swiper-slide-active'))")
                if current == desired:
                    slides[desired].scroll_into_view_if_needed()
                    return
                if current < 0:
                    raise SolverError("Не найдено активное упражнение карусели.")
                direction = '.swiper-button-next' if current < desired else '.swiper-button-prev'
                arrow = carousel.locator(direction)
                if arrow.count() != 1 or 'swiper-button-disabled' in (arrow.get_attribute('class') or ''):
                    raise SolverError("Стрелка карусели недоступна.")
                arrow.click()
                deadline = time.monotonic() + self.settings.transition_timeout
                while time.monotonic() < deadline:
                    checkpoint(stop)
                    new = carousel.locator('.swiper-slide').evaluate_all(
                        "es => es.findIndex(e => e.classList.contains('swiper-slide-active'))")
                    if new != current:
                        break
                    self.page.wait_for_timeout(100)
                else:
                    raise SolverError("Карусель не переключилась.")
                # Swiper changes the active class before its slide animation finishes.
                self.page.wait_for_timeout(350)
            raise SolverError("Не удалось открыть упражнение карусели.")

    def image(self, question):
        root = self.page.locator(question.root)
        root.scroll_into_view_if_needed()
        try:
            self.page.wait_for_function(
                "selector => [...document.querySelector(selector).querySelectorAll('img')].every(e => e.complete && e.naturalWidth > 0)",
                arg=question.root, timeout=10000)
        except Exception as exc:
            raise SolverError("Изображение задания ещё не загрузилось. Проверьте соединение с Beyim.") from exc
        if self.read().fingerprint != question.fingerprint:
            raise SolverError("Задание изменилось до чтения изображения. Запустите решение заново.")
        raw = base64.b64encode(root.screenshot()).decode()
        result = self.page.evaluate("""async raw => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + raw;
            await image.decode();
            const ratio = Math.min(1, 1400 / Math.max(image.width, image.height));
            if (ratio < 0.5) return null;
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(image.width * ratio);
            canvas.height = Math.round(image.height * ratio);
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
        }""", raw)
        if not result:
            raise SolverError("Блок рисунка слишком большой. Укажите более узкий root во вкладке распознавания.")
        return result

    def apply(self, question, answer, stop):
        checkpoint(stop)
        if self.read().fingerprint != question.fingerprint:
            raise SolverError("Задание изменилось во время решения. Старый ответ не отправлен.")
        if question.kind == "text":
            self.page.locator(question.input_selector).fill(answer["text_answer"])
            checkpoint(stop)
            return
        selected = set(answer["answer_ids"])
        for index, option in enumerate(question.options, 1):
            checkpoint(stop)
            self.assert_site()
            target = self.page.locator(option["selector"])
            native = target if target.evaluate("e => e.matches('input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]')") else target.locator("input[type=radio],input[type=checkbox],[role=radio],[role=checkbox]")
            if native.count() == 1:
                if question.kind == "multiple" or index in selected:
                    desired = index in selected
                    if native.is_checked() != desired:
                        if option.get("label_selector") and not native.is_visible():
                            self.page.locator(option["label_selector"]).click(timeout=3500)
                        else:
                            native.set_checked(desired, timeout=3500)
                    if native.is_checked() != (index in selected):
                        raise SolverError("Не удалось подтвердить выбор варианта.")
            elif index in selected:
                target.click(timeout=3500)
                # Custom choices must expose a selected state; a click alone is not proof.
                checked = target.evaluate("e => e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-pressed') === 'true' || e.getAttribute('data-state') === 'checked'")
                if not checked:
                    raise SolverError("Не удалось проверить выбор нестандартного варианта. Отправка остановлена.")
        checkpoint(stop)

    def advance(self, question, stop):
        checkpoint(stop)
        if question.adapter == "beyim-activity":
            return self.advance_activity(question, stop)
        # A previous selection may already have advanced the lesson.
        try:
            if self.read().fingerprint != question.fingerprint:
                return "next"
        except SolverError:
            if self.complete():
                return "complete"
            raise
        submit = self.button("submit")
        next_clicked = False
        if submit and submit.is_enabled():
            checkpoint(stop)
            submit.click()
        else:
            nxt = self.button("next")
            if not nxt or not nxt.is_enabled():
                raise SolverError("Нет доступной кнопки проверки/перехода. Ответ выбран, но не отправлен.")
            checkpoint(stop)
            nxt.click()
            next_clicked = True
        deadline = time.monotonic() + self.settings.transition_timeout
        while time.monotonic() < deadline:
            checkpoint(stop)
            self.assert_site()
            if self.complete():
                return "complete"
            try:
                if self.read().fingerprint != question.fingerprint:
                    return "next"
            except SolverError:
                pass  # Transitional/answered DOM is allowed only during the bounded wait.
            if not next_clicked:
                nxt = self.button("next")
                if nxt and nxt.is_enabled():
                    checkpoint(stop)
                    nxt.click()
                    next_clicked = True
            self.page.wait_for_timeout(150)
        raise SolverError("Новое задание не появилось. Повторная отправка запрещена; проверьте страницу.")

    def advance_activity(self, question, stop):
        self.assert_site()
        root = self.page.locator(question.root)
        button = self.page.locator(question.submit_selector)
        if not button.is_enabled():
            raise SolverError("Кнопка проверки упражнения недоступна. Ответ не отправлен.")
        checkpoint(stop)
        button.click()
        deadline = time.monotonic() + self.settings.transition_timeout
        while time.monotonic() < deadline:
            checkpoint(stop)
            self.assert_site()
            if root.locator('label.answerTrue').count():
                self.log("Beyim подтвердил правильный ответ.")
                if self.complete():
                    return "complete"
                self.prepare(stop)
                if self.read().fingerprint == question.fingerprint:
                    raise SolverError("Упражнение не сменилось после проверки.")
                return "next"
            self.page.wait_for_timeout(150)
        raise SolverError("Beyim не подтвердил правильный ответ. Проверьте упражнение; повторная отправка остановлена.")

    def close(self):
        if self.context:
            try:
                self.context.close()
            except Exception:
                pass
        if self.playwright:
            self.playwright.stop()
        self.context = self.playwright = self.page = None


class Runner:
    def __init__(self, browser, client, settings, stop, log=print):
        self.browser, self.client, self.settings, self.stop, self.log = browser, client, settings, stop, log
        self.submitted = set()

    def solve(self):
        checkpoint(self.stop)
        q = self.browser.read()
        self.log("Вопрос: " + q.text)
        for i, option in enumerate(q.options, 1):
            self.log(f"  {i}. {option['text']}")
        image = None
        client = self.client
        if q.has_image:
            client = self.client.for_image(self.stop)
            self.log("Читаю изображение задания…")
            image = self.browser.image(q)
        from .cloud import selected_model
        settings = getattr(client, 'settings', self.settings)
        label = getattr(client, 'label', '') or settings.provider.title()
        self.log(f'{label} решает задание ({selected_model(settings)})…')
        answer = client.solve(q, self.stop, image=image)
        self.log("Ответ: " + (str(answer["answer_ids"]) if q.options else answer["text_answer"]))
        self.log(answer["explanation"])
        return q, answer

    def run(self, limit):
        for index in range(limit):
            checkpoint(self.stop)
            if self.browser.complete():
                self.log("Все упражнения на открытой странице завершены.")
                return
            self.browser.prepare(self.stop)
            question = self.browser.read()
            if question.fingerprint in self.submitted:
                raise SolverError("Это задание уже отправлялось в текущей сессии. Проверьте результат вручную.")
            q, answer = self.solve()
            # Remember before the first mutation, including cancelled/partial submissions.
            self.submitted.add(q.fingerprint)
            self.browser.apply(q, answer, self.stop)
            state = self.browser.advance(q, self.stop)
            self.log(f"Обработано: {index + 1}/{limit}.")
            if state == "complete":
                self.log("Урок/тест завершён.")
                return
        self.log("Достигнут заданный лимит. Автопрохождение остановлено.")
