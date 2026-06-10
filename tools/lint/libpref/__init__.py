# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import re
import sys

import yaml
from mozlint import result
from mozlint.pathutils import expand_exclusions

# This simple linter checks for duplicates from
# modules/libpref/init/StaticPrefList.yaml against modules/libpref/init/all.js

# If for any reason a pref needs to appear in both files, add it to this set.
IGNORE_PREFS = {
    "devtools.console.stdout.chrome",  # Uses the 'sticky' attribute.
    "devtools.console.stdout.content",  # Uses the 'sticky' attribute.
    "fission.autostart",  # Uses the 'locked' attribute.
    "browser.dom.window.dump.enabled",  # Uses the 'sticky' attribute.
    "apz.fling_curve_function_y2",  # This pref is a part of a series.
    "dom.postMessage.sharedArrayBuffer.bypassCOOP_COEP.insecure.enabled",  # NOQA: E501; Uses the 'locked' attribute.
    "extensions.backgroundServiceWorker.enabled",  # NOQA: E501; Uses the 'locked' attribute.
    "general.smoothScroll",  # Uses the 'sticky` attribute.
    "layout.word_select.eat_space_to_next_word",  # Waterfox overrides the Windows default.
    "security.storage.encryption.sqlite.enabled",  # NOQA: E501; Uses the 'locked' attribute.
}

# A regular expression to match preference names and values from js preference
# files. This is not an exact parser, but close enough for our purposes.
# The exact parser grammar is defined at https://searchfox.org/mozilla-central/rev/5c2888b35d56928d252acf84e8816fa89a8a6a61/modules/libpref/parser/src/lib.rs#5-30
PATTERN = re.compile(
    r"""
    \s*pref\(
    \s*"
        (?P<pref>[^"]+)
    "
    \s*,
    \s*
        (?P<val>
            "(              # String value
                [^"\\]+     # Any unescaped string character.
                |
                \\.         # An escaped character.
            )*"
            |
            [^,)]+          # other literals: true, false, integers
        )
        (\s*,.*)?           # optional pref-attr: "sticky" | "locked"
    \s*\)
    \s*;.*
    """,
    re.VERBOSE,
)


def get_names(pref_list_filename):
    pref_names = {}
    # We want to transform patterns like 'foo: @VAR@' into valid yaml. This
    # pattern does not happen in 'name', so it's fine to ignore these.
    # We also want to evaluate all branches of #ifdefs for pref names, so we
    # ignore anything else preprocessor related.
    file = open(pref_list_filename, encoding="utf-8").read().replace("@", "")
    try:
        pref_list = yaml.safe_load(file)
    except (OSError, ValueError) as e:
        print(f"{pref_list_filename}: error:\n  {e}", file=sys.stderr)
        sys.exit(1)

    # Caveats on pref["value"]:
    # - StaticPrefList.yaml may contain expressions such as 10*1000, 0.0f, and
    #   even float(M_PI / 6.0). We don't parse these and may therefore fail to
    #   report these prefs if their value in the js pref file still matches.
    # - Some prefs have values dependent on preprocessor directives. In these
    #   cases, the last value takes precedence over values declared at an
    #   earlier line.
    for pref in pref_list:
        if pref["name"] not in IGNORE_PREFS:
            pref_names[pref["name"]] = pref["value"]

    return pref_names


# Check the names of prefs against each other, and if the pref is a duplicate
# that has not previously been noted, add that name to the list of errors.
def check_against(path, pref_names):
    errors = []
    prefs = read_prefs(path)
    for pref in prefs:
        if pref["name"] in pref_names:
            errors.extend(check_value_for_pref(pref, pref_names[pref["name"]], path))
    return errors


def check_value_for_pref(some_pref, some_value, path):
    errors = []
    if some_pref["value"] == some_value:
        errors.append({
            "path": path,
            "message": some_pref["raw"],
            "lineno": some_pref["line"],
            "hint": "Remove the duplicate pref or add it to IGNORE_PREFS.",
            "level": "error",
        })
    return errors


# The entries in the *.js pref files are regular enough to use simple pattern
# matching to load in prefs.
def read_prefs(path):
    prefs = []
    with open(path, encoding="utf-8") as source:
        for lineno, line in enumerate(source, start=1):
            match = PATTERN.match(line)
            if match:
                prefs.append({
                    "name": match.group("pref"),
                    "value": evaluate_pref(match.group("val")),
                    "line": lineno,
                    "raw": line,
                })
    return prefs


def evaluate_pref(value):
    bools = {"true": True, "false": False}
    if value in bools:
        return bools[value]
    elif value.isdigit():
        return int(value)
    return value


def checkdupes(paths, config, **kwargs):
    results = []
    errors = []
    pref_names = get_names(config["support-files"][0])
    files = list(expand_exclusions(paths, config, kwargs["root"]))
    for file in files:
        errors.extend(check_against(file, pref_names))
    for error in errors:
        results.append(result.from_config(config, **error))
    return results
