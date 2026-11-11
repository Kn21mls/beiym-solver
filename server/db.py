from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("BEYIM_DATA_DIR", ROOT / "data"))
DB_PATH = Path(os.environ.get("BEYIM_DB", DATA_DIR / "app.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    groq_key TEXT,
    groq_hint TEXT,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id);

CREATE TABLE IF NOT EXISTS beta_invites (
    id TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    session_hash TEXT UNIQUE,
    session_expires_at INTEGER,
    revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS beta_usage (
    day INTEGER NOT NULL,
    invite_id TEXT NOT NULL REFERENCES beta_invites(id),
    requests INTEGER NOT NULL,
    PRIMARY KEY (day, invite_id)
);

CREATE TABLE IF NOT EXISTS beta_activation_limit (
    minute INTEGER PRIMARY KEY,
    attempts INTEGER NOT NULL
);
"""


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db() -> None:
    with connect() as connection:
        connection.executescript(SCHEMA)
