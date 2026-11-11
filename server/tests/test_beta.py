from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import beta, db, security


QUESTION = {"question": {"kind": "single", "text": "3 + 2?", "options": [{"text": "5"}]}}
ANSWER = {"answer_ids": [1], "text_answer": "", "explanation": "3 + 2 = 5.", "confidence": 0.95, "needs_help": False}


class BetaTests(unittest.TestCase):
    def setUp(self):
        temporary = self.enterContext(TemporaryDirectory())
        self.enterContext(patch.object(db, "DB_PATH", Path(temporary) / "beta.sqlite"))
        self.enterContext(patch.dict("os.environ", {"GROQ_API_KEY": "fake-test-key"}))
        self.groq = self.enterContext(patch.object(beta, "Groq"))
        self.groq.return_value.solve.return_value = ANSWER
        self.client = self.enterContext(TestClient(beta.app))

    def activate(self):
        invite_id, code = beta.issue_invite()
        response = self.client.post("/v1/beta/activate", json={"code": code})
        self.assertEqual(response.status_code, 200, response.text)
        return invite_id, code, {"Authorization": "Bearer " + response.json()["token"]}

    def test_activation_is_single_use_and_revocable(self):
        invite_id, code, headers = self.activate()
        self.assertEqual(self.client.post("/v1/beta/activate", json={"code": code}).status_code, 403)
        self.assertEqual(self.client.post("/v1/auth/register", json={}).status_code, 404)
        self.assertEqual(self.client.post("/v1/solve", json=QUESTION, headers=headers).json(), {"answer": ANSWER})
        with db.connect() as conn:
            row = conn.execute("SELECT * FROM beta_invites WHERE id = ?", (invite_id,)).fetchone()
        self.assertEqual(row["code_hash"], security.token_hash(code))
        self.assertEqual(row["session_hash"], security.token_hash(headers["Authorization"][7:]))
        self.assertEqual(self.client.post("/v1/auth/logout", headers=headers).status_code, 200)
        self.assertEqual(self.client.post("/v1/solve", json=QUESTION, headers=headers).status_code, 401)

    def test_expiry(self):
        _, code = beta.issue_invite()
        _, _, headers = self.activate()
        with patch.object(beta.time, "time", return_value=4_000_000_000):
            self.assertEqual(self.client.post("/v1/beta/activate", json={"code": code}).status_code, 403)
            self.assertEqual(self.client.post("/v1/solve", json=QUESTION, headers=headers).status_code, 401)

    def test_invalid_codes_are_throttled(self):
        with patch.object(beta.time, "time", return_value=1234560):
            for _ in range(10):
                self.assertEqual(self.client.post("/v1/beta/activate", json={"code": "invalid"}).status_code, 403)
            response = self.client.post("/v1/beta/activate", json={"code": "invalid"})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers["Retry-After"], "60")

    def test_concurrent_reservations_cannot_exceed_limits(self):
        first, _, _ = self.activate()
        second, _, _ = self.activate()
        with patch.object(beta, "PER_INVITE", 2), patch.object(beta, "TOTAL", 3), ThreadPoolExecutor(6) as pool:
            results = list(pool.map(lambda invite: self.reserve_status(invite), [first] * 6))
            self.assertEqual(results.count(200), 2)
            results = list(pool.map(lambda invite: self.reserve_status(invite), [second] * 6))
            self.assertEqual(results.count(200), 1)

    @staticmethod
    def reserve_status(invite):
        try:
            beta.reserve(invite)
            return 200
        except beta.HTTPException as exc:
            return exc.status_code

    def test_busy_provider_and_quota(self):
        _, _, headers = self.activate()
        with beta.provider_slot:
            response = self.client.post("/v1/solve", json=QUESTION, headers=headers)
        self.assertEqual(response.status_code, 429)
        self.groq.assert_not_called()
        self.groq.return_value.solve.side_effect = beta.RateLimited(12)
        response = self.client.post("/v1/solve", json=QUESTION, headers=headers)
        self.assertEqual(response.headers["Retry-After"], "12")
        self.assertFalse(self.groq.return_value.solve.call_args.kwargs["retry"])

    def test_limits_body_and_invites(self):
        _, _, headers = self.activate()
        with patch.object(beta, "MAX_BODY", 10):
            self.assertEqual(self.client.post("/v1/solve", json=QUESTION, headers=headers).status_code, 413)
        for _ in range(4):
            beta.issue_invite()
        with self.assertRaises(ValueError):
            beta.issue_invite()
