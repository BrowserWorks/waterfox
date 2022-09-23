## Please refer to the following commit:
# https://github.com/WaterfoxCo/Waterfox/commit/f92e95c09ecd98f987bf54e1e6a1cf969b683277

# Make sure to execute from the scripts directory
cd $(dirname $0)

## Download latest release, override icons and CSS
mkdir -p tmp
curl -LJ `curl -s https://api.github.com/repos/black7375/Firefox-UI-Fix/releases/latest | python3  -c 'import sys, json; print(json.load(sys.stdin)["tarball_url"])'` | tar -zxf - --strip 1 -C tmp
mv -f tmp/icons/* icons
mv -f tmp/css/leptonChrome.css leptonChrome.css
mv -f tmp/css/leptonContent.css leptonContent.css
rm -r tmp

## Replace Path
# `./icons/` to `chrome://browser/skin/lepton/`
replace_icon_path() {
  sedi () {
    case $(uname -s) in
        *[Dd]arwin* | *BSD* ) sed -i '' "$@";;
        *) sed -i "$@";;
    esac
}
  file=$1
  sedi "s/\.\.\/icons\//chrome:\/\/browser\/skin\/lepton\//g" "${file}"
}
replace_icon_path ./leptonChrome.css
replace_icon_path ./leptonContent.css
