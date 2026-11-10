from __future__ import annotations

import hashlib
import hmac
import os
import secrets
from pathlib import Path

from cryptography.fernet import Fernet

ROOT = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("BEYIM_DATA_DIR", ROOT / "data"))
SECRET_FILE = Path(os.environ.get("BEYIM_SECRET_FILE", DATA_DIR / "secret.key"))


def _fernet() -> Fernet:
    value = os.environ.get("BEYIM_SECRET_KEY", "").strip()
    if value:
        return Fernet(value.encode())
    SECRET_FILE.parent.mkdir(parents=True, exist_ok=True)
    if not SECRET_FILE.exists():
        SECRET_FILE.write_bytes(Fernet.generate_key())
        try:
            SECRET_FILE.chmod(0o600)
        except OSError:
            pass
    return Fernet(SECRET_FILE.read_bytes().strip())


def hash_password(password: str) -> tuple[str, str]:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return digest.hex(), salt.hex()


def verify_password(password: str, digest_hex: str, salt_hex: str) -> bool:
    try:
        salt = bytes.fromhex(salt_hex)
    except ValueError:
        return False
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return hmac.compare_digest(digest.hex(), digest_hex)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def encrypt_key(value: str) -> str:
    return _fernet().encrypt(value.encode("utf-8")).decode("ascii")


def decrypt_key(value: str) -> str:
    return _fernet().decrypt(value.encode("ascii")).decode("utf-8")


def key_hint(value: str) -> str:
    if len(value) <= 8:
        return "…"
    return value[:4] + "…" + value[-4:]
