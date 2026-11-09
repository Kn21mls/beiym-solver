"""End-to-end check on a synthetic lesson using the selected AI provider."""
import threading
import time

from .browser import Browser, Runner
from .cloud import create_client, selected_model
from .core import ROOT, Settings, SolverError


def check_vision(full=False, provider=None):
    from playwright.sync_api import sync_playwright

    class LocalBrowser(Browser):
        def assert_site(self):
            if not self.page or self.page.url != 'about:blank':
                raise SolverError('Проверка допускает только локальное тестовое задание.')

    settings = Settings.load()
    if provider:
        settings.provider = provider
    settings.selectors = Settings().selectors
    settings.transition_timeout = 3
    stop = threading.Event()
    client = create_client(settings, print)
    installed = client.models(stop)
    if selected_model(settings) not in installed or (settings.provider == "ollama" and settings.vision_model not in installed):
        raise SolverError('Выбранная модель недоступна. Проверьте список моделей сервиса.')
    started = time.monotonic()
    with sync_playwright() as playwright:
        engine = playwright.chromium.launch(channel=settings.browser or None, headless=True)
        try:
            page = engine.new_page(viewport={'width': 900, 'height': 800})
            page.set_default_timeout(5000)
            page.set_content((ROOT / 'tests' / 'vision.html').read_text(encoding='utf-8'))
            browser = LocalBrowser(settings, print)
            browser.page = page
            def text_lesson():
                page.set_content((ROOT / 'tests' / 'lesson.html').read_text(encoding='utf-8'))
                Runner(browser, client, settings, stop, print).run(3)
                if not browser.complete() or page.evaluate('submissions') != 3:
                    raise SolverError('Текстовый цикл не завершён тремя правильными ответами.')
                if settings.provider == 'ollama' and client.request('/api/ps').get('models'):
                    raise SolverError('После решения модель осталась в памяти.')
            if full:
                text_lesson()
                page.set_content((ROOT / 'tests' / 'vision.html').read_text(encoding='utf-8'))
            q = browser.read()
            if not q.has_image:
                raise SolverError('Рисунок тестового задания не распознан.')
            proof = ROOT / '.state' / 'verification'
            proof.mkdir(parents=True, exist_ok=True)
            page.locator(q.root).screenshot(path=str(proof / 'vision-question.png'))
            Runner(browser, client, settings, stop, print).run(1)
            if not browser.complete() or page.evaluate('window.submitted') != 1:
                raise SolverError('Не подтверждён однократный правильный ответ на локальное задание.')
            page.screenshot(path=str(proof / 'vision-result.png'))
            if settings.provider == 'ollama' and client.request('/api/ps').get('models'):
                raise SolverError('После рисунка модель осталась в памяти.')
            if full:
                text_lesson()
        finally:
            engine.close()
    print(f'VISION CHECK PASSED: рисунок -> {settings.provider} -> выбор -> проверка ({time.monotonic() - started:.1f} с).')
