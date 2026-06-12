#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

DEFAULT_SERVER = "https://firefox.settings.services.mozilla.com/v1"
FETCH_ATTEMPTS = 3
RETRY_DELAY_SECONDS = 2.0
POLICY_PATH = Path("services/settings/WaterfoxSettingsPolicy.sys.mjs")
REGULAR_DUMP_ROOT = Path("services/settings/dumps")
STATIC_DUMP_ROOT = Path("services/settings/static-dumps")
ENTRY_RE = re.compile(r'\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]')


@dataclass(frozen=True)
class DumpTarget:
    bucket: str
    collection: str
    path: Path

    @property
    def key(self):
        return f"{self.bucket}/{self.collection}"


def parse_args():
    parser = argparse.ArgumentParser(
        description="Update Waterfox's bundled Remote Settings dumps."
    )
    parser.add_argument(
        "--server",
        default=DEFAULT_SERVER,
        help=f"Remote Settings server root. Defaults to {DEFAULT_SERVER}",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fetch and validate required dumps without writing local files. "
        "Exits 2 when local dumps differ from the server.",
    )
    parser.add_argument(
        "--only",
        action="append",
        metavar="BUCKET/COLLECTION",
        help="Restrict the update to a required dump. May be passed more than once.",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=60.0,
        help="HTTP timeout in seconds. Defaults to 60.",
    )
    return parser.parse_args()


def repo_root():
    return Path(__file__).resolve().parents[1]


def load_required_dumps(root):
    policy = root / POLICY_PATH
    text = policy.read_text(encoding="utf-8")
    start = text.index("const REQUIRED_OFFLINE_DUMPS")
    end = text.index("]);", start)
    entries = ENTRY_RE.findall(text[start:end])
    if not entries:
        raise ValueError(f"no required dumps found in {POLICY_PATH}")

    seen = set()
    for entry in entries:
        if entry in seen:
            raise ValueError(f"duplicate required dump {entry[0]}/{entry[1]}")
        seen.add(entry)
    return entries


def validate_only_filter(required, only):
    if not only:
        return required

    requested = set()
    for item in only:
        parts = item.split("/", 1)
        if len(parts) != 2 or not all(parts):
            raise ValueError(f"--only expects BUCKET/COLLECTION, got {item!r}")
        requested.add(tuple(parts))

    available = set(required)
    missing = sorted(requested - available)
    if missing:
        formatted = ", ".join(
            f"{bucket}/{collection}" for bucket, collection in missing
        )
        raise ValueError(
            f"--only contains dumps not in the required manifest: {formatted}"
        )

    return [entry for entry in required if entry in requested]


def resolve_targets(root, required):
    targets = []
    for bucket, collection in required:
        regular_path = root / REGULAR_DUMP_ROOT / bucket / f"{collection}.json"
        static_path = root / STATIC_DUMP_ROOT / bucket / f"{collection}.json"
        path = static_path if static_path.exists() else regular_path

        if not path.exists():
            relpath = path.relative_to(root)
            raise FileNotFoundError(f"missing required dump source: {relpath}")

        targets.append(DumpTarget(bucket, collection, path))
    return targets


def records_url(server, bucket, collection):
    server = server.rstrip("/")
    bucket = urllib.parse.quote(bucket, safe="")
    collection = urllib.parse.quote(collection, safe="")
    return (
        f"{server}/buckets/{bucket}/collections/{collection}/records"
        "?_sort=-last_modified"
    )


def parse_etag_timestamp(etag):
    if not etag:
        return None
    value = etag.strip()
    if value.startswith("W/"):
        value = value[2:].strip()
    value = value.strip('"')
    if not value.isdigit():
        return None
    return int(value)


def fetch_json_once(url, timeout):
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/json",
            "User-Agent": "Waterfox Remote Settings dump updater",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = json.load(response)
        return body, response.headers.get("ETag"), response.headers.get("Next-Page")


def fetch_json(url, timeout):
    last_error = None
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            return fetch_json_once(url, timeout)
        except urllib.error.HTTPError as error:
            if error.code < 500:
                raise
            last_error = error
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
        if attempt < FETCH_ATTEMPTS:
            print(
                f"attempt {attempt}/{FETCH_ATTEMPTS} failed for {url}, "
                f"retrying: {last_error}",
                file=sys.stderr,
            )
            time.sleep(RETRY_DELAY_SECONDS * attempt)
    raise last_error


def fetch_records(server, target, timeout):
    url = records_url(server, target.bucket, target.collection)
    records = []
    timestamp = None

    while url:
        body, etag, next_page = fetch_json(url, timeout)
        page_records = body.get("data")
        if not isinstance(page_records, list):
            raise ValueError(f"{target.key} response did not contain a data list")

        if timestamp is None:
            timestamp = parse_etag_timestamp(etag)
        records.extend(page_records)
        url = urllib.parse.urljoin(url, next_page) if next_page else None

    last_modified_values = [
        record.get("last_modified")
        for record in records
        if isinstance(record.get("last_modified"), int)
    ]
    if timestamp is None:
        if not last_modified_values:
            raise ValueError(f"{target.key} response did not provide a timestamp")
        timestamp = max(last_modified_values)

    if last_modified_values and records[0].get("last_modified") != max(
        last_modified_values
    ):
        raise ValueError(f"{target.key} records were not sorted by last_modified")

    return {"data": records, "timestamp": timestamp}


def dump_json(data):
    return json.dumps(data, ensure_ascii=False, indent=2) + "\n"


def update_target(root, server, target, check, timeout):
    relpath = target.path.relative_to(root)
    remote_dump = fetch_records(server, target, timeout)
    new_content = dump_json(remote_dump)
    old_content = target.path.read_text(encoding="utf-8")
    changed = old_content != new_content

    if check:
        state = "would update" if changed else "current"
    elif changed:
        target.path.write_text(new_content, encoding="utf-8")
        state = "updated"
    else:
        state = "current"

    record_count = len(remote_dump["data"])
    print(
        f"{state} {target.key} at {relpath} "
        f"({record_count} records, timestamp {remote_dump['timestamp']})"
    )
    return changed


def main():
    args = parse_args()
    root = repo_root()

    try:
        required = load_required_dumps(root)
        required = validate_only_filter(required, args.only)
        targets = resolve_targets(root, required)

        changed = False
        for target in targets:
            changed = (
                update_target(root, args.server, target, args.check, args.timeout)
                or changed
            )

        if args.check and changed:
            print("check complete; local dumps differ from the server")
            return 2
        return 0
    except (OSError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
