/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

#include "mozilla/ContentClassifierEngine.h"
#include "ContentClassifierService.h"
#include "mozilla/Components.h"
#include "mozIThirdPartyUtil.h"

namespace mozilla {

ContentClassifierResult ContentClassifierEngine::CheckNetworkRequest(
    const ContentClassifierRequest& aRequest) {
  if (!mEngine || !sInitializedETLDService) {
    return ContentClassifierResult(NS_ERROR_NOT_INITIALIZED);
  }

  if (!aRequest.mValid) {
    return ContentClassifierResult(NS_ERROR_INVALID_ARG);
  }

  // We perform no classification on third-party resources for webcompat.
  // This early-return saves CPU cycles.
  if (!aRequest.mThirdParty) {
    return ContentClassifierResult(NS_OK);
  }

  bool matched = false;
  bool important = false;
  nsCString exception;

  nsresult rv = content_classifier_engine_check_network_request_preparsed(
      mEngine, &aRequest.mUrl, &aRequest.mSchemelessSite,
      &aRequest.mSourceSchemelessSite, &aRequest.mRequestType,
      aRequest.mThirdParty, &matched, &important, &exception);
  return ContentClassifierResult(matched, !exception.IsEmpty(), important, rv);
}

nsresult ContentClassifierEngine::CheckNetworkRequestPreparsed(
    const nsACString& aUrl, const nsACString& aHostname,
    const nsACString& aSourceHostname, const nsACString& aRequestType,
    bool aThirdParty, bool* aOutMatched, bool* aOutImportant,
    nsACString& aOutException) {
  aOutException.Truncate();

  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  if (!aOutMatched || !aOutImportant) {
    return NS_ERROR_INVALID_ARG;
  }

  bool matched = false;
  bool important = false;
  nsCString exception;

  nsresult rv = content_classifier_engine_check_network_request_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType, aThirdParty,
      &matched, &important, &exception);
  if (NS_FAILED(rv)) {
    return rv;
  }

  *aOutMatched = matched;
  *aOutImportant = important;
  aOutException.Assign(exception);
  return NS_OK;
}

nsresult ContentClassifierEngine::CheckNetworkRequestPreparsedDetailed(
    const nsACString& aUrl, const nsACString& aHostname,
    const nsACString& aSourceHostname, const nsACString& aRequestType,
    bool aThirdParty, bool* aOutMatched, bool* aOutImportant,
    nsACString& aOutRedirect, nsACString& aOutRewrittenUrl,
    nsACString& aOutException) {
  aOutRedirect.Truncate();
  aOutRewrittenUrl.Truncate();
  aOutException.Truncate();

  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  if (!aOutMatched || !aOutImportant) {
    return NS_ERROR_INVALID_ARG;
  }

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;

  nsresult rv =
      content_classifier_engine_check_network_request_preparsed_detailed(
          mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
          aThirdParty, &matched, &important, &redirect, &rewrittenUrl,
          &exception);
  if (NS_FAILED(rv)) {
    return rv;
  }

  *aOutMatched = matched;
  *aOutImportant = important;
  aOutRedirect.Assign(redirect);
  aOutRewrittenUrl.Assign(rewrittenUrl);
  aOutException.Assign(exception);
  return NS_OK;
}

nsresult ContentClassifierEngine::GetCspDirectivesPreparsed(
    const nsACString& aUrl, const nsACString& aHostname,
    const nsACString& aSourceHostname, const nsACString& aRequestType,
    bool aThirdParty, nsACString& aOutDirectives) {
  aOutDirectives.Truncate();

  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  nsCString directives;
  nsresult rv = content_classifier_engine_get_csp_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType, aThirdParty,
      &directives);
  if (NS_FAILED(rv)) {
    return rv;
  }

  aOutDirectives.Assign(directives);
  return NS_OK;
}

nsresult ContentClassifierEngine::EnableTags(const nsTArray<nsCString>& aTags) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  return content_classifier_engine_enable_tags(mEngine, &aTags);
}

nsresult ContentClassifierEngine::DisableTags(const nsTArray<nsCString>& aTags) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  return content_classifier_engine_disable_tags(mEngine, &aTags);
}

bool ContentClassifierEngine::TagExists(const nsACString& aTag) {
  if (!mEngine) {
    return false;
  }

  bool exists = false;
  nsresult rv = content_classifier_engine_tag_exists(mEngine, &aTag, &exists);
  return NS_SUCCEEDED(rv) && exists;
}

nsresult ContentClassifierEngine::Serialize(nsTArray<uint8_t>& aOutData) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  return content_classifier_engine_serialize(mEngine, &aOutData);
}

nsresult ContentClassifierEngine::Deserialize(
    const nsTArray<uint8_t>& aData,
    UniquePtr<ContentClassifierEngine>* aOutEngine) {
  if (!aOutEngine) {
    return NS_ERROR_INVALID_ARG;
  }

  auto engine = MakeUnique<ContentClassifierEngine>();
  ContentClassifierFFIEngine* ffiEngine = nullptr;

  nsresult rv = content_classifier_engine_deserialize(&ffiEngine, &aData);
  if (NS_FAILED(rv)) {
    return rv;
  }

  if (!ffiEngine) {
    return NS_ERROR_FAILURE;
  }

  engine->mEngine = ffiEngine;
  aOutEngine->reset(engine.release());
  return NS_OK;
}

nsresult ContentClassifierEngine::GetCosmeticResources(
    const nsACString& aUrl, nsACString& aOutJson) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  nsCString outJson;
  nsresult rv =
      content_classifier_engine_url_cosmetic_resources(mEngine, &aUrl, &outJson);
  if (NS_SUCCEEDED(rv)) {
    aOutJson.Assign(outJson);
  }
  return rv;
}

nsresult ContentClassifierEngine::GetHiddenClassIdSelectors(
    const nsACString& aClassesJson, const nsACString& aIdsJson,
    const nsACString& aExceptionsJson, nsACString& aOutJson) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  nsCString outJson;
  nsresult rv = content_classifier_engine_hidden_class_id_selectors(
      mEngine, &aClassesJson, &aIdsJson, &aExceptionsJson, &outJson);
  if (NS_SUCCEEDED(rv)) {
    aOutJson.Assign(outJson);
  }
  return rv;
}

nsresult ContentClassifierEngine::UseResources(
    const nsACString& aResourcesJson) {
  if (!mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }

  return content_classifier_engine_use_resources(mEngine, &aResourcesJson);
}

void ContentClassifierResult::Accumulate(
    const ContentClassifierResult& aOther) {
  if (NS_FAILED(aOther.mEngineResult)) {
    return;
  }

  if (this->mImportant) {
    return;
  }

  if (aOther.mMatched || aOther.mException) {
    this->mMatched = aOther.mMatched;
    this->mException = aOther.mException;
    this->mImportant = aOther.mImportant;
  }
}

ContentClassifierRequest::ContentClassifierRequest(nsIChannel* aChannel)
    : mThirdParty(true), mValid(false) {
  nsCOMPtr<nsIURI> uri;
  nsresult rv = aChannel->GetURI(getter_AddRefs(uri));
  if (NS_FAILED(rv)) return;

  rv = uri->GetSpec(mUrl);
  if (NS_FAILED(rv)) return;

  rv = uri->GetAsciiHost(mSchemelessSite);
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsILoadInfo> loadInfo;
  rv = aChannel->GetLoadInfo(getter_AddRefs(loadInfo));
  if (NS_FAILED(rv)) return;

  nsCOMPtr<nsIPrincipal> loadingPrincipal = loadInfo->GetLoadingPrincipal();
  if (loadingPrincipal) {
    rv = loadingPrincipal->GetAsciiHost(mSourceSchemelessSite);
    if (NS_FAILED(rv)) {
      mSourceSchemelessSite.Truncate();
    }
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

  mValid = true;
}

}  // namespace mozilla
