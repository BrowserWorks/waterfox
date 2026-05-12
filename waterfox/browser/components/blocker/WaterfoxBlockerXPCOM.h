/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef waterfox_blocker_xpcom_h
#define waterfox_blocker_xpcom_h

#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsIContentPolicy.h"
#include "nsISupportsImpl.h"
#include "nsIWaterfoxBlocker.h"

extern "C" nsresult waterfox_blocker_xpcom_constructor(REFNSIID aIID,
                                                        void** aResult);

/**
 * Content policy that checks every resource load against the blocker,
 * including loads served from internal caches. Delegates decisions to the
 * JS service bridge so bypass and exception logic stays in one place.
 */
class WaterfoxBlockerContentPolicy final : public nsIContentPolicy {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICONTENTPOLICY

  WaterfoxBlockerContentPolicy();

 private:
  ~WaterfoxBlockerContentPolicy();

  nsIWaterfoxBlockerContentPolicyBridge* GetBridge();

  nsCOMPtr<nsIWaterfoxBlockerContentPolicyBridge> mBridge;
};

/**
 * Implements `nsIWaterfoxBlockerEngine` and delegates to
 * `mozilla::ContentClassifierEngine` to bridge JS callers and the Rust
 * adblock engine.
 */
class WaterfoxBlockerXPCOM final : public nsIWaterfoxBlockerEngine {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWATERFOXBLOCKERENGINE

  WaterfoxBlockerXPCOM();

 private:
  ~WaterfoxBlockerXPCOM();

  mozilla::UniquePtr<mozilla::ContentClassifierEngine> mEngine;
};

#endif  // waterfox_blocker_xpcom_h
