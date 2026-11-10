from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

DATA_DIR = Path(tempfile.mkdtemp(prefix="beyim-api-test-"))
os.environ["BEYIM_DATA_DIR"] = str(DATA_DIR)
os.environ["BEYIM_SECRET_FILE"] = str(DATA_DIR / "secret.key")

from fastapi.testclient import TestClient

from server.app import app


class FakeGroq:
    def __init__(self, settings, api_key=None):
        self.settings = settings
        self.api_key = api_key

    def solve(self, question, stop, image=None):
        return {
            "answer_ids": [1],
            "text_answer": "",
            "explanation": "Тестовый ответ.",
            "confidence": 0.95,
            "needs_help": False,
        }


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.email = f"test-{uuid4().hex}@example.com"
        self.client = TestClient(app)
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)

    def auth(self):
        response = self.client.post(
            "/v1/auth/register",
            json={"email": self.email, "password": "correct-horse"},
        )
        self.assertEqual(response.status_code, 201, response.text)
        token = response.json()["token"]
        return {"Authorization": "Bearer " + token}

    def test_private_network_preflight(self):
        response = self.client.options(
            "/v1/auth/register",
            headers={
                "Origin": "chrome-extension://test",
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "content-type",
                "Access-Control-Request-Private-Network": "true",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers["access-control-allow-private-network"], "true")

    def test_onboarding(self):
        response = self.client.get("/v1/onboarding/groq")
        self.assertEqual(response.status_code, 200)
        self.assertIn("console.groq.com/keys", response.json()["keys_url"])

    def test_register_me_and_groq_key(self):
        headers = self.auth()
        me = self.client.get("/v1/me", headers=headers)
        self.assertEqual(me.status_code, 200)
        self.assertFalse(me.json()["groq_connected"])

        connected = self.client.put("/v1/groq", json={"api_key": "gsk_test_12345678"}, headers=headers)
        self.assertEqual(connected.status_code, 200, connected.text)
        self.assertTrue(connected.json()["connected"])

        me = self.client.get("/v1/me", headers=headers)
        self.assertTrue(me.json()["groq_connected"])
        self.assertTrue(me.json()["groq_hint"].startswith("gsk_"))

    def test_logout_revokes_token(self):
        headers = self.auth()
        logout = self.client.post("/v1/auth/logout", headers=headers)
        self.assertEqual(logout.status_code, 200, logout.text)
        me = self.client.get("/v1/me", headers=headers)
        self.assertEqual(me.status_code, 401)

    def test_solve_requires_groq_key(self):
        headers = self.auth()
        response = self.client.post(
            "/v1/solve",
            json={"question": {"text": "2+2?", "kind": "single", "options": [{"text": "4"}]}},
            headers=headers,
        )
        self.assertEqual(response.status_code, 409)

    def test_solve_with_fake_groq(self):
        headers = self.auth()
        self.client.put("/v1/groq", json={"api_key": "gsk_test_12345678"}, headers=headers)
        with patch("server.app.Groq", FakeGroq):
            response = self.client.post(
                "/v1/solve",
                json={
                    "question": {
                        "text": "2+2?",
                        "kind": "single",
                        "options": [{"text": "4"}, {"text": "5"}],
                    }
                },
                headers=headers,
            )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["answer"]["answer_ids"], [1])


if __name__ == "__main__":
    unittest.main()
