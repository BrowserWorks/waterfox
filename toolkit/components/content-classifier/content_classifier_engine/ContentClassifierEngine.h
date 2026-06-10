/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#ifndef mozilla_ContentClassifierEngine_h
#define mozilla_ContentClassifierEngine_h

#include "content_classifier_ffi.h"

#include "mozilla/Atomics.h"
#include "mozilla/Mutex.h"
#include "mozilla/ThreadSafety.h"
#include "nsError.h"
#include "nsString.h"
#include "nsTArray.h"
#include "nsIChannel.h"
#include "nsISupportsImpl.h"

namespace mozilla {

class ContentClassifierService;
struct ContentClassifierFeature;

struct ContentClassifierDetailedResult {
  bool mMatched = false;
  bool mImportant = false;
  nsCString mException;
  nsCString mRedirect;
  nsCString mRewrittenUrl;
};

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
  bool ThirdParty() const { return mThirdParty; }

  explicit ContentClassifierRequest(nsIChannel* aChannel);
};

class ContentClassifierEngine final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(ContentClassifierEngine)

  ContentClassifierEngine() = default;
  explicit ContentClassifierEngine(const ContentClassifierFeature& aFeature)
      : mFeature(&aFeature) {}

  static nsresult InitializeDomainResolver();

  nsresult InitFromRules(const nsTArray<nsCString>& aRules);
  nsresult InitFromCache(const nsTArray<uint8_t>& aCacheData);
  nsresult Serialize(nsTArray<uint8_t>& aCacheData);
  nsresult UseResources(const nsACString& aResourcesJson);
  nsresult PrepareForPublication();

  const ContentClassifierFeature& Feature() const {
    MOZ_RELEASE_ASSERT(mFeature);
    return *mFeature;
  }

  ContentClassifierEngineResult CheckNetworkRequest(
      const ContentClassifierRequest& aRequest, bool aPreviouslyMatched);

  nsresult CheckNetworkRequestDetailed(
      const nsACString& aUrl, const nsACString& aSourceHostname,
      const nsACString& aHostname, const nsACString& aRequestType,
      const nsACString& aRequestMethod, bool aIsThirdParty,
      ContentClassifierDetailedResult& aResult);
  nsresult GetCspDirectives(const nsACString& aUrl,
                            const nsACString& aSourceHostname,
                            const nsACString& aHostname,
                            const nsACString& aRequestType,
                            const nsACString& aRequestMethod,
                            bool aIsThirdParty, nsACString& aDirectives);
  nsresult GetReplaceDirectives(const nsACString& aUrl,
                                const nsACString& aSourceHostname,
                                const nsACString& aHostname,
                                const nsACString& aRequestType,
                                const nsACString& aRequestMethod,
                                bool aIsThirdParty,
                                nsACString& aDirectivesJson);
  nsresult GetCosmeticResources(const nsACString& aUrl,
                                nsACString& aResourcesJson);
  nsresult GetHiddenClassIdSelectors(const nsACString& aClassesJson,
                                     const nsACString& aIdsJson,
                                     const nsACString& aExceptionsJson,
                                     nsACString& aSelectorsJson);

 private:
  ~ContentClassifierEngine();
  void ReplaceEngine(ContentClassifierFFIEngine* aEngine) MOZ_REQUIRES(mLock);

  static Atomic<bool> sInitializedETLDService;

  const ContentClassifierFeature* const mFeature = nullptr;
  Mutex mLock{"ContentClassifierEngine::mLock"};
  ContentClassifierFFIEngine* mEngine MOZ_GUARDED_BY(mLock) = nullptr;
  bool mResourcesLoaded MOZ_GUARDED_BY(mLock) = false;
  bool mPublished MOZ_GUARDED_BY(mLock) = false;

  ContentClassifierEngine(const ContentClassifierEngine&) = delete;
  ContentClassifierEngine& operator=(const ContentClassifierEngine&) = delete;
};

}  // namespace mozilla

#endif  // mozilla_ContentClassifierEngine_h
