/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WaterfoxBlockerXPCOM.h"

#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Span.h"
#include "nsCharSeparatedTokenizer.h"
#include "nsError.h"
#include "nsImportModule.h"

using mozilla::JSONStringRefWriteFunc;
using mozilla::JSONWriter;
using mozilla::MakeStringSpan;

NS_IMPL_ISUPPORTS(WaterfoxBlockerContentPolicy, nsIContentPolicy)
NS_IMPL_ISUPPORTS(WaterfoxBlockerXPCOM, nsIWaterfoxBlockerEngine)

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

// The Rust side registers a global domain resolver backed by the eTLD
// service. Upstream initializes it from its own engine wrapper; the blocker
// engine has to do the same before the first engine is created.
bool EnsureDomainResolver() {
  static bool sInitialized = false;
  if (!sInitialized &&
      NS_SUCCEEDED(content_classifier_initialize_domain_resolver())) {
    sInitialized = true;
  }
  return sInitialized;
}

}  // namespace

WaterfoxBlockerContentPolicy::WaterfoxBlockerContentPolicy() = default;

WaterfoxBlockerContentPolicy::~WaterfoxBlockerContentPolicy() = default;

nsIWaterfoxBlockerContentPolicyBridge*
WaterfoxBlockerContentPolicy::GetBridge() {
  if (mBridge) {
    return mBridge;
  }

  nsresult rv;
  mBridge =
      do_ImportESModule("resource:///modules/WaterfoxBlockerService.sys.mjs",
                        "WaterfoxBlockerService", &rv);
  if (NS_FAILED(rv)) {
    mBridge = nullptr;
  }

  return mBridge;
}

NS_IMETHODIMP
WaterfoxBlockerContentPolicy::ShouldLoad(nsIURI* aContentLocation,
                                         nsILoadInfo* aLoadInfo,
                                         int16_t* aDecision) {
  NS_ENSURE_ARG_POINTER(aDecision);

  *aDecision = nsIContentPolicy::ACCEPT;

  if (!aContentLocation || !aLoadInfo) {
    return NS_OK;
  }

  nsIWaterfoxBlockerContentPolicyBridge* bridge = GetBridge();
  if (!bridge) {
    return NS_OK;
  }

  nsresult rv = bridge->ShouldLoad(aContentLocation, aLoadInfo, aDecision);
  if (NS_FAILED(rv)) {
    *aDecision = nsIContentPolicy::ACCEPT;
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

WaterfoxBlockerXPCOM::~WaterfoxBlockerXPCOM() { ResetEngine(nullptr); }

void WaterfoxBlockerXPCOM::ResetEngine(ContentClassifierFFIEngine* aEngine) {
  if (mEngine) {
    content_classifier_engine_destroy(mEngine);
  }
  mEngine = aEngine;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InitFromLists(const nsTArray<nsCString>& aFilterLists) {
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
  NS_ENSURE_TRUE(EnsureDomainResolver(), NS_ERROR_NOT_AVAILABLE);

  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_from_rules(&rules, &engine);
  NS_ENSURE_SUCCESS(rv, rv);

  ResetEngine(engine);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InitFromCache(const nsTArray<uint8_t>& aCacheData) {
  NS_ENSURE_TRUE(EnsureDomainResolver(), NS_ERROR_NOT_AVAILABLE);

  ContentClassifierFFIEngine* engine = nullptr;
  nsresult rv = content_classifier_engine_deserialize(&engine, &aCacheData);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(engine, NS_ERROR_FAILURE);

  ResetEngine(engine);
  return NS_OK;
}

// Returns JSON: { matched, important, redirect, rewrittenUrl, exception }.
NS_IMETHODIMP
WaterfoxBlockerXPCOM::CheckRequestDetailed(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, nsACString& _retval) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;

  nsresult rv =
      content_classifier_engine_check_network_request_preparsed_detailed(
          mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
          &aRequestMethod, aIsThirdParty, &matched, &important, &redirect,
          &rewrittenUrl, &exception);
  NS_ENSURE_SUCCESS(rv, rv);

  WriteCheckResultJSON(_retval, matched, important, redirect, rewrittenUrl,
                       !exception.IsEmpty());
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

  nsCString directives;
  nsresult rv = content_classifier_engine_get_csp_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      &aRequestMethod, aIsThirdParty, &directives);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(directives);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetReplaceDirectives(
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aRequestMethod, bool aIsThirdParty, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString directivesJson;
  nsresult rv = content_classifier_engine_get_replace_directives_preparsed(
      mEngine, &aUrl, &aHostname, &aSourceHostname, &aRequestType,
      &aRequestMethod, aIsThirdParty, &directivesJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(directivesJson);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::Serialize(nsTArray<uint8_t>& _retval) {
  _retval.Clear();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_serialize(mEngine, &_retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetCosmeticResources(const nsACString& aUrl,
                                           nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString outJson;
  nsresult rv = content_classifier_engine_url_cosmetic_resources(mEngine, &aUrl,
                                                                 &outJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(outJson);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetHiddenClassIdSelectors(
    const nsACString& aClassesJson, const nsACString& aIdsJson,
    const nsACString& aExceptionsJson, nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  nsCString outJson;
  nsresult rv = content_classifier_engine_hidden_class_id_selectors(
      mEngine, &aClassesJson, &aIdsJson, &aExceptionsJson, &outJson);
  NS_ENSURE_SUCCESS(rv, rv);

  _retval.Assign(outJson);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::UseResources(const nsACString& aResourcesJson) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return content_classifier_engine_use_resources(mEngine, &aResourcesJson);
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
