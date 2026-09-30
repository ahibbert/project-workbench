#!/usr/bin/env python3
"""Convert Manga109 frame annotations into book-disjoint COCO splits."""

import argparse
import hashlib
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from PIL import Image


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, required=True, help="Manga109 images directory")
    parser.add_argument("--annotations", type=Path, required=True, help="Manga109 XML directory")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--validation-percent", type=int, default=20)
    return parser.parse_args()


def is_validation_book(book, percent):
    bucket = int(hashlib.sha256(book.encode("utf-8")).hexdigest()[:8], 16) % 100
    return bucket < percent


def image_for_page(images_root, book, page_index):
    book_dir = images_root / book
    for suffix in ("jpg", "jpeg", "png", "webp"):
        candidate = book_dir / f"{page_index:03d}.{suffix}"
        if candidate.exists():
            return candidate
    matches = sorted(book_dir.glob(f"{page_index:03d}.*"))
    if not matches:
        raise FileNotFoundError(f"No image for {book} page {page_index}")
    return matches[0]


def empty_coco():
    return {"images": [], "annotations": [], "categories": [{"id": 1, "name": "panel"}]}


def main():
    args = arguments()
    if not 1 <= args.validation_percent <= 50:
        raise SystemExit("--validation-percent must be between 1 and 50")
    splits = {"train": empty_coco(), "val": empty_coco()}
    next_image_id = 1
    next_annotation_id = 1

    for xml_path in sorted(args.annotations.rglob("*.xml")):
        root = ET.parse(xml_path).getroot()
        book = root.attrib.get("title") or xml_path.stem
        split = "val" if is_validation_book(book, args.validation_percent) else "train"
        coco = splits[split]
        for page in root.iter("page"):
            page_index = int(page.attrib["index"])
            frames = list(page.iter("frame"))
            if not frames:
                continue
            image_path = image_for_page(args.images, book, page_index)
            with Image.open(image_path) as image:
                width, height = image.size
            coco["images"].append({
                "id": next_image_id,
                "file_name": image_path.relative_to(args.images).as_posix(),
                "width": width,
                "height": height,
                "book": book,
                "page": page_index,
            })
            for frame in frames:
                x0 = float(frame.attrib["xmin"])
                y0 = float(frame.attrib["ymin"])
                x1 = float(frame.attrib["xmax"])
                y1 = float(frame.attrib["ymax"])
                box_width = max(0.0, x1 - x0)
                box_height = max(0.0, y1 - y0)
                if box_width < 2 or box_height < 2:
                    continue
                coco["annotations"].append({
                    "id": next_annotation_id,
                    "image_id": next_image_id,
                    "category_id": 1,
                    "bbox": [x0, y0, box_width, box_height],
                    "area": box_width * box_height,
                    "iscrowd": 0,
                })
                next_annotation_id += 1
            next_image_id += 1

    args.out.mkdir(parents=True, exist_ok=True)
    for split, payload in splits.items():
        (args.out / f"{split}.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"{split}: {len(payload['images'])} pages, {len(payload['annotations'])} panels")


if __name__ == "__main__":
    main()
