#!/usr/bin/env python3
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
# /// script
# dependencies = ["cryptography==49.0.0"]
# ///

"""Sign MARs with Azure Key Vault, or verify them offline."""

import argparse
import base64
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.request import Request, urlopen

from cryptography import x509
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils

SIGNING_DIR = (
    Path(__file__).resolve().parents[2] / "waterfox/browser/branding/mar-signing"
)
MAX_MAR_SIZE = 500 * 1024 * 1024
SIGNATURE_START = 28
SIGNATURE_END = SIGNATURE_START + 512


def index_entries(data, signed):
    if not 24 <= len(data) <= MAX_MAR_SIZE or data[:4] != b"MAR1":
        raise ValueError("Invalid MAR header or size")
    index, size, count = struct.unpack_from(">IQI", data, 4)
    header_end = SIGNATURE_END if signed else 20
    if size != len(data) or count != int(signed):
        raise ValueError("Expected a modern MAR with the requested signature count")
    if not header_end <= index <= len(data) - 4:
        raise ValueError("Invalid MAR index offset")
    if signed and struct.unpack_from(">II", data, 20) != (2, 512):
        raise ValueError("Expected an RSA-4096/SHA-384 MAR signature")
    index_size = struct.unpack_from(">I", data, index)[0]
    if not index_size or index + 4 + index_size != len(data):
        raise ValueError("Invalid MAR index length")
    entries = []
    position = index + 4
    while position < len(data):
        if len(data) - position < 14:
            raise ValueError("Truncated MAR index entry")
        offset, length = struct.unpack_from(">II", data, position)
        end = data.find(b"\0", position + 12)
        if end <= position + 12 or offset < header_end or offset + length > index:
            raise ValueError("Invalid MAR index entry")
        entries.append(position)
        position = end + 1
    return index, entries


def prepare_mar(data):
    index, entries = index_entries(data, signed=False)
    delta = 8 + 512
    if len(data) + delta > MAX_MAR_SIZE:
        raise ValueError("Signed MAR exceeds the native size limit")
    signed = bytearray(data[:20] + struct.pack(">II", 2, 512) + bytes(512) + data[20:])
    struct.pack_into(">IQI", signed, 4, index + delta, len(signed), 1)
    for position in entries:
        offset = struct.unpack_from(">I", data, position)[0]
        struct.pack_into(">I", signed, position + delta, offset + delta)
    return signed


def mar_digest(data):
    # libmar excludes only the signature bytes, not the signature metadata.
    digest = hashlib.sha384(memoryview(data)[:SIGNATURE_START])
    digest.update(memoryview(data)[SIGNATURE_END:])
    return digest.digest()


def verify_mar(data, key):
    index_entries(data, signed=True)
    key.verify(
        bytes(data[SIGNATURE_START:SIGNATURE_END]),
        mar_digest(data),
        padding.PKCS1v15(),
        utils.Prehashed(hashes.SHA384()),
    )


def azure_sign(key_id, digest):
    if not re.fullmatch(
        r"https://[a-z0-9-]+\.vault\.azure\.net/keys/[\w-]+/[0-9a-f]{32}", key_id
    ):
        raise ValueError("Expected a version-pinned Azure Key Vault key URL")
    token = os.environ.get("AZURE_MAR_ACCESS_TOKEN")
    if not token:
        token = subprocess.check_output(
            [
                "az",
                "account",
                "get-access-token",
                "--resource",
                "https://vault.azure.net",
                "--query",
                "accessToken",
                "--output",
                "tsv",
            ],
            text=True,
            stderr=subprocess.PIPE,
            timeout=120,
        ).strip()
    request = Request(
        key_id + "/sign?api-version=7.4",
        data=json.dumps({
            "alg": "RS384",
            "value": base64.urlsafe_b64encode(digest).decode().rstrip("="),
        }).encode(),
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
        },
    )
    with urlopen(request, timeout=120) as result:
        response = json.load(result)
    if response["kid"] != key_id:
        raise ValueError("Azure returned a different key version")
    signature = response["value"]
    return base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))


def sign_mar(data, key_id, key):
    signed = prepare_mar(data)
    signed[SIGNATURE_START:SIGNATURE_END] = azure_sign(key_id, mar_digest(signed))
    verify_mar(signed, key)
    return signed


def replace_file(path, data):
    temporary = tempfile.NamedTemporaryFile(dir=path.parent, delete=False)
    try:
        with temporary:
            temporary.write(data)
        os.replace(temporary.name, path)
    finally:
        Path(temporary.name).unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    operation = parser.add_mutually_exclusive_group(required=True)
    operation.add_argument("--input", type=Path, help="Unsigned MAR to sign in place")
    operation.add_argument("--verify", type=Path, help="Verify without accessing Azure")
    parser.add_argument("--output", type=Path, help="Write to a separate output MAR")
    parser.add_argument(
        "--key-id",
        default=os.environ.get("AZURE_MAR_KEY_ID"),
        help="Version-pinned key URL (defaults to AZURE_MAR_KEY_ID)",
    )
    parser.add_argument(
        "--certificate", type=Path, default=SIGNING_DIR / "release_primary.der"
    )
    args = parser.parse_args()
    try:
        key = x509.load_der_x509_certificate(args.certificate.read_bytes()).public_key()
        if not isinstance(key, rsa.RSAPublicKey) or key.key_size != 4096:
            raise ValueError("Certificate must contain an RSA-4096 public key")
        source = args.verify or args.input
        with source.open("rb") as archive:
            data = archive.read(MAX_MAR_SIZE + 1)
        if args.verify:
            verify_mar(data, key)
        else:
            output = args.output or source
            if output.resolve() == args.certificate.resolve() or (
                output.exists() and os.path.samefile(output, args.certificate)
            ):
                raise ValueError("Output cannot overwrite the signing certificate")
            if not args.key_id:
                raise ValueError("Set AZURE_MAR_KEY_ID or pass --key-id")
            replace_file(output, sign_mar(data, args.key_id, key))
        print(f"{'Verified' if args.verify else 'Signed'} {args.output or source}")
    except subprocess.CalledProcessError as error:
        print(error.stderr.strip(), file=sys.stderr)
        return 1
    except (
        OSError,
        ValueError,
        KeyError,
        InvalidSignature,
        subprocess.TimeoutExpired,
    ) as error:
        print(
            f"MAR signing failed: {error or 'signature verification failed'}",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
