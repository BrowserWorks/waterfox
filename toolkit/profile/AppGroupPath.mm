/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Provides the base path to the macOS App Group container for storing
// Firefox profile data. Controlled via the MOZ_APP_GROUP env var.

#import <Foundation/Foundation.h>

#include "nsCOMPtr.h"
#include "nsIFile.h"
#include "nsString.h"

nsresult GetAppGroupContainerBase(nsIFile** aResult) {
  NSString* groupID = @"PZWYM7N4GF.net.waterfox.waterfox.browserprofiles";
  NSURL* containerURL = [[NSFileManager defaultManager]
      containerURLForSecurityApplicationGroupIdentifier:groupID];

  if (!containerURL) {
    return NS_ERROR_FAILURE;
  }

  NSString* path = [containerURL path];
  nsCOMPtr<nsIFile> file;
  nsresult rv = NS_NewLocalFile(NS_ConvertUTF8toUTF16([path UTF8String]),
                                getter_AddRefs(file));
  NS_ENSURE_SUCCESS(rv, rv);

  file.forget(aResult);
  return NS_OK;
}
