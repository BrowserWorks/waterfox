/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WaterfoxBlockerNativeAlias.h"

#include "mozilla/Components.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/JSONStringWriteFuncs.h"
#include "mozilla/Preferences.h"
#include "mozilla/RefPtr.h"
#include "mozilla/Services.h"
#include "mozilla/Unused.h"
#include "nsICancelable.h"
#include "nsIDNSListener.h"
#include "nsIDNSRecord.h"
#include "nsIDNSService.h"
#include "nsIEffectiveTLDService.h"
#include "nsIObserverService.h"
#include "nsIProtocolProxyService.h"
#include "nsIURIMutator.h"
#include "nsNetUtil.h"
#include "nsReadableUtils.h"
#include "nsThreadUtils.h"

using mozilla::JSONStringRefWriteFunc;
using mozilla::JSONWriter;
using mozilla::MakeStringSpan;

namespace {

constexpr auto kNativeBlockedRequestTopic = "WaterfoxBlocker:NativeBlockedRequest";
constexpr auto kCnameUncloakingPref = "waterfox.blocker.cnameUncloaking";

static nsCString NormalizeHostname(const nsACString& aHostname) {
  nsCString normalized(aHostname);
  normalized.Trim(".");
  ToLowerCase(normalized);
  return normalized;
}

static nsCString LowercaseHostname(const nsACString& aHostname) {
  nsCString normalized(aHostname);
  ToLowerCase(normalized);
  return normalized;
}

static bool GetSchemelessSiteForHost(const nsACString& aHostname,
                                     nsACString& aOutSite) {
  aOutSite.Truncate();

  nsCString normalized = LowercaseHostname(aHostname);
  if (normalized.IsEmpty()) {
    return false;
  }

  nsCOMPtr<nsIEffectiveTLDService> eTLDService =
      mozilla::components::EffectiveTLD::Service();
  if (!eTLDService) {
    aOutSite.Assign(normalized);
    return true;
  }

  if (NS_FAILED(eTLDService->GetSchemelessSiteFromHost(normalized, aOutSite)) ||
      aOutSite.IsEmpty()) {
    aOutSite.Assign(normalized);
  } else {
    ToLowerCase(aOutSite);
  }

  return true;
}

static bool IsThirdPartyHost(const nsACString& aSourceHostname,
                             const nsACString& aDestinationHostname) {
  nsCString sourceSite;
  nsCString destinationSite;
  if (!GetSchemelessSiteForHost(aSourceHostname, sourceSite) ||
      !GetSchemelessSiteForHost(aDestinationHostname, destinationSite) ||
      sourceSite.IsEmpty() || destinationSite.IsEmpty()) {
    return false;
  }

  return !sourceSite.Equals(destinationSite);
}

static void WriteNativeAliasCheckResultJSON(nsACString& aOutJSON, bool aMatched,
                                            bool aImportant,
                                            const nsCString& aRedirect,
                                            const nsCString& aRewrittenUrl,
                                            bool aException) {
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

class WaterfoxBlockerNativeAliasListener final : public nsIDNSListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIDNSLISTENER

  WaterfoxBlockerNativeAliasListener(
      WaterfoxBlockerNativeAlias* aOwner,
      mozilla::ContentClassifierEngine* aEngine, nsIHttpChannel* aChannel,
      const nsACString& aUrl, const nsACString& aSourceHostname,
      const nsACString& aHostname, const nsACString& aRequestType,
      uint64_t aBrowserId)
      : mOwner(aOwner),
        mEngine(aEngine),
        mChannel(aChannel),
        mUrl(aUrl),
        mSourceHostname(aSourceHostname),
        mHostname(aHostname),
        mRequestType(aRequestType),
        mBrowserId(aBrowserId) {}

 private:
  ~WaterfoxBlockerNativeAliasListener() = default;

  RefPtr<WaterfoxBlockerNativeAlias> mOwner;
  mozilla::ContentClassifierEngine* mEngine = nullptr;
  nsCOMPtr<nsIHttpChannel> mChannel;
  nsCString mUrl;
  nsCString mSourceHostname;
  nsCString mHostname;
  nsCString mRequestType;
  uint64_t mBrowserId = 0;
};

NS_IMPL_ISUPPORTS(WaterfoxBlockerNativeAliasListener, nsIDNSListener)

}  // namespace

static bool HasNonEmptyStringPref(const char* aPrefName) {
  nsCString value;
  return NS_SUCCEEDED(mozilla::Preferences::GetCString(aPrefName, value)) &&
         !value.IsEmpty();
}

static bool IsCnameUncloakingEnabled() {
  return mozilla::Preferences::GetBool(kCnameUncloakingPref, true);
}

bool WaterfoxBlockerNativeAlias::ProxySettingsAllowUncloaking() const {
  if (!IsCnameUncloakingEnabled()) {
    return false;
  }

  nsCOMPtr<nsIProtocolProxyService> proxyService =
      mozilla::components::ProtocolProxy::Service();
  uint32_t proxyType = nsIProtocolProxyService::PROXYCONFIG_DIRECT;
  if (proxyService) {
    mozilla::Unused << proxyService->GetProxyConfigType(&proxyType);
  }

  switch (proxyType) {
    case nsIProtocolProxyService::PROXYCONFIG_DIRECT:
      return true;

    case nsIProtocolProxyService::PROXYCONFIG_MANUAL:
      return !(
          mozilla::Preferences::GetBool("network.proxy.share_proxy_settings",
                                        false) ||
          HasNonEmptyStringPref("network.proxy.ssl") ||
          HasNonEmptyStringPref("network.proxy.socks"));

    case nsIProtocolProxyService::PROXYCONFIG_PAC:
    case nsIProtocolProxyService::PROXYCONFIG_WPAD:
    case nsIProtocolProxyService::PROXYCONFIG_SYSTEM:
    default:
      return false;
  }
}

bool WaterfoxBlockerNativeAlias::GetCachedCanonicalHostname(
    const nsACString& aHostname, nsACString& aOutCanonicalHostname) const {
  aOutCanonicalHostname.Truncate();

  nsCString normalized = NormalizeHostname(aHostname);
  if (normalized.IsEmpty()) {
    return false;
  }

  auto entry = mCanonicalHostByHost.Lookup(normalized);
  if (!entry) {
    return false;
  }

  aOutCanonicalHostname.Assign(entry.Data());
  return !aOutCanonicalHostname.IsEmpty();
}

void WaterfoxBlockerNativeAlias::CacheCanonicalHostname(
    const nsACString& aHostname, const nsACString& aCanonicalHostname) {
  nsCString normalizedHost = NormalizeHostname(aHostname);
  nsCString normalizedCanonical = NormalizeHostname(aCanonicalHostname);
  if (normalizedHost.IsEmpty() || normalizedCanonical.IsEmpty() ||
      normalizedHost.Equals(normalizedCanonical)) {
    return;
  }

  mCanonicalHostByHost.InsertOrUpdate(normalizedHost, normalizedCanonical);
}

bool WaterfoxBlockerNativeAlias::CheckRequestAgainstCanonicalHostname(
    mozilla::ContentClassifierEngine* aEngine, const nsACString& aUrl,
    const nsACString& aSourceHostname, const nsACString& aRequestType,
    const nsACString& aCanonicalHostname, bool* aOutMatched,
    bool* aOutImportant, nsACString& aOutRedirect,
    nsACString& aOutRewrittenUrl, nsACString& aOutException) {
  if (!aEngine || !aOutMatched || !aOutImportant) {
    return false;
  }

  nsCString normalizedSource = NormalizeHostname(aSourceHostname);
  nsCString normalizedCanonical = NormalizeHostname(aCanonicalHostname);
  if (normalizedSource.IsEmpty() || normalizedCanonical.IsEmpty() ||
      !IsThirdPartyHost(normalizedSource, normalizedCanonical)) {
    return false;
  }

  nsCOMPtr<nsIURI> canonicalURI;
  if (NS_FAILED(NS_NewURI(getter_AddRefs(canonicalURI), aUrl)) ||
      !canonicalURI) {
    return false;
  }

  nsresult rv =
      NS_MutateURI(canonicalURI).SetHost(normalizedCanonical).Finalize(canonicalURI);
  if (NS_FAILED(rv) || !canonicalURI) {
    return false;
  }

  nsCString canonicalUrl;
  if (NS_FAILED(canonicalURI->GetSpec(canonicalUrl)) || canonicalUrl.IsEmpty()) {
    return false;
  }

  return NS_SUCCEEDED(aEngine->CheckNetworkRequestPreparsedDetailed(
      canonicalUrl, normalizedCanonical, normalizedSource, aRequestType, true,
      aOutMatched, aOutImportant, aOutRedirect, aOutRewrittenUrl,
      aOutException));
}

bool WaterfoxBlockerNativeAlias::MaybeBlockWithCanonicalHostname(
    mozilla::ContentClassifierEngine* aEngine, nsIHttpChannel* aChannel,
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    const nsACString& aCanonicalHostname, uint64_t aBrowserId) {
  if (!aEngine || !aChannel) {
    return false;
  }

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;
  if (!CheckRequestAgainstCanonicalHostname(
          aEngine, aUrl, aSourceHostname, aRequestType, aCanonicalHostname,
          &matched, &important, redirect, rewrittenUrl, exception) ||
      !matched || !exception.IsEmpty()) {
    return false;
  }

  mozilla::Unused << aChannel->Cancel(NS_ERROR_ABORT);
  NotifyNativeBlockedRequest(aBrowserId, aUrl, aHostname, aRequestType);
  return true;
}

void WaterfoxBlockerNativeAlias::NotifyNativeBlockedRequest(
    uint64_t aBrowserId, const nsACString& aUrl, const nsACString& aHostname,
    const nsACString& aRequestType) {
  nsCOMPtr<nsIObserverService> observerService =
      mozilla::services::GetObserverService();
  if (!observerService) {
    return;
  }

  nsCString json;
  const nsPromiseFlatCString flatUrl(aUrl);
  const nsPromiseFlatCString flatHostname(aHostname);
  const nsPromiseFlatCString flatRequestType(aRequestType);
  JSONStringRefWriteFunc jsonOut(json);
  JSONWriter writer(jsonOut, JSONWriter::CollectionStyle::SingleLineStyle);
  writer.Start();
  writer.IntProperty("browserId", static_cast<int64_t>(aBrowserId));
  writer.StringProperty("url", MakeStringSpan(flatUrl.get()));
  writer.StringProperty("hostname", MakeStringSpan(flatHostname.get()));
  writer.StringProperty("requestType", MakeStringSpan(flatRequestType.get()));
  writer.End();

  nsString wideData = NS_ConvertUTF8toUTF16(json);
  observerService->NotifyObservers(nullptr, kNativeBlockedRequestTopic,
                                   wideData.get());
}

bool WaterfoxBlockerNativeAlias::CheckRequestDetailedWithNativeAliasCache(
    mozilla::ContentClassifierEngine* aEngine, const nsACString& aUrl,
    const nsACString& aSourceHostname, const nsACString& aHostname,
    const nsACString& aRequestType, nsACString& aOutJson) {
  aOutJson.Truncate();

  nsCString canonicalHostname;
  if (!GetCachedCanonicalHostname(aHostname, canonicalHostname)) {
    WriteNativeAliasCheckResultJSON(aOutJson, false, false, nsCString(),
                                    nsCString(), false);
    return true;
  }

  bool matched = false;
  bool important = false;
  nsCString redirect;
  nsCString rewrittenUrl;
  nsCString exception;
  if (!CheckRequestAgainstCanonicalHostname(
          aEngine, aUrl, aSourceHostname, aRequestType, canonicalHostname,
          &matched, &important, redirect, rewrittenUrl, exception)) {
    WriteNativeAliasCheckResultJSON(aOutJson, false, false, nsCString(),
                                    nsCString(), false);
    return true;
  }

  WriteNativeAliasCheckResultJSON(aOutJson, matched, important, redirect,
                                  rewrittenUrl, !exception.IsEmpty());
  return true;
}

nsresult WaterfoxBlockerNativeAlias::MaybeBlockRequestWithNativeAlias(
    mozilla::ContentClassifierEngine* aEngine, nsIHttpChannel* aChannel,
    const nsACString& aUrl, const nsACString& aSourceHostname,
    const nsACString& aHostname, const nsACString& aRequestType,
    uint64_t aBrowserId) {
  if (!aEngine || !aChannel) {
    return NS_OK;
  }

  nsCString normalizedSource = NormalizeHostname(aSourceHostname);
  nsCString normalizedHostname = NormalizeHostname(aHostname);
  if (normalizedSource.IsEmpty() || normalizedHostname.IsEmpty() ||
      IsThirdPartyHost(normalizedSource, normalizedHostname) ||
      !ProxySettingsAllowUncloaking()) {
    return NS_OK;
  }

  nsCString cachedCanonical;
  if (GetCachedCanonicalHostname(normalizedHostname, cachedCanonical)) {
    MaybeBlockWithCanonicalHostname(aEngine, aChannel, aUrl, normalizedSource,
                                    normalizedHostname, aRequestType,
                                    cachedCanonical, aBrowserId);
    return NS_OK;
  }

  nsresult rv;
  nsCOMPtr<nsIDNSService> dns = mozilla::components::DNS::Service(&rv);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(dns, NS_ERROR_FAILURE);

  nsresult suspendRv = aChannel->Suspend();
  NS_ENSURE_SUCCESS(suspendRv, suspendRv);

  RefPtr<WaterfoxBlockerNativeAliasListener> listener =
      new WaterfoxBlockerNativeAliasListener(
          this, aEngine, aChannel, aUrl, normalizedSource, normalizedHostname,
          aRequestType, aBrowserId);

  nsCOMPtr<nsICancelable> request;
  rv = dns->AsyncResolveNative(
      normalizedHostname, nsIDNSService::RESOLVE_TYPE_DEFAULT,
      nsIDNSService::RESOLVE_CANONICAL_NAME, nullptr, listener,
      mozilla::GetMainThreadSerialEventTarget(), mozilla::OriginAttributes(),
      getter_AddRefs(request));
  if (NS_FAILED(rv)) {
    mozilla::Unused << aChannel->Resume();
  }

  return rv;
}

NS_IMETHODIMP WaterfoxBlockerNativeAliasListener::OnLookupComplete(
    nsICancelable* aRequest, nsIDNSRecord* aRecord, nsresult aStatus) {
  nsCOMPtr<nsIHttpChannel> channel = mChannel;
  RefPtr<WaterfoxBlockerNativeAlias> owner = mOwner;
  if (!channel || !owner || !mEngine) {
    return NS_OK;
  }

  nsCString canonicalHostname;
  if (NS_SUCCEEDED(aStatus)) {
    nsCOMPtr<nsIDNSAddrRecord> addressRecord = do_QueryInterface(aRecord);
    if (addressRecord) {
      mozilla::Unused << addressRecord->GetCanonicalName(canonicalHostname);
    }
  }

  canonicalHostname = NormalizeHostname(canonicalHostname);
  if (!canonicalHostname.IsEmpty()) {
    owner->CacheCanonicalHostname(mHostname, canonicalHostname);
  }

  mozilla::Unused << channel->Resume();
  if (!canonicalHostname.IsEmpty()) {
    owner->MaybeBlockWithCanonicalHostname(
        mEngine, channel, mUrl, mSourceHostname, mHostname, mRequestType,
        canonicalHostname, mBrowserId);
  }

  return NS_OK;
}
