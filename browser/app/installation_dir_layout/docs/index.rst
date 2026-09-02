=============================
Installation Directory Layout
=============================

Rationale
===================

Firefox supports automatic downloading and applying of updates while the user is still using
the browser. However, once the update has been installed, files that the browser relies on
may have changed on disk, which caused the original implementation of update functionality to
force the user to restart the browser after updates. (See
_this bug: https://bugzilla.mozilla.org/show_bug.cgi?id=1891600 for details and discussion.)


In order to let users continue to use the browser after updates are applied, the updater needs
to leave in place the files associated with the running browser, for as long as the browser's process
exists.

The approach we are taking to enable this behavior is a new installation layout called "versioned install directories".
What this involves is:

- Under the "base" install directory, there will be one or more "versioned" install directories,
  with names based on the version of Firefox installed in them.
- Each versioned directory contains a complete installation of Firefox at the approapriate version.
- In the base install directory, there will be a launcher executable that launches the Firefox
    executable in the appropriate versioned directory for the current Firefox version,

Example of "single" layout

This process allows all of the file resolution in Firefox to remain unchanged (for example,
C:\\Program Files\\Mozilla Firefox\\136.0.1a\\firefox.exe will load libraries from the directory
C:\\Program Files\\Mozilla Firefox\\136.0.1a\\). Most code will have no need to be aware of the change.

However, when applying updates to an installation,
the updater needs to know if it should:
- apply updates to a "single" install directory, and leave a single install directory in place (current behavior)
- apply updates to a single install directory, and migrate it to be a versioned install
- apply updates to a versioned install directory, using the new versioned install behavior

This means that the updater needs a way to know unambiguously whether an installation
is using a single or versioned layout. This is the functionality provided by this module.

Module contents
===============

The installation_dir_layout module provides two different implementations of a library `installation_dir_layout.dll`

This library has a single function, `GetInstallationDirLayoutType`, which returns an enumerated type.

The implementation of `installation_dir_layout.dll` in the `single` directory returns `InstallationDirLayoutType::Single`
The implementation of `installation_dir_layout.dll` in the `versioned` directory returns `InstallationDirLayoutType::Versioned`

The interface for both implementations is specified in InstallationDirLayout.h

DLL installation
================

When Firefox is installed or updated, the installer or updater will choose the appropriate version of `installation_dir_layout.dll`
to install. This version will be available to firefox.exe and its supporting utilities as a runtime library.

DLL usage
=========

Code that needs to know about the installation directory layout (such as updater and uninstaller) will load the installed
version of the DLL and call `GetInstallationDirLayoutType`.
