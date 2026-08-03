/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_ContentClassifierEngine_h
#define mozilla_ContentClassifierEngine_h

#include "content_classifier_ffi.h"

#include "nsError.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsIChannel.h"

namespace mozilla {

class ContentClassifierService;
struct ContentClassifierFeature;

// Per-engine outcome from ContentClassifierEngine::CheckNetworkRequest.
// Carries a reference back to the feature definition whose engine produced
// it, so consumers can attribute the match.
class ContentClassifierEngineResult {
 public:
  ContentClassifierEngineResult(bool aMatched, bool aException, bool aImportant,
                                nsresult aEngineResult,
                                const ContentClassifierFeature& aFeature)
      : mMatched(aMatched),
        mException(aException),
        mImportant(aImportant),
        mEngineResult(aEngineResult),
        mFeature(aFeature) {}
  ContentClassifierEngineResult(nsresult aEngineResult,
                                const ContentClassifierFeature& aFeature)
      : mEngineResult(aEngineResult), mFeature(aFeature) {}

  nsresult EngineResult() const { return mEngineResult; }
  bool Matched() const { return NS_SUCCEEDED(mEngineResult) && mMatched; }
  bool Exception() const { return NS_SUCCEEDED(mEngineResult) && mException; }
  bool Important() const { return NS_SUCCEEDED(mEngineResult) && mImportant; }
  const ContentClassifierFeature& Feature() const { return mFeature; }

 private:
  bool mMatched = false;
  bool mException = false;
  bool mImportant = false;
  nsresult mEngineResult = NS_ERROR_UNEXPECTED;
  const ContentClassifierFeature& mFeature;
};

class ContentClassifierRequest {
  friend class ContentClassifierEngine;
  nsCString mUrl;
  nsCString mSchemelessSite;
  nsCString mSourceSchemelessSite;
  nsCString mRequestType;
  nsCString mRequestMethod;
  bool mThirdParty = false;
  bool mPrivateBrowsing = false;
  bool mValid = false;

 public:
  bool Valid() const { return mValid; }
  const nsCString& Url() const { return mUrl; }
  bool PrivateBrowsing() const { return mPrivateBrowsing; }

  explicit ContentClassifierRequest(nsIChannel* aChannel);
};

class ContentClassifierEngine final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(ContentClassifierEngine)

  explicit ContentClassifierEngine(const ContentClassifierFeature& aFeature)
      : mFeature(aFeature), mEngine(nullptr) {
    if (!sInitializedETLDService) {
      nsresult rv = content_classifier_initialize_domain_resolver();
      if (NS_SUCCEEDED(rv)) {
        sInitializedETLDService = true;
      }
    }
  }

  nsresult InitFromRules(const nsTArray<nsCString>& aRules) {
    return content_classifier_engine_from_rules(&aRules, &mEngine);
  }

  const ContentClassifierFeature& Feature() const { return mFeature; }

  ContentClassifierEngineResult CheckNetworkRequest(
      const ContentClassifierRequest& aRequest, bool aPreviouslyMatched);

 private:
  ~ContentClassifierEngine() {
    if (mEngine) {
      content_classifier_engine_destroy(mEngine);
      mEngine = nullptr;
    }
  }

  static inline bool sInitializedETLDService = false;

  const ContentClassifierFeature& mFeature;
  ContentClassifierFFIEngine* mEngine;

  ContentClassifierEngine(const ContentClassifierEngine&) = delete;
  ContentClassifierEngine& operator=(const ContentClassifierEngine&) = delete;
};

}  // namespace mozilla

#endif  // mozilla_ContentClassifierEngine_h
