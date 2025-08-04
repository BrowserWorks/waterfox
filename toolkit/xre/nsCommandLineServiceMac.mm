/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCommandLineServiceMac.h"

#include "nsString.h"
#include "nsTArray.h"
#include "MacApplicationDelegate.h"
#include "MacAutoreleasePool.h"
#include <cstring>
#include <Cocoa/Cocoa.h>

namespace CommandLineServiceMac {

static const int kArgsGrowSize = 20;

static char** sArgs = nullptr;
static int sArgsAllocated = 0;
static int sArgsUsed = 0;

void AddToCommandLine(const char* inArgText) {
  if (sArgsUsed >= sArgsAllocated - 1) {
    // realloc does not free the given pointer if allocation fails
    char** temp = static_cast<char**>(
        realloc(sArgs, (sArgsAllocated + kArgsGrowSize) * sizeof(char*)));
    if (!temp) return;
    sArgs = temp;
    sArgsAllocated += kArgsGrowSize;
  }

  char* temp2 = strdup(inArgText);
  if (!temp2) return;

  sArgs[sArgsUsed++] = temp2;
  sArgs[sArgsUsed] = nullptr;

  return;
}

// Caller has ownership of argv and is responsible for freeing the allocated
// memory.
void SetupMacCommandLine(int& argc, char**& argv, bool forRestart) {
  mozilla::MacAutoreleasePool pool;

  sArgs = static_cast<char**>(malloc(kArgsGrowSize * sizeof(char*)));
  if (!sArgs) {
    return;
  }
  sArgsAllocated = kArgsGrowSize;
  sArgs[0] = nullptr;
  sArgsUsed = 0;

  NSString* path = [NSString stringWithUTF8String:argv[0]];
  if (forRestart &&
      [path hasSuffix:[NSString stringWithUTF8String:MOZ_APP_NAME]]) {
    // When we restart, we ask the updater binary to restart us instead.
    // This avoids duplicate Dock icons, by giving this process a chance to
    // shut down before the new process is launched.
    // Essentially, we are using the updater as a relauncher process.
    NSString* updaterPath = [[path stringByDeletingLastPathComponent]
        stringByAppendingPathComponent:
            @"updater.app/Contents/MacOS/net.waterfox.updater"];
    AddToCommandLine(updaterPath.UTF8String);
    AddToCommandLine("--openAppBundle");
  }

  // We adjust the path to point to the .app bundle, rather than the executable
  // itself, to allow for the use of the NSWorkspace API for launching and
  // relaunching the application. We intentionally exclude the
  // org.mozilla.updater binary because we are experiencing NSCocoaErrors of
  // type `kLSUnknownErr` when trying to launch the updater.app with the
  // NSWorkspace API, at least on macOS 10.15. The updater is launched using
  // NSTask instead. We do not experience these NSCocoaErrors on more modern
  // versions of macOS and we may be able to switch to the NSWorkspace API once
  // we no longer support the older versions of macOS where these errors occur.
  // See bug 1911178.
  if (![path hasSuffix:@"net.waterfox.updater"] && ![path hasSuffix:@".app"]) {
    // Ensure that the path in the first argument points to the .app bundle.
    // This strips three last path components, for example:
    //
    //    Firefox.app/Contents/MacOS/firefox -> Firefox.app
    //
    path = [[[path stringByDeletingLastPathComponent]
        stringByDeletingLastPathComponent] stringByDeletingLastPathComponent];
  }
  if (![path hasSuffix:@"net.waterfox.updater"] && ![path hasSuffix:@".app"]) {
    // We were unable to obtain the path to the .app bundle and are unable to
    // build a valid command line.
    return;
  }
  AddToCommandLine(path.UTF8String);

  // Copy the rest of the args, stripping anything we don't want.
  for (int arg = 1; arg < argc; arg++) {
    char* flag = argv[arg];
    // Don't pass on the psn (Process Serial Number) flag from the OS, or
    // the "-foreground" flag since it will be set below if necessary.
    if (strncmp(flag, "-psn_", 5) != 0 && strncmp(flag, "-foreground", 11) != 0)
      AddToCommandLine(flag);
  }

  // Process the URLs we captured when the NSApp was first run and add them to
  // the command line.
  nsTArray<nsCString> startupURLs = TakeStartupURLs();
  for (const nsCString& url : startupURLs) {
    AddToCommandLine("-url");
    AddToCommandLine(url.get());
  }

  // If the process will be relaunched, the child should be in the foreground
  // if the parent is in the foreground.  This will be communicated in a
  // command-line argument to the child.
  if (forRestart) {
    NSRunningApplication* frontApp =
        [[NSWorkspace sharedWorkspace] frontmostApplication];
    if ([frontApp isEqual:[NSRunningApplication currentApplication]]) {
      AddToCommandLine("-foreground");
    }
  }

  free(argv);
  argc = sArgsUsed;
  argv = sArgs;
}

}  // namespace CommandLineServiceMac
