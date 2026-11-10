from __future__ import annotations

import base64
import binascii
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from beyim_solver.cloud import Groq, RateLimited
from beyim_solver.core import Question, Settings, SolverError

from . import db, security

TOKEN_TTL = 30 * 24 * 60 * 60
MAX_IMAGE_BYTES = 8 * 1024 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init_db()
    yield


app = FastAPI(title="Beyim Solver API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_private_network=True,
)


class RegisterIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=200)


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=200)


class GroqKeyIn(BaseModel):
    api_key: str = Field(min_length=8, max_length=500)


class OptionIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class QuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    options: list[OptionIn] = Field(default_factory=list)
    kind: Literal["single", "multiple", "text"]
    image: str | None = None


class SolveIn(BaseModel):
    question: QuestionIn
    model: str | None = Field(default=None, max_length=200)
    min_confidence: float = Field(default=0.8, ge=0, le=1)
    timeout: float = Field(default=180, ge=10, le=180)
    num_predict: int = Field(default=768, ge=64, le=4096)


def normalize_email(value: str) -> str:
    email = value.strip().lower()
    if "@" not in email or email.startswith("@") or email.endswith("@") or " " in email:
        raise HTTPException(422, "Укажите корректный email.")
    return email


def issue_token(connection: sqlite3.Connection, user_id: int) -> str:
    token = security.new_token()
    connection.execute(
        "INSERT INTO tokens(token_hash, user_id, expires_at) VALUES(?, ?, ?)",
        (security.token_hash(token), user_id, int(time.time()) + TOKEN_TTL),
    )
    return token


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Требуется вход.")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Требуется вход.")
    return token


def current_user(authorization: str | None = Header(default=None)) -> dict[str, Any]:
    token = bearer_token(authorization)
    with db.connect() as connection:
        row = connection.execute(
            """
            SELECT u.id, u.email, u.groq_key, u.groq_hint
            FROM tokens t JOIN users u ON u.id = t.user_id
            WHERE t.token_hash = ? AND t.expires_at > ?
            """,
            (security.token_hash(token), int(time.time())),
        ).fetchone()
    if row is None:
        raise HTTPException(401, "Сессия истекла. Войдите снова.")
    return dict(row)


def user_payload(user: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": user["id"],
        "email": user["email"],
        "groq_connected": bool(user.get("groq_key")),
        "groq_hint": user.get("groq_hint") or "",
    }


def decode_image(value: str) -> str:
    data = value.strip()
    if data.startswith("data:"):
        if "," not in data:
            raise HTTPException(422, "Некорректное изображение.")
        data = data.split(",", 1)[1]
    try:
        raw = base64.b64decode(data, validate=True)
    except (ValueError, binascii.Error):
        raise HTTPException(422, "Некорректное изображение.") from None
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Изображение слишком большое.")
    return base64.b64encode(raw).decode("ascii")


@app.get("/health")
def health() -> dict[str, bool]:
    return {"ok": True}


@app.get("/v1/onboarding/groq")
def groq_onboarding() -> dict[str, Any]:
    return {
        "signup_url": "https://console.groq.com/login",
        "keys_url": "https://console.groq.com/keys",
        "steps": [
            "Зарегистрируйтесь или войдите в Groq Console.",
            "Откройте API Keys и нажмите Create API Key.",
            "Скопируйте ключ gsk_… и вставьте его в Beyim Solver.",
        ],
        "note": "Groq не позволяет создавать ключи программно — это делается вручную в консоли.",
    }


@app.post("/v1/auth/register", status_code=201)
def register(body: RegisterIn) -> dict[str, Any]:
    email = normalize_email(body.email)
    digest, salt = security.hash_password(body.password)
    with db.connect() as connection:
        try:
            cursor = connection.execute(
                "INSERT INTO users(email, password_hash, salt, created_at) VALUES(?, ?, ?, ?)",
                (email, digest, salt, int(time.time())),
            )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Этот email уже зарегистрирован.") from None
        user_id = int(cursor.lastrowid)
        token = issue_token(connection, user_id)
    return {"token": token, "user": {"id": user_id, "email": email}}


@app.post("/v1/auth/login")
def login(body: LoginIn) -> dict[str, Any]:
    email = normalize_email(body.email)
    with db.connect() as connection:
        row = connection.execute(
            "SELECT id, email, password_hash, salt FROM users WHERE email = ?",
            (email,),
        ).fetchone()
        if row is None or not security.verify_password(body.password, row["password_hash"], row["salt"]):
            raise HTTPException(401, "Неверный email или пароль.")
        token = issue_token(connection, int(row["id"]))
    return {"token": token, "user": {"id": int(row["id"]), "email": row["email"]}}


@app.post("/v1/auth/logout")
def logout(authorization: str | None = Header(default=None)) -> dict[str, bool]:
    token = bearer_token(authorization)
    with db.connect() as connection:
        connection.execute(
            "DELETE FROM tokens WHERE token_hash = ?",
            (security.token_hash(token),),
        )
    return {"ok": True}


@app.get("/v1/me")
def me(user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    return user_payload(user)


@app.put("/v1/groq")
def connect_groq(body: GroqKeyIn, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    key = body.api_key.strip()
    if any(ord(char) < 33 or ord(char) > 126 for char in key):
        raise HTTPException(422, "В API-ключе есть недопустимые символы.")
    encrypted = security.encrypt_key(key)
    hint = security.key_hint(key)
    with db.connect() as connection:
        connection.execute(
            "UPDATE users SET groq_key = ?, groq_hint = ? WHERE id = ?",
            (encrypted, hint, user["id"]),
        )
    return {"connected": True, "hint": hint}


@app.delete("/v1/groq")
def disconnect_groq(user: dict[str, Any] = Depends(current_user)) -> dict[str, bool]:
    with db.connect() as connection:
        connection.execute(
            "UPDATE users SET groq_key = NULL, groq_hint = NULL WHERE id = ?",
            (user["id"],),
        )
    return {"connected": False}


@app.post("/v1/solve")
def solve(body: SolveIn, user: dict[str, Any] = Depends(current_user)) -> dict[str, Any]:
    if not user.get("groq_key"):
        raise HTTPException(409, "Сначала подключите Groq API-ключ.")
    try:
        api_key = security.decrypt_key(user["groq_key"])
    except Exception:
        raise HTTPException(500, "Не удалось прочитать сохранённый ключ Groq.") from None

    question_in = body.question
    if question_in.kind in ("single", "multiple") and not question_in.options:
        raise HTTPException(422, "Для выбора вариантов нужен хотя бы один вариант.")
    image = decode_image(question_in.image) if question_in.image else None
    question = Question(
        text=question_in.text,
        options=[{"text": option.text} for option in question_in.options],
        kind=question_in.kind,
        has_image=bool(image),
    )
    settings = Settings(
        provider="groq",
        groq_model=body.model or Settings().groq_model,
        min_confidence=body.min_confidence,
        timeout=body.timeout,
        num_predict=body.num_predict,
    )
    try:
        answer = Groq(settings, api_key=api_key).solve(question, threading.Event(), image)
    except RateLimited as exc:
        raise HTTPException(429, str(exc)) from exc
    except SolverError as exc:
        message = str(exc)
        code = 401 if "отклонил доступ" in message or "API-ключ" in message else 422
        raise HTTPException(code, message) from exc
    return {"answer": answer}
