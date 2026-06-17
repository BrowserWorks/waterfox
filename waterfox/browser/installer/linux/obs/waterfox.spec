# Waterfox OBS package.
#
# This wraps the prebuilt, Widevine VMP signed Linux tarball produced by the
# Waterfox GitHub Actions build. There is no compilation here. The binaries are
# already stripped and VMP signed, so this spec must not strip or otherwise
# modify them: any change to the binaries invalidates the VMP signature and
# breaks DRM playback. That is why all of rpm's post-install binary processing
# is disabled below.
%global __os_install_post %{nil}
%global debug_package %{nil}
%global __strip /bin/true

%global mozappdir /usr/lib/waterfox
%global upstream_version @UPSTREAM_VERSION@

# Waterfox bundles its own NSS, NSPR, sqlite and so on. Let the package both
# provide and require those internal sonames so they satisfy each other; only
# drop the bundled libonnxruntime, which has no provider.
%global __requires_exclude_from ^%{mozappdir}/.*/libonnxruntime\\.so$

Name:           waterfox
Version:        @PACKAGE_VERSION@
Release:        0%{?dist}
Summary:        Waterfox, a privacy conscious web browser
License:        MPL-2.0
URL:            https://www.waterfox.net/
Vendor:         BrowserWorks
ExclusiveArch:  @RPM_ARCH@

Source0:        https://cdn.waterfox.com/waterfox/releases/%{upstream_version}/Linux_@RPM_ARCH@/waterfox-%{upstream_version}.tar.bz2#/waterfox-%{version}.tar.bz2
Source2:        waterfox.desktop
Source3:        waterfox.1
Source4:        package-prefs.js
Source5:        waterfox.appdata.xml

# Runtime dependencies are generated automatically from the binaries' shared
# library references (gtk3, X11, and the rest). The bundled sonames self satisfy.

%description
Waterfox is a customizable, privacy conscious web browser based on Firefox.

%prep
%setup -q -n waterfox -T -b 0

%build
# Nothing to build: prebuilt, VMP signed binaries.

%install
mkdir -p %{buildroot}%{mozappdir}
cp -a . %{buildroot}%{mozappdir}

mkdir -p %{buildroot}%{_bindir}
ln -s %{mozappdir}/waterfox %{buildroot}%{_bindir}/waterfox

install -D -m 0644 %{SOURCE2} %{buildroot}%{_datadir}/applications/waterfox.desktop
install -D -m 0644 %{SOURCE3} %{buildroot}%{_mandir}/man1/waterfox.1
install -D -m 0644 %{SOURCE5} %{buildroot}%{_datadir}/metainfo/waterfox.appdata.xml
install -D -m 0644 %{SOURCE4} %{buildroot}%{mozappdir}/defaults/pref/package-prefs.js

# Marker so Waterfox knows it is a packaged build (the in-app updater is off).
echo "This is a packaged app." > %{buildroot}%{mozappdir}/is-packaged-app

for size in 16 32 48 64 128; do
    install -D -m 0644 \
        %{buildroot}%{mozappdir}/browser/chrome/icons/default/default${size}.png \
        %{buildroot}%{_datadir}/icons/hicolor/${size}x${size}/apps/waterfox.png
done

%files
%dir %{mozappdir}
%{mozappdir}/*
%{_bindir}/waterfox
%{_datadir}/applications/waterfox.desktop
%{_mandir}/man1/waterfox.1*
%{_datadir}/metainfo/waterfox.appdata.xml
%{_datadir}/icons/hicolor/*/apps/waterfox.png

%changelog
* Wed Jun 17 2026 BrowserWorks <MrAlex94@users.noreply.github.com> - @PACKAGE_VERSION@-0
- Packaged release.
