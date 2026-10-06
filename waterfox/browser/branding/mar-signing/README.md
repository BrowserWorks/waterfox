# MAR signing

MAR files contain browser updates. Release and beta builds use
`release_primary.der` and `release_secondary.der` to verify update signatures.
Either corresponding private key can sign an update. Private keys are not
included here.

## Sign and verify

The release workflow signs updates automatically. Local signing requires
configured access to the signing service. With `uv` installed, run from the
repository root:

```sh
uv run scripts/ci/sign-mar.py --input candidate.complete.mar
```

The script verifies the signature before replacing the unsigned input file.
To verify a signed MAR using only a public certificate:

```sh
uv run scripts/ci/sign-mar.py --verify candidate.complete.mar
```

Verification uses `release_primary.der` by default. Use `--certificate` with
the path to another certificate to verify against it.

## Publishing updates

Signing increases the archive's size. Update XML must contain the signed file's
size in bytes. The release workflow records this after signing.

Before switching signing keys, distribute the new public certificate in a
browser update signed with a key that installed browsers already trust.

## Development builds

The default developer configuration accepts unsigned updates from
`http://127.0.0.1:8000/update.xml`. Updating with this configuration does not test
release signature enforcement. Use a disposable profile and installation.
