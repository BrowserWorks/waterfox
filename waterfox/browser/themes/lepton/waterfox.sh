## Please refer to the following commit:
# https://github.com/WaterfoxCo/Waterfox/commit/f92e95c09ecd98f987bf54e1e6a1cf969b683277

# Make sure to execute from the scripts directory
cd $(dirname $0)

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
