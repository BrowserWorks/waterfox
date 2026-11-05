# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import base64
import importlib.util
import io
import json
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa, utils

SPEC = importlib.util.spec_from_file_location(
    "sign_mar", Path(__file__).resolve().parents[1] / "sign-mar.py"
)
signer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(signer)


def unsigned_mar(kind="complete"):
    payload = f'type "{kind}"\n'.encode()
    index = struct.pack(">III", 20, len(payload), 0o644) + b"updatev3.manifest\0"
    offset = 20 + len(payload)
    return (
        struct.pack(">4sIQI", b"MAR1", offset, offset + 4 + len(index), 0)
        + payload
        + struct.pack(">I", len(index))
        + index
    )


class SignMarTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.key = rsa.generate_private_key(public_exponent=65537, key_size=4096)

    def sign_digest(self, key_id, digest):
        return self.key.sign(
            digest, padding.PKCS1v15(), utils.Prehashed(hashes.SHA384())
        )

    def signed_mar(self, kind="complete"):
        with patch.object(signer, "azure_sign", side_effect=self.sign_digest):
            return signer.sign_mar(
                unsigned_mar(kind), "test-key", self.key.public_key()
            )

    def test_complete_and_partial_signatures(self):
        for kind in ("complete", "partial"):
            with self.subTest(kind=kind):
                data = self.signed_mar(kind)
                signer.verify_mar(data, self.key.public_key())
                self.assertEqual(len(data), len(unsigned_mar(kind)) + 520)
                index, entries = signer.index_entries(data, signed=True)
                self.assertEqual(struct.unpack_from(">I", data, entries[0])[0], 540)
                self.assertEqual(data[540:index], f'type "{kind}"\n'.encode())

    def test_rejects_tampering_and_wrong_key(self):
        signed = self.signed_mar()
        wrong_key = rsa.generate_private_key(public_exponent=65537, key_size=4096)
        with self.assertRaises(InvalidSignature):
            signer.verify_mar(signed, wrong_key.public_key())
        for position in (28, 540):
            data = bytearray(signed)
            data[position] ^= 1
            with self.assertRaises(InvalidSignature):
                signer.verify_mar(data, self.key.public_key())

    def test_rejects_invalid_or_already_signed_input(self):
        signed = self.signed_mar()
        with patch.object(signer, "azure_sign") as azure:
            for data in (b"not a MAR", unsigned_mar()[:-1], signed):
                with self.assertRaises(ValueError):
                    signer.sign_mar(data, "test-key", self.key.public_key())
            azure.assert_not_called()

    def test_rejects_invalid_azure_signature(self):
        with patch.object(signer, "azure_sign", return_value=bytes(512)):
            with self.assertRaises(InvalidSignature):
                signer.sign_mar(unsigned_mar(), "test-key", self.key.public_key())


class AzureSignTests(unittest.TestCase):
    KEY_ID = "https://test-vault.vault.azure.net/keys/mar/" + "a" * 32

    def test_uses_cli_login_or_supplied_token(self):
        digest = b"\xfb" * 48
        signature = bytes(range(256)) * 2
        response = json.dumps({
            "kid": self.KEY_ID,
            "value": base64.urlsafe_b64encode(signature).decode().rstrip("="),
        }).encode()
        for token in ("", "supplied-token"):
            with self.subTest(token=token), patch.dict(
                signer.os.environ, {"AZURE_MAR_ACCESS_TOKEN": token}
            ), patch.object(
                signer.subprocess, "check_output", return_value="cli-token\n"
            ) as cli, patch.object(
                signer, "urlopen", return_value=io.BytesIO(response)
            ) as key_vault:
                self.assertEqual(signer.azure_sign(self.KEY_ID, digest), signature)
                if token:
                    cli.assert_not_called()
                else:
                    cli.assert_called_once_with(
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
                        stderr=signer.subprocess.PIPE,
                        timeout=120,
                    )
                request = key_vault.call_args.args[0]
                self.assertEqual(
                    request.full_url, self.KEY_ID + "/sign?api-version=7.4"
                )
                self.assertEqual(
                    request.get_header("Authorization"),
                    "Bearer " + (token or "cli-token"),
                )
                self.assertEqual(
                    json.loads(request.data),
                    {
                        "alg": "RS384",
                        "value": base64.urlsafe_b64encode(digest).decode().rstrip("="),
                    },
                )

    def test_rejects_different_key_version(self):
        response = json.dumps({"kid": self.KEY_ID + "b", "value": ""}).encode()
        with patch.dict(
            signer.os.environ, {"AZURE_MAR_ACCESS_TOKEN": "token"}
        ), patch.object(
            signer, "urlopen", return_value=io.BytesIO(response)
        ), self.assertRaisesRegex(ValueError, "different key version"):
            signer.azure_sign(self.KEY_ID, b"\0" * 48)


class ReplaceFileTests(unittest.TestCase):
    def test_replaces_existing_and_creates_new_files(self):
        for exists in (False, True):
            with self.subTest(
                exists=exists
            ), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "update.mar"
                if exists:
                    path.write_bytes(b"unsigned")
                signer.replace_file(path, b"signed")
                self.assertEqual(path.read_bytes(), b"signed")
                self.assertEqual(list(path.parent.iterdir()), [path])

    def test_preserves_original_when_replace_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "update.mar"
            path.write_bytes(b"unsigned")
            with patch.object(
                signer.os, "replace", side_effect=OSError("replace failed")
            ), self.assertRaisesRegex(OSError, "replace failed"):
                signer.replace_file(path, b"signed")
            self.assertEqual(path.read_bytes(), b"unsigned")
            self.assertEqual(list(path.parent.iterdir()), [path])

    def test_cleans_up_when_write_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "update.mar"
            path.write_bytes(b"unsigned")
            temporary = tempfile.NamedTemporaryFile(dir=directory, delete=False)
            with patch.object(
                signer.tempfile, "NamedTemporaryFile", return_value=temporary
            ), patch.object(
                temporary, "write", side_effect=OSError("write failed")
            ), self.assertRaisesRegex(OSError, "write failed"):
                signer.replace_file(path, b"signed")
            self.assertEqual(path.read_bytes(), b"unsigned")
            self.assertEqual(list(path.parent.iterdir()), [path])


if __name__ == "__main__":
    unittest.main()
