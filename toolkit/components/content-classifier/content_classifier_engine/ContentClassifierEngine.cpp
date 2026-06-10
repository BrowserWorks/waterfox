/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "mozilla/ContentClassifierEngine.h"
#include "ContentClassifierService.h"
#include "nsIEffectiveTLDService.h"
#include "nsIHttpChannel.h"
#include "nsNetUtil.h"
#include "mozilla/Components.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozIThirdPartyUtil.h"
#include "nsThreadUtils.h"

namespace mozilla {

Atomic<bool> ContentClassifierEngine::sInitializedETLDService{false};

nsresult ContentClassifierEngine::InitializeDomainResolver() {
  MOZ_ASSERT(NS_IsMainThread());
  if (PastShutdownPhase(ShutdownPhase::XPCOMShutdownThreads)) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  if (sInitializedETLDService) {
    return NS_OK;
  }
  nsresult rv = content_classifier_initialize_domain_resolver();
  NS_ENSURE_SUCCESS(rv, rv);
  sInitializedETLDService = true;
  RunOnShutdown([] {
    sInitializedETLDService = false;
    content_classifier_teardown_domain_resolver();
  });
  return NS_OK;
}

ContentClassifierEngine::~ContentClassifierEngine() {
  MutexAutoLock lock(mLock);
  ReplaceEngine(nullptr);
}

void ContentClassifierEngine::ReplaceEngine(
    ContentClassifierFFIEngine* aEngine) {
  if (mEngine) {
    content_classifier_engine_destroy(mEngine);
  }
  mEngine = aEngine;
}

nsresult ContentClassifierEngine::InitFromRules(
    const nsTArray<nsCString>& aRules) {
  NS_ENSURE_TRUE(sInitializedETLDService, NS_ERROR_NOT_AVAILABLE);
  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_from_rules(&aRules, &engine);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(engine, NS_ERROR_FAILURE);
  MutexAutoLock lock(mLock);
  if (mPublished) {
    content_classifier_engine_destroy(engine);
    return NS_ERROR_NOT_AVAILABLE;
  }
  ReplaceEngine(engine);
  mResourcesLoaded = false;
  return NS_OK;
}

nsresult ContentClassifierEngine::InitFromCache(
    const nsTArray<uint8_t>& aCacheData) {
  NS_ENSURE_TRUE(sInitializedETLDService, NS_ERROR_NOT_AVAILABLE);
  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_deserialize(&engine, &aCacheData);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(engine, NS_ERROR_FAILURE);
  MutexAutoLock lock(mLock);
  if (mPublished) {
    content_classifier_engine_destroy(engine);
    return NS_ERROR_NOT_AVAILABLE;
  }
  ReplaceEngine(engine);
  mResourcesLoaded = false;
  return NS_OK;
}

nsresult ContentClassifierEngine::Serialize(nsTArray<uint8_t>& aCacheData) {
  aCacheData.Clear();
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_serialize(mEngine, &aCacheData);
}

nsresult ContentClassifierEngine::UseResources(
    const nsACString& aResourcesJson) {
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  NS_ENSURE_TRUE(!mPublished, NS_ERROR_NOT_AVAILABLE);
  nsresult rv =
      content_classifier_engine_use_resources(mEngine, &aResourcesJson);
  NS_ENSURE_SUCCESS(rv, rv);
  mResourcesLoaded = true;
  return NS_OK;
}

nsresult ContentClassifierEngine::PrepareForPublication() {
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine && mResourcesLoaded, NS_ERROR_NOT_INITIALIZED);
  mPublished = true;
  return NS_OK;
}

ContentClassifierEngineResult ContentClassifierEngine::CheckNetworkRequest(
    const ContentClassifierRequest& aRequest, bool aPreviouslyMatched) {
  MutexAutoLock lock(mLock);
  if (!mEngine || !sInitializedETLDService) {
    return ContentClassifierEngineResult(NS_ERROR_NOT_INITIALIZED, Feature());
  }

  if (!aRequest.mValid) {
    return ContentClassifierEngineResult(NS_ERROR_INVALID_ARG, Feature());
  }

  bool matched = false;
  bool important = false;
  nsCString exception;

  nsresult rv = content_classifier_engine_check_network_request_preparsed(
      mEngine, &aRequest.mUrl, &aRequest.mSchemelessSite,
      &aRequest.mSourceSchemelessSite, &aRequest.mRequestType,
      &aRequest.mRequestMethod, aRequest.mThirdParty, aPreviouslyMatched,
      &matched, &important, &exception);
  return ContentClassifierEngineResult(matched, !exception.IsEmpty(), important,
                                       rv, Feature());
}

nsresult ContentClassifierEngine::CheckNetworkRequestDetailed(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty,
    ContentClassifierDetailedResult& aResult) {
  aResult = ContentClassifierDetailedResult{};
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine && sInitializedETLDService, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_check_network_request_preparsed_detailed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      &aRequestMethod, aIsThirdParty, &aResult.mMatched, &aResult.mImportant,
      &aResult.mRedirect, &aResult.mRewrittenUrl, &aResult.mException);
}

nsresult ContentClassifierEngine::GetCspDirectives(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty,
    nsACString& aDirectives) {
  aDirectives.Truncate();
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine && sInitializedETLDService, NS_ERROR_NOT_INITIALIZED);
  nsCString directives;
  nsresult rv = content_classifier_engine_get_csp_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      &aRequestMethod, aIsThirdParty, &directives);
  NS_ENSURE_SUCCESS(rv, rv);
  aDirectives.Assign(directives);
  return NS_OK;
}

nsresult ContentClassifierEngine::GetReplaceDirectives(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty,
    nsACString& aDirectivesJson) {
  aDirectivesJson.Truncate();
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  nsCString directivesJson;
  nsresult rv = content_classifier_engine_get_replace_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      &aRequestMethod, aIsThirdParty, &directivesJson);
  NS_ENSURE_SUCCESS(rv, rv);
  aDirectivesJson.Assign(directivesJson);
  return NS_OK;
}

nsresult ContentClassifierEngine::GetCosmeticResources(
    const nsACString& aUrl, nsACString& aResourcesJson) {
  aResourcesJson.Truncate();
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine && sInitializedETLDService, NS_ERROR_NOT_INITIALIZED);
  nsCString resourcesJson;
  nsresult rv = content_classifier_engine_url_cosmetic_resources(
      mEngine, &aUrl, &resourcesJson);
  NS_ENSURE_SUCCESS(rv, rv);
  aResourcesJson.Assign(resourcesJson);
  return NS_OK;
}

nsresult ContentClassifierEngine::GetHiddenClassIdSelectors(
    const nsACString& aClassesJson, const nsACString& aIdsJson,
    const nsACString& aExceptionsJson, nsACString& aSelectorsJson) {
  aSelectorsJson.Truncate();
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  nsCString selectorsJson;
  nsresult rv = content_classifier_engine_hidden_class_id_selectors(
      mEngine, &aClassesJson, &aIdsJson, &aExceptionsJson, &selectorsJson);
  NS_ENSURE_SUCCESS(rv, rv);
  aSelectorsJson.Assign(selectorsJson);
  return NS_OK;
}

ContentClassifierRequest::ContentClassifierRequest(nsIChannel* aChannel)
    : mThirdParty(true), mValid(false) {
  nsCOMPtr<nsIURI> uri;
  nsresult rv = aChannel->GetURI(getter_AddRefs(uri));
  if (NS_FAILED(rv)) return;

  rv = uri->GetSpec(mUrl);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsIHttpChannel> httpChannel = do_QueryInterface(aChannel);
  if (httpChannel && NS_FAILED(httpChannel->GetRequestMethod(mRequestMethod))) {
    mRequestMethod.Truncate();
  }

  nsCString host;
  rv = uri->GetHost(host);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsIEffectiveTLDService> eTLDService =
      components::EffectiveTLD::Service();
  if (!eTLDService) return;

  rv = eTLDService->GetSchemelessSiteFromHost(host, mSchemelessSite);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsILoadInfo> loadInfo;
  rv = aChannel->GetLoadInfo(getter_AddRefs(loadInfo));
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsIPrincipal> loadingPrincipal = loadInfo->GetLoadingPrincipal();
  if (loadingPrincipal) {
    rv = loadingPrincipal->GetBaseDomain(mSourceSchemelessSite);
    if (NS_FAILED(rv)) return;
  }

  ExtContentPolicyType contentPolicyType =
      loadInfo->GetExternalContentPolicyType();
  switch (contentPolicyType) {
    case ExtContentPolicyType::TYPE_CSP_REPORT:
      mRequestType.AssignLiteral("csp_report");
      break;
    case ExtContentPolicyType::TYPE_DOCUMENT:
      mRequestType.AssignLiteral("document");
      break;
    case ExtContentPolicyType::TYPE_FONT:
      mRequestType.AssignLiteral("font");
      break;
    case ExtContentPolicyType::TYPE_IMAGE:
    case ExtContentPolicyType::TYPE_IMAGESET:
      mRequestType.AssignLiteral("image");
      break;
    case ExtContentPolicyType::TYPE_MEDIA:
      mRequestType.AssignLiteral("media");
      break;
    case ExtContentPolicyType::TYPE_OBJECT:
      mRequestType.AssignLiteral("object");
      break;
    case ExtContentPolicyType::TYPE_BEACON:
    case ExtContentPolicyType::TYPE_PING:
      mRequestType.AssignLiteral("ping");
      break;
    case ExtContentPolicyType::TYPE_SCRIPT:
      mRequestType.AssignLiteral("script");
      break;
    case ExtContentPolicyType::TYPE_STYLESHEET:
      mRequestType.AssignLiteral("stylesheet");
      break;
    case ExtContentPolicyType::TYPE_SUBDOCUMENT:
      mRequestType.AssignLiteral("subdocument");
      break;
    case ExtContentPolicyType::TYPE_WEBSOCKET:
      mRequestType.AssignLiteral("websocket");
      break;
    case ExtContentPolicyType::TYPE_XMLHTTPREQUEST:
      mRequestType.AssignLiteral("xmlhttprequest");
      break;
    default:
      mRequestType.AssignLiteral("other");
      break;
  }

  nsCOMPtr<mozIThirdPartyUtil> thirdPartyUtil =
      components::ThirdPartyUtil::Service();
  if (!thirdPartyUtil) {
    return;
  }
  rv = thirdPartyUtil->IsThirdPartyChannel(aChannel, nullptr, &mThirdParty);
  if (NS_FAILED(rv)) {
    mThirdParty = true;
  }

  mPrivateBrowsing = NS_UsePrivateBrowsing(aChannel);

  mValid = true;
}

}  // namespace mozilla
