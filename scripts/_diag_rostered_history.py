import json
import re
import sys
import urllib.error
import urllib.request
import base64

RAIDS_JS = "raids.js"

def extract_constant(source, name):
    m = re.search(rf'const {name} = "([^"]*)"', source)
    return m.group(1)

source = open(RAIDS_JS).read()
access_key = extract_constant(source, "JSONBIN_ACCESS_KEY")
bin_id = extract_constant(source, "JSONBIN_BIN_ID")
PASSPHRASE = "Qa4lL1ps05Dv7iQyDTcbHznnmgJq8HcM"

from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

def decrypt(envelope):
    salt = base64.b64decode(envelope["salt"])
    iv = base64.b64decode(envelope["iv"])
    ciphertext = base64.b64decode(envelope["ciphertext"])
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=envelope["iterations"])
    key = kdf.derive(PASSPHRASE.encode("utf-8"))
    plaintext = AESGCM(key).decrypt(iv, ciphertext, None)
    return json.loads(plaintext)

def fetch_version(v):
    req = urllib.request.Request(
        f"https://api.jsonbin.io/v3/b/{bin_id}/{v}",
        headers={"X-Access-Key": access_key, "User-Agent": "roster-site-backup/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return True, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return False, e.code

# Binary search for the highest existing version number.
lo, hi = 1, 1
while True:
    ok, _ = fetch_version(hi)
    if not ok:
        break
    lo = hi
    hi *= 2
    if hi > 5000:
        break
while lo < hi - 1:
    mid = (lo + hi) // 2
    ok, _ = fetch_version(mid)
    if ok:
        lo = mid
    else:
        hi = mid
latest = lo
print(f"Latest version: {latest}")

# Walk the most recent 40 versions.
results = []
start = max(1, latest - 39)
for v in range(start, latest + 1):
    ok, data = fetch_version(v)
    if not ok:
        continue
    record = data.get("record")
    if record and record.get("encrypted"):
        try:
            payload = decrypt(record)
            entries = payload.get("entries", payload)
            snapshot = {}
            for e in entries.values():
                snapshot[e["raidId"]] = e.get("rosteredCharRealm")
            results.append((v, snapshot))
        except Exception:
            pass

prev = None
for v, snap in results:
    if snap != prev:
        print(f"v{v}: " + json.dumps(snap))
        prev = snap
