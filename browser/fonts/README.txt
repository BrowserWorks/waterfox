# Twemoji Mozilla

TwemojiMozilla.ttf is a COLR/CPAL font built from Twemoji 17.0.2 artwork
using Mozilla's twemoji-colr pipeline, with the updates from PR #74:

  https://github.com/mozilla/twemoji-colr/pull/74

Pinned source revision:

  https://github.com/win98se/twemoji-colr/commit/3e8996668dfcf9460965ebd131e168033de08e8c

The font's internal family name is "Twemoji Mozilla".

SHA-256 of the bundled font:

  12474850b0764240adf20f1b73f6f5990eefa0fc2b22861d2798309df1d0185d

## Build

The bundled font was generated on macOS with FontForge 20251009,
Node.js 26.8.2, npm 11.19.1, Python 3.14.7, fonttools 4.62.1, and
setuptools 80.9.0. From the pinned source checkout:

  npm install
  uv venv --python python3.14 .venv
  uv pip install --python .venv/bin/python fonttools==4.62.1 setuptools==80.9.0

For compatibility with current Python, in
node_modules/grunt-webfonts/tasks/engines/fontforge/generate.py replace:

  from distutils.spawn import find_executable

with:

  from shutil import which as find_executable

Build using FontForge's Python interpreter for fixDirection.py:

  PYTHONPATH="$PWD/.venv/lib/python3.14/site-packages" \
    make PYTHON='fontforge -lang=py -script' TTX=.venv/bin/ttx

Copy build/Twemoji Mozilla.ttf to browser/fonts/TwemojiMozilla.ttf.
The pinned twemoji-colr source and artwork were not otherwise modified.
The checksum identifies this binary; build timestamps and dependency
resolution may differ on subsequent builds.

## Format and validation

Keep COLR/CPAL with TrueType outlines for Windows compatibility. The
CBDT/CBLC bitmap-only ttf-twemoji build is not a suitable replacement for
Waterfox's Windows font-rendering path, even though it contains flags.

The bundled font was checked with fonttools and HarfBuzz: COLR version 0,
4,010 color glyphs with nonempty outlines, and all 259 regional-indicator
flag sequences in the source artwork shaping to color glyphs. Subdivision
flags, keycaps, skin tones, a ZWJ family, and new Emoji 17 characters were
also checked. These checks do not replace Windows rendering tests.

The source emoji artwork comes from jdecked's Twemoji repository:

  https://github.com/jdecked/twemoji

See about:license for license information.
