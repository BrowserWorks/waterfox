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

using mozilla::ContentClassifierEngine;
using mozilla::JSONStringRefWriteFunc;
using mozilla::JSONWriter;
using mozilla::MakeStringSpan;
using mozilla::UniquePtr;

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

}

WaterfoxBlockerContentPolicy::WaterfoxBlockerContentPolicy() = default;

WaterfoxBlockerContentPolicy::~WaterfoxBlockerContentPolicy() = default;

nsIWaterfoxBlockerContentPolicyBridge* WaterfoxBlockerContentPolicy::GetBridge() {
  if (mBridge) {
    return mBridge;
  }

  nsresult rv;
  mBridge = do_ImportESModule("resource:///modules/WaterfoxBlockerService.sys.mjs",
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

WaterfoxBlockerXPCOM::~WaterfoxBlockerXPCOM() = default;

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

  auto engine = mozilla::MakeUnique<ContentClassifierEngine>();
  nsresult rv = engine->InitFromRules(rules);
  NS_ENSURE_SUCCESS(rv, rv);

  mEngine = std::move(engine);
  return NS_OK;
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::InitFromCache(const nsTArray<uint8_t>& aCacheData) {
  UniquePtr<ContentClassifierEngine> engine;
  nsresult rv = ContentClassifierEngine::Deserialize(aCacheData, &engine);
  NS_ENSURE_SUCCESS(rv, rv);

  mEngine = std::move(engine);
  return NS_OK;
}

// Returns JSON: { matched, important, redirect, rewrittenUrl, exception }.
NS_IMETHODIMP
WaterfoxBlockerXPCOM::CheckRequestDetailed(const nsACString& aUrl,
                                           const nsACString& aSourceHostname,
                                           const nsACString& aHostname,
                                           const nsACString& aRequestType,
                                           bool aIsThirdParty,
                                           nsACString& _retval) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;

  nsresult rv = mEngine->CheckNetworkRequestPreparsedDetailed(
      aUrl, aHostname, aSourceHostname, aRequestType, aIsThirdParty, &matched,
      &important, redirect, rewrittenUrl, exception);
  NS_ENSURE_SUCCESS(rv, rv);

  WriteCheckResultJSON(_retval, matched, important, redirect, rewrittenUrl,
                       !exception.IsEmpty());
  return NS_OK;
}

// Returns an empty string when no directives apply.
NS_IMETHODIMP
WaterfoxBlockerXPCOM::GetCspDirectives(const nsACString& aUrl,
                                       const nsACString& aSourceHostname,
                                       const nsACString& aHostname,
                                       const nsACString& aRequestType,
                                       bool aIsThirdParty,
                                       nsACString& _retval) {
  _retval.Truncate();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->GetCspDirectivesPreparsed(
      aUrl, aHostname, aSourceHostname, aRequestType, aIsThirdParty, _retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::Serialize(nsTArray<uint8_t>& _retval) {
  _retval.Clear();

  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->Serialize(_retval);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::EnableTags(const nsTArray<nsCString>& aTags) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->EnableTags(aTags);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::DisableTags(const nsTArray<nsCString>& aTags) {
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);
  return mEngine->DisableTags(aTags);
}

NS_IMETHODIMP
WaterfoxBlockerXPCOM::TagExists(const nsACString& aTag, bool* _retval) {
  NS_ENSURE_ARG_POINTER(_retval);
  NS_ENSURE_TRUE(mEngine, NS_ERROR_NOT_INITIALIZED);

  *_retval = mEngine->TagExists(aTag);
  return NS_OK;
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

// Follows nsIUrlClassifierDBService: components.conf maps CID/contract here,
// this allocates the implementation and returns the requested interface.
extern "C" nsresult waterfox_blocker_xpcom_constructor(REFNSIID aIID,
                                                       void** aResult) {
  NS_ENSURE_ARG_POINTER(aResult);
  *aResult = nullptr;

  RefPtr<WaterfoxBlockerXPCOM> blocker = new WaterfoxBlockerXPCOM();
  return blocker->QueryInterface(aIID, aResult);
}
