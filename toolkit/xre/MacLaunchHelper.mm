/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "MacLaunchHelper.h"

#include "MacAutoreleasePool.h"
#include "MacUtils.h"
#include "mozilla/UniquePtr.h"

#include <Cocoa/Cocoa.h>
#include <crt_externs.h>
#include <ServiceManagement/ServiceManagement.h>
#include <Security/Authorization.h>
#include <spawn.h>
#include <stdio.h>

using namespace mozilla;
using namespace mozilla::MacUtils;
using namespace mozilla::MacLaunchHelper;

static void RegisterAppWithLaunchServices(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  @try {
    OSStatus status =
        LSRegisterURL((CFURLRef)[NSURL fileURLWithPath:aBundlePath], YES);
    if (status != noErr) {
      NSLog(@"We failed to register the app in the Launch Services database, "
            @"which may lead to a failure to launch the app. Launch path: %@",
            aBundlePath);
    }
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

static void StripQuarantineBit(NSString* aBundlePath) {
  MacAutoreleasePool pool;

  NSArray* arguments = @[ @"-dr", @"com.apple.quarantine", aBundlePath ];
  LaunchTask(@"/usr/bin/xattr", arguments);
}

namespace mozilla::MacLaunchHelper {

void LaunchMacAppWithBundle(NSString* aBundlePath, NSArray* aArguments) {
  MacAutoreleasePool pool;

  @try {
    NSString* launchPath = aBundlePath;
    if (![launchPath hasSuffix:@".app"]) {
      // We only support launching applications inside .app bundles.
      NSLog(@"An attempt was made to launch an app that was not in a .app "
            @"bundle. Please verify launch path: %@",
            launchPath);
      return;
    }

    StripQuarantineBit(launchPath);
    RegisterAppWithLaunchServices(launchPath);

    // We use NSWorkspace to register the application into the
    // `TALAppsToRelaunchAtLogin` list and allow for macOS session resume.
    // This API only works with `.app`s.
    __block dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    NSWorkspaceOpenConfiguration* config =
        [NSWorkspaceOpenConfiguration configuration];
    [config setArguments:aArguments];
    [config setCreatesNewApplicationInstance:YES];
    [config setEnvironment:[[NSProcessInfo processInfo] environment]];

    [[NSWorkspace sharedWorkspace]
        openApplicationAtURL:[NSURL fileURLWithPath:launchPath]
               configuration:config
           completionHandler:^(NSRunningApplication* aChild, NSError* aError) {
             if (aError) {
               NSLog(@"LaunchMacApp: Failed to run application. Error: %@",
                     aError);
             }
             dispatch_semaphore_signal(semaphore);
           }];

    // We use a semaphore to wait for the application to launch.
    dispatch_semaphore_wait(semaphore, DISPATCH_TIME_FOREVER);
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

}  // namespace mozilla::MacLaunchHelper

void LaunchChildMac(int aArgc, char** aArgv, pid_t* aPid) {
  MacAutoreleasePool pool;

  @try {
    NSString* launchPath = [NSString stringWithUTF8String:aArgv[0]];
    NSMutableArray* arguments = [NSMutableArray arrayWithCapacity:aArgc - 1];
    for (int i = 1; i < aArgc; i++) {
      [arguments addObject:[NSString stringWithUTF8String:aArgv[i]]];
    }
    NSTask* task = [[NSTask alloc] init];
    [task setExecutableURL:[NSURL fileURLWithPath:launchPath]];
    [task setArguments:arguments];
    NSError* error = nil;
    [task launchAndReturnError:&error];
    if (!error && aPid) {
      *aPid = [task processIdentifier];
      [task waitUntilExit];
    }
    [task release];
  } @catch (NSException* e) {
    NSLog(@"%@: %@", e.name, e.reason);
  }
}

void LaunchMacApp(int aArgc, char** aArgv) {
  MacAutoreleasePool pool;

  NSString* launchPath = [NSString stringWithUTF8String:aArgv[0]];
  if (![launchPath hasSuffix:@".app"]) {
    LaunchChildMac(aArgc, aArgv, 0);
    return;
  }
  NSMutableArray* arguments = [NSMutableArray arrayWithCapacity:aArgc - 1];
  for (int i = 1; i < aArgc; i++) {
    [arguments addObject:[NSString stringWithUTF8String:aArgv[i]]];
  }
  LaunchMacAppWithBundle(launchPath, arguments);
}

bool InstallPrivilegedHelper() {
  AuthorizationRef authRef = NULL;
  OSStatus status = AuthorizationCreate(
      NULL, kAuthorizationEmptyEnvironment,
      kAuthorizationFlagDefaults | kAuthorizationFlagInteractionAllowed,
      &authRef);
  if (status != errAuthorizationSuccess) {
    // AuthorizationCreate really shouldn't fail.
    NSLog(@"AuthorizationCreate failed! NSOSStatusErrorDomain / %d",
          (int)status);
    return NO;
  }

  BOOL result = NO;
  AuthorizationItem authItem = {kSMRightBlessPrivilegedHelper, 0, NULL, 0};
  AuthorizationRights authRights = {1, &authItem};
  AuthorizationFlags flags =
      kAuthorizationFlagDefaults | kAuthorizationFlagInteractionAllowed |
      kAuthorizationFlagPreAuthorize | kAuthorizationFlagExtendRights;

  // Obtain the right to install our privileged helper tool.
  status = AuthorizationCopyRights(authRef, &authRights,
                                   kAuthorizationEmptyEnvironment, flags, NULL);
  if (status != errAuthorizationSuccess) {
    NSLog(@"AuthorizationCopyRights failed! NSOSStatusErrorDomain / %d",
          (int)status);
  } else {
    CFErrorRef cfError;
    // This does all the work of verifying the helper tool against the
    // application and vice-versa. Once verification has passed, the embedded
    // launchd.plist is extracted and placed in /Library/LaunchDaemons and
    // then loaded. The executable is placed in
    // /Library/PrivilegedHelperTools.
    result = (BOOL)SMJobBless(kSMDomainSystemLaunchd,
                              (CFStringRef) @"net.waterfox.updater", authRef,
                              &cfError);
    if (!result) {
      NSLog(@"Unable to install helper!");
      CFRelease(cfError);
    }
  }

  return result;
}

void AbortElevatedUpdate() {
  mozilla::MacAutoreleasePool pool;

  id updateServer = nil;
  int currTry = 0;
  const int numRetries = 10;  // Number of IPC connection retries before
                              // giving up.
  while (currTry < numRetries) {
    @try {
      updateServer = (id)[NSConnection
          rootProxyForConnectionWithRegisteredName:@"net.waterfox.updater.server"
                                              host:nil
                                   usingNameServer:[NSSocketPortNameServer
                                                       sharedInstance]];
      if (updateServer && [updateServer respondsToSelector:@selector(abort)]) {
        [updateServer performSelector:@selector(abort)];
        return;
      }
      NSLog(@"Server doesn't exist or doesn't provide correct selectors.");
      sleep(1);  // Wait 1 second.
      currTry++;
    } @catch (NSException* e) {
      NSLog(@"Encountered exception, retrying: %@: %@", e.name, e.reason);
      sleep(1);  // Wait 1 second.
      currTry++;
    }
  }
  NSLog(@"Unable to clean up updater.");
}

bool LaunchElevatedUpdate(int aArgc, char** aArgv, pid_t* aPid) {
  LaunchChildMac(aArgc, aArgv, aPid);
  bool didSucceed = InstallPrivilegedHelper();
  if (!didSucceed) {
    AbortElevatedUpdate();
  }
  return didSucceed;
}
