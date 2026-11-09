import json
import threading
import time
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from beyim_solver.core import ANSWER_SCHEMA, Cancelled, Ollama, Question, Settings, SolverError, answer_schema, validate_answer


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


class ModelResponseTests(unittest.TestCase):
    def setUp(self):
        self.q = Question("3x + 7 = 22. x?", [{"text": "3"}, {"text": "5"}, {"text": "7"}], "single")

    def client(self, responses, stop=None):
        class Stub(Ollama):
            def __init__(self):
                super().__init__(Settings())
                self.calls = []

            def request(self, path, body=None, *args, **kwargs):
                if path == "/api/ps":
                    return {"models": []}
                if path == "/api/generate":
                    return {}
                if path == "/api/show":
                    return {"capabilities": ["thinking"]}
                self.calls.append(json.loads(json.dumps(body)))
                response = responses[len(self.calls) - 1]
                if stop:
                    stop.set()
                return {"message": {"content": json.dumps(response)}, "done_reason": "stop"}
        return Stub()

    def test_single_choice_constrains_ids_not_numeric_answer(self):
        schema = answer_schema(self.q)
        ids = schema['properties']['answer_ids']
        self.assertEqual(ids['items']['enum'], [1, 2, 3])
        self.assertEqual((ids['minItems'], ids['maxItems']), (1, 1))
        self.assertEqual(schema['properties']['text_answer']['enum'], [''])
        self.assertEqual(next(iter(schema['properties'])), 'explanation')
        self.assertNotIn('enum', ANSWER_SCHEMA['properties']['answer_ids']['items'])

    def test_multiple_and_text_have_separate_schemas(self):
        self.q.kind = 'multiple'
        self.assertEqual(answer_schema(self.q)['properties']['answer_ids']['maxItems'], 3)
        self.q.kind, self.q.options = 'text', []
        schema = answer_schema(self.q)
        self.assertEqual(schema['properties']['answer_ids']['maxItems'], 0)
        self.assertNotIn('enum', schema['properties']['text_answer'])

    def test_reproduced_empty_ids_get_one_format_repair(self):
        client = self.client([answer([], text_answer='5'), answer([2])])
        result = client.solve(self.q, threading.Event())
        self.assertEqual(result['answer_ids'], [2])
        self.assertEqual(len(client.calls), 2)
        self.assertEqual(client.calls[1]['messages'][-2]['role'], 'assistant')
        self.assertFalse(client.calls[0]['think'])

    def test_invalid_repair_stops_after_two_calls(self):
        client = self.client([answer([], text_answer='5'), answer([8])])
        with self.assertRaises(SolverError):
            client.solve(self.q, threading.Event())
        self.assertEqual(len(client.calls), 2)

    def test_uncertain_response_is_not_retried(self):
        client = self.client([answer(confidence=0.3)])
        with self.assertRaises(SolverError):
            client.solve(self.q, threading.Event())
        self.assertEqual(len(client.calls), 1)

    def test_cancel_before_repair(self):
        stop = threading.Event()
        client = self.client([answer([], text_answer='5')], stop)
        with self.assertRaises(Cancelled):
            client.solve(self.q, stop)
        self.assertEqual(len(client.calls), 1)


class VisionRoutingTests(unittest.TestCase):
    def setUp(self):
        self.client = Ollama(Settings())
        self.stop = threading.Event()

    def test_text_model_routes_to_installed_vision_model(self):
        def respond(path, body=None, *args, **kwargs):
            if path == '/api/tags':
                return {'models': [{'name': 'qwen3:1.7b'}, {'name': 'qwen3-vl:2b'}]}
            return {'capabilities': ['vision'] if body['model'] == 'qwen3-vl:2b' else ['completion']}
        with patch.object(self.client, 'request', side_effect=respond):
            routed = self.client.for_image(self.stop)
        self.assertEqual(routed.settings.model, 'qwen3-vl:2b')
        self.assertEqual(routed.settings.timeout, 420)
        self.assertEqual(self.client.settings.model, 'qwen3:1.7b')

    def test_selected_vision_model_is_preserved(self):
        with patch.object(self.client, 'request', return_value={'capabilities': ['vision']}):
            routed = self.client.for_image(self.stop)
        self.assertEqual(routed.settings.model, self.client.settings.model)

    def test_missing_vision_model_gives_install_command(self):
        with patch.object(self.client, 'request', side_effect=[{'capabilities': ['completion']}, {'models': []}]):
            with self.assertRaisesRegex(SolverError, 'ollama pull qwen3-vl:2b'):
                self.client.for_image(self.stop)

    def test_wrong_fallback_does_not_send_image(self):
        with patch.object(self.client, 'request', side_effect=[
            {'capabilities': ['completion']}, {'models': [{'name': 'qwen3-vl:2b'}]}, {'capabilities': ['completion']}
        ]):
            with self.assertRaisesRegex(SolverError, 'не поддерживает изображения'):
                self.client.for_image(self.stop)

if __name__ == "__main__":
    unittest.main()
