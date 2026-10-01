"""Build Panel Pilot's deterministic PWA PNG icon set."""

from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"


def draw_icon(size: int, path: Path, *, maskable: bool = False) -> None:
    image = Image.new("RGB", (size, size), "#151515")
    draw = ImageDraw.Draw(image)
    inset = round(size * (0.2 if maskable else 0.12))
    border = max(4, round(size * 0.052))
    page = (inset, inset, size - inset, size - inset)
    draw.rounded_rectangle(page, radius=round(size * 0.08), fill="#fffdf6", outline="#e1b84b", width=border)
    inner = inset + border + round(size * 0.035)
    right = size - inner
    top_height = round((right - inner) * 0.36)
    gap = max(4, round(size * 0.035))
    draw.rounded_rectangle((inner, inner, right, inner + top_height), radius=round(size * 0.025), fill="#151515")
    lower_top = inner + top_height + gap
    split = inner + round((right - inner - gap) * 0.56)
    draw.rounded_rectangle((inner, lower_top, split, right), radius=round(size * 0.025), fill="#347f80")
    draw.rounded_rectangle((split + gap, lower_top, right, right), radius=round(size * 0.025), fill="#151515")
    image.save(path, "PNG", optimize=True)


if __name__ == "__main__":
    ASSETS.mkdir(exist_ok=True)
    draw_icon(192, ASSETS / "icon-192.png")
    draw_icon(512, ASSETS / "icon-512.png")
    draw_icon(512, ASSETS / "icon-maskable-512.png", maskable=True)
    draw_icon(180, ASSETS / "apple-touch-icon.png")
