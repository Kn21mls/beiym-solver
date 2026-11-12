"""Public HTTPS beta API. Run with one worker behind Tailscale Funnel."""

from __future__ import annotations

import argparse
import math
import os
import secrets
import threading
import time
from contextlib import asynccontextmanager
from typing import TypeVar

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field, ValidationError
from starlette.concurrency import run_in_threadpool

from beyim_solver.cloud import Groq, RateLimited
from beyim_solver.core import Question, Settings, SolverError

from . import db, security
from .contracts import QuestionIn, TOKEN_TTL, bearer_token, decode_image

DAY = 86400
MAX_BODY = 4 * 1024 * 1024
PER_INVITE = int(os.environ.get('BEYIM_BETA_PER_INVITE', '10'))
TOTAL = int(os.environ.get('BEYIM_BETA_TOTAL', '50'))
MAX_ACTIVE_INVITES = 5
MODEL = TypeVar("MODEL", bound=BaseModel)
provider_slot = threading.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    if not os.environ.get("GROQ_API_KEY", "").strip():
        raise RuntimeError("Задайте GROQ_API_KEY перед запуском беты.")
    if not 0 < PER_INVITE <= TOTAL:
        raise RuntimeError('Ожидаются лимиты 0 < BEYIM_BETA_PER_INVITE <= BEYIM_BETA_TOTAL.')
    db.init_db()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


class ActivationIn(BaseModel):
    code: str = Field(min_length=1, max_length=128)


def limited(seconds: int, detail: str) -> HTTPException:
    return HTTPException(429, detail, headers={"Retry-After": str(seconds)})


async def read_body(request: Request, model: type[MODEL], limit: int) -> MODEL:
    body = bytearray()
    async for chunk in request.stream():
        if len(body) + len(chunk) > limit:
            raise HTTPException(413, "Задание слишком большое. Откройте одно упражнение и повторите.")
        body.extend(chunk)
    try:
        return model.model_validate_json(body)
    except ValidationError:
        raise HTTPException(422, "Проверьте введённый код или формат задания.") from None


def issue_invite() -> tuple[str, str]:
    invite_id, code = secrets.token_hex(8), security.new_token()
    now = int(time.time())
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        active = conn.execute(
            """SELECT COUNT(*) FROM beta_invites WHERE revoked = 0
               AND (session_expires_at > ? OR (session_hash IS NULL AND expires_at > ?))""",
            (now, now),
        ).fetchone()[0]
        if active >= MAX_ACTIVE_INVITES:
            raise ValueError("Уже есть пять действующих приглашений. Отзовите одно перед выдачей нового.")
        conn.execute(
            "INSERT INTO beta_invites (id, code_hash, expires_at) VALUES (?, ?, ?)",
            (invite_id, security.token_hash(code), now + 7 * DAY),
        )
    return invite_id, code


def activate(code: str) -> dict:
    now = int(time.time())
    minute = now // 60
    session = security.new_token()
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        count = conn.execute("SELECT attempts FROM beta_activation_limit WHERE minute = ?", (minute,)).fetchone()
        if count and count[0] >= 10:
            raise limited(60 - now % 60, "Слишком много попыток активации.")
        conn.execute("DELETE FROM beta_activation_limit WHERE minute < ?", (minute,))
        conn.execute(
            """INSERT INTO beta_activation_limit VALUES (?, 1)
               ON CONFLICT(minute) DO UPDATE SET attempts = attempts + 1""",
            (minute,),
        )
        updated = conn.execute(
            """UPDATE beta_invites SET session_hash = ?, session_expires_at = ?
               WHERE code_hash = ? AND expires_at > ? AND revoked = 0 AND session_hash IS NULL""",
            (security.token_hash(session), now + TOKEN_TTL, security.token_hash(code.strip()), now),
        ).rowcount
    if not updated:
        raise HTTPException(403, "Код недействителен или уже использован. Попросите новый код.")
    return {"token": session, "expires_at": now + TOKEN_TTL}


def current_invite(authorization: str | None = Header(default=None)) -> str:
    token = bearer_token(authorization)
    with db.connect() as conn:
        row = conn.execute(
            """SELECT id FROM beta_invites
               WHERE session_hash = ? AND session_expires_at > ? AND revoked = 0""",
            (security.token_hash(token), int(time.time())),
        ).fetchone()
    if row is None:
        raise HTTPException(401, "Доступ истёк или отозван. Попросите новый код.")
    return row["id"]


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/v1/beta/activate")
async def activation(request: Request) -> dict:
    body = await read_body(request, ActivationIn, 1024)
    return await run_in_threadpool(activate, body.code)


@app.post("/v1/auth/logout")
def logout(invite_id: str = Depends(current_invite)) -> dict:
    with db.connect() as conn:
        conn.execute("UPDATE beta_invites SET revoked = 1 WHERE id = ?", (invite_id,))
    return {"ok": True}


def reserve(invite_id: str) -> None:
    now = int(time.time())
    day = now // DAY
    with db.connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        active = conn.execute(
            "SELECT 1 FROM beta_invites WHERE id = ? AND revoked = 0 AND session_expires_at > ?",
            (invite_id, now),
        ).fetchone()
        if not active:
            raise HTTPException(401, "Доступ истёк или отозван. Попросите новый код.")
        usage = conn.execute(
            "SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(CASE WHEN invite_id = ? THEN requests END), 0) "
            "FROM beta_usage WHERE day = ?",
            (invite_id, day),
        ).fetchone()
        if usage[0] >= TOTAL or usage[1] >= PER_INVITE:
            raise limited(DAY - now % DAY, "Дневной лимит разборов исчерпан.")
        conn.execute("DELETE FROM beta_usage WHERE day < ?", (day,))
        conn.execute(
            "INSERT INTO beta_usage VALUES (?, ?, 1) ON CONFLICT(day, invite_id) DO UPDATE SET requests = requests + 1",
            (day, invite_id),
        )


def solve(question_in: QuestionIn, invite_id: str) -> dict:
    if len(question_in.options) > 30 or sum(len(option.text) for option in question_in.options) > 8000:
        raise HTTPException(422, "Слишком много вариантов для одного разбора.")
    if question_in.kind != "text" and not question_in.options:
        raise HTTPException(422, "Откройте задание с видимыми вариантами ответа.")
    image = decode_image(question_in.image) if question_in.image else None
    question = Question(
        text=question_in.text,
        options=[{"text": option.text} for option in question_in.options],
        kind=question_in.kind,
        has_image=bool(image),
    )
    if not provider_slot.acquire(blocking=False):
        raise limited(5, "Сейчас разбирается другое задание.")
    try:
        reserve(invite_id)
        settings = Settings(provider="groq", timeout=45, num_predict=768, min_confidence=0)
        answer = Groq(settings).solve(question, threading.Event(), image, retry=False)
        return {"answer": answer}
    except RateLimited as exc:
        raise limited(math.ceil(exc.delay), "Временный лимит Groq.") from None
    except SolverError as exc:
        raise HTTPException(502, str(exc)) from None
    finally:
        provider_slot.release()


class SolveRequest(BaseModel):
    question: QuestionIn


@app.post("/v1/solve")
async def solve_request(request: Request, invite_id: str = Depends(current_invite)) -> dict:
    body = await read_body(request, SolveRequest, MAX_BODY)
    return await run_in_threadpool(solve, body.question, invite_id)


def main() -> None:
    parser = argparse.ArgumentParser(description="Управление приглашениями Beyim Solver")
    actions = parser.add_subparsers(dest="action", required=True)
    actions.add_parser("issue")
    actions.add_parser("list")
    revoke = actions.add_parser("revoke")
    revoke.add_argument("invite_id")
    args = parser.parse_args()
    db.init_db()
    if args.action == "issue":
        try:
            invite_id, code = issue_invite()
        except ValueError as exc:
            parser.exit(1, f"{exc}\n")
        print(f"{invite_id}\t{code}")
    elif args.action == "revoke":
        with db.connect() as conn:
            updated = conn.execute("UPDATE beta_invites SET revoked = 1 WHERE id = ?", (args.invite_id,)).rowcount
        if not updated:
            parser.exit(1, "Приглашение не найдено.\n")
    else:
        with db.connect() as conn:
            for row in conn.execute("SELECT id, expires_at, session_expires_at, revoked FROM beta_invites ORDER BY rowid"):
                print(*row, sep="\t")


if __name__ == "__main__":
    main()
