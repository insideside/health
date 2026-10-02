"""Разбор фраз из parity_cases.json сервером (app/food.quick_parse) → JSON для tests/parity.mjs."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app import food  # noqa: E402

idx = food.Index()
cases = json.loads((Path(__file__).parent / "parity_cases.json").read_text("utf-8"))
out = {}
for t in cases:
    done, rest = food.quick_parse(t, idx)
    out[t] = {"items": [[i["name"], round(i["grams"]), bool(i.get("choice"))] for i in done], "rest": rest}
print(json.dumps(out, ensure_ascii=False))
