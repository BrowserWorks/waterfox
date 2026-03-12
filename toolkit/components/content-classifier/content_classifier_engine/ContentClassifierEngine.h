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
#include "mozilla/UniquePtr.h"

namespace mozilla {

class ContentClassifierService;

class ContentClassifierResult {
  bool mMatched = false;
  bool mException = false;
  bool mImportant = false;
  nsresult mEngineResult = NS_ERROR_UNEXPECTED;

 public:
  ContentClassifierResult(bool aMatched, bool aException, bool aImportant,
                          nsresult aEngineResult)
      : mMatched(aMatched),
        mException(aException),
        mImportant(aImportant),
        mEngineResult(aEngineResult) {}
  explicit ContentClassifierResult(nsresult aEngineResult)
      : mMatched(false),
        mException(false),
        mImportant(false),
        mEngineResult(aEngineResult) {}

  nsresult EngineResult() { return mEngineResult; }

  bool Hit() { return NS_SUCCEEDED(mEngineResult) && mMatched && !mException; }

  bool Exception() { return NS_SUCCEEDED(mEngineResult) && mException; }

  bool Important() { return NS_SUCCEEDED(mEngineResult) && mImportant; }

  // Used to combine results from multiple engines. Respects important as a lock
  // on the result.
  void Accumulate(const ContentClassifierResult& aOther);
};

class ContentClassifierRequest {
  friend class ContentClassifierEngine;
  nsCString mUrl;
  nsCString mSchemelessSite;
  nsCString mSourceSchemelessSite;
  nsCString mRequestType;
  bool mThirdParty = false;
  bool mValid = false;

 public:
  bool Valid() const { return mValid; }
  const nsCString& Url() const { return mUrl; }

  explicit ContentClassifierRequest(nsIChannel* aChannel);
};

class ContentClassifierEngine final {
 public:
  ContentClassifierEngine() : mEngine(nullptr) {
    if (!sInitializedETLDService) {
      nsresult rv = content_classifier_initialize_domain_resolver();
      if (NS_SUCCEEDED(rv)) {
        sInitializedETLDService = true;
      }
    }
  }

  ~ContentClassifierEngine() {
    if (mEngine) {
      content_classifier_engine_destroy(mEngine);
      mEngine = nullptr;
    }
  }

  nsresult InitFromRules(const nsTArray<nsCString>& aRules) {
    return content_classifier_engine_from_rules(&aRules, &mEngine);
  }

  nsresult CheckNetworkRequestPreparsed(const nsACString& aUrl,
                                        const nsACString& aHostname,
                                        const nsACString& aSourceHostname,
                                        const nsACString& aRequestType,
                                        bool aThirdParty, bool* aOutMatched,
                                        bool* aOutImportant,
                                        nsACString& aOutException);

  nsresult CheckNetworkRequestPreparsedDetailed(
      const nsACString& aUrl, const nsACString& aHostname,
      const nsACString& aSourceHostname, const nsACString& aRequestType,
      bool aThirdParty, bool* aOutMatched, bool* aOutImportant,
      nsACString& aOutRedirect, nsACString& aOutRewrittenUrl,
      nsACString& aOutException);

  nsresult GetCspDirectivesPreparsed(const nsACString& aUrl,
                                     const nsACString& aHostname,
                                     const nsACString& aSourceHostname,
                                     const nsACString& aRequestType,
                                     bool aThirdParty,
                                     nsACString& aOutDirectives);

  nsresult EnableTags(const nsTArray<nsCString>& aTags);
  nsresult DisableTags(const nsTArray<nsCString>& aTags);
  bool TagExists(const nsACString& aTag);

  nsresult Serialize(nsTArray<uint8_t>& aOutData);
  static nsresult Deserialize(const nsTArray<uint8_t>& aData,
                              UniquePtr<ContentClassifierEngine>* aOutEngine);

  nsresult GetCosmeticResources(const nsACString& aUrl, nsACString& aOutJson);
  nsresult GetHiddenClassIdSelectors(const nsACString& aClassesJson,
                                     const nsACString& aIdsJson,
                                     const nsACString& aExceptionsJson,
                                     nsACString& aOutJson);
  nsresult UseResources(const nsACString& aResourcesJson);

  ContentClassifierResult CheckNetworkRequest(
      const ContentClassifierRequest& aRequest);

 private:
  static inline bool sInitializedETLDService = false;

  ContentClassifierFFIEngine* mEngine;

  ContentClassifierEngine(const ContentClassifierEngine&) = delete;
  ContentClassifierEngine& operator=(const ContentClassifierEngine&) = delete;
};

}  // namespace mozilla

#endif  // mozilla_ContentClassifierEngine_h
