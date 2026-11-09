import subprocess
import sys
import threading
import unittest
from unittest.mock import patch


from beyim_solver.core import ROOT, Cancelled, Ollama, Question, Settings, SolverError
from beyim_solver.resources import inference_slot


class ResourceTests(unittest.TestCase):
    def test_cross_process_lock_is_released(self):
        code = 'from beyim_solver.resources import inference_slot\nwith inference_slot(): pass'
        with inference_slot():
            result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
        result = subprocess.run([sys.executable, '-c', code], cwd=ROOT, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_memory_limits_and_cleanup_even_when_cancelled(self):
        client = Ollama(Settings())
        calls = []
        stop = threading.Event()
        def request(path, body=None, *args, **kwargs):
            calls.append((path, body))
            if path == '/api/ps':
                return {'models': [{'name': 'qwen3-vl:4b'}]}
            if path == '/api/show':
                return {'capabilities': ['thinking']}
            if path == '/api/chat':
                self.assertEqual(body['keep_alive'], 0)
                self.assertEqual(body['options']['num_ctx'], 4096)
                self.assertEqual(body['options']['num_predict'], 768)
                self.assertFalse(body['think'])
                stop.set()
                raise Cancelled('test')
            return {}
        with patch.object(client, 'request', side_effect=request), self.assertRaises(Cancelled):
            client.solve(Question('2+2', [], 'text'), stop)
        self.assertEqual(calls[1], ('/api/generate', {'model': 'qwen3-vl:4b', 'keep_alive': 0}))
        self.assertEqual(calls[-1], ('/api/generate', {'model': 'qwen3:1.7b', 'keep_alive': 0}))
        with inference_slot():
            pass

    def test_other_app_model_is_not_unloaded(self):
        client = Ollama(Settings())
        with patch.object(client, 'request', return_value={'models': [{'name': 'other:8b'}]}) as request:
            with self.assertRaisesRegex(SolverError, 'другая модель'):
                client.solve(Question('2+2', [], 'text'), threading.Event())
        self.assertEqual(request.call_count, 1)


if __name__ == '__main__':
    unittest.main()
