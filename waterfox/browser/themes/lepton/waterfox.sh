#!/bin/sh
# Sync the vendored Lepton (Firefox-UI-Fix) copy. Run from this directory:
#   ./waterfox.sh [ref]
# Without a ref the latest upstream master commit is used. Record the synced
# commit in the commit message.

cd "$(dirname "$0")" || exit 1

REF=${1:-master}
COMMIT=$(curl -fsSL "https://api.github.com/repos/black7375/Firefox-UI-Fix/commits/${REF}" | python3 -c 'import sys, json; print(json.load(sys.stdin)["sha"])') || exit 1

mkdir -p tmp
curl -LJ "https://github.com/black7375/Firefox-UI-Fix/tarball/${COMMIT}" | tar -zxf - --strip 1 -C tmp
mv -f tmp/icons/* icons
mv -f tmp/css/leptonChrome.css leptonChrome.css
rm -r tmp

sedi() {
  case $(uname -s) in
    *[Dd]arwin* | *BSD*) sed -i '' "$@" ;;
    *) sed -i "$@" ;;
  esac
}

# Icon paths must resolve inside the jar.
sedi 's/\.\.\/icons\//chrome:\/\/browser\/skin\/lepton\//g' leptonChrome.css
# Gecko replaced the -moz-bool-pref media feature with -moz-pref().
sedi 's/(-moz-bool-pref: \("[^"]*"\))/-moz-pref(\1)/g' leptonChrome.css

echo "Synced Lepton ${COMMIT}"
