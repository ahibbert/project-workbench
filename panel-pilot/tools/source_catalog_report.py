#!/usr/bin/env python3
"""Validate the reviewed Keiyoushi catalog and print a non-mutating extension plan."""

import argparse
import json
import pathlib
import sys
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from source_benchmark import (  # noqa: E402
    build_extension_plan,
    load_suite_manifest,
    parse_keiyoushi_catalog,
)


def load_json(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def fetch_catalog(url, opener=urllib.request.urlopen, timeout=30):
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": "Panels-Source-Catalog/1"},
    )
    with opener(request, timeout=timeout) as response:
        payload = response.read(5_000_001)
    if not payload or len(payload) > 5_000_000:
        raise ValueError("Keiyoushi metadata response is empty or too large")
    return json.loads(payload.decode("utf-8"))


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        description="Produce a validated extension review plan. This command cannot install or remove extensions.",
    )
    parser.add_argument("--manifest", type=pathlib.Path, default=ROOT / "tools" / "source_suite_manifest.json")
    parser.add_argument("--metadata", type=pathlib.Path, help="Use a downloaded catalog instead of fetching official metadata.")
    parser.add_argument("--inventory", type=pathlib.Path, help="Panels source-intelligence inventory JSON.")
    parser.add_argument("--installed-package", action="append", default=[])
    parser.add_argument("--obsolete-package", action="append", default=[])
    parser.add_argument("--output", type=pathlib.Path, help="Also save the URL-free JSON report.")
    parser.add_argument("--timeout", type=int, default=30)
    return parser.parse_args(argv)


def inventory_from_args(args):
    if args.inventory:
        payload = load_json(args.inventory)
        inventory = payload.get("inventory", payload) if isinstance(payload, dict) else payload
        if not isinstance(inventory, list):
            raise ValueError("Inventory JSON must be an array or an inventory response")
        return inventory
    obsolete = set(args.obsolete_package)
    installed = set(args.installed_package) | obsolete
    return [{
        "packageName": package_name,
        "installed": True,
        "obsolete": package_name in obsolete,
        "extensionVersion": "unknown",
    } for package_name in sorted(installed)]


def main(argv=None):
    args = parse_args(argv)
    if args.timeout < 1 or args.timeout > 120:
        raise SystemExit("--timeout must be between 1 and 120 seconds")
    try:
        manifest = load_suite_manifest(args.manifest)
        raw_catalog = load_json(args.metadata) if args.metadata else fetch_catalog(
            manifest["store"]["metadataUrl"], timeout=args.timeout
        )
        catalog = parse_keiyoushi_catalog(raw_catalog, manifest["store"]["signingKey"])
        report = build_extension_plan(manifest, catalog, inventory_from_args(args))
        encoded = json.dumps(report, ensure_ascii=True, indent=2) + "\n"
        if args.output:
            destination = args.output.expanduser().resolve()
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(encoded, encoding="utf-8")
        print(encoded, end="")
        return 0
    except (OSError, ValueError, json.JSONDecodeError) as error:
        print(f"Catalog report stopped: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
