#!/usr/bin/env python3
"""Daily backup of the raid sales sync data (active signups + history)
from JSONBin.

Fetches the current bin contents -- still encrypted, this script never
has the passphrase and doesn't need it -- and writes a snapshot into the
repo, so an accidental overwrite (stale-tab sync, a bad push, JSONBin
itself having an issue) doesn't mean the data is gone for good; the last
several days of snapshots stay recoverable in git history regardless.

The access key and bin id are read directly out of raids.js rather than
duplicated here, so there's a single source of truth for them.
"""
import json
import re
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIDS_JS = Path(__file__).parent.parent / "raids.js"
BACKUP_DIR = Path(__file__).parent.parent / "backups"

# Keep this many of the most recent dated snapshots around; older ones get
# pruned so the backups directory doesn't grow forever. The data itself is
# tiny (a few KB), but there's no reason to keep hundreds of near-identical
# daily copies once far more than enough history has accumulated.
KEEP_DATED_SNAPSHOTS = 90


def extract_constant(source, name):
    m = re.search(rf'const {name} = "([^"]*)"', source)
    if not m:
        print(f"Could not find {name} in raids.js", file=sys.stderr)
        sys.exit(1)
    return m.group(1)


def main():
    source = RAIDS_JS.read_text()
    access_key = extract_constant(source, "JSONBIN_ACCESS_KEY")
    bin_id = extract_constant(source, "JSONBIN_BIN_ID")
    if not bin_id:
        print("No bin id set yet -- nothing to back up.", file=sys.stderr)
        return

    req = urllib.request.Request(
        f"https://api.jsonbin.io/v3/b/{bin_id}",
        headers={"X-Access-Key": access_key},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        print(f"Backup fetch failed: {exc}", file=sys.stderr)
        sys.exit(1)

    record = data.get("record")
    if not record:
        print("No record in bin response -- nothing to back up.", file=sys.stderr)
        return

    BACKUP_DIR.mkdir(exist_ok=True)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    dated_path = BACKUP_DIR / f"raid-data-{today}.json"
    latest_path = BACKUP_DIR / "raid-data-latest.json"

    # The record is the SAME encrypted envelope already living in JSONBin
    # -- opaque without the passphrase, same privacy model as data.json,
    # so it's fine for this (and the repo) to be public.
    payload = json.dumps(record, indent=2)
    dated_path.write_text(payload)
    latest_path.write_text(payload)
    print(f"Backed up raid data to {dated_path.name} and {latest_path.name}")

    # Prune old dated snapshots beyond the retention window.
    dated_snapshots = sorted(BACKUP_DIR.glob("raid-data-????-??-??.json"))
    for old in dated_snapshots[:-KEEP_DATED_SNAPSHOTS]:
        old.unlink()
        print(f"Pruned old snapshot {old.name}")


if __name__ == "__main__":
    main()
