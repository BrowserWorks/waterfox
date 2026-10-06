#!/usr/bin/env bash
# Staging omits installer metadata; production also flips /admin/latest.
set -euo pipefail

USAGE="usage: aus-publish.sh <staging|production> <metadata-env-file>"
MODE="${1:?${USAGE}}"
METADATA="${2:?${USAGE}}"

case "$MODE" in
  staging|production) ;;
  *)
    echo "$USAGE" >&2
    exit 1
    ;;
esac

# Derive the channel from the workflow input before sourcing the metadata,
# which carries its own PRE_RELEASE value from build time.
case "$PRE_RELEASE" in
  true) CHANNEL=beta ;;
  false) CHANNEL=release ;;
  *)
    echo "PRE_RELEASE must be true or false" >&2
    exit 1
    ;;
esac

set -a
. "$METADATA"
set +a

WITH_INSTALLERS=false
if [[ "$MODE" == "production" ]]; then
  WITH_INSTALLERS=true
fi

RELEASE_DATE="$(date -u +%F)"

jq -n \
  --argjson withInstallers "$WITH_INSTALLERS" \
  --arg appVersion "$APP_VERSION" \
  --arg buildID "$BUILD_ID" \
  --arg releaseDate "$RELEASE_DATE" \
  --arg channel "$CHANNEL" \
  --arg version "$DISPLAY_VERSION" \
  --argjson winMarSize "$WIN_MAR_SIZE" \
  --argjson macMarSize "$MAC_MAR_SIZE" \
  --argjson linMarSize "$LIN_MAR_SIZE" \
  --argjson winArmMarSize "$WINARM_MAR_SIZE" \
  --argjson linArmMarSize "$LINARM_MAR_SIZE" \
  --arg winInstallerHash "${WIN_INSTALLER_HASH:-}" --argjson winInstallerSize "${WIN_INSTALLER_SIZE:-0}" \
  --arg macInstallerHash "${MAC_INSTALLER_HASH:-}" --argjson macInstallerSize "${MAC_INSTALLER_SIZE:-0}" \
  --arg linInstallerHash "${LIN_INSTALLER_HASH:-}" --argjson linInstallerSize "${LIN_INSTALLER_SIZE:-0}" \
  --arg winArmInstallerHash "${WINARM_INSTALLER_HASH:-}" --argjson winArmInstallerSize "${WINARM_INSTALLER_SIZE:-0}" \
  --arg linArmInstallerHash "${LINARM_INSTALLER_HASH:-}" --argjson linArmInstallerSize "${LINARM_INSTALLER_SIZE:-0}" \
  --arg winPartialMar "${WIN_PARTIAL_MAR:-}" \
  --argjson winPartialSize "${WIN_PARTIAL_SIZE:-0}" --arg winPartialFrom "${WIN_PARTIAL_FROM:-}" \
  --arg macPartialMar "${MAC_PARTIAL_MAR:-}" \
  --argjson macPartialSize "${MAC_PARTIAL_SIZE:-0}" --arg macPartialFrom "${MAC_PARTIAL_FROM:-}" \
  --arg linPartialMar "${LIN_PARTIAL_MAR:-}" \
  --argjson linPartialSize "${LIN_PARTIAL_SIZE:-0}" --arg linPartialFrom "${LIN_PARTIAL_FROM:-}" \
  --arg winArmPartialMar "${WINARM_PARTIAL_MAR:-}" \
  --argjson winArmPartialSize "${WINARM_PARTIAL_SIZE:-0}" --arg winArmPartialFrom "${WINARM_PARTIAL_FROM:-}" \
  --arg linArmPartialMar "${LINARM_PARTIAL_MAR:-}" \
  --argjson linArmPartialSize "${LINARM_PARTIAL_SIZE:-0}" --arg linArmPartialFrom "${LINARM_PARTIAL_FROM:-}" \
  '
  def plat(marSize; installer; partial):
    {mar: ("waterfox-" + $version + ".complete.mar"), size: marSize}
    + (if partial.mar != "" then {partials: [partial]} else {} end)
    + (if $withInstallers then {installer: installer} else {} end);
  {
    appVersion: $appVersion,
    buildID: $buildID,
    releaseDate: $releaseDate,
    rollout: 0,
    channels: [$channel],
    platforms: {
      WINNT_x86_64: plat($winMarSize;
        {file: ("Waterfox Setup " + $version + ".exe"), hash: $winInstallerHash, size: $winInstallerSize};
        {mar: $winPartialMar, size: $winPartialSize, from: $winPartialFrom}),
      "Darwin_x86_64-aarch64": plat($macMarSize;
        {file: ("Waterfox " + $version + ".dmg"), hash: $macInstallerHash, size: $macInstallerSize};
        {mar: $macPartialMar, size: $macPartialSize, from: $macPartialFrom}),
      Linux_x86_64: plat($linMarSize;
        {file: ("waterfox-" + $version + ".tar.bz2"), hash: $linInstallerHash, size: $linInstallerSize};
        {mar: $linPartialMar, size: $linPartialSize, from: $linPartialFrom}),
      WINNT_aarch64: plat($winArmMarSize;
        {file: ("Waterfox Setup " + $version + ".exe"), hash: $winArmInstallerHash, size: $winArmInstallerSize};
        {mar: $winArmPartialMar, size: $winArmPartialSize, from: $winArmPartialFrom}),
      Linux_aarch64: plat($linArmMarSize;
        {file: ("waterfox-" + $version + ".tar.bz2"), hash: $linArmInstallerHash, size: $linArmInstallerSize};
        {mar: $linArmPartialMar, size: $linArmPartialSize, from: $linArmPartialFrom})
    },
    unsupported: [],
    paused: false
  }' > version.json

if [[ "$MODE" == "staging" ]]; then
  curl -fsS -X PUT \
    "${AUS_BASE_URL}/admin/staging/versions/${DISPLAY_VERSION}" \
    -H "Authorization: Bearer ${AUS_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary @version.json
else
  curl -fsS -X PUT \
    "${AUS_BASE_URL}/admin/versions/${DISPLAY_VERSION}" \
    -H "Authorization: Bearer ${AUS_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data-binary @version.json

  curl -fsS -X PATCH \
    "${AUS_BASE_URL}/admin/latest" \
    -H "Authorization: Bearer ${AUS_ADMIN_TOKEN}" \
    -H "Content-Type: application/json" \
    --data "{\"${CHANNEL}\":\"${DISPLAY_VERSION}\"}"
fi
