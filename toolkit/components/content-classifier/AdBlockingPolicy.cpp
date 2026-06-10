/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AdBlockingPolicy.h"
#include "ContentClassifierService.h"
#include "mozilla/Components.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/WindowGlobalParent.h"
#include "nsIEffectiveTLDService.h"
#include "nsIHttpChannel.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsIReferrerInfo.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsThreadUtils.h"
#include "prtime.h"

namespace mozilla {
namespace {

uint64_t NowMilliseconds() { return PR_Now() / PR_USEC_PER_MSEC; }

nsCString UriHost(nsIURI* aUri) {
  nsCString host;
  if (aUri) {
    (void)aUri->GetHost(host);
  }
  return host;
}

nsCString PrincipalHost(nsIPrincipal* aPrincipal) {
  nsCOMPtr<nsIURI> uri;
  if (aPrincipal) {
    (void)aPrincipal->GetURI(getter_AddRefs(uri));
  }
  return UriHost(uri);
}

nsCString DocumentHost(dom::BrowsingContext* aContext) {
  if (!aContext || aContext->IsDiscarded()) {
    return nsCString();
  }
  auto* global = aContext->Canonical()->GetCurrentWindowGlobal();
  if (!global) {
    return nsCString();
  }
  nsCString host = PrincipalHost(global->DocumentPrincipal());
  return host.IsEmpty() ? UriHost(global->GetDocumentURI()) : host;
}

nsCString BaseDomain(const nsACString& aHost) {
  nsCString base;
  nsCOMPtr<nsIEffectiveTLDService> tld = components::EffectiveTLD::Service();
  if (!tld || NS_FAILED(tld->GetBaseDomainFromHost(aHost, 0, base))) {
    base = aHost;
  }
  return base;
}

struct LoadContext {
  nsTArray<RefPtr<dom::BrowsingContext>> mContexts;
  nsTArray<RefPtr<dom::BrowsingContext>> mSourceContexts;
  uint64_t mBrowserId = 0;
  uint64_t mNavigationId = 0;
  bool mPrivate = false;

  explicit LoadContext(nsILoadInfo* aLoadInfo) {
    RefPtr<dom::BrowsingContext> primary = aLoadInfo->GetBrowsingContext();
    RefPtr<dom::BrowsingContext> target = aLoadInfo->GetTargetBrowsingContext();
    RefPtr<dom::BrowsingContext> associated =
        aLoadInfo->GetAssociatedBrowsingContext();
    for (const auto& context : {primary, target, associated}) {
      if (!mBrowserId && context && !context->IsDiscarded()) {
        mBrowserId = context->Top()->BrowserId();
      }
    }
    for (const auto& source : {primary, target}) {
      if (source && !source->IsDiscarded()) {
        mSourceContexts.AppendElement(source);
      }
    }
    mPrivate = aLoadInfo->GetOriginAttributes().IsPrivateBrowsing();
    for (const auto& context : {primary, target, associated}) {
      if (!context || context->IsDiscarded()) {
        continue;
      }
      auto* top = context->Top();
      auto* global = top->Canonical()->GetCurrentWindowGlobal();
      if (!mNavigationId && global &&
          (!mBrowserId || top->BrowserId() == mBrowserId)) {
        mNavigationId = global->InnerWindowId();
      }
      mPrivate |= context->UsePrivateBrowsing() || top->UsePrivateBrowsing();
      if (global && global->DocumentPrincipal()) {
        mPrivate |= global->DocumentPrincipal()
                        ->OriginAttributesRef()
                        .IsPrivateBrowsing();
      }
      auto* localGlobal = context->Canonical()->GetCurrentWindowGlobal();
      if (localGlobal && localGlobal->DocumentPrincipal()) {
        mPrivate |= localGlobal->DocumentPrincipal()
                        ->OriginAttributesRef()
                        .IsPrivateBrowsing();
      }
      mContexts.AppendElement(context);
    }
  }
};

}  // namespace

nsCString AdBlockingPolicy::NormalizeHost(const nsACString& aHost) {
  nsCString host(aHost);
  if (StringEndsWith(host, "."_ns)) {
    host.Truncate(host.Length() - 1);
  }
  ToLowerCase(host);
  return host;
}

void AdBlockingPolicy::SetDomainAllowances(
    const nsTArray<nsCString>& aSites, const nsTArray<nsCString>& aDomains) {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(aSites.Length() == aDomains.Length());
  mDomainAllowances.Clear();
  for (size_t i = 0; i < aSites.Length(); ++i) {
    mDomainAllowances.LookupOrInsert(aSites[i]).AppendElement(aDomains[i]);
  }
  ++mGeneration;
}

nsCString AdBlockingPolicy::TopHost(uint64_t aBrowserId) const {
  return mTopHosts.Get(aBrowserId);
}

void AdBlockingPolicy::RememberTopHost(uint64_t aBrowserId,
                                       const nsACString& aHost) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCString host = NormalizeHost(aHost);
  if (!aBrowserId || host.IsEmpty()) {
    return;
  }
  if (!mTopHosts.Contains(aBrowserId)) {
    mTopHostOrder.AppendElement(aBrowserId);
  }
  if (mTopHosts.Get(aBrowserId) != host) {
    ++mGeneration;
  }
  mTopHosts.InsertOrUpdate(aBrowserId, host);
  if (mTopHostOrder.Length() > 500) {
    uint64_t oldest = mTopHostOrder[0];
    mTopHostOrder.RemoveElementAt(0);
    mTopHosts.Remove(oldest);
    mBlockedDocuments.Remove(oldest);
    mBlockedDocumentOrder.RemoveElement(oldest);
    mNavigationBypasses.Remove(oldest);
    ++mGeneration;
  }
}

void AdBlockingPolicy::RememberBlockedDocument(uint64_t aBrowserId,
                                               const nsACString& aHost,
                                               const nsACString& aUrl) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCString host = NormalizeHost(aHost);
  if (!aBrowserId || host.IsEmpty() || aUrl.IsEmpty()) {
    return;
  }
  if (!mBlockedDocuments.Contains(aBrowserId)) {
    mBlockedDocumentOrder.AppendElement(aBrowserId);
  }
  mBlockedDocuments.InsertOrUpdate(aBrowserId,
                                   BlockedDocument{host, nsCString(aUrl)});
  if (mBlockedDocumentOrder.Length() > 500) {
    uint64_t oldest = mBlockedDocumentOrder[0];
    mBlockedDocumentOrder.RemoveElementAt(0);
    mBlockedDocuments.Remove(oldest);
    mTopHosts.Remove(oldest);
    mTopHostOrder.RemoveElement(oldest);
    mNavigationBypasses.Remove(oldest);
    ++mGeneration;
  }
}

void AdBlockingPolicy::ForgetBlockedDocument(uint64_t aBrowserId) {
  mBlockedDocuments.Remove(aBrowserId);
  mBlockedDocumentOrder.RemoveElement(aBrowserId);
}

bool AdBlockingPolicy::ConsumeBlockedDocument(uint64_t aBrowserId,
                                              const nsACString& aHost,
                                              const nsACString& aUrl) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCString host = NormalizeHost(aHost);
  if (!aBrowserId || host.IsEmpty()) {
    return false;
  }
  auto blocked = mBlockedDocuments.Lookup(aBrowserId);
  bool valid = blocked && blocked.Data().mHost == host &&
               (aUrl.IsEmpty() || blocked.Data().mUrl == aUrl);
  ForgetBlockedDocument(aBrowserId);
  return valid;
}

void AdBlockingPolicy::RememberBypass(uint64_t aBrowserId,
                                      const nsACString& aSourceHost) {
  if (aBrowserId && !aSourceHost.IsEmpty()) {
    mNavigationBypasses.InsertOrUpdate(
        aBrowserId,
        NavigationBypass{nsCString(aSourceHost), NowMilliseconds() + 60000});
    ++mGeneration;
  }
}

bool AdBlockingPolicy::HasNavigationBypass(uint64_t aBrowserId,
                                           bool aIsPrivate) {
  MOZ_ASSERT(NS_IsMainThread());
  auto bypass = mNavigationBypasses.Lookup(aBrowserId);
  if (!bypass) {
    return false;
  }
  if (bypass.Data().mUntil > NowMilliseconds() &&
      AdBlockingRequestSnapshot::ShouldBypassHost(bypass.Data().mSourceHost,
                                                  aIsPrivate)) {
    return true;
  }
  bypass.Remove();
  ++mGeneration;
  return false;
}

bool AdBlockingPolicy::ResolveNavigationBypass(
    AdBlockingRequestSnapshot& aRequest, const nsTArray<nsCString>& aCandidates,
    const nsTArray<nsCString>& aSources, bool aCanUseSource, bool aDiscover) {
  const bool isPrivate = aRequest.mPolicyFlags & AdPolicyPrivate;
  nsCString source;
  if (aCanUseSource) {
    for (const auto& host : aSources) {
      if (AdBlockingRequestSnapshot::ShouldBypassHost(host, isPrivate)) {
        source = host;
        break;
      }
    }
  }
  for (const auto& host : aCandidates) {
    if (AdBlockingRequestSnapshot::ShouldBypassHost(host, isPrivate)) {
      if (aDiscover && !source.IsEmpty() &&
          !AdBlockingRequestSnapshot::ShouldBypassHost(aRequest.mHostname,
                                                       isPrivate)) {
        RememberBypass(aRequest.mBrowserId, source);
      }
      return true;
    }
  }
  if (!aCanUseSource) {
    return false;
  }
  if (HasNavigationBypass(aRequest.mBrowserId, isPrivate)) {
    return true;
  }
  if (!source.IsEmpty()) {
    if (aDiscover) {
      RememberBypass(aRequest.mBrowserId, source);
    }
    return true;
  }
  return false;
}

nsresult AdBlockingPolicy::Capture(AdBlockingRequestSnapshot& aRequest,
                                   nsIURI* aUri, nsILoadInfo* aLoadInfo,
                                   nsIChannel* aChannel, AdBlockingPhase aPhase,
                                   bool aDiscoverNavigation) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aUri);
  NS_ENSURE_ARG(aLoadInfo);
  NS_ENSURE_TRUE(aUri->SchemeIs("http") || aUri->SchemeIs("https"),
                 NS_ERROR_NOT_AVAILABLE);
  aRequest = AdBlockingRequestSnapshot{};
  nsresult rv = aRequest.InitFromLoad(aUri, aLoadInfo, aChannel);
  NS_ENSURE_SUCCESS(rv, rv);
  LoadContext context(aLoadInfo);
  aRequest.mBrowserId = context.mBrowserId;
  aRequest.mNavigationId = context.mNavigationId;
  const bool topLevel = aRequest.mRequestType.EqualsLiteral("document") &&
                        aLoadInfo->GetIsTopLevelLoad();
  if (context.mPrivate) {
    aRequest.mPolicyFlags |= AdPolicyPrivate;
  }
  if (topLevel) {
    aRequest.mPolicyFlags |= AdPolicyTopLevel;
  }
  nsCOMPtr<nsIPrincipal> triggering = aLoadInfo->TriggeringPrincipal();
  const bool canUseSource =
      !topLevel || (triggering && !triggering->IsSystemPrincipal() &&
                    !aLoadInfo->GetLoadTriggeredFromExternal() &&
                    (triggering->GetIsContentPrincipal() ||
                     triggering->GetIsNullPrincipal() ||
                     aLoadInfo->GetHasValidUserGestureActivation()));
  nsTArray<nsCString> candidates;
  if (topLevel || aPhase == AdBlockingPhase::Response) {
    candidates.AppendElement(aRequest.mHostname);
  }
  candidates.AppendElement(PrincipalHost(triggering));
  candidates.AppendElement(PrincipalHost(aLoadInfo->GetLoadingPrincipal()));
  candidates.AppendElement(PrincipalHost(aLoadInfo->PrincipalToInherit()));
  nsTArray<nsCString> sources;
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  nsCOMPtr<nsIReferrerInfo> referrer;
  if (http) {
    (void)http->GetReferrerInfo(getter_AddRefs(referrer));
  }
  nsAutoCString referrerSpec;
  if (referrer) {
    (void)referrer->GetComputedReferrerSpec(referrerSpec);
  }
  nsCOMPtr<nsIURI> referrerUri;
  if (!referrerSpec.IsEmpty()) {
    (void)NS_NewURI(getter_AddRefs(referrerUri), referrerSpec);
  }
  sources.AppendElement(UriHost(referrerUri));
  for (size_t i = topLevel ? 1 : 0; i < candidates.Length(); ++i) {
    sources.AppendElement(candidates[i]);
  }
  if (canUseSource) {
    for (const auto& browsing : context.mContexts) {
      candidates.AppendElement(DocumentHost(browsing->Top()));
    }
  }
  for (const auto& browsing : context.mSourceContexts) {
    sources.AppendElement(DocumentHost(browsing->Top()));
  }
  sources.AppendElement(TopHost(context.mBrowserId));
  if (!mTopHosts.Contains(context.mBrowserId)) {
    for (const auto& browsing : context.mSourceContexts) {
      RefPtr<dom::BrowsingContext> opener = browsing->GetOpener();
      if (opener && !opener->IsDiscarded()) {
        sources.AppendElement(DocumentHost(opener->Top()));
      }
    }
  }
  if (topLevel && aPhase == AdBlockingPhase::Request) {
    if (ResolveNavigationBypass(aRequest, candidates, sources, canUseSource,
                                aDiscoverNavigation)) {
      aRequest.mPolicyFlags |= AdPolicyBypass;
      auto bypass = mNavigationBypasses.Lookup(context.mBrowserId);
      if (bypass) {
        aRequest.mValidUntil = bypass.Data().mUntil;
      }
    }
    candidates.Clear();
  } else if (topLevel &&
             (aPhase == AdBlockingPhase::CachedLoad ||
              HasNavigationBypass(context.mBrowserId, context.mPrivate))) {
    aRequest.mPolicyFlags |= AdPolicyBypass;
  }
  nsTArray<nsCString> allowed;
  nsCString site = BaseDomain(NormalizeHost(TopHost(context.mBrowserId)));
  auto domains = mDomainAllowances.Lookup(site);
  if (domains) {
    allowed = domains.Data().Clone();
  }
  rv = aRequest.ResolvePolicy(candidates, allowed);
  aRequest.mContextGeneration = mGeneration;
  return rv;
}

bool AdBlockingPolicy::IsCurrentContext(
    const AdBlockingRequestSnapshot& aRequest, nsILoadInfo* aLoadInfo,
    nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!aLoadInfo) {
    return false;
  }
  LoadContext context(aLoadInfo);
  if (context.mBrowserId != aRequest.mBrowserId ||
      context.mNavigationId != aRequest.mNavigationId ||
      context.mPrivate != bool(aRequest.mPolicyFlags & AdPolicyPrivate)) {
    return false;
  }
  if (aChannel) {
    nsCOMPtr<nsIURI> uri;
    (void)aChannel->GetURI(getter_AddRefs(uri));
    nsAutoCString method;
    nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
    if (!uri || !http || NS_FAILED(http->GetRequestMethod(method)) ||
        method != aRequest.mRequestMethod ||
        uri->GetSpecOrDefault() != aRequest.mUrl) {
      return false;
    }
  }
  return true;
}

void AdBlockingPolicy::FinishResponse(
    nsIChannel* aChannel, const AdBlockingRequestSnapshot& aRequest) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!(aRequest.mPolicyFlags & AdPolicyTopLevel)) {
    return;
  }
  uint32_t status = 0;
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  if (http) {
    (void)http->GetResponseStatus(&status);
  }
  if (status >= 300 && status < 400) {
    return;
  }
  RememberTopHost(aRequest.mBrowserId, aRequest.mHostname);
  ForgetBlockedDocument(aRequest.mBrowserId);
  mNavigationBypasses.Remove(aRequest.mBrowserId);
  ++mGeneration;
}

void AdBlockingPolicy::Clear() {
  MOZ_ASSERT(NS_IsMainThread());
  mTopHosts.Clear();
  mTopHostOrder.Clear();
  mBlockedDocuments.Clear();
  mBlockedDocumentOrder.Clear();
  mNavigationBypasses.Clear();
  ++mGeneration;
}

}  // namespace mozilla
