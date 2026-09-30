#!/usr/bin/env python3
"""Train the manga-only panel detector with Torchvision."""

import argparse
import json
from pathlib import Path

import torch
from PIL import Image
from torch.utils.data import DataLoader, Dataset
from torchvision.models.detection import FasterRCNN_MobileNet_V3_Large_FPN_Weights
from torchvision.models.detection import fasterrcnn_mobilenet_v3_large_fpn
from torchvision.models.detection.faster_rcnn import FastRCNNPredictor
from torchvision.transforms.functional import pil_to_tensor


class CocoPanels(Dataset):
    def __init__(self, images_root, annotations):
        self.images_root = Path(images_root)
        payload = json.loads(Path(annotations).read_text(encoding="utf-8"))
        self.images = payload["images"]
        self.boxes = {image["id"]: [] for image in self.images}
        for annotation in payload["annotations"]:
            x, y, width, height = annotation["bbox"]
            self.boxes[annotation["image_id"]].append([x, y, x + width, y + height])

    def __len__(self):
        return len(self.images)

    def __getitem__(self, index):
        info = self.images[index]
        image = Image.open(self.images_root / info["file_name"]).convert("RGB")
        image = pil_to_tensor(image).float() / 255.0
        boxes = torch.as_tensor(self.boxes[info["id"]], dtype=torch.float32).reshape(-1, 4)
        target = {
            "boxes": boxes,
            "labels": torch.ones((len(boxes),), dtype=torch.int64),
            "image_id": torch.tensor(info["id"]),
        }
        return image, target


def collate(batch):
    return tuple(zip(*batch))


def build_model(pretrained=True):
    weights = FasterRCNN_MobileNet_V3_Large_FPN_Weights.DEFAULT if pretrained else None
    model = fasterrcnn_mobilenet_v3_large_fpn(weights=weights)
    features = model.roi_heads.box_predictor.cls_score.in_features
    model.roi_heads.box_predictor = FastRCNNPredictor(features, 2)
    return model


def move_target(target, device):
    return {key: value.to(device) for key, value in target.items()}


def mean_loss(model, loader, device):
    model.train()
    values = []
    with torch.no_grad():
        for images, targets in loader:
            losses = model([image.to(device) for image in images], [move_target(t, device) for t in targets])
            values.append(float(sum(losses.values()).cpu()))
    return sum(values) / max(1, len(values))


def arguments():
    parser = argparse.ArgumentParser()
    parser.add_argument("--images", type=Path, required=True)
    parser.add_argument("--train", type=Path, required=True)
    parser.add_argument("--val", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=20)
    parser.add_argument("--batch-size", type=int, default=2)
    parser.add_argument("--learning-rate", type=float, default=0.0025)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--no-pretrained", action="store_true")
    return parser.parse_args()


def main():
    args = arguments()
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    train_loader = DataLoader(CocoPanels(args.images, args.train), batch_size=args.batch_size, shuffle=True,
                              num_workers=args.workers, collate_fn=collate)
    val_loader = DataLoader(CocoPanels(args.images, args.val), batch_size=args.batch_size, shuffle=False,
                            num_workers=args.workers, collate_fn=collate)
    model = build_model(not args.no_pretrained).to(device)
    optimizer = torch.optim.SGD(
        [parameter for parameter in model.parameters() if parameter.requires_grad],
        lr=args.learning_rate,
        momentum=.9,
        weight_decay=.0005,
    )
    best = float("inf")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    for epoch in range(1, args.epochs + 1):
        model.train()
        for images, targets in train_loader:
            losses = model([image.to(device) for image in images], [move_target(t, device) for t in targets])
            loss = sum(losses.values())
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
        validation_loss = mean_loss(model, val_loader, device)
        print(f"epoch={epoch} validation_loss={validation_loss:.5f}")
        if validation_loss < best:
            best = validation_loss
            torch.save({"model": model.state_dict(), "validation_loss": best, "epoch": epoch}, args.out)


if __name__ == "__main__":
    main()
