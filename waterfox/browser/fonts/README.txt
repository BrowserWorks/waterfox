# Archivo

Archivo.woff2 is the Archivo variable font (wght 100-900, wdth 62-125)
used for headings on Waterfox pages, from the Archivo project by
Omnibus-Type:

  https://github.com/Omnibus-Type/archivo

It is the Waterfox website's Archivo.woff2, recompressed with fontTools.
The internal name table still says "Archivo SemiBold" with a wght=600
default instance; that does not matter because the @font-face rule in
fonts.css defines the family name and axis ranges used for matching.

SHA-256:

  fafe8c6da61cb81b60a65332d69bb3860fb6673f72a71d4b4fd7ff405679589c  Archivo.woff2

Archivo is licensed under the SIL Open Font License 1.1. See
about:license for the license text.

# Noto Color Emoji

Noto-COLRv1.ttf is the unmodified Noto Color Emoji font from Google's
noto-emoji project, bundled for Windows and GTK/Linux only. It replaces
the bundled Twemoji font on those platforms. macOS continues to use its
native emoji font; this migration does not change macOS.

Upstream project:

  https://github.com/googlefonts/noto-emoji

Pinned source:

  Commit: e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e
  Path: 2D/fonts/Noto-COLRv1.ttf
  Release: v2026-09-24-unicode18_0
  Unicode version: 18.0
  Font version: 2.057
  Family: Noto Color Emoji
  Copyright: Copyright 2022 Google Inc.
  Size: 5038236 bytes
  Git blob: d1c82373d26e6949d81bbaefa4323f1e19f77262

SHA-256:

  b8e25ea68db82f9e4d0aee921f4420be2be39887bd5c893a2ad98710531f9d0c  Noto-COLRv1.ttf

The font uses OpenType COLR version 1 color glyphs with CPAL palettes and
glyf outlines. It contains 4012 color glyphs and no SVG or bitmap tables.
These metadata describe the supplied font, not runtime rendering results.

To update, download the upstream font unchanged from a pinned commit and
update the source, version, size, Git blob, and SHA-256 recorded above.
Do not rebuild, subset, rename its internal family, or convert the font.
The current pinned download is:

  https://raw.githubusercontent.com/googlefonts/noto-emoji/e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e/2D/fonts/Noto-COLRv1.ttf

Noto Color Emoji is licensed under the SIL Open Font License 1.1.
LICENSE-Noto.txt is the unmodified upstream 2D/fonts/LICENSE from the same
pinned commit:

  https://raw.githubusercontent.com/googlefonts/noto-emoji/e20cbc2bbec1926686be9f9bee7d1d2cfa1fea0e/2D/fonts/LICENSE

Keep LICENSE-Noto.txt installed beside Noto-COLRv1.ttf on Windows and
GTK/Linux. about:license also includes the font copyright and full
upstream license text.
