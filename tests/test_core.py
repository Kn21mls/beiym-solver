import json
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from beyim_solver.core import Cancelled, Ollama, Question, Settings, SolverError, validate_answer


def answer(ids=None, **changes):
    value = {"answer_ids": [2] if ids is None else ids, "text_answer": "", "explanation": "Проверено",
             "confidence": 0.95, "needs_help": False}
    value.update(changes)
    return value


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.q = Question("2 + 2?", [{"text": "3"}, {"text": "4"}], "single")

    def test_valid(self):
        self.assertEqual(validate_answer(answer(), self.q, 0.8)["answer_ids"], [2])

    def test_reject_malformed_or_uncertain(self):
        for value in (answer([3]), answer([True]), answer([1, 2]), answer([2, 2]), answer([]),
                      answer(confidence=0.5), answer(needs_help=True), answer(confidence=float("nan")),
                      answer(needs_help="false"), answer(text_answer=None), {}, []):
            with self.subTest(value=value), self.assertRaises(SolverError):
                validate_answer(value, self.q, 0.8)

    def test_text(self):
        q = Question("2 + 2?", [], "text")
        self.assertEqual(validate_answer(answer([], text_answer="4"), q, 0.8)["text_answer"], "4")
        with self.assertRaises(SolverError):
            validate_answer(answer([], text_answer=""), q, 0.8)

    def test_multiple(self):
        self.q.kind = "multiple"
        validate_answer(answer([1, 2]), self.q, 0.8)

    def test_fingerprint_tracks_option_order(self):
        q2 = Question(self.q.text, list(reversed(self.q.options)), self.q.kind)
        self.assertNotEqual(self.q.fingerprint, q2.fingerprint)

    def test_remote_inference_rejected(self):
        for url in ("http://evil.test:11434", "https://127.0.0.1", "http://localhost/api", "http://user:pass@localhost"):
            with self.subTest(url=url), self.assertRaises(SolverError):
                Ollama(Settings(ollama_url=url))

    def test_domain_validation(self):
        for url in ("https://beyim.ai.evil.test", "http://beyim.ai", "https://example.com"):
            with self.subTest(url=url), self.assertRaises(SolverError):
                Settings(url=url).validate()


class TransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path == "/slow":
                    time.sleep(2)
                raw = json.dumps({"models": [{"name": "test"}]}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_models(self):
        client = Ollama(Settings(ollama_url=f"http://127.0.0.1:{self.server.server_port}"))
        self.assertEqual(client.models(), ["test"])

    def test_cancel_in_flight(self):
        client = Ollama(Settings(ollama_url=f"http://127.0.0.1:{self.server.server_port}"))
        stop = threading.Event()
        timer = threading.Timer(0.15, stop.set)
        timer.start()
        started = time.monotonic()
        with self.assertRaises(Cancelled):
            client.request("/slow", stop=stop, timeout=5)
        self.assertLess(time.monotonic() - started, 1.2)
        timer.join()


if __name__ == "__main__":
    unittest.main()
