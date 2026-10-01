"""Build Panels' deterministic PWA PNG icon set from its source artwork."""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MASTER = ROOT / "artwork" / "panels-icon-master.png"
ASSETS = ROOT / "public" / "assets"
BACKGROUND = "#0b3f42"


def draw_icon(size: int, path: Path, *, maskable: bool = False) -> None:
    with Image.open(MASTER) as source:
        source = source.convert("RGBA")
        scale = 0.70 if maskable else 0.92
        artwork_size = round(size * scale)
        artwork = source.resize((artwork_size, artwork_size), Image.Resampling.LANCZOS)

    image = Image.new("RGBA", (size, size), BACKGROUND)
    offset = (size - artwork_size) // 2
    image.alpha_composite(artwork, (offset, offset))
    image.convert("RGB").save(path, "PNG", optimize=True)


if __name__ == "__main__":
    ASSETS.mkdir(parents=True, exist_ok=True)
    draw_icon(192, ASSETS / "icon-192.png")
    draw_icon(512, ASSETS / "icon-512.png")
    draw_icon(512, ASSETS / "icon-maskable-512.png", maskable=True)
    draw_icon(180, ASSETS / "apple-touch-icon.png")
