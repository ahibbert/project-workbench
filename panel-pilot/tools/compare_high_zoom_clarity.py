#!/usr/bin/env python3
"""Create non-destructive manga enlargement and deconvolution comparisons.

The script deliberately uses only Pillow and NumPy so it can run beside Panels
without adding a server dependency. It is an experiment, not part of the live
reader path.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont


VARIANTS = (
    "browser_bicubic",
    "lanczos",
    "clean_unsharp",
    "wiener_subtle",
    "wiener_mild",
    "wiener_medium",
)


def gaussian_psf(size: int, sigma: float) -> np.ndarray:
    axis = np.arange(size, dtype=np.float32) - (size - 1) / 2
    xx, yy = np.meshgrid(axis, axis)
    kernel = np.exp(-(xx * xx + yy * yy) / (2 * sigma * sigma))
    return kernel / np.sum(kernel)


def wiener_deconvolve(channel: np.ndarray, sigma: float, balance: float) -> np.ndarray:
    """Regularised inverse filtering with reflective padding to limit edge wrap."""
    source = np.asarray(channel, dtype=np.float32) / 255.0
    padding = max(16, int(round(sigma * 12)))
    padded = np.pad(source, padding, mode="reflect")
    psf = gaussian_psf(max(5, int(round(sigma * 6)) | 1), sigma)
    transfer = np.zeros_like(padded)
    y0 = (transfer.shape[0] - psf.shape[0]) // 2
    x0 = (transfer.shape[1] - psf.shape[1]) // 2
    transfer[y0:y0 + psf.shape[0], x0:x0 + psf.shape[1]] = psf
    transfer = np.fft.fft2(np.fft.ifftshift(transfer))
    spectrum = np.fft.fft2(padded)
    restored = np.fft.ifft2(
        np.conj(transfer) * spectrum / (np.abs(transfer) ** 2 + balance)
    ).real
    restored = restored[padding:-padding, padding:-padding]
    return np.clip(restored * 255.0, 0, 255).astype(np.uint8)


def deconvolve_luminance(image: Image.Image, *, sigma: float, balance: float) -> Image.Image:
    ycbcr = image.convert("YCbCr")
    luminance, cb, cr = ycbcr.split()
    restored = Image.fromarray(
        wiener_deconvolve(np.asarray(luminance), sigma=sigma, balance=balance),
        mode="L",
    )
    return Image.merge("YCbCr", (restored, cb, cr)).convert("RGB")


def enlarge_variants(image: Image.Image, scale: float) -> dict[str, Image.Image]:
    size = tuple(max(1, round(value * scale)) for value in image.size)
    lanczos = image.resize(size, Image.Resampling.LANCZOS)
    subtle = deconvolve_luminance(image, sigma=0.5, balance=0.05).resize(size, Image.Resampling.LANCZOS)
    mild = deconvolve_luminance(image, sigma=0.7, balance=0.03).resize(size, Image.Resampling.LANCZOS)
    medium = deconvolve_luminance(image, sigma=0.9, balance=0.012).resize(size, Image.Resampling.LANCZOS)
    return {
        "browser_bicubic": image.resize(size, Image.Resampling.BICUBIC),
        "lanczos": lanczos,
        "clean_unsharp": lanczos.filter(ImageFilter.UnsharpMask(radius=1.05, percent=55, threshold=3)),
        "wiener_subtle": subtle,
        "wiener_mild": mild,
        "wiener_medium": medium,
    }


def edge_energy(image: Image.Image) -> float:
    grey = np.asarray(image.convert("L"), dtype=np.float32)
    horizontal = np.abs(np.diff(grey, axis=1)).mean()
    vertical = np.abs(np.diff(grey, axis=0)).mean()
    return round(float((horizontal + vertical) / 2), 4)


def labelled_tile(image: Image.Image, label: str, width: int) -> Image.Image:
    ratio = width / image.width
    resized = image.resize((width, max(1, round(image.height * ratio))), Image.Resampling.LANCZOS)
    header = 42
    tile = Image.new("RGB", (width, resized.height + header), "white")
    tile.paste(resized, (0, header))
    draw = ImageDraw.Draw(tile)
    draw.text((12, 12), label.replace("_", " ").title(), fill="black", font=ImageFont.load_default())
    return tile


def contact_sheet(tiles: list[Image.Image], columns: int, gutter: int = 12) -> Image.Image:
    rows = (len(tiles) + columns - 1) // columns
    column_width = max(tile.width for tile in tiles)
    row_heights = []
    for row in range(rows):
        row_heights.append(max(tile.height for tile in tiles[row * columns:(row + 1) * columns]))
    sheet = Image.new(
        "RGB",
        (column_width * columns + gutter * (columns - 1), sum(row_heights) + gutter * (rows - 1)),
        "#d8d8d8",
    )
    y = 0
    for row, row_height in enumerate(row_heights):
        for column in range(columns):
            index = row * columns + column
            if index >= len(tiles):
                break
            sheet.paste(tiles[index], (column * (column_width + gutter), y))
        y += row_height + gutter
    return sheet


def detail_boxes(width: int, height: int) -> list[tuple[str, tuple[int, int, int, int]]]:
    return [
        ("top faces and small text", (round(width * 0.38), 0, width, round(height * 0.24))),
        ("middle speech and screentone", (round(width * 0.34), round(height * 0.23), width, round(height * 0.51))),
        ("dense lower panel", (round(width * 0.34), round(height * 0.5), width, round(height * 0.96))),
    ]


def run(input_path: Path, output_dir: Path, scale: float) -> dict:
    image = Image.open(input_path).convert("RGB")
    output_dir.mkdir(parents=True, exist_ok=True)
    variants = enlarge_variants(image, scale)
    metrics = {}
    for name, variant in variants.items():
        path = output_dir / f"{name}.png"
        variant.save(path, optimize=True)
        metrics[name] = {
            "file": path.name,
            "width": variant.width,
            "height": variant.height,
            "edgeEnergy": edge_energy(variant),
        }

    full_tiles = [labelled_tile(variants[name], name, 360) for name in VARIANTS]
    contact_sheet(full_tiles, columns=len(full_tiles)).save(output_dir / "full-page-comparison.jpg", quality=92)

    detail_tiles = []
    boxes = detail_boxes(*image.size)
    for detail_label, box in boxes:
        scaled_box = tuple(round(value * scale) for value in box)
        for name in VARIANTS:
            detail_tiles.append(labelled_tile(variants[name].crop(scaled_box), f"{detail_label} — {name}", 420))
    contact_sheet(detail_tiles, columns=3).save(output_dir / "detail-comparison.jpg", quality=94)

    manifest = {
        "input": str(input_path.resolve()),
        "inputSize": list(image.size),
        "scale": scale,
        "notes": {
            "browser_bicubic": "Approximation of ordinary smooth browser enlargement.",
            "lanczos": "High-quality resampling only.",
            "clean_unsharp": "Lanczos plus a restrained unsharp mask.",
            "wiener_subtle": "Heavily regularised luminance deconvolution; sigma 0.5, balance 0.05.",
            "wiener_mild": "Regularised luminance deconvolution; sigma 0.7, balance 0.03.",
            "wiener_medium": "Artifact-seeking comparison; sigma 0.9, balance 0.012.",
        },
        "metrics": metrics,
    }
    (output_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output-dir", type=Path, default=Path("test-output/clarity"))
    parser.add_argument("--scale", type=float, default=2.0)
    args = parser.parse_args()
    if args.scale < 1 or args.scale > 4:
        parser.error("--scale must be between 1 and 4")
    manifest = run(args.input, args.output_dir, args.scale)
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
