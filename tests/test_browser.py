import threading
import unittest
from pathlib import Path

from playwright.sync_api import sync_playwright

from beyim_solver.browser import Browser, Runner
from beyim_solver.core import Cancelled, Settings, SolverError


class FixtureBrowser(Browser):
    """Only fixture tests bypass the production domain guard."""
    def assert_site(self):
        if self.page.url != "about:blank":
            raise AssertionError("Fixture attempted navigation to an external site")


class FakeModel:
    def __init__(self, stop=None):
        self.stop = stop

    def solve(self, q, stop, image=None):
        if self.stop:
            self.stop.set()
        ids = [1, 3] if q.kind == "multiple" else [2]
        return {"answer_ids": ids, "text_answer": "", "confidence": 1,
                "needs_help": False, "explanation": "Fixture"}


class BrowserTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw = sync_playwright().start()
        cls.engine = cls.pw.chromium.launch(channel="msedge", headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.engine.close()
        cls.pw.stop()

    def setUp(self):
        self.page = self.engine.new_page()
        self.page.set_default_timeout(3500)
        self.page.set_content(Path(__file__).with_name("lesson.html").read_text(encoding="utf-8"))
        self.settings = Settings(transition_timeout=1)
        self.browser = FixtureBrowser(self.settings)
        self.browser.page = self.page
        self.stop = threading.Event()

    def tearDown(self):
        self.page.close()

    def test_complete_three_questions(self):
        runner = Runner(self.browser, FakeModel(), self.settings, self.stop, lambda _: None)
        runner.run(5)
        self.assertTrue(self.browser.complete())
        self.assertEqual(self.page.evaluate("submissions"), 3)

    def test_no_duplicate_submission_after_failure(self):
        self.page.evaluate("() => { window.checkAnswer = () => { submissions++; }; }")
        runner = Runner(self.browser, FakeModel(), self.settings, self.stop, lambda _: None)
        with self.assertRaises(SolverError):
            runner.run(2)
        with self.assertRaises(SolverError):
            runner.run(2)
        self.assertEqual(self.page.evaluate("submissions"), 1)

    def test_stale_answer_does_not_select(self):
        q = self.browser.read()
        self.page.locator("legend").evaluate("e => e.textContent='Другой вопрос'")
        with self.assertRaises(SolverError):
            self.browser.apply(q, {"answer_ids": [2]}, self.stop)
        self.assertEqual(self.page.locator("input:checked").count(), 0)

    def test_cancel_before_click(self):
        runner = Runner(self.browser, FakeModel(self.stop), self.settings, self.stop, lambda _: None)
        with self.assertRaises(Cancelled):
            runner.run(1)
        self.assertEqual(self.page.locator("input:checked").count(), 0)
        self.assertEqual(self.page.evaluate("submissions"), 0)

    def test_ambiguous_questions_rejected(self):
        self.page.locator("fieldset").evaluate("e => e.after(e.cloneNode(true))")
        with self.assertRaises(SolverError):
            self.browser.read()

    def test_text_answer(self):
        self.page.set_content('<fieldset id="q"><legend>2+2?</legend><input id="answer" type="text"></fieldset>')
        self.settings.selectors.update(root="#q", input="#answer")
        q = self.browser.read()
        self.browser.apply(q, {"text_answer": "4"}, self.stop)
        self.assertEqual(self.page.locator("#answer").input_value(), "4")

    def test_checkbox_clears_old_selection(self):
        self.page.evaluate("index=1;render()")
        self.page.locator('input[value="3"]').check()
        q = self.browser.read()
        self.browser.apply(q, {"answer_ids": [1, 3]}, self.stop)
        self.assertEqual(self.page.locator("input:checked").evaluate_all("es => es.map(e=>e.value)"), ["2", "4"])

    def test_image_detection(self):
        self.page.locator("fieldset").evaluate("e => e.insertAdjacentHTML('beforeend','<canvas width=300 height=150></canvas>')")
        self.assertTrue(self.browser.read().has_image)

    def test_mixed_groups_rejected(self):
        self.page.locator('input[value="7"]').evaluate("e => e.name='other'")
        with self.assertRaises(SolverError):
            self.browser.read()

    def test_real_beyim_structure_hidden_inputs_and_carousels(self):
        self.page.set_content(Path(__file__).with_name("beyim_activity.html").read_text(encoding="utf-8"))
        q = self.browser.read()
        self.assertEqual(q.adapter, "beyim-activity")
        self.assertEqual([o['text'] for o in q.options], ['4', '5', '6'])
        runner = Runner(self.browser, FakeModel(), self.settings, self.stop, lambda _: None)
        runner.run(10)
        self.assertTrue(self.browser.complete())
        self.assertEqual(self.page.evaluate('window.fixtureSubmissions'), 4)

    def test_beyim_resumes_and_does_not_repeat_completed(self):
        self.page.set_content(Path(__file__).with_name("beyim_activity.html").read_text(encoding="utf-8"))
        self.page.locator('label').nth(1).evaluate("e => e.classList.add('answerTrue')")
        runner = Runner(self.browser, FakeModel(), self.settings, self.stop, lambda _: None)
        runner.run(10)
        self.assertEqual(self.page.evaluate('window.fixtureSubmissions'), 3)

    def test_beyim_stops_after_incorrect_answer(self):
        self.page.set_content(Path(__file__).with_name("beyim_activity.html").read_text(encoding="utf-8"))
        class WrongModel(FakeModel):
            def solve(self, *args, **kwargs):
                value = super().solve(*args, **kwargs)
                value['answer_ids'] = [1]
                return value
        runner = Runner(self.browser, WrongModel(), self.settings, self.stop, lambda _: None)
        with self.assertRaises(SolverError):
            runner.run(10)
        self.assertEqual(self.page.evaluate('window.fixtureSubmissions'), 1)


if __name__ == "__main__":
    unittest.main()
