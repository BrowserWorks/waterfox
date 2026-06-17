Format: 1.0
Source: waterfox
Version: @PACKAGE_VERSION@-0
Binary: waterfox
Maintainer: BrowserWorks <MrAlex94@users.noreply.github.com>
Architecture: @DEB_ARCH@
# OBS reads Build-Depends from this .dsc to set up the build chroot, so it must
# match debian.control. The runtime libraries are needed for dh_shlibdeps.
Build-Depends: debhelper (>= 9),
 libgtk-3-0 | libgtk-3-0t64,
 libglib2.0-0 | libglib2.0-0t64,
 libatk1.0-0 | libatk1.0-0t64,
 libasound2 | libasound2t64,
 libdbus-1-3,
 libpango-1.0-0,
 libcairo2,
 libcairo-gobject2,
 libgdk-pixbuf-2.0-0,
 libfreetype6,
 libfontconfig1,
 libx11-6,
 libx11-xcb1,
 libxcb1,
 libxcb-shm0,
 libxext6,
 libxrandr2,
 libxcomposite1,
 libxcursor1,
 libxdamage1,
 libxfixes3,
 libxi6,
 libxrender1
Files:
 0 0 waterfox-@PACKAGE_VERSION@.tar.bz2
