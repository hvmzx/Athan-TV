# Regenerate tizen-app/icon.png: flatten the transparent brand artwork
# (logo.png) onto the opaque brand gradient.
#
# Why: the TV launcher highlights app tiles with a light background when the
# icon has transparent pixels — they showed up white on selection. A fully
# opaque icon keeps the dark look consistent everywhere (launcher tiles,
# notification icon, Smart Hub recents).
#
# Usage:
#   <python> tools/make-icon.py   (Python with Pillow)
#   On this machine: the DSH runtime Python ships Pillow (see load_workspace_dependencies).
import sys
from PIL import Image, ImageDraw

ROOT = __import__("pathlib").Path(__file__).resolve().parent.parent
SRC = ROOT / "tizen-app" / "logo.png"
OUT = ROOT / "tizen-app" / "icon.png"

SIZE = 500
TOP = (14, 56, 68)     # #0e3844
BOTTOM = (8, 34, 45)   # #08222d

art = Image.open(SRC).convert("RGBA")

base = Image.new("RGBA", (SIZE, SIZE))
draw = ImageDraw.Draw(base)
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = round(TOP[0] + (BOTTOM[0] - TOP[0]) * t)
    g = round(TOP[1] + (BOTTOM[1] - TOP[1]) * t)
    b = round(TOP[2] + (BOTTOM[2] - TOP[2]) * t)
    draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

side = int(SIZE * 0.84)
art_scaled = art.resize((side, side), Image.LANCZOS)
offset = (SIZE - side) // 2
base.alpha_composite(art_scaled, (offset, offset))

base.convert("RGB").save(OUT, optimize=True)
print(f"Wrote {OUT}")
