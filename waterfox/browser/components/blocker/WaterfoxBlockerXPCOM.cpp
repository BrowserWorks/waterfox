/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WaterfoxBlockerXPCOM.h"
#include "mozilla/ContentClassifierService.h"

#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Span.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsError.h"
#include "nsProxyRelease.h"
#include "nsThreadUtils.h"

using mozilla::ContentClassifierDetailedResult;
using mozilla::ContentClassifierEngine;
using mozilla::JSONStringRefWriteFunc;
using mozilla::JSONWriter;
using mozilla::MakeStringSpan;

NS_IMPL_ISUPPORTS(WaterfoxBlockerContentPolicy, nsIContentPolicy)
NS_IMPL_ISUPPORTS(WaterfoxBlockerXPCOM, nsIWaterfoxBlockerEngine)
NS_IMPL_ISUPPORTS(WaterfoxBlockerRequest, nsIWaterfoxBlockerRequest)

namespace {

void WriteCheckResultJSON(nsACString& aOutJSON, bool aMatched, bool aImportant,
                          const nsCString& aRedirect,
                          const nsCString& aRewrittenUrl, bool aException) {
  aOutJSON.Truncate();

  JSONStringRefWriteFunc jsonOut(aOutJSON);
  JSONWriter writer(jsonOut, JSONWriter::CollectionStyle::SingleLineStyle);

  writer.Start();
  writer.BoolProperty("matched", aMatched);
  writer.BoolProperty("important", aImportant);
  writer.StringProperty("redirect", MakeStringSpan(aRedirect.get()));
  writer.StringProperty("rewrittenUrl", MakeStringSpan(aRewrittenUrl.get()));
  writer.BoolProperty("exception", aException);
  writer.End();
}

}  // namespace

NS_IMETHODIMP
WaterfoxBlockerRequest::GetCanMatch(bool* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.CanMatch();
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetCanBlock(bool* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.CanBlock();
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetIsPrivate(bool* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mPolicyFlags & mozilla::AdPolicyPrivate;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetBrowserId(uint64_t* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mBrowserId;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetNavigationId(uint64_t* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mNavigationId;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetEngineGeneration(uint64_t* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mEngine.mGeneration;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetPolicyGeneration(uint64_t* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mPolicyGeneration;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetIsCurrent(bool* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mService->IsCurrentAdBlockingRequest(mRequest);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetUrl(nsACString& aValue) {
  aValue = mRequest.mUrl;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetSourceHostname(nsACString& aValue) {
  aValue = mRequest.mSourceHostname;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetHostname(nsACString& aValue) {
  aValue = mRequest.mHostname;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetRequestType(nsACString& aValue) {
  aValue = mRequest.mRequestType;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetRequestMethod(nsACString& aValue) {
  aValue = mRequest.mRequestMethod;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::GetIsThirdParty(bool* aValue) {
  NS_ENSURE_ARG_POINTER(aValue);
  *aValue = mRequest.mThirdParty;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::CheckRequestDetailed(nsACString& aResultJson) {
  ContentClassifierDetailedResult result;
  nsresult rv = mozilla::ContentClassifierService::ClassifyAdBlockingRequest(
      mRequest, result);
  NS_ENSURE_SUCCESS(rv, rv);
  WriteCheckResultJSON(aResultJson, result.mMatched, result.mImportant,
                       result.mRedirect, result.mRewrittenUrl,
                       !result.mException.IsEmpty());
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::CheckRequestDetailedAsync(
    nsIWaterfoxBlockerClassificationCallback* aCallback) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aCallback);
  mService->ClassifyAdBlockingRequestAsync(mRequest)->Then(
      mozilla::GetMainThreadSerialEventTarget(), __func__,
      [self = RefPtr{this},
       callback = nsMainThreadPtrHandle<
           nsIWaterfoxBlockerClassificationCallback>(
           new nsMainThreadPtrHolder<nsIWaterfoxBlockerClassificationCallback>(
               "WaterfoxBlockerClassificationCallback", aCallback))](
          mozilla::ContentClassifierService::AdClassificationPromise::
              ResolveOrRejectValue&& aValue) {
        MOZ_ASSERT(NS_IsMainThread());
        nsAutoCString json;
        nsresult rv = aValue.IsReject() ? aValue.RejectValue() : NS_OK;
        if (NS_SUCCEEDED(rv) &&
            !self->mService->IsCurrentAdBlockingRequest(self->mRequest)) {
          rv = NS_ERROR_ABORT;
        }
        if (NS_SUCCEEDED(rv)) {
          const auto& result = aValue.ResolveValue();
          WriteCheckResultJSON(json, result.mMatched, result.mImportant,
                               result.mRedirect, result.mRewrittenUrl,
                               !result.mException.IsEmpty());
        }
        callback->OnClassified(rv, json);
      });
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerRequest::IsCurrentForLoad(nsILoadInfo* aLoadInfo,
                                         nsIChannel* aChannel, bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mService->IsCurrentAdBlockingRequest(mRequest) &&
             mozilla::AdBlockingPolicy::IsCurrentContext(mRequest, aLoadInfo,
                                                         aChannel);
  return NS_OK;
}

WaterfoxBlockerContentPolicy::WaterfoxBlockerContentPolicy() = default;

WaterfoxBlockerContentPolicy::~WaterfoxBlockerContentPolicy() = default;

NS_IMETHODIMP
WaterfoxBlockerContentPolicy::ShouldLoad(nsIURI* aContentLocation,
                                         nsILoadInfo* aLoadInfo,
                                         int16_t* aDecision) {
  NS_ENSURE_ARG_POINTER(aDecision);

  *aDecision = nsIContentPolicy::ACCEPT;

  if (!aContentLocation || !aLoadInfo) {
    return NS_OK;
  }

  RefPtr<mozilla::ContentClassifierService> classifier =
      mozilla::ContentClassifierService::GetForAdBlocking();
  if (classifier) {
    (void)classifier->CheckAdBlockingLoad(aContentLocation, aLoadInfo,
                                          aDecision);
  }

  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerContentPolicy::ShouldProcess(nsIURI* /* aContentLocation */,
                                            nsILoadInfo* /* aLoadInfo */,
                                            int16_t* aDecision) {
  NS_ENSURE_ARG_POINTER(aDecision);

  *aDecision = nsIContentPolicy::ACCEPT;
  return NS_OK;
}

WaterfoxBlockerXPCOM::WaterfoxBlockerXPCOM() = default;

WaterfoxBlockerXPCOM::~WaterfoxBlockerXPCOM() = default;

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InitFromLists(const nsTArray<nsCString>& aFilterLists) {
  NS_ENSURE_TRUE(!mPublishedGeneration, NS_ERROR_NOT_AVAILABLE);
  nsTArray<nsCString> rules;
  for (const nsCString& listText : aFilterLists) {
    for (const nsACString& token :
         nsCCharSeparatedTokenizer(listText, '\n').ToRange()) {
      nsCString rule(token);
      rule.Trim(" \t\r");
      if (rule.IsEmpty() || rule.First() == '!' || rule.First() == '[') {
        continue;
      }
      rules.AppendElement(std::move(rule));
    }
  }

  NS_ENSURE_TRUE(!rules.IsEmpty(), NS_ERROR_INVALID_ARG);
  nsresult rv = ContentClassifierEngine::InitializeDomainResolver();
  NS_ENSURE_SUCCESS(rv, rv);

  RefPtr<ContentClassifierEngine> engine = new ContentClassifierEngine();
  rv = engine->InitFromRules(rules);
  NS_ENSURE_SUCCESS(rv, rv);

  mEngine = std::move(engine);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InitFromCache(const nsTArray<uint8_t>& aCacheData) {
  NS_ENSURE_TRUE(!mPublishedGeneration, NS_ERROR_NOT_AVAILABLE);
  nsresult rv = ContentClassifierEngine::InitializeDomainResolver();
  NS_ENSURE_SUCCESS(rv, rv);

  RefPtr<ContentClassifierEngine> engine = new ContentClassifierEngine();
  rv = engine->InitFromCache(aCacheData);
  NS_ENSURE_SUCCESS(rv, rv);

  mEngine = std::move(engine);
  return NS_OK;
}

// Returns JSON: { matched, important, redirect, rewrittenUrl, exception }.
NS_IMETHODIMP
WaterfoxBlockerXPCOM::CheckRequestDetailed(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, nsACString& _retval) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  ContentClassifierDetailedResult result;
  nsresult rv = mEngine->CheckNetworkRequestDetailed(
      aUrl, aSourceHostname, aHostname, aRequestType, aRequestMethod,
      aIsThirdParty, result);
  NS_ENSURE_SUCCESS(rv, rv);

  WriteCheckResultJSON(_retval, result.mMatched, result.mImportant,
                       result.mRedirect, result.mRewrittenUrl,
                       !result.mException.IsEmpty());
  return NS_OK;
}

// Returns an empty string when no directives apply.
NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetCspDirectives(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  return mEngine->GetCspDirectives(aUrl, aSourceHostname, aHostname,
                                   aRequestType, aRequestMethod, aIsThirdParty,
                                   _retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetReplaceDirectives(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  return mEngine->GetReplaceDirectives(aUrl, aSourceHostname, aHostname,
                                       aRequestType, aRequestMethod,
                                       aIsThirdParty, _retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::Serialize(nsTArray<uint8_t>& _retval) {
  _retval.Clear();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->Serialize(_retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetCosmeticResources(const nsACString& aUrl,
                                           nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  return mEngine->GetCosmeticResources(aUrl, _retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetHiddenClassIdSelectors(
    const nsACString& aClassesJson, const nsACString& aIdsJson,
    const nsACString& aExceptionsJson, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  return mEngine->GetHiddenClassIdSelectors(aClassesJson, aIdsJson,
                                            aExceptionsJson, _retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::UseResources(const nsACString& aResourcesJson) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->UseResources(aResourcesJson);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::Publish(uint64_t* aGeneration) {
  NS_ENSURE_ARG_POINTER(aGeneration);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  if (!mPublishedGeneration) {
    nsresult rv =
        service->PublishAdBlockingEngine(mEngine, &mPublishedGeneration);
    NS_ENSURE_SUCCESS(rv, rv);
  } else {
    auto current = service->GetAdBlockingEngineSnapshot();
    NS_ENSURE_TRUE(current.mEngine == mEngine &&
                       current.mGeneration == mPublishedGeneration,
                   NS_ERROR_NOT_AVAILABLE);
  }
  *aGeneration = mPublishedGeneration;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::Unpublish() {
  if (mPublishedGeneration) {
    RefPtr<mozilla::ContentClassifierService> service =
        mozilla::ContentClassifierService::GetForAdBlocking();
    if (service) {
      service->UnpublishAdBlockingEngine(mEngine, mPublishedGeneration);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetPublishedGeneration(uint64_t* aGeneration) {
  NS_ENSURE_ARG_POINTER(aGeneration);
  *aGeneration = mPublishedGeneration;
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::CaptureRequest(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, uint32_t aPolicyFlags,
    uint64_t aBrowserId, uint64_t aNavigationId, uint64_t aValidUntil,
    nsIWaterfoxBlockerRequest** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;
  mozilla::AdBlockingRequestSnapshot request;
  request.mUrl = aUrl;
  request.mSourceHostname = aSourceHostname;
  request.mHostname = aHostname;
  request.mRequestType = aRequestType;
  request.mRequestMethod = aRequestMethod;
  request.mThirdParty = aIsThirdParty;
  request.mPolicyFlags = aPolicyFlags;
  request.mBrowserId = aBrowserId;
  request.mNavigationId = aNavigationId;
  request.mValidUntil = aValidUntil;
  return Capture(std::move(request), aResult);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::CaptureLoad(nsIURI* aUri, nsILoadInfo* aLoadInfo,
                                  nsIChannel* aChannel, uint32_t aPolicyFlags,
                                  uint64_t aBrowserId, uint64_t aNavigationId,
                                  uint64_t aValidUntil,
                                  nsIWaterfoxBlockerRequest** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;
  mozilla::AdBlockingRequestSnapshot request;
  nsresult rv = request.InitFromLoad(aUri, aLoadInfo, aChannel);
  NS_ENSURE_SUCCESS(rv, rv);
  request.mPolicyFlags = aPolicyFlags;
  request.mBrowserId = aBrowserId;
  request.mNavigationId = aNavigationId;
  request.mValidUntil = aValidUntil;
  return Capture(std::move(request), aResult);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::CapturePolicyLoad(
    nsIURI* aUri, nsILoadInfo* aLoadInfo, nsIChannel* aChannel,
    uint32_t aContextFlags, const nsTArray<nsCString>& aBypassHosts,
    const nsTArray<nsCString>& aAllowedDomains, uint64_t aBrowserId,
    uint64_t aNavigationId, uint64_t aValidUntil,
    nsIWaterfoxBlockerRequest** aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;
  mozilla::AdBlockingRequestSnapshot request;
  nsresult rv = request.InitFromLoad(aUri, aLoadInfo, aChannel);
  NS_ENSURE_SUCCESS(rv, rv);
  request.mPolicyFlags = aContextFlags;
  request.mBrowserId = aBrowserId;
  request.mNavigationId = aNavigationId;
  request.mValidUntil = aValidUntil;
  rv = request.ResolvePolicy(aBypassHosts, aAllowedDomains);
  NS_ENSURE_SUCCESS(rv, rv);
  return Capture(std::move(request), aResult);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::ShouldBypassHost(const nsACString& aHost, bool aIsPrivate,
                                       bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult =
      mozilla::AdBlockingRequestSnapshot::ShouldBypassHost(aHost, aIsPrivate);
  return NS_OK;
}

nsresult WaterfoxBlockerXPCOM::Capture(
    mozilla::AdBlockingRequestSnapshot aRequest,
    nsIWaterfoxBlockerRequest** aResult) {
  constexpr uint32_t supported =
      nsIWaterfoxBlockerRequest::ENABLED | nsIWaterfoxBlockerRequest::BYPASS |
      nsIWaterfoxBlockerRequest::DOMAIN_ALLOWED |
      nsIWaterfoxBlockerRequest::PRIVATE | nsIWaterfoxBlockerRequest::TOP_LEVEL;
  NS_ENSURE_TRUE(!(aRequest.mPolicyFlags & ~supported), NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(mPublishedGeneration, NS_ERROR_NOT_AVAILABLE);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  nsresult rv = service->CaptureAdBlockingRequest(aRequest);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(aRequest.mEngine.mEngine == mEngine &&
                     aRequest.mEngine.mGeneration == mPublishedGeneration,
                 NS_ERROR_NOT_AVAILABLE);
  RefPtr<WaterfoxBlockerRequest> captured =
      new WaterfoxBlockerRequest(std::move(service), std::move(aRequest));
  captured.forget(aResult);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::SetNetworkBridge(
    nsIContentClassifierAdBlockingBridge* aBridge) {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  if (!service && !aBridge) {
    return NS_OK;
  }
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  service->SetAdBlockingBridge(aBridge);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::OwnsNetworkChannel(nsIChannel* aChannel, bool* aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = mozilla::ContentClassifierService::ShouldClassifyAdBlockingChannel(
      aChannel);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::ShouldSkipNetworkChannel(nsIChannel* aChannel,
                                               bool* aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult =
      mozilla::ContentClassifierService::ShouldSkipAdBlockingChannel(aChannel);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetClassifierService(
    nsIContentClassifierService** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  nsCOMPtr<nsIContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  service.forget(aResult);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::SetDomainAllowances(const nsTArray<nsCString>& aSites,
                                          const nsTArray<nsCString>& aDomains) {
  NS_ENSURE_TRUE(aSites.Length() == aDomains.Length(), NS_ERROR_INVALID_ARG);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  service->AdPolicy().SetDomainAllowances(aSites, aDomains);
  service->InvalidateAdBlockingPolicy();
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::RememberTopHost(uint64_t aBrowserId,
                                      const nsACString& aHost) {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  service->AdPolicy().RememberTopHost(aBrowserId, aHost);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetTopHost(uint64_t aBrowserId, nsACString& aHost) {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  aHost = service ? service->AdPolicy().TopHost(aBrowserId) : nsCString();
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::RememberBlockedDocument(uint64_t aBrowserId,
                                              const nsACString& aHost,
                                              const nsACString& aUrl) {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  service->AdPolicy().RememberBlockedDocument(aBrowserId, aHost, aUrl);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::ForgetBlockedDocument(uint64_t aBrowserId) {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  if (service) {
    service->AdPolicy().ForgetBlockedDocument(aBrowserId);
  }
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::ConsumeBlockedDocument(uint64_t aBrowserId,
                                             const nsACString& aHost,
                                             const nsACString& aUrl,
                                             bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  *aResult = service && service->AdPolicy().ConsumeBlockedDocument(aBrowserId,
                                                                   aHost, aUrl);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::HasNavigationBypass(uint64_t aBrowserId, bool aIsPrivate,
                                          bool* aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  *aResult = service &&
             service->AdPolicy().HasNavigationBypass(aBrowserId, aIsPrivate);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::ClearNavigationState() {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  if (service) {
    service->AdPolicy().Clear();
  }
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::CaptureNativeLoad(nsIURI* aUri, nsILoadInfo* aLoadInfo,
                                        nsIChannel* aChannel, uint16_t aPhase,
                                        nsIWaterfoxBlockerRequest** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;
  NS_ENSURE_TRUE(aPhase <= RESPONSE, NS_ERROR_INVALID_ARG);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  NS_ENSURE_TRUE(service, NS_ERROR_NOT_AVAILABLE);
  mozilla::AdBlockingRequestSnapshot request;
  nsresult rv = service->CaptureAdBlockingLoad(
      request, aUri, aLoadInfo, aChannel, mozilla::AdBlockingPhase(aPhase));
  NS_ENSURE_SUCCESS(rv, rv);
  RefPtr<WaterfoxBlockerRequest> captured =
      new WaterfoxBlockerRequest(std::move(service), std::move(request));
  captured.forget(aResult);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::CheckChannel(
    nsIChannel* aChannel, nsIWaterfoxBlockerClassificationCallback* aCallback) {
  NS_ENSURE_ARG(aChannel);
  NS_ENSURE_ARG(aCallback);
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  nsresult rv = NS_ERROR_NOT_AVAILABLE;
  if (service) {
    nsMainThreadPtrHandle<nsIWaterfoxBlockerClassificationCallback> callback(
        new nsMainThreadPtrHolder<nsIWaterfoxBlockerClassificationCallback>(
            "AdBlockingChannelCallback", aCallback));
    rv = service->CheckAdBlockingChannel(aChannel, [callback] {
      callback->OnClassified(NS_OK, EmptyCString());
    });
  }
  if (NS_FAILED(rv)) {
    aCallback->OnClassified(rv, EmptyCString());
  }
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InvalidatePolicy() {
  RefPtr<mozilla::ContentClassifierService> service =
      mozilla::ContentClassifierService::GetForAdBlocking();
  if (service) {
    service->InvalidateAdBlockingPolicy();
  }
  return NS_OK;
}

// Follows nsIUrlClassifierDBService: components.conf maps CID/contract here,
// this allocates the implementation and returns the requested interface.
extern "C" nsresult waterfox_blocker_xpcom_constructor(REFNSIID aIID,
                                                       void** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;

  RefPtr<WaterfoxBlockerXPCOM> blocker = new WaterfoxBlockerXPCOM();
  return blocker->QueryInterface(aIID, aResult);
}
