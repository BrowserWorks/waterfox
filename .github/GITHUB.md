# GitHub CI

This folder contains the GitHub Actions workflows used to build, sign, stage, and publish Waterfox releases.

## Quick mental model

The normal end-to-end flow is:

- `pipeline.yml` (orchestrator)
  - calls `build.yml` (produce build artifacts + metadata)
  - calls `sign.yml` (consume build artifacts, sign/package, output signed artifacts)
  - calls `publish.yml` (consume signed artifacts, stage to R2/AUS, optionally promote to production)

`publish.yml` calls:
- `stage.yml` (uploads installers/MARs/update.xml into the staging locations)
- `production.yml` (promotes staging → production and updates redirects; only runs for non-pre-release)

Each of `build.yml`, `sign.yml`, `publish.yml`, and `stage.yml` can also be run directly via `workflow_dispatch` for manual operations.

---

## Prerequisites

- GitHub CLI (`gh`) installed
- Authenticated to GitHub:
  ```sh
  gh auth login
  ```

- Use `-R BrowserWorks/waterfox` to avoid accidentally running workflows on a fork.

---

## Common CLI commands

### List workflows

```sh
gh workflow list -R BrowserWorks/waterfox
```

### List recent runs for a workflow

```sh
gh run list -R BrowserWorks/waterfox --workflow pipeline.yml --limit 10
```

### View a run (summary)

```sh
gh run view -R BrowserWorks/waterfox <RUN_ID>
```

### View logs (failed steps only)

```sh
gh run view -R BrowserWorks/waterfox <RUN_ID> --log-failed
```

### Download artifacts from a run (all)

```sh
RUN_ID=<RUN_ID>
OUT="/tmp/waterfox-artifacts/$RUN_ID"
rm -rf "$OUT" && mkdir -p "$OUT"

gh run download "$RUN_ID" -R BrowserWorks/waterfox --dir "$OUT"
find "$OUT" -maxdepth 4 -print | sed "s|$OUT/||" | sort
```

### Download a specific artifact by name

```sh
RUN_ID=<RUN_ID>
OUT="/tmp/waterfox-artifacts/$RUN_ID/windows-signed"
rm -rf "$OUT" && mkdir -p "$OUT"

gh run download "$RUN_ID" -R BrowserWorks/waterfox --name windows-signed --dir "$OUT"
find "$OUT" -maxdepth 2 -type f -print | sed "s|$OUT/||" | sort
```

---

## Workflows

### 1. `pipeline.yml`
**Purpose:** full deployment: build → sign → publish.

**How to run:**
```sh
DATE="$(date +'%Y%m%d%H%M%S')"

gh workflow run pipeline.yml \
  -R BrowserWorks/waterfox \
  -r current \
  -f prerelease=false \
  -f tags=6.6.7 \
  -f date="$DATE"
```

**Inputs:**
- `date` (string, required): build date / identifier
- `prerelease` (string, required): `true`/`false`
- `tags` (string, required): display/release version (e.g. `6.6.7`)

Notes:
- `pipeline.yml` calls the reusable workflows and passes the correct secrets/inputs.
- Pipeline runs intentionally set `manual_*` flags to `false` so they do not require GitHub App credentials for cross-run artifact access.

### 2. `build.yml`
**Purpose:** build platform artifacts and upload them.

**Typical usage:** called by `pipeline.yml`.

**How to run manually:**
```sh
gh workflow run build.yml \
  -R BrowserWorks/waterfox \
  -r current \
  -f PRE_RELEASE=false \
  -f TAG_VERSION=6.6.7 \
  -f MOZ_BUILD_DATE="$(date +'%Y%m%d%H%M%S')"
```

**Key outputs/artifacts (high-level):**
- `build-metadata` (artifact): a small env file consumed by `sign.yml`
- platform build artifacts (names vary by platform/arch)

### 3. `sign.yml`
**Purpose:** download build artifacts, sign/package them, and upload signed artifacts (`windows-signed`, `macos-signed`, `linux-signed`).

#### Normal mode (pipeline)
Called by `pipeline.yml` with `manual_resign: 'false'`.

#### Manual re-sign mode (direct run)
Use this when to re-sign artifacts from an existing **build workflow run**.

```sh
gh workflow run sign.yml \
  -R BrowserWorks/waterfox \
  -r current \
  -f build_run_id=<BUILD_RUN_ID>
```

**Inputs:**
- `build_run_id` (string, optional): build workflow run id to sign from
- `manual_resign` (string):
  - default for direct manual runs: `true`
  - default for workflow_call: `false`

**GitHub App credentials (manual re-sign only):**
Manual re-sign downloads artifacts across workflow runs using a GitHub App token.
Required secrets:
- `ARTIFACTS_APP_ID`
- `ARTIFACTS_APP_PRIVATE_KEY`

### 4. `publish.yml`
**Purpose:** download `sign-metadata` from a signing run, then stage artifacts and (optionally) promote to production.

#### Normal mode (pipeline)
Called by `pipeline.yml` with `manual_publish: 'false'`.

#### Manual publish mode (direct run)
Use this to publish from an existing **sign workflow run**.

```sh
gh workflow run publish.yml \
  -R BrowserWorks/waterfox \
  -r current \
  -f sign_run_id=<SIGN_RUN_ID>
```

**Inputs:**
- `sign_run_id` (string, optional): sign workflow run id to publish from
- `manual_publish` (string):
  - default for direct manual runs: `true`
  - default for workflow_call: `false`

**GitHub App credentials (manual publish only):**
- `ARTIFACTS_APP_ID`
- `ARTIFACTS_APP_PRIVATE_KEY`

### 5. `stage.yml`
**Purpose:** upload signed artifacts to staging locations (R2/AUS).

Usually invoked by `publish.yml`, but can be run directly.

**How to run manually:**
```sh
gh workflow run stage.yml \
  -R BrowserWorks/waterfox \
  -r current \
  -f DISPLAY_VERSION=6.6.7 \
  -f PRE_RELEASE=false \
  -f SIGN_RUN_ID=<SIGN_RUN_ID>
```

**Inputs:**
- `DISPLAY_VERSION` (string, required)
- `PRE_RELEASE` (string, optional)
- `SIGN_RUN_ID` (string, required)
- `manual_stage` (string):
  - default for direct manual runs: `true`
  - default for workflow_call: `false`

**GitHub App credentials (manual stage only):**
- `ARTIFACTS_APP_ID`
- `ARTIFACTS_APP_PRIVATE_KEY`

### 6) `production.yml` — 🚀 Production
**Purpose:** production promotion / redirects / final release publishing steps.

Normally invoked by `publish.yml` after staging.

---

## Notes

### Reusable workflow secrets are not automatic
When a workflow is called via `workflow_call`, it only receives secrets that the caller passes (or `secrets: inherit` if used). This is why the pipeline explicitly passes the secrets it needs.

Manual `workflow_dispatch` operations often download artifacts from a different run id. Those are gated behind `manual_*` inputs and may require GitHub App credentials.

## Helpers

Get the latest pipeline run id:
```sh
gh run list -R BrowserWorks/waterfox --workflow pipeline.yml --limit 1 --json databaseId -q '.[0].databaseId'
```

Download and list signed artifacts for a run:
```sh
RUN_ID=<RUN_ID>
OUT="/tmp/waterfox-artifacts/$RUN_ID"
rm -rf "$OUT" && mkdir -p "$OUT"

for a in windows-signed macos-signed linux-signed; do
  gh run download "$RUN_ID" -R BrowserWorks/waterfox --name "$a" --dir "$OUT/$a" || true
done

find "$OUT" -maxdepth 3 -type f -print | sed "s|$OUT/||" | sort
```
