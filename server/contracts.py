from __future__ import annotations

import base64
import binascii
from typing import Literal

from fastapi import HTTPException
from pydantic import BaseModel, Field

TOKEN_TTL = 30 * 24 * 60 * 60
MAX_IMAGE_BYTES = 8 * 1024 * 1024


class OptionIn(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


class QuestionIn(BaseModel):
    text: str = Field(min_length=1, max_length=20000)
    options: list[OptionIn] = Field(default_factory=list)
    kind: Literal["single", "multiple", "text"]
    image: str | None = None


def bearer_token(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "Требуется вход.")
    token = authorization[7:].strip()
    if not token:
        raise HTTPException(401, "Требуется вход.")
    return token


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
