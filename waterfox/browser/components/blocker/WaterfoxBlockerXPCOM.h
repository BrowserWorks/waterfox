/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef waterfox_blocker_xpcom_h
#define waterfox_blocker_xpcom_h

#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/ContentClassifierService.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsIContentPolicy.h"
#include "nsISupportsImpl.h"
#include "nsIWaterfoxBlocker.h"

extern "C" nsresult waterfox_blocker_xpcom_constructor(REFNSIID aIID,
                                                       void** aResult);

class WaterfoxBlockerRequest final : public nsIWaterfoxBlockerRequest {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIWATERFOXBLOCKERREQUEST

  WaterfoxBlockerRequest(RefPtr<mozilla::ContentClassifierService> aService,
                         mozilla::AdBlockingRequestSnapshot aRequest)
      : mService(std::move(aService)), mRequest(std::move(aRequest)) {}

 private:
  ~WaterfoxBlockerRequest() = default;
  const RefPtr<mozilla::ContentClassifierService> mService;
  const mozilla::AdBlockingRequestSnapshot mRequest;
};

/**
 * Content policy that checks every resource load against the blocker,
 * including loads served from internal caches, using the shared native policy.
 */
class WaterfoxBlockerContentPolicy final : public nsIContentPolicy {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSICONTENTPOLICY

  WaterfoxBlockerContentPolicy();

 private:
  ~WaterfoxBlockerContentPolicy();
};

/**
 * Implements nsIWaterfoxBlockerEngine through the shared native engine,
 * bridging JS callers and the Rust adblock engine.
 */
class WaterfoxBlockerXPCOM final : public nsIWaterfoxBlockerEngine {
 public:
  NS_DECL_ISUPPORTS
  NS_DECL_NSIWATERFOXBLOCKERENGINE

  WaterfoxBlockerXPCOM();

 private:
  ~WaterfoxBlockerXPCOM();

  nsresult Capture(mozilla::AdBlockingRequestSnapshot aRequest,
                   nsIWaterfoxBlockerRequest** aResult);

  RefPtr<mozilla::ContentClassifierEngine> mEngine;
  uint64_t mPublishedGeneration = 0;
};

#endif  // waterfox_blocker_xpcom_h
