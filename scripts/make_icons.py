"""Иконки Тренера без зависимостей: минималистичная гантель в цветах «Стенограммы».

  python3 scripts/make_icons.py

Что и зачем (опыт vk-music, см. ../vk-music/CLAUDE.md):
- apple-touch-icon и иконки манифеста — PNG **RGB без прозрачности**: прозрачность iOS не принимает
  и рисует чёрный квадрат. Фон во весь квадрат, углы iOS скругляет сама.
- iOS не применяет apple-touch-icon, скачанный с самоподписанного HTTPS, — поэтому сервер ещё и вшивает
  ту же картинку в страницу и манифест строкой data: (app/server.py, icon_data_uri).
- Для вкладки браузера — только гантель на прозрачном фоне (favicon.svg и PNG 32/48): тёмный квадрат
  Safari на Mac обводил светлой плашкой ради контраста с тёмной панелью вкладок.
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "app" / "static"
BG = (0x14, 0x13, 0x11)          # графит «стола»
PLATE = (0xd4, 0x70, 0x5a)       # терракота — акцент приложения
BAR = (0xe9, 0xe1, 0xd0)         # светлые чернила
ANGLE = -30                      # лёгкий наклон — гантель «в движении», а не на полке

# Гантель в координатах 0..1 (центр 0.5, 0.5) до поворота: гриф и по два диска с каждой стороны.
# (центр x, полуширина, полувысота, радиус скругления, цвет)
SHAPES = [
    (0.50, 0.30, 0.035, 0.035, BAR),     # гриф
    (0.29, 0.045, 0.185, 0.03, PLATE),   # большой диск слева
    (0.71, 0.045, 0.185, 0.03, PLATE),   # большой диск справа
    (0.225, 0.03, 0.12, 0.022, PLATE),   # малый диск слева
    (0.775, 0.03, 0.12, 0.022, PLATE),   # малый диск справа
]


def box_sdf(px, py, cx, cy, hw, hh, r):
    """Знаковое расстояние до скруглённого прямоугольника (отрицательное — внутри)."""
    qx, qy = abs(px - cx) - (hw - r), abs(py - cy) - (hh - r)
    return math.hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r


def color_at(x, y, scale=1.0):
    """Цвет точки (x, y в долях иконки). scale < 1 уменьшает гантель — отступы для маски/вкладки."""
    a = math.radians(ANGLE)
    dx, dy = (x - 0.5) / scale, (y - 0.5) / scale
    rx, ry = dx * math.cos(a) - dy * math.sin(a) + 0.5, dx * math.sin(a) + dy * math.cos(a) + 0.5
    for cx, hw, hh, r, col in reversed(SHAPES):   # диски поверх грифа
        if box_sdf(rx, ry, cx, 0.5, hw, hh, r) <= 0:
            return col
    return None


def render(size, scale=1.0, rounded=0.0, ss=4):
    """→ строки пикселей. rounded > 0 — прозрачные скруглённые углы (только для вкладки браузера)."""
    rows = []
    for j in range(size):
        row = []
        for i in range(size):
            acc, alpha = [0, 0, 0], 0
            for sj in range(ss):
                for si in range(ss):
                    x, y = (i + (si + .5) / ss) / size, (j + (sj + .5) / ss) / size
                    if rounded and box_sdf(x, y, 0.5, 0.5, 0.5, 0.5, rounded) > 0:
                        continue
                    c = color_at(x, y, scale) or BG
                    for k in range(3):
                        acc[k] += c[k]
                    alpha += 1
            n = ss * ss
            if rounded:
                row.append(tuple(round(acc[k] / max(alpha, 1)) for k in range(3)) + (round(alpha / n * 255),))
            else:
                row.append(tuple(round(v / n) for v in acc))
        rows.append(row)
    return rows


def png(rows, path, alpha=False):
    size = len(rows)
    raw = b"".join(b"\x00" + b"".join(bytes(p) for p in r) for r in rows)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)

    color_type = 6 if alpha else 2
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, color_type, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


TAB_BAR = (0x9a, 0x8f, 0x80)     # гриф на вкладке: средне-серый, виден и на светлой, и на тёмной панели


def render_tab(size, scale=1.3, ss=8):
    """Значок вкладки: только гантель, фон прозрачный.

    Safari на Mac подкладывает светлую плашку под тёмные значки на тёмной панели вкладок —
    получалась белая рамка вокруг графитового квадрата. Без фона подкладывать нечего."""
    rows = []
    for j in range(size):
        row = []
        for i in range(size):
            acc, hit = [0, 0, 0], 0
            for sj in range(ss):
                for si in range(ss):
                    c = color_at((i + (si + .5) / ss) / size, (j + (sj + .5) / ss) / size, scale)
                    if c is None:
                        continue
                    c = TAB_BAR if c == BAR else c
                    for k in range(3):
                        acc[k] += c[k]
                    hit += 1
            row.append(tuple(round(acc[k] / max(hit, 1)) for k in range(3)) + (round(hit / (ss * ss) * 255),))
        rows.append(row)
    return rows


def svg(path):
    """Векторный значок вкладки: только гантель, без фона (см. render_tab)."""
    bar = "#%02x%02x%02x" % TAB_BAR
    parts = [f'<g transform="rotate({ANGLE} 50 50) translate(50 50) scale(1.3) translate(-50 -50)">']
    for cx, hw, hh, r, col in SHAPES:
        fill = bar if col == BAR else "#%02x%02x%02x" % col
        parts.append(f'<rect x="{(cx - hw) * 100:.1f}" y="{(0.5 - hh) * 100:.1f}" width="{hw * 200:.1f}" height="{hh * 200:.1f}" '
                     f'rx="{r * 100:.1f}" fill="{fill}"/>')
    parts.append("</g>")
    path.write_text(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{"".join(parts)}</svg>\n')


if __name__ == "__main__":
    # домашний экран и манифест: без прозрачности, гантель чуть меньше — iOS/Android срезают края маской
    for size, name in ((180, "apple-touch-icon.png"), (192, "icon-192.png"), (512, "icon-512.png")):
        png(render(size, scale=0.96), OUT / name)
        print(name)
    # вкладка браузера: только гантель на прозрачном фоне, крупно — читается в 16 px на любой панели
    for size, name in ((32, "favicon-32.png"), (48, "favicon-48.png")):
        png(render_tab(size), OUT / name, alpha=True)
        print(name)
    svg(OUT / "favicon.svg")
    print("favicon.svg")
