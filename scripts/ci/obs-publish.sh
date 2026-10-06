#!/usr/bin/env bash
set -euo pipefail

version=$1
project=isv:BrowserWorks
branch=obs/waterfox
recipe_dir=waterfox/browser/installer/linux/obs

: "${OBS_TRIGGER_TOKEN:?}" "${RELEASE_TOKEN:?}" "${GITHUB_REPOSITORY:?}"

# rpm forbids hyphens in Version
pkg_version=${version/-beta./\~beta.}
if [[ "$pkg_version" == *-* ]]; then
  echo "unsupported version format: $version" >&2
  exit 1
fi

workdir=$(mktemp -d)
trap 'rm -rf "$workdir"' EXIT

render() { # <subdir> <rpm arch> <deb arch>
  mkdir -p "$workdir/pkg/$1"
  cp -R "$recipe_dir/." "$workdir/pkg/$1/"
  sed -i.bak "s/@PACKAGE_VERSION@/$pkg_version/g; s/@UPSTREAM_VERSION@/$version/g; s/@RPM_ARCH@/$2/g; s/@DEB_ARCH@/$3/g" \
    "$workdir/pkg/$1/waterfox.spec" "$workdir/pkg/$1/waterfox.dsc" "$workdir/pkg/$1/debian.changelog" \
    "$workdir/pkg/$1/_service"
  rm "$workdir/pkg/$1"/*.bak
}

git init -q -b "$branch" "$workdir/pkg"
git -C "$workdir/pkg" remote add origin \
  "https://x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git"
if git -C "$workdir/pkg" fetch -q --depth 1 origin "refs/heads/$branch" 2>/dev/null; then
  git -C "$workdir/pkg" reset -q --hard FETCH_HEAD
  find "$workdir/pkg" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
fi
render waterfox x86_64 amd64
render waterfox-aarch64 aarch64 arm64
if grep -rq '@\(PACKAGE\|UPSTREAM\)_VERSION@\|@\(RPM\|DEB\)_ARCH@' "$workdir/pkg" \
  --exclude-dir=.git --exclude=README.md; then
  echo "unresolved recipe placeholder" >&2
  exit 1
fi

git -C "$workdir/pkg" add -A
if ! git -C "$workdir/pkg" diff --cached --quiet; then
  git -C "$workdir/pkg" \
    -c user.name='github-actions[bot]' \
    -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
    commit -q -m "Waterfox $version"
fi
git -C "$workdir/pkg" push -q origin "HEAD:refs/heads/$branch"

for package in waterfox waterfox-aarch64; do
  curl -fsS -X POST -H "Authorization: Token ${OBS_TRIGGER_TOKEN}" \
    "https://build.opensuse.org/trigger/runservice?project=${project}&package=${package}"
done

echo "Waiting for OBS to sync the recipes and fetch the tarballs from the CDN"
for package in waterfox waterfox-aarch64; do
  url="https://api.opensuse.org/public/source/${project}/${package}"
  synced=
  for _ in $(seq 60); do
    sleep 30
    listing=$(curl -fsS "$url?rev=latest") || continue
    if grep -q 'code="failed"' <<<"$listing"; then
      echo "OBS source services failed; check ${project}/${package} in the OBS web UI" >&2
      exit 1
    fi
    if grep -q 'code="succeeded"' <<<"$listing" \
      && curl -fsS "$url/waterfox.spec?rev=latest" | grep -q "^Version: *${pkg_version}\$"; then
      echo "${package} carries ${pkg_version}; builds are queued"
      synced=1
      break
    fi
  done
  if [[ -z "$synced" ]]; then
    echo "timed out waiting for ${package} to pick up ${pkg_version}" >&2
    exit 1
  fi
done
