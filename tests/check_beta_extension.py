"""Exercise the unpacked beta in Chromium using a fixture lesson and API stubs."""

from pathlib import Path
from tempfile import TemporaryDirectory
import time

from playwright.sync_api import Error, expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "extension" / "dist"
SHOTS = ROOT / "docs" / "store"
LESSON = "https://beyim.ai/ru/ai/topicFeed/store-test"
API = "https://beta.example.test"
ASSESSMENT = "https://beyim.ai/ru/assessment/store-test"
FIXTURE = (ROOT / "tests" / "beyim_activity.html").read_text(encoding="utf-8")
ASSESSMENT_FIXTURE = """
<form id="test" onsubmit="event.preventDefault(); window.finished = true">
  <fieldset data-question>
    <legend>Сколько будет 3 + 2?</legend>
    <label><input type="radio" name="answer">4</label>
    <label><input type="radio" name="answer">5</label>
  </fieldset>
  <button type="submit">Завершить тест</button>
</form>
"""
CUSTOM_FIXTURE = """
<article class="exam-card">
  <p class="exam-prompt">Сколько будет 3 + 2?</p>
  <label><input class="exam-choice" type="radio" name="answer">4</label>
  <label><input class="exam-choice" type="radio" name="answer">5</label>
</article>
"""


def main() -> None:
    with TemporaryDirectory() as profile, sync_playwright() as playwright:
        browser = playwright.chromium.launch_persistent_context(
            profile,
            channel="chromium",
            headless=True,
            args=[f"--disable-extensions-except={DIST}", f"--load-extension={DIST}"],
            viewport={"width": 1280, "height": 800},
        )
        try:
            verify(browser)
        finally:
            browser.close()


def verify(browser) -> None:
    worker = browser.service_workers[0] if browser.service_workers else browser.wait_for_event("serviceworker")
    panel_url = worker.url.rsplit("/", 1)[0] + "/panel.html"
    auto_opened = next((page for page in browser.pages if page.url.startswith(panel_url)), None)
    if auto_opened is None:
        auto_opened = browser.wait_for_event("page", predicate=lambda page: page.url.startswith(panel_url))
    expect(auto_opened.get_by_label("Код приглашения")).to_be_visible()
    auto_opened.close()
    panel = browser.new_page()
    panel.goto(panel_url)
    browser.route("https://beyim.ai/**", lambda route: route.fulfill(content_type="text/html", body=FIXTURE))
    browser.route(ASSESSMENT, lambda route: route.fulfill(content_type="text/html", body=ASSESSMENT_FIXTURE))
    browser.route(ASSESSMENT + "-custom", lambda route: route.fulfill(content_type="text/html", body=CUSTOM_FIXTURE))
    lesson = browser.new_page()
    lesson.goto(LESSON)
    solve_calls = []
    pending = []
    mode = "normal"

    def mock_api(route):
        if route.request.url.endswith("/activate"):
            route.fulfill(json={"token": "fixture-session", "expires_at": time.time() + 86400})
            return
        solve_calls.append(route.request.post_data_json["question"])
        if mode == "hold":
            pending.append(route)
        elif mode == "offline":
            route.abort()
        elif mode == "limited":
            route.fulfill(status=429, headers={"Retry-After": "12"}, json={"detail": "Дневной лимит разборов исчерпан."})
        else:
            route.fulfill(json={"answer": {
                "answer_ids": [2], "text_answer": "", "explanation": "Если к трём прибавить два, получится пять.",
                "confidence": 0.95, "needs_help": False,
            }})

    panel.route(API + "/**", mock_api)
    SHOTS.mkdir(parents=True, exist_ok=True)
    expect(panel.get_by_label("Код приглашения")).to_be_focused()
    panel.screenshot(path=SHOTS / "activation.png")
    panel.get_by_label("Код приглашения").fill("fixture-invitation")
    panel.keyboard.press("Enter")
    expect(panel.get_by_role("button", name="Открыть Beyim")).to_be_visible()
    panel.get_by_role("button", name="Согласиться и продолжить").click()
    analyse = panel.get_by_role("button", name="Разобрать задание")
    submit = panel.get_by_role("button", name="Отправить ответ")
    status = panel.get_by_role("status")
    analyse.click()
    expect(submit).to_be_visible()
    assert lesson.evaluate("window.fixtureSubmissions") == 0
    panel.screenshot(path=SHOTS / "analysis.png")

    lesson.locator(".swiper-button-next").first.click()
    submit.click()
    expect(status).to_contain_text("Задание изменилось")
    assert lesson.evaluate("window.fixtureSubmissions") == 0
    lesson.locator(".swiper-button-prev").first.click()

    mode = "hold"
    with panel.expect_request(API + "/v1/solve"):
        analyse.click()
    expect(status).to_have_text("Готовим объяснение…")
    panel.keyboard.press("Escape")
    expect(status).to_contain_text("Остановлено")
    for route in pending:
        try:
            route.abort()
        except Error:
            pass
    assert lesson.evaluate("window.fixtureSubmissions") == 0

    mode = "offline"
    analyse.click()
    expect(status).to_contain_text("недоступен")
    mode = "limited"
    analyse.click()
    expect(status).to_contain_text("Повторите после")
    mode = "normal"
    lesson.goto(ASSESSMENT)
    analyse.click()
    choose = panel.get_by_role("button", name="Выбрать на странице")
    expect(choose).to_be_visible()
    choose.click()
    expect(status).to_contain_text("Ответ выбран")
    expect(lesson.get_by_role("radio", name="5")).to_be_checked()
    assert lesson.evaluate("window.finished !== true")
    panel.get_by_text("Автопрохождение", exact=True).click()
    count = len(solve_calls)
    panel.get_by_role("button", name="Начать автопрохождение").click()
    expect(status).to_contain_text("Откройте урок")
    assert len(solve_calls) == count
    panel.get_by_text("Автопрохождение", exact=True).click()

    lesson.goto(ASSESSMENT + "-custom")
    analyse.click()
    expect(status).to_contain_text("Не найден блок")
    assert len(solve_calls) == count
    panel.get_by_text("Настройки распознавания", exact=True).click()
    panel.get_by_label("Блок одного вопроса").fill(".exam-card")
    panel.get_by_label("Текст вопроса").fill(".exam-prompt")
    panel.get_by_label("Варианты ответа").fill(".exam-choice")
    panel.get_by_role("button", name="Сохранить для этого раздела").click()
    expect(status).to_contain_text("Распознавание сохранено")
    panel.get_by_text("Настройки распознавания", exact=True).click()
    analyse.click()
    expect(choose).to_be_visible()

    lesson.goto(LESSON)
    lesson.locator(".question").first.evaluate("""element => {
        const canvas = document.createElement('canvas');
        canvas.width = 160;
        canvas.height = 100;
        canvas.getContext('2d').fillRect(20, 20, 100, 50);
        element.append(canvas);
    }""")
    analyse.click()
    expect(submit).to_be_visible()
    assert solve_calls[-1]["image"].startswith("data:image/jpeg;base64,")
    submit.click()
    expect(status).to_contain_text("Beyim подтвердил ответ")
    assert lesson.evaluate("window.fixtureSubmissions") == 1
    panel.get_by_text("Автопрохождение", exact=True).click()
    panel.get_by_role("button", name="Начать автопрохождение").click()
    expect(status).to_contain_text("Подтверждено за этот запуск: 3")
    assert lesson.evaluate("window.fixtureSubmissions") == 4
    print("OK: beta installation, activation, preview, cancellation, limits, assessment, custom CSS, image and autoplay")


if __name__ == "__main__":
    main()
