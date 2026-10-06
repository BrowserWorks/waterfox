#!/usr/bin/env bash
# Generates a partial MAR from the previous release on the same channel to
# the complete MAR just built. Skips (exit 0) when no previous release is
# published yet; fails on real errors so a broken delta never ships silently.
#
# usage: make-partial.sh <to-complete-mar> <meta-env-file>
#
# Environment:
#   AUS_BASE_URL     AUS base URL for the /api/latest lookup (skip when empty)
#   CDN_BASE_URL     optional, defaults to https://cdn.waterfox.com/waterfox
#   PRE_RELEASE      true|false -> beta|release channel
#   VERSION_DISPLAY  display version being built (the "to" version)
#   OS_ARCH          AUS platform key, e.g. WINNT_x86_64, Darwin_x86_64-aarch64
#   MAR_ARCH         x86_64 | aarch64 | macos-x86_64-aarch64 (xz BCJ selection)
#   META_KEY         WIN | WINARM | MAC | LIN | LINARM
#   MAR_BIN          path to the host mar binary
#   MBSDIFF_BIN      path to the host mbsdiff binary
set -euo pipefail

USAGE="usage: make-partial.sh <to-complete-mar> <meta-env-file>"
TO_MAR="${1:?${USAGE}}"
META_ENV="${2:?${USAGE}}"

: "${PRE_RELEASE:?PRE_RELEASE must be set}"
: "${VERSION_DISPLAY:?VERSION_DISPLAY must be set}"
: "${OS_ARCH:?OS_ARCH must be set}"
: "${MAR_ARCH:?MAR_ARCH must be set}"
: "${META_KEY:?META_KEY must be set}"
: "${MAR_BIN:?MAR_BIN must be set}"
: "${MBSDIFF_BIN:?MBSDIFF_BIN must be set}"

CDN_BASE_URL="${CDN_BASE_URL:-https://cdn.waterfox.com/waterfox}"

skip() {
  echo "::notice title=Partial MAR skipped (${META_KEY})::$1"
  exit 0
}

case "$PRE_RELEASE" in
  true) CHANNEL=beta ;;
  false) CHANNEL=release ;;
  *)
    echo "PRE_RELEASE must be true or false" >&2
    exit 1
    ;;
esac

if [[ -z "${AUS_BASE_URL:-}" ]]; then
  skip "AUS_BASE_URL not provided; cannot resolve previous version"
fi

command -v xz > /dev/null || { echo "xz not found on PATH" >&2; exit 1; }
command -v python3 > /dev/null || { echo "python3 not found on PATH" >&2; exit 1; }

FROM_VERSION=$(curl -fsSL --retry 5 "${AUS_BASE_URL}/api/latest" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin) or {}; c=d.get(sys.argv[1]) or {}; print(c.get("version") or "")' "$CHANNEL")

if [[ -z "$FROM_VERSION" ]]; then
  skip "no previous version published on the ${CHANNEL} channel"
fi

if [[ "$FROM_VERSION" == "$VERSION_DISPLAY" ]]; then
  skip "latest ${CHANNEL} version is already ${VERSION_DISPLAY}"
fi

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

FROM_MAR="$WORKDIR/from.complete.mar"
FROM_URL="${CDN_BASE_URL}/releases/${FROM_VERSION}/update/${OS_ARCH}/waterfox-${FROM_VERSION}.complete.mar"

HTTP_CODE=$(curl -sSL --retry 5 -w '%{http_code}' -o "$FROM_MAR" "$FROM_URL" || echo "000")
if [[ "$HTTP_CODE" == "404" ]]; then
  skip "previous complete MAR not found (HTTP 404): ${FROM_URL}"
elif [[ "$HTTP_CODE" != "200" ]]; then
  echo "Failed to download previous complete MAR (HTTP ${HTTP_CODE}): ${FROM_URL}" >&2
  exit 1
fi

# MAR entries are individually xz-compressed; make_incremental_update.sh
# diffs plain files, so decompress everything that carries the xz magic.
unpack_mar() {
  local mar_file="$1"
  local dest="$2"
  local jobs
  jobs="$(getconf _NPROCESSORS_ONLN 2> /dev/null || echo 4)"

  mkdir -p "$dest"
  (cd "$dest" && "$MAR_BIN" -x "$mar_file")

  find "$dest" -type f -print0 | xargs -0 -P "$jobs" -I{} bash -c '
    f="$1"
    if [[ "$(head -c 6 "$f" | od -An -tx1 | tr -d " \n")" == "fd377a585a00" ]]; then
      mv "$f" "$f.xz" && xz -d "$f.xz"
    fi
  ' _ {}
}

TO_MAR_ABS="$(cd "$(dirname "$TO_MAR")" && pwd)/$(basename "$TO_MAR")"
unpack_mar "$FROM_MAR" "$WORKDIR/from"
unpack_mar "$TO_MAR_ABS" "$WORKDIR/to"

BCJ_OPTIONS=""
if [[ "$MAR_ARCH" == "x86_64" ]]; then
  BCJ_OPTIONS="--x86"
fi

FORCE_ARGS=()
if [[ "$MAR_ARCH" == macos* ]]; then
  FORCE_ARGS+=(-f Contents/MacOS/waterfox)
fi

PARTIAL_NAME="waterfox-${FROM_VERSION}-${VERSION_DISPLAY}.partial.mar"

MAR="$MAR_BIN" \
MBSDIFF="$MBSDIFF_BIN" \
BCJ_OPTIONS="$BCJ_OPTIONS" \
MOZ_PRODUCT_VERSION="$VERSION_DISPLAY" \
MAR_CHANNEL_ID="$CHANNEL" \
  bash "$(dirname "$0")/../../tools/update-packaging/make_incremental_update.sh" \
  "${FORCE_ARGS[@]+"${FORCE_ARGS[@]}"}" -q "$PARTIAL_NAME" "$WORKDIR/from" "$WORKDIR/to" waterfox

if [[ ! -s "$PARTIAL_NAME" ]]; then
  echo "Partial MAR generation produced no output: ${PARTIAL_NAME}" >&2
  exit 1
fi

PARTIAL_HASH=$(shasum -a 512 "$PARTIAL_NAME" | awk '{print $1}')
PARTIAL_SIZE=$(ls -l "$PARTIAL_NAME" | awk '{print $5}')

echo "Partial MAR: ${PARTIAL_NAME} (from ${FROM_VERSION}, ${PARTIAL_SIZE} bytes, SHA512 ${PARTIAL_HASH})"

{
  echo "${META_KEY}_PARTIAL_MAR=${PARTIAL_NAME}"
  echo "${META_KEY}_PARTIAL_HASH=${PARTIAL_HASH}"
  echo "${META_KEY}_PARTIAL_SIZE=${PARTIAL_SIZE}"
  echo "${META_KEY}_PARTIAL_FROM=${FROM_VERSION}"
} >> "$META_ENV"
