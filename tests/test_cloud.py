import copy
import http.client
import json
import os
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from beyim_solver.cloud import Groq, OpenRouter, RateLimited, create_client, selected_model, _cache
from beyim_solver.core import Settings, Question, SolverError, Cancelled, ROOT


def result(ids=None, **changes):
    answer = dict(answer_ids=[2] if ids is None else ids, text_answer='',
                  explanation='Проверено', confidence=1, needs_help=False)
    answer.update(changes)
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(answer)}}]}


class CloudTests(unittest.TestCase):
    def setUp(self):
        _cache.clear()
        self.client = Groq(Settings(), api_key='fake-test-key')
        self.q = Question('2+2?', [{'text':'3'}, {'text':'4'}], 'single')
        self.stop = threading.Event()

    def test_missing_key_and_local_mode(self):
        with patch.dict('os.environ', {}, clear=True), self.assertRaisesRegex(SolverError, 'API-ключ'):
            create_client(Settings())
        self.assertEqual(type(create_client(Settings(provider='ollama'))).__name__, 'Ollama')

    def test_cache_distinguishes_images_options_and_model(self):
        bodies = []
        def request(path, body, *args):
            bodies.append(copy.deepcopy(body))
            return result()
        with patch.object(self.client, 'request', side_effect=request):
            self.client.solve(self.q, self.stop)
            self.client.solve(self.q, self.stop)
            self.client.solve(self.q, self.stop, 'image-one')
            self.client.solve(self.q, self.stop, 'image-two')
            self.q.options.reverse()
            self.client.solve(self.q, self.stop)
            self.client.settings.groq_model = 'another-model'
            self.client.solve(self.q, self.stop)
        self.assertEqual(len(bodies), 5)
        self.assertEqual(bodies[0]['reasoning_effort'], 'none')
        self.assertEqual(len(bodies[0]['messages'][1]['content']), 1)
        self.assertEqual(bodies[1]['messages'][1]['content'][1]['image_url']['url'], 'data:image/jpeg;base64,image-one')
        self.assertNotIn('reasoning_effort', bodies[-1])

    def test_cache_revalidates_confidence(self):
        with patch.object(self.client, 'request', return_value=result(confidence=0.85)) as req:
            self.client.solve(self.q, self.stop)
            self.client.settings.min_confidence = 0.9
            with self.assertRaises(SolverError): self.client.solve(self.q, self.stop)
        self.assertEqual(req.call_count, 1)

    def test_bad_format_has_one_repair_but_uncertainty_does_not(self):
        with patch.object(self.client, 'request', side_effect=[result(ids=[]), result()]) as req:
            self.client.solve(self.q, self.stop)
            self.assertEqual(req.call_count, 2)
        _cache.clear()
        with patch.object(self.client, 'request', return_value=result(confidence=0.3)) as req:
            with self.assertRaises(SolverError): self.client.solve(self.q, self.stop)
            self.assertEqual(req.call_count, 1)
            self.assertFalse(_cache)

    def test_rate_limit_retries_and_long_limit_stops(self):
        with patch.object(self.client, 'request', side_effect=[RateLimited(0.01), result()]) as req:
            self.client.solve(self.q, self.stop)
            self.assertEqual(req.call_count, 2)
        _cache.clear()
        with patch.object(self.client, 'request', side_effect=RateLimited(86400)) as req:
            with self.assertRaises(SolverError): self.client.solve(self.q, self.stop)
            self.assertEqual(req.call_count, 1)

    def test_stop_interrupts_limit_wait(self):
        timer = threading.Timer(0.1, self.stop.set)
        timer.start()
        started = time.monotonic()
        with patch.object(self.client, 'request', side_effect=RateLimited(20)), self.assertRaises(Cancelled):
            self.client.solve(self.q, self.stop)
        timer.join()
        self.assertLess(time.monotonic() - started, 1)


class CloudTransportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.status = 200
        cls.delay = 0
        cls.calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_GET(self): self.respond(None)
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                self.respond(body)
            def respond(self, body):
                cls.calls.append((self.path, self.headers.get('Authorization'), body))
                time.sleep(cls.delay)
                if body:
                    question = json.loads(body['messages'][1]['content'][0]['text'])
                    payload = result(ids=[1, 3] if question['type'] == 'multiple' else [2])
                else:
                    payload = {'data': [{'id': Settings().groq_model}]}
                if cls.status != 200: payload = {'error': 'fake-test-key must never appear in errors'}
                raw = json.dumps(payload).encode()
                self.send_response(cls.status)
                self.send_header('Content-Length', str(len(raw)))
                self.send_header('retry-after', '10')
                self.end_headers()
                try: self.wfile.write(raw)
                except OSError: pass
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        type(self).status, type(self).delay = 200, 0
        self.calls.clear()
        _cache.clear()
        self.client = Groq(Settings(), api_key='fake-test-key')
        def connection(host, timeout):
            self.assertEqual(host, 'api.groq.com')
            return http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=timeout)
        self.patcher = patch('beyim_solver.cloud.http.client.HTTPSConnection', side_effect=connection)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)

    def test_auth_and_models(self):
        self.assertEqual(self.client.models(), [Settings().groq_model])
        self.assertEqual(self.calls[0][:2], ('/openai/v1/models', 'Bearer fake-test-key'))

    def test_http_errors_are_sanitized_and_retry_header_parsed(self):
        for status in [401, 403, 400, 500, 429]:
            type(self).status = status
            with self.assertRaises(SolverError) as error: self.client.models()
            self.assertNotIn('fake-test-key', str(error.exception))
            if status == 429: self.assertEqual(error.exception.delay, 10)

    def test_inflight_cancel(self):
        type(self).delay = 1
        stop = threading.Event()
        timer = threading.Timer(0.1, stop.set)
        timer.start()
        with self.assertRaises(Cancelled): self.client.models(stop)
        timer.join()

    def test_text_and_image_browser_cycle_without_ollama(self):
        from playwright.sync_api import sync_playwright
        from beyim_solver.browser import Browser, Runner
        class LocalBrowser(Browser):
            def assert_site(self):
                if self.page.url != 'about:blank': raise AssertionError('External navigation')
        settings = Settings(transition_timeout=2)
        with sync_playwright() as pw:
            engine = pw.chromium.launch(channel='msedge' if os.name == 'nt' else None, headless=True)
            try:
                page = engine.new_page()
                browser = LocalBrowser(settings, lambda _: None)
                browser.page = page
                page.set_content((ROOT/'tests'/'lesson.html').read_text(encoding='utf-8'))
                Runner(browser, self.client, settings, threading.Event(), lambda _: None).run(3)
                self.assertTrue(browser.complete())
                self.assertEqual(page.evaluate('submissions'), 3)
                page.set_content((ROOT/'tests'/'vision.html').read_text(encoding='utf-8'))
                Runner(browser, self.client, settings, threading.Event(), lambda _: None).run(1)
                self.assertTrue(browser.complete())
                self.assertEqual(page.evaluate('window.submitted'), 1)
                self.assertTrue(self.calls[-1][2]['messages'][1]['content'][1]['image_url']['url'].startswith('data:image/jpeg;base64,'))
            finally: engine.close()


class _FakeResponse:
    def __init__(self, payload, status=200):
        self._raw = json.dumps(payload).encode()
        self.status = status

    def read(self, _size=-1):
        return self._raw

    def getheader(self, _name, default=None):
        return default


class _FakeConnection:
    calls = []
    status = 200
    payload = {'data': [{'id': 'qwen/qwen3.8-27b'}]}

    def __init__(self, host, timeout):
        self.host = host
        self.sock = None

    def request(self, method, path, body, headers):
        type(self).calls.append((self.host, method, path, headers))

    def getresponse(self):
        return _FakeResponse(type(self).payload, type(self).status)

    def close(self):
        pass


class OpenRouterTests(unittest.TestCase):
    def setUp(self):
        _cache.clear()
        self.settings = Settings(provider='openrouter', openrouter_model='qwen/qwen3.8-27b')
        self.client = OpenRouter(self.settings, api_key='fake-test-key')
        self.q = Question('2+2?', [{'text': '3'}, {'text': '4'}], 'single')
        self.stop = threading.Event()

    def test_create_client_and_selected_model(self):
        with patch.dict('os.environ', {'OPENROUTER_API_KEY': 'env-key'}, clear=True):
            client = create_client(self.settings)
        self.assertIsInstance(client, OpenRouter)
        self.assertEqual(selected_model(self.settings), 'qwen/qwen3.8-27b')
        self.assertEqual(selected_model(Settings(provider='groq', groq_model='g')), 'g')
        self.assertEqual(selected_model(Settings(provider='ollama', model='m')), 'm')

    def test_missing_key(self):
        with patch.dict('os.environ', {}, clear=True), self.assertRaisesRegex(SolverError, 'API-ключ'):
            OpenRouter(self.settings)

    def test_transport_uses_openrouter_origin_and_attribution(self):
        _FakeConnection.calls.clear()
        with patch('beyim_solver.cloud.http.client.HTTPSConnection', _FakeConnection):
            self.assertEqual(self.client.models(), ['qwen/qwen3.8-27b'])
        host, method, path, headers = _FakeConnection.calls[0]
        self.assertEqual(host, 'openrouter.ai')
        self.assertEqual(method, 'GET')
        self.assertEqual(path, '/api/v1/models')
        self.assertEqual(headers['Authorization'], 'Bearer fake-test-key')
        self.assertEqual(headers['X-Title'], 'Beyim Solver')

    def test_payment_required_explains_credits(self):
        _FakeConnection.calls.clear()
        _FakeConnection.status = 402
        self.addCleanup(setattr, _FakeConnection, 'status', 200)
        with patch('beyim_solver.cloud.http.client.HTTPSConnection', _FakeConnection):
            with self.assertRaisesRegex(SolverError, 'недостаточно кредитов'):
                self.client.models()

    def test_solve_uses_openrouter_model_and_sends_images(self):
        bodies = []

        def request(path, body, *args):
            bodies.append(copy.deepcopy(body))
            return result()

        with patch.object(self.client, 'request', side_effect=request):
            self.client.solve(self.q, self.stop)
            self.client.solve(self.q, self.stop, 'image-one')
        self.assertEqual(bodies[0]['model'], 'qwen/qwen3.8-27b')
        self.assertNotIn('reasoning_effort', bodies[0])
        self.assertEqual(len(bodies[0]['messages'][1]['content']), 1)
        self.assertEqual(bodies[1]['messages'][1]['content'][1]['image_url']['url'],
                         'data:image/jpeg;base64,image-one')

    def test_thinking_requests_high_reasoning(self):
        self.settings.thinking = True
        bodies = []
        with patch.object(self.client, 'request',
                          side_effect=lambda path, body, *a: bodies.append(body) or result()):
            self.client.solve(self.q, self.stop)
        self.assertEqual(bodies[0]['reasoning'], {'effort': 'high'})
