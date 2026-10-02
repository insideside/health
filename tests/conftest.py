"""Общая подготовка: свежая база во временной папке (не трогает data/), справочник продуктов загружен один раз."""
import os
import sys
import tempfile
from pathlib import Path

import pytest

_tmp = tempfile.mkdtemp(prefix="trainer-test-")
os.environ["TRAINER_DATA"] = _tmp
os.environ["TRAINER_NO_WEB"] = "1"          # тесты не ходят в интернет
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app import db, food  # noqa: E402


@pytest.fixture(scope="session")
def idx():
    db.conn()
    db.seed_foods()
    return food.Index()


@pytest.fixture(scope="session")
def users(idx):
    """Два пользователя одной пары: ivan и masha."""
    ts = db.now_ms()
    with db.tx() as c:
        for uid, login, name in (("u_ivan", "ivan", "Иван"), ("u_masha", "masha", "Мария")):
            c.execute("INSERT OR IGNORE INTO users (id, login, name, pw_hash, created) VALUES (?, ?, ?, 'x', ?)", (uid, login, name, ts))
    return {"ivan": {"id": "u_ivan", "login": "ivan", "name": "Иван"}, "masha": {"id": "u_masha", "login": "masha", "name": "Мария"}}
