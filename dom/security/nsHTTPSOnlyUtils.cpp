/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsHTTPSOnlyUtils.h"

#include "mozilla/BasePrincipal.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Components.h"
#include "mozilla/NullPrincipal.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/TimeStamp.h"
#include "mozilla/extensions/WebExtensionPolicy.h"
#include "mozilla/glean/DomSecurityMetrics.h"
#include "mozilla/net/DNS.h"
#include "nsContentUtils.h"
#include "nsDNSPrefetch.h"
#include "nsIEffectiveTLDService.h"
#include "nsIHttpChannel.h"
#include "nsIHttpChannelInternal.h"
#include "nsIHttpsOnlyModePermission.h"
#include "nsILoadInfo.h"
#include "nsIPermissionManager.h"
#include "nsIPrincipal.h"
#include "nsIRedirectHistoryEntry.h"
#include "nsIScriptError.h"
#include "nsIURIMutator.h"
#include "nsNetUtil.h"
#include "prnetdb.h"

/* static */
nsHTTPSOnlyUtils::UpgradeMode nsHTTPSOnlyUtils::GetUpgradeMode(
    bool aFromPrivateWindow,
    nsILoadInfo::SchemelessInputType aSchemelessInputType) {
  if (mozilla::StaticPrefs::dom_security_https_only_mode() ||
      (aFromPrivateWindow &&
       mozilla::StaticPrefs::dom_security_https_only_mode_pbm())) {
    return nsHTTPSOnlyUtils::HTTPS_ONLY_MODE;
  }

  if (mozilla::StaticPrefs::dom_security_https_first() ||
      (aFromPrivateWindow &&
       mozilla::StaticPrefs::dom_security_https_first_pbm())) {
    return nsHTTPSOnlyUtils::HTTPS_FIRST_MODE;
  }

  if (mozilla::StaticPrefs::dom_security_https_first_schemeless() &&
      aSchemelessInputType == nsILoadInfo::SchemelessInputTypeSchemeless) {
    return nsHTTPSOnlyUtils::SCHEMELESS_HTTPS_FIRST_MODE;
  }

  return NO_UPGRADE_MODE;
}

/* static */
nsHTTPSOnlyUtils::UpgradeMode nsHTTPSOnlyUtils::GetUpgradeMode(
    nsILoadInfo* aLoadInfo) {
  bool isPrivateWin = aLoadInfo->GetOriginAttributes().IsPrivateBrowsing();
  return GetUpgradeMode(isPrivateWin, aLoadInfo->GetSchemelessInput());
}

/* static */
void nsHTTPSOnlyUtils::PotentiallyFireHttpRequestToShortenTimout(
    mozilla::net::DocumentLoadListener* aDocumentLoadListener) {
  // only send http background request to counter timeouts if the
  // pref allows us to do that.
  if (!mozilla::StaticPrefs::
          dom_security_https_only_mode_send_http_background_request()) {
    return;
  }

  nsCOMPtr<nsIChannel> channel = aDocumentLoadListener->GetChannel();
  if (!channel) {
    return;
  }

  nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
  UpgradeMode upgradeMode = GetUpgradeMode(loadInfo);

  // if neither HTTPS-Only nor HTTPS-First mode is enabled, then there is
  // nothing to do here.
  if (upgradeMode == NO_UPGRADE_MODE) {
    return;
  }

  // if we are not dealing with a top-level load, then there is nothing to do
  // here.
  if (loadInfo->GetExternalContentPolicyType() !=
      ExtContentPolicy::TYPE_DOCUMENT) {
    return;
  }

  // if the load is exempt, then there is nothing to do here.
  uint32_t httpsOnlyStatus = loadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::nsILoadInfo::HTTPS_ONLY_EXEMPT) {
    return;
  }

  // if it's not an http channel, then there is nothing to do here.
  nsCOMPtr<nsIHttpChannel> httpChannel(do_QueryInterface(channel));
  if (!httpChannel) {
    return;
  }

  // if it's not a GET method, then there is nothing to do here either.
  nsAutoCString method;
  (void)httpChannel->GetRequestMethod(method);
  if (!method.EqualsLiteral("GET")) {
    return;
  }

  // if it's already an https channel, then there is nothing to do here.
  nsCOMPtr<nsIURI> channelURI;
  channel->GetURI(getter_AddRefs(channelURI));
  if (!channelURI->SchemeIs("http")) {
    return;
  }

  // Upgrades for custom ports may be disabled in that case
  // HTTPS-First only applies to standard ports but HTTPS-Only brute forces
  // all http connections to be https and overrules HTTPS-First. In case
  // HTTPS-First is enabled, but HTTPS-Only is not enabled, we might return
  // early if attempting to send a background request to a non standard port.
  if (!mozilla::StaticPrefs::dom_security_https_first_for_custom_ports() &&
      (upgradeMode == HTTPS_FIRST_MODE ||
       upgradeMode == SCHEMELESS_HTTPS_FIRST_MODE)) {
    int32_t port = 0;
    nsresult rv = channelURI->GetPort(&port);
    int defaultPortforScheme = NS_GetDefaultPort("http");
    if (NS_SUCCEEDED(rv) && port != defaultPortforScheme && port != -1) {
      return;
    }
  }

  // Check for general exceptions
  if (OnionException(channelURI) || LoopbackOrLocalException(channelURI)) {
    return;
  }

  RefPtr<nsIRunnable> task =
      new TestHTTPAnswerRunnable(channelURI, aDocumentLoadListener);
  NS_DispatchToMainThread(task.forget());
}

/* static */
bool nsHTTPSOnlyUtils::ShouldUpgradeRequest(nsIURI* aURI,
                                            nsILoadInfo* aLoadInfo) {
  // 1. Check if the HTTPS-Only Mode is even enabled, before we do anything else
  if (GetUpgradeMode(aLoadInfo) != HTTPS_ONLY_MODE) {
    return false;
  }

  // 2. Check for general exceptions
  if (OnionException(aURI) || LoopbackOrLocalException(aURI)) {
    return false;
  }

  // 3. Check if NoUpgrade-flag is set in LoadInfo
  uint32_t httpsOnlyStatus = aLoadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT) {
    AutoTArray<nsString, 1> params = {
        NS_ConvertUTF8toUTF16(aURI->GetSpecOrDefault())};
    nsHTTPSOnlyUtils::LogLocalizedString("HTTPSOnlyNoUpgradeException", params,
                                         nsIScriptError::infoFlag, aLoadInfo,
                                         aURI);
    return false;
  }

  // All subresources of an exempt triggering principal are also exempt
  ExtContentPolicyType contentType = aLoadInfo->GetExternalContentPolicyType();
  if (contentType != ExtContentPolicy::TYPE_DOCUMENT) {
    if (!aLoadInfo->TriggeringPrincipal()->IsSystemPrincipal() &&
        TestIfPrincipalIsExempt(aLoadInfo->TriggeringPrincipal(),
                                HTTPS_ONLY_MODE)) {
      return false;
    }
  }

  if (IsExemptedExtensionRequest(aURI, aLoadInfo)) {
    AutoTArray<nsString, 1> params = {
        NS_ConvertUTF8toUTF16(aURI->GetSpecOrDefault())};
    nsHTTPSOnlyUtils::LogLocalizedString("HTTPSOnlyNoUpgradeException", params,
                                         nsIScriptError::infoFlag, aLoadInfo,
                                         aURI);
    return false;
  }

  // We can not upgrade "Save-As" downloads, since we have no way of detecting
  // if the upgrade failed (Bug 1674859). For now we will just allow the
  // download, since there will still be a visual warning about the download
  // being insecure.
  if (contentType == ExtContentPolicyType::TYPE_SAVEAS_DOWNLOAD) {
    return false;
  }

  // We can upgrade the request - let's log it to the console
  // Appending an 's' to the scheme for the logging. (http -> https)
  nsAutoCString scheme;
  aURI->GetScheme(scheme);
  scheme.AppendLiteral("s");
  NS_ConvertUTF8toUTF16 reportSpec(aURI->GetSpecOrDefault());
  NS_ConvertUTF8toUTF16 reportScheme(scheme);

  bool isSpeculative = aLoadInfo->GetExternalContentPolicyType() ==
                       ExtContentPolicy::TYPE_SPECULATIVE;
  AutoTArray<nsString, 2> params = {reportSpec, reportScheme};
  nsHTTPSOnlyUtils::LogLocalizedString(
      isSpeculative ? "HTTPSOnlyUpgradeSpeculativeConnection"
                    : "HTTPSOnlyUpgradeRequest",
      params, nsIScriptError::warningFlag, aLoadInfo, aURI);

  // If the status was not determined before, we now indicate that the request
  // will get upgraded, but no event-listener has been registered yet.
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_UNINITIALIZED) {
    httpsOnlyStatus ^= nsILoadInfo::HTTPS_ONLY_UNINITIALIZED;
    httpsOnlyStatus |= nsILoadInfo::HTTPS_ONLY_UPGRADED_LISTENER_NOT_REGISTERED;
    aLoadInfo->SetHttpsOnlyStatus(httpsOnlyStatus);
  }
  return true;
}

/* static */
bool nsHTTPSOnlyUtils::ShouldUpgradeWebSocket(nsIURI* aURI,
                                              nsILoadInfo* aLoadInfo) {
  // 1. Check if the HTTPS-Only Mode is even enabled, before we do anything else
  if (GetUpgradeMode(aLoadInfo) != HTTPS_ONLY_MODE) {
    return false;
  }

  // 2. Check for general exceptions
  if (OnionException(aURI) || LoopbackOrLocalException(aURI)) {
    return false;
  }

  // 3. Check if NoUpgrade-flag is set in LoadInfo
  uint32_t httpsOnlyStatus = aLoadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT) {
    // Let's log to the console, that we didn't upgrade this request
    AutoTArray<nsString, 1> params = {
        NS_ConvertUTF8toUTF16(aURI->GetSpecOrDefault())};
    nsHTTPSOnlyUtils::LogLocalizedString("HTTPSOnlyNoUpgradeException", params,
                                         nsIScriptError::infoFlag, aLoadInfo,
                                         aURI);
    return false;
  }

  // All subresources of an exempt triggering principal are also exempt.
  if (!aLoadInfo->TriggeringPrincipal()->IsSystemPrincipal() &&
      TestIfPrincipalIsExempt(aLoadInfo->TriggeringPrincipal(),
                              HTTPS_ONLY_MODE)) {
    return false;
  }

  // We can upgrade the request - let's log it to the console
  // Appending an 's' to the scheme for the logging. (ws -> wss)
  nsAutoCString scheme;
  aURI->GetScheme(scheme);
  scheme.AppendLiteral("s");
  NS_ConvertUTF8toUTF16 reportSpec(aURI->GetSpecOrDefault());
  NS_ConvertUTF8toUTF16 reportScheme(scheme);

  AutoTArray<nsString, 2> params = {reportSpec, reportScheme};
  nsHTTPSOnlyUtils::LogLocalizedString("HTTPSOnlyUpgradeRequest", params,
                                       nsIScriptError::warningFlag, aLoadInfo,
                                       aURI);
  return true;
}

/* static */
bool nsHTTPSOnlyUtils::IsUpgradeDowngradeEndlessLoop(
    nsIURI* aOldURI, nsIURI* aNewURI, nsILoadInfo* aLoadInfo,
    const mozilla::EnumSet<UpgradeDowngradeEndlessLoopOptions>& aOptions) {
  // 1. Check if the HTTPS-Only/HTTPS-First is even enabled, before doing
  // anything else
  UpgradeMode upgradeMode = GetUpgradeMode(aLoadInfo);
  bool enforceForHTTPSOnlyMode =
      upgradeMode == HTTPS_ONLY_MODE &&
      aOptions.contains(
          UpgradeDowngradeEndlessLoopOptions::EnforceForHTTPSOnlyMode);
  bool enforceForHTTPSFirstMode =
      upgradeMode == HTTPS_FIRST_MODE &&
      aOptions.contains(
          UpgradeDowngradeEndlessLoopOptions::EnforceForHTTPSFirstMode);
  bool enforceForHTTPSRR =
      aOptions.contains(UpgradeDowngradeEndlessLoopOptions::EnforceForHTTPSRR);
  if (!enforceForHTTPSOnlyMode && !enforceForHTTPSFirstMode &&
      !enforceForHTTPSRR) {
    return false;
  }

  // 2. Check if the upgrade downgrade pref even wants us to try to break the
  // cycle. In the case that HTTPS RR is presented, we ignore this pref.
  if (!mozilla::StaticPrefs::
          dom_security_https_only_mode_break_upgrade_downgrade_endless_loop() &&
      !enforceForHTTPSRR) {
    return false;
  }

  // 3. If it's not a top-level load, then there is nothing to do here either.
  if (aLoadInfo->GetExternalContentPolicyType() !=
      ExtContentPolicy::TYPE_DOCUMENT) {
    return false;
  }

  // 4. If the load is exempt, then it's defintely not related to https-only
  uint32_t httpsOnlyStatus = aLoadInfo->GetHttpsOnlyStatus();
  if ((httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT) &&
      !enforceForHTTPSRR) {
    return false;
  }

  // 5. Check HTTP 3xx redirects. If the Principal that kicked off the
  // load/redirect is not https, then it's definitely not a redirect cause by
  // https-only. If the scheme of the principal however is https and the
  // asciiHost of the URI to be loaded and the asciiHost of the Principal are
  // identical, then we are dealing with an upgrade downgrade scenario and we
  // have to break the cycle.
  if (IsHttpDowngrade(aOldURI, aNewURI)) {
    return true;
  }

  // TODO(Bug 1896691): Don't depend on triggeringPrincipal for JS/Meta
  //     redirects. Call this function at the correct places instead

  // 6. Bug 1725026: Disable JS/Meta loop detection when the load was triggered
  // by a user gesture.
  if (aLoadInfo->GetHasValidUserGestureActivation()) {
    return false;
  }

  // 7. Meta redirects and JS based redirects (win.location). We detect them
  // during the https upgrade internal redirect.
  nsCOMPtr<nsIPrincipal> triggeringPrincipal = aLoadInfo->TriggeringPrincipal();
  if (!triggeringPrincipal->SchemeIs("https")) {
    return false;
  }

  // We detect Meta and JS based redirects during the upgrade. Check whether
  // we are currently in an upgrade situation here.
  if (!IsHttpDowngrade(aNewURI, aOldURI)) {
    return false;
  }
  // If we upgrade to the same URI that the load is origining from we are
  // creating a redirect loop.
  bool isLoop = false;
  nsresult rv = triggeringPrincipal->EqualsURI(aNewURI, &isLoop);
  NS_ENSURE_SUCCESS(rv, false);
  return isLoop;
}

/* static */
bool nsHTTPSOnlyUtils::ShouldUpgradeHttpsFirstRequest(nsIURI* aURI,
                                                      nsILoadInfo* aLoadInfo) {
  MOZ_ASSERT(aURI->SchemeIs("http"), "how come the request is not 'http'?");

  // 1. Check if HTTPS-First Mode is enabled
  UpgradeMode upgradeMode = GetUpgradeMode(aLoadInfo);
  if (upgradeMode != HTTPS_FIRST_MODE &&
      upgradeMode != SCHEMELESS_HTTPS_FIRST_MODE) {
    return false;
  }
  // 2. HTTPS-First only upgrades top-level loads (and speculative connections)
  ExtContentPolicyType contentType = aLoadInfo->GetExternalContentPolicyType();
  if (contentType != ExtContentPolicy::TYPE_DOCUMENT &&
      contentType != ExtContentPolicy::TYPE_SPECULATIVE) {
    return false;
  }

  // 3. Check for general exceptions
  if (OnionException(aURI) ||
      (!mozilla::StaticPrefs::dom_security_https_first_for_local_addresses() &&
       LoopbackOrLocalException(aURI)) ||
      (!mozilla::StaticPrefs::dom_security_https_first_for_unknown_suffixes() &&
       UnknownPublicSuffixException(aURI))) {
    return false;
  }

  // 4. Don't upgrade if upgraded previously or exempt from upgrades
  uint32_t httpsOnlyStatus = aLoadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT) {
    return false;
  }

  // 5. Don't upgrade if the user explicitly provided a scheme
  if (aLoadInfo->GetSchemelessInput() ==
          nsILoadInfo::SchemelessInputTypeSchemeful &&
      aLoadInfo->GetExternalContentPolicyType() !=
          ExtContentPolicy::TYPE_SPECULATIVE &&
      aURI->SchemeIs("http")) {
    AddHTTPSFirstException(aURI, aLoadInfo);
    return false;
  }

  // 6. Make sure HTTPS-First does not upgrade custom ports when it is disabled
  if (!mozilla::StaticPrefs::dom_security_https_first_for_custom_ports()) {
    int defaultPortforScheme = NS_GetDefaultPort("http");
    // If no port is specified, then the API returns -1 to indicate the default
    // port.
    int32_t port = 0;
    nsresult rv = aURI->GetPort(&port);
    NS_ENSURE_SUCCESS(rv, false);
    if (port != defaultPortforScheme && port != -1) {
      return false;
    }
  }

  // 7. Do not upgrade requests other than GET
  if (!aLoadInfo->GetIsGETRequest()) {
    return false;
  }

  // We can upgrade the request - let's log to the console and set the status
  // so we know that we upgraded the request.
  if (upgradeMode == SCHEMELESS_HTTPS_FIRST_MODE) {
    nsAutoCString urlCString;
    aURI->GetSpec(urlCString);
    NS_ConvertUTF8toUTF16 urlString(urlCString);

    AutoTArray<nsString, 1> params = {urlString};
    nsHTTPSOnlyUtils::LogLocalizedString("HTTPSFirstSchemeless", params,
                                         nsIScriptError::warningFlag, aLoadInfo,
                                         aURI, true);
  } else {
    nsAutoCString scheme;

    aURI->GetScheme(scheme);
    scheme.AppendLiteral("s");
    NS_ConvertUTF8toUTF16 reportSpec(aURI->GetSpecOrDefault());
    NS_ConvertUTF8toUTF16 reportScheme(scheme);

    bool isSpeculative = contentType == ExtContentPolicy::TYPE_SPECULATIVE;
    AutoTArray<nsString, 2> params = {reportSpec, reportScheme};
    nsHTTPSOnlyUtils::LogLocalizedString(
        isSpeculative ? "HTTPSOnlyUpgradeSpeculativeConnection"
                      : "HTTPSOnlyUpgradeRequest",
        params, nsIScriptError::warningFlag, aLoadInfo, aURI, true);
  }

  // Set flag so we know that we upgraded the request
  httpsOnlyStatus |= nsILoadInfo::HTTPS_ONLY_UPGRADED_HTTPS_FIRST;
  aLoadInfo->SetHttpsOnlyStatus(httpsOnlyStatus);
  return true;
}

/* static */
already_AddRefed<nsIURI>
nsHTTPSOnlyUtils::PotentiallyDowngradeHttpsFirstRequest(
    mozilla::net::DocumentLoadListener* aDocumentLoadListener,
    nsresult aStatus) {
  nsCOMPtr<nsIChannel> channel = aDocumentLoadListener->GetChannel();
  nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
  uint32_t httpsOnlyStatus = loadInfo->GetHttpsOnlyStatus();
  // Only downgrade if we this request was upgraded using HTTPS-First Mode
  if (!(httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_UPGRADED_HTTPS_FIRST)) {
    return nullptr;
  }
  // Once loading is in progress we set that flag so that timeout counter
  // measures do not kick in.
  loadInfo->SetHttpsOnlyStatus(
      httpsOnlyStatus | nsILoadInfo::HTTPS_ONLY_TOP_LEVEL_LOAD_IN_PROGRESS);

  nsresult status = aStatus;
  // Since 4xx and 5xx errors return NS_OK instead of NS_ERROR_*, we need
  // to check each NS_OK for those errors.
  // Only downgrade an NS_OK status if it is an 4xx or 5xx error.
  if (NS_SUCCEEDED(aStatus)) {
    nsCOMPtr<nsIHttpChannel> httpChannel = do_QueryInterface(channel);
    // If no httpChannel exists we have nothing to do here.
    if (!httpChannel) {
      return nullptr;
    }
    uint32_t responseStatus = 0;
    if (NS_FAILED(httpChannel->GetResponseStatus(&responseStatus))) {
      return nullptr;
    }

    // In case we found one 4xx or 5xx error we need to log it later on,
    // for that reason we flip the nsresult 'status' from 'NS_OK' to the
    // corresponding NS_ERROR_*.
    // To do so we convert the response status to  an nsresult error
    // Every NS_OK that is NOT an 4xx or 5xx error code won't get downgraded.
    if (responseStatus >= 400 && responseStatus < 600) {
      // HttpProxyResponseToErrorCode() maps 400 and 404 on
      // the same error as a 500 status which would lead to no downgrade
      // later on. For that reason we explicit filter for 400 and 404 status
      // codes to log them correctly and to downgrade them if possible.
      switch (responseStatus) {
        case 400:
          status = NS_ERROR_PROXY_BAD_REQUEST;
          break;
        case 404:
          status = NS_ERROR_PROXY_NOT_FOUND;
          break;
        default:
          status = mozilla::net::HttpProxyResponseToErrorCode(responseStatus);
          break;
      }
    }
    if (NS_SUCCEEDED(status)) {
      return nullptr;
    }
  }

  // We're only downgrading if it's possible that the error was
  // caused by the upgrade.
  nsCOMPtr<nsIHttpChannelInternal> httpChannelInternal(
      do_QueryInterface(channel));
  if (!httpChannelInternal) {
    return nullptr;
  }
  bool proxyUsed = false;
  nsresult rv = httpChannelInternal->GetIsProxyUsed(&proxyUsed);
  MOZ_ASSERT(NS_SUCCEEDED(rv));
  if (!(proxyUsed && status == nsresult::NS_ERROR_UNKNOWN_HOST)
      // When a proxy returns an error code it is converted by
      // HttpProxyResponseToErrorCode. We do want to downgrade in
      // that case. If the host is actually unreachable this will
      // show the same error page, but technically for the HTTP
      // site not the HTTPS site.
      && HttpsUpgradeUnrelatedErrorCode(status)) {
    return nullptr;
  }

  nsCOMPtr<nsIURI> uri;
  rv = channel->GetURI(getter_AddRefs(uri));
  NS_ENSURE_SUCCESS(rv, nullptr);

  nsAutoCString spec;
  nsCOMPtr<nsIURI> newURI;

  // Only downgrade if the current scheme is (a) https or (b) view-source:https
  if (uri->SchemeIs("https")) {
    rv = uri->GetSpec(spec);
    NS_ENSURE_SUCCESS(rv, nullptr);

    rv = NS_NewURI(getter_AddRefs(newURI), spec);
    NS_ENSURE_SUCCESS(rv, nullptr);

    rv = NS_MutateURI(newURI).SetScheme("http"_ns).Finalize(
        getter_AddRefs(newURI));
    NS_ENSURE_SUCCESS(rv, nullptr);
  } else if (uri->SchemeIs("view-source")) {
    nsCOMPtr<nsINestedURI> nestedURI = do_QueryInterface(uri);
    if (!nestedURI) {
      return nullptr;
    }
    nsCOMPtr<nsIURI> innerURI;
    rv = nestedURI->GetInnerURI(getter_AddRefs(innerURI));
    NS_ENSURE_SUCCESS(rv, nullptr);
    if (!innerURI || !innerURI->SchemeIs("https")) {
      return nullptr;
    }
    rv = NS_MutateURI(innerURI).SetScheme("http"_ns).Finalize(
        getter_AddRefs(innerURI));
    NS_ENSURE_SUCCESS(rv, nullptr);

    nsAutoCString innerSpec;
    rv = innerURI->GetSpec(innerSpec);
    NS_ENSURE_SUCCESS(rv, nullptr);

    spec.Append("view-source:");
    spec.Append(innerSpec);

    rv = NS_NewURI(getter_AddRefs(newURI), spec);
    NS_ENSURE_SUCCESS(rv, nullptr);
  } else {
    return nullptr;
  }

  // Log downgrade to console
  NS_ConvertUTF8toUTF16 reportSpec(uri->GetSpecOrDefault());
  AutoTArray<nsString, 1> params = {reportSpec};
  nsHTTPSOnlyUtils::LogLocalizedString("HTTPSOnlyFailedDowngradeAgain", params,
                                       nsIScriptError::warningFlag, loadInfo,
                                       uri, true);

  if (mozilla::StaticPrefs::
          dom_security_https_first_add_exception_on_failure()) {
    AddHTTPSFirstException(uri, loadInfo);
  }

  return newURI.forget();
}

void nsHTTPSOnlyUtils::UpdateLoadStateAfterHTTPSFirstDowngrade(
    mozilla::net::DocumentLoadListener* aDocumentLoadListener,
    nsDocShellLoadState* aLoadState) {
  // We have to exempt the load from HTTPS-First to prevent a upgrade-downgrade
  // loop
  aLoadState->SetIsExemptFromHTTPSFirstMode(true);

  // we can safely set the flag to indicate the downgrade here and it will be
  // propagated all the way to nsHttpChannel::OnStopRequest() where we collect
  // the telemetry.
  nsCOMPtr<nsIChannel> channel = aDocumentLoadListener->GetChannel();
  nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
  if (loadInfo->GetSchemelessInput() ==
      nsILoadInfo::SchemelessInputTypeSchemeless) {
    aLoadState->SetHttpsUpgradeTelemetry(
        nsILoadInfo::HTTPS_FIRST_SCHEMELESS_UPGRADE_DOWNGRADE);
  } else {
    aLoadState->SetHttpsUpgradeTelemetry(
        nsILoadInfo::HTTPS_FIRST_UPGRADE_DOWNGRADE);
  }

  // Add downgrade data for later telemetry usage to load state
  nsDOMNavigationTiming* timing = aDocumentLoadListener->GetTiming();
  if (timing) {
    mozilla::TimeStamp navigationStart = timing->GetNavigationStartTimeStamp();
    if (navigationStart) {
      mozilla::TimeDuration duration =
          mozilla::TimeStamp::Now() - navigationStart;

      nsresult channelStatus;
      channel->GetStatus(&channelStatus);

      RefPtr downgradeData = mozilla::MakeRefPtr<HTTPSFirstDowngradeData>();
      downgradeData->downgradeTime = duration;
      downgradeData->isOnTimer = channelStatus == NS_ERROR_NET_TIMEOUT_EXTERNAL;
      downgradeData->isSchemeless =
          GetUpgradeMode(loadInfo) == SCHEMELESS_HTTPS_FIRST_MODE;
      aLoadState->SetHttpsFirstDowngradeData(downgradeData);
    }
  }
}

void nsHTTPSOnlyUtils::SubmitHTTPSFirstTelemetry(
    nsCOMPtr<nsILoadInfo> const& aLoadInfo,
    RefPtr<HTTPSFirstDowngradeData> const& aHttpsFirstDowngradeData) {
  using namespace mozilla::glean::httpsfirst;
  if (aHttpsFirstDowngradeData) {
    // Successfully downgraded load

    auto downgradedMetric = aHttpsFirstDowngradeData->isSchemeless
                                ? downgraded_schemeless
                                : downgraded;
    auto downgradedOnTimerMetric = aHttpsFirstDowngradeData->isSchemeless
                                       ? downgraded_on_timer_schemeless
                                       : downgraded_on_timer;
    auto downgradeTimeMetric = aHttpsFirstDowngradeData->isSchemeless
                                   ? downgrade_time_schemeless
                                   : downgrade_time;

    if (aHttpsFirstDowngradeData->isOnTimer) {
      downgradedOnTimerMetric.AddToNumerator();
    }
    downgradedMetric.Add();
    downgradeTimeMetric.AccumulateRawDuration(
        aHttpsFirstDowngradeData->downgradeTime);
  } else if (aLoadInfo->GetHttpsOnlyStatus() &
             nsILoadInfo::HTTPS_ONLY_UPGRADED_HTTPS_FIRST) {
    // Successfully upgraded load

    if (GetUpgradeMode(aLoadInfo) == SCHEMELESS_HTTPS_FIRST_MODE) {
      upgraded_schemeless.Add();
    } else {
      upgraded.Add();
    }
  }
}

/* static */
bool nsHTTPSOnlyUtils::CouldBeHttpsOnlyError(nsIChannel* aChannel,
                                             nsresult aError) {
  // If there is no failed channel, then there is nothing to do here.
  if (!aChannel) {
    return false;
  }

  // If HTTPS-Only Mode is not enabled, then there is nothing to do here.
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  if (GetUpgradeMode(loadInfo) != HTTPS_ONLY_MODE) {
    return false;
  }

  // If the load is exempt or did not get upgraded,
  // then there is nothing to do here.
  uint32_t httpsOnlyStatus = loadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT ||
      httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_UNINITIALIZED) {
    return false;
  }

  // If it's one of those errors, then most likely it's not a HTTPS-Only error
  // (This list of errors is largely drawn from nsDocShell::DisplayLoadError())
  return !HttpsUpgradeUnrelatedErrorCode(aError);
}

/* static */
bool nsHTTPSOnlyUtils::TestIfPrincipalIsExempt(nsIPrincipal* aPrincipal,
                                               UpgradeMode aUpgradeMode) {
  static nsCOMPtr<nsIPermissionManager> sPermMgr;
  if (!sPermMgr) {
    sPermMgr = mozilla::components::PermissionManager::Service();
    mozilla::ClearOnShutdown(&sPermMgr);
  }
  NS_ENSURE_TRUE(sPermMgr, false);

  uint32_t perm;
  nsresult rv = sPermMgr->TestExactPermissionFromPrincipal(
      aPrincipal, "https-only-load-insecure"_ns, &perm);
  NS_ENSURE_SUCCESS(rv, false);

  bool checkForHTTPSFirst = aUpgradeMode == HTTPS_FIRST_MODE ||
                            aUpgradeMode == SCHEMELESS_HTTPS_FIRST_MODE;

  return perm == nsIHttpsOnlyModePermission::LOAD_INSECURE_ALLOW ||
         perm == nsIHttpsOnlyModePermission::LOAD_INSECURE_ALLOW_SESSION ||
         (checkForHTTPSFirst &&
          perm == nsIHttpsOnlyModePermission::HTTPSFIRST_LOAD_INSECURE_ALLOW);
}

/* static */
bool nsHTTPSOnlyUtils::IsExemptedExtensionRequest(nsIURI* aURI,
                                                  nsILoadInfo* aLoadInfo) {
  nsCOMPtr<nsIPrincipal> triggeringPrincipal = aLoadInfo->TriggeringPrincipal();
  if (!triggeringPrincipal) {
    return false;
  }

  RefPtr<mozilla::extensions::WebExtensionPolicyCore> core =
      mozilla::BasePrincipal::Cast(triggeringPrincipal)->AddonPolicyCore();
  if (!core) {
    return false;
  }

  mozilla::OriginAttributes oa = aLoadInfo->GetOriginAttributes();
  nsCOMPtr<nsIPrincipal> targetPrincipal =
      mozilla::BasePrincipal::CreateContentPrincipal(aURI, oa);
  if (!targetPrincipal) {
    return false;
  }

  return TestIfPrincipalIsExempt(targetPrincipal, HTTPS_ONLY_MODE);
}

/* static */
void nsHTTPSOnlyUtils::TestSitePermissionAndPotentiallyAddExemption(
    nsIChannel* aChannel) {
  NS_ENSURE_TRUE_VOID(aChannel);

  // If HTTPS-Only or HTTPS-First Mode is not enabled, then there is nothing to
  // do here.
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  UpgradeMode upgradeMode = GetUpgradeMode(loadInfo);

  if (upgradeMode == NO_UPGRADE_MODE) {
    return;
  }

  // if it's not a top-level load then there is nothing to here.
  ExtContentPolicyType type = loadInfo->GetExternalContentPolicyType();
  if (type != ExtContentPolicy::TYPE_DOCUMENT) {
    return;
  }

  // it it's not an http channel, then there is nothing to do here.
  nsCOMPtr<nsIHttpChannel> httpChannel = do_QueryInterface(aChannel);
  if (!httpChannel) {
    return;
  }

  nsCOMPtr<nsIPrincipal> principal;
  nsresult rv = nsContentUtils::GetSecurityManager()->GetChannelResultPrincipal(
      aChannel, getter_AddRefs(principal));
  NS_ENSURE_SUCCESS_VOID(rv);

  uint32_t httpsOnlyStatus = loadInfo->GetHttpsOnlyStatus();
  bool isPrincipalExempt = TestIfPrincipalIsExempt(principal, upgradeMode);
  if (isPrincipalExempt) {
    httpsOnlyStatus |= nsILoadInfo::HTTPS_ONLY_EXEMPT;
  }
  loadInfo->SetHttpsOnlyStatus(httpsOnlyStatus);

  // For the telemetry we do not want downgrade values to be overwritten
  // in the loadinfo. We only want e.g. a reload() or a back() click
  // to carry the upgrade exception.
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_EXEMPT) {
    nsILoadInfo::HTTPSUpgradeTelemetryType httpsTelemetry =
        nsILoadInfo::NOT_INITIALIZED;
    loadInfo->GetHttpsUpgradeTelemetry(&httpsTelemetry);
    if (httpsTelemetry != nsILoadInfo::HTTPS_ONLY_UPGRADE_DOWNGRADE &&
        httpsTelemetry != nsILoadInfo::HTTPS_FIRST_UPGRADE_DOWNGRADE &&
        httpsTelemetry !=
            nsILoadInfo::HTTPS_FIRST_SCHEMELESS_UPGRADE_DOWNGRADE) {
      loadInfo->SetHttpsUpgradeTelemetry(nsILoadInfo::UPGRADE_EXCEPTION);
    }
  }
}

/* static */
bool nsHTTPSOnlyUtils::IsSafeToAcceptCORSOrMixedContent(
    nsILoadInfo* aLoadInfo) {
  // Check if the request is exempt from upgrades
  if ((aLoadInfo->GetHttpsOnlyStatus() & nsILoadInfo::HTTPS_ONLY_EXEMPT)) {
    return false;
  }
  // Check if HTTPS-Only Mode is enabled for this request
  return GetUpgradeMode(aLoadInfo) == HTTPS_ONLY_MODE;
}

/* static */
bool nsHTTPSOnlyUtils::HttpsUpgradeUnrelatedErrorCode(nsresult aError) {
  return NS_ERROR_UNKNOWN_PROTOCOL == aError ||
         NS_ERROR_FILE_NOT_FOUND == aError ||
         NS_ERROR_FILE_ACCESS_DENIED == aError ||
         NS_ERROR_UNKNOWN_HOST == aError || NS_ERROR_PHISHING_URI == aError ||
         NS_ERROR_MALWARE_URI == aError || NS_ERROR_UNWANTED_URI == aError ||
         NS_ERROR_HARMFUL_URI == aError || NS_ERROR_CONTENT_CRASHED == aError ||
         NS_ERROR_FRAME_CRASHED == aError ||
         NS_ERROR_NET_EMPTY_RESPONSE == aError ||
         NS_ERROR_NET_ERROR_RESPONSE == aError;
}

/* ------ Logging ------ */

/* static */
void nsHTTPSOnlyUtils::LogLocalizedString(const char* aName,
                                          const nsTArray<nsString>& aParams,
                                          uint32_t aFlags,
                                          nsILoadInfo* aLoadInfo, nsIURI* aURI,
                                          bool aUseHttpsFirst) {
  nsAutoString logMsg;
  nsContentUtils::FormatLocalizedString(PropertiesFile::SECURITY_PROPERTIES,
                                        aName, aParams, logMsg);
  LogMessage(logMsg, aFlags, aLoadInfo, aURI, aUseHttpsFirst);
}

/* static */
void nsHTTPSOnlyUtils::LogMessage(const nsAString& aMessage, uint32_t aFlags,
                                  nsILoadInfo* aLoadInfo, nsIURI* aURI,
                                  bool aUseHttpsFirst) {
  // do not log to the console if the loadinfo says we should not!
  uint32_t httpsOnlyStatus = aLoadInfo->GetHttpsOnlyStatus();
  if (httpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_DO_NOT_LOG_TO_CONSOLE) {
    return;
  }

  // Prepending HTTPS-Only to the outgoing console message
  nsString message;
  message.Append(aUseHttpsFirst ? u"HTTPS-First Mode: "_ns
                                : u"HTTPS-Only Mode: "_ns);
  message.Append(aMessage);

  // Allow for easy distinction in devtools code.
  auto category = aUseHttpsFirst ? "HTTPSFirst"_ns : "HTTPSOnly"_ns;

  uint64_t windowId = aLoadInfo->GetInnerWindowID();
  if (!windowId) {
    windowId = aLoadInfo->GetTriggeringWindowId();
  }
  if (windowId) {
    // Send to content console
    nsContentUtils::ReportToConsoleByWindowID(
        message, aFlags, category, windowId, mozilla::SourceLocation(aURI));
  } else {
    // Send to browser console
    bool isPrivateWin = aLoadInfo->GetOriginAttributes().IsPrivateBrowsing();
    nsContentUtils::LogSimpleConsoleError(message, category, isPrivateWin,
                                          true /* from chrome context */,
                                          aFlags);
  }
}

/* ------ Exceptions ------ */

/* static */
bool nsHTTPSOnlyUtils::OnionException(nsIURI* aURI) {
  // Onion-host exception can get disabled with a pref
  if (mozilla::StaticPrefs::dom_security_https_only_mode_upgrade_onion()) {
    return false;
  }
  nsAutoCString host;
  aURI->GetHost(host);
  return StringEndsWith(host, ".onion"_ns);
}

/* static */
bool nsHTTPSOnlyUtils::LoopbackOrLocalException(nsIURI* aURI) {
  nsAutoCString asciiHost;
  nsresult rv = aURI->GetAsciiHost(asciiHost);
  NS_ENSURE_SUCCESS(rv, false);

  // Let's make a quick check if the host matches these loopback strings
  // before we do anything else
  if (asciiHost.EqualsLiteral("localhost") || asciiHost.EqualsLiteral("::1")) {
    return true;
  }

  mozilla::net::NetAddr addr;
  if (NS_FAILED(addr.InitFromString(asciiHost))) {
    return false;
  }
  // Loopback IPs are always exempt
  if (addr.IsLoopbackAddr()) {
    return true;
  }

  // Local IP exception can get disabled with a pref
  bool upgradeLocal =
      mozilla::StaticPrefs::dom_security_https_only_mode_upgrade_local();
  return (!upgradeLocal && addr.IsIPAddrLocal());
}

/* static */
bool nsHTTPSOnlyUtils::UnknownPublicSuffixException(nsIURI* aURI) {
  nsCOMPtr<nsIEffectiveTLDService> tldService =
      do_GetService(NS_EFFECTIVETLDSERVICE_CONTRACTID);
  NS_ENSURE_TRUE(tldService, false);

  bool hasKnownPublicSuffix;
  nsresult rv = tldService->HasKnownPublicSuffix(aURI, &hasKnownPublicSuffix);
  NS_ENSURE_SUCCESS(rv, false);

  return !hasKnownPublicSuffix;
}

/* static */
bool nsHTTPSOnlyUtils::IsHttpDowngrade(nsIURI* aFromURI, nsIURI* aToURI) {
  MOZ_ASSERT(aFromURI);
  MOZ_ASSERT(aToURI);

  if (!aFromURI || !aToURI) {
    return false;
  }

  // 2. If the target URI is not http, then it's not a http downgrade
  if (!aToURI->SchemeIs("http")) {
    return false;
  }

  // 3. If the origin URI isn't https, then it's not a http downgrade either.
  if (!aFromURI->SchemeIs("https")) {
    return false;
  }

  // 4. Create a new target URI with 'https' instead of 'http' and compare it
  // to the origin URI
  int32_t port = 0;
  nsresult rv = aToURI->GetPort(&port);
  NS_ENSURE_SUCCESS(rv, false);
  // a port of -1 indicates the default port, hence we upgrade from port 80 to
  // port 443
  // otherwise we keep the port.
  if (port == -1) {
    port = NS_GetDefaultPort("https");
  }
  nsCOMPtr<nsIURI> newHTTPSchemeURI;
  rv = NS_MutateURI(aToURI)
           .SetScheme("https"_ns)
           .SetPort(port)
           .Finalize(newHTTPSchemeURI);
  NS_ENSURE_SUCCESS(rv, false);

  bool uriEquals = false;
  if (NS_FAILED(aFromURI->EqualsExceptRef(newHTTPSchemeURI, &uriEquals))) {
    return false;
  }

  return uriEquals;
}

/* static */
nsresult nsHTTPSOnlyUtils::AddHTTPSFirstException(
    nsCOMPtr<nsIURI> aURI, nsILoadInfo* const aLoadInfo) {
  // We need to reconstruct a principal instead of taking one from the loadinfo,
  // as the permission needs a http scheme, while the passed URL or principals
  // on the loadinfo may have a https scheme.
  nsresult rv =
      NS_MutateURI(aURI).SetScheme("http"_ns).Finalize(getter_AddRefs(aURI));
  NS_ENSURE_SUCCESS(rv, rv);

  mozilla::OriginAttributes oa = aLoadInfo->GetOriginAttributes();
  oa.SetFirstPartyDomain(true, aURI);

  nsCOMPtr<nsIPermissionManager> permMgr =
      mozilla::components::PermissionManager::Service();
  NS_ENSURE_TRUE(permMgr, nsresult::NS_ERROR_SERVICE_NOT_AVAILABLE);

  nsCOMPtr<nsIPrincipal> principal =
      mozilla::BasePrincipal::CreateContentPrincipal(aURI, oa);

  nsCString host;
  aURI->GetHost(host);
  LogLocalizedString("HTTPSFirstAddingException", {NS_ConvertUTF8toUTF16(host)},
                     nsIScriptError::warningFlag, aLoadInfo, aURI, true);

  uint32_t lifetime =
      mozilla::StaticPrefs::dom_security_https_first_exception_lifetime();
  int64_t expirationTime = (PR_Now() / PR_USEC_PER_MSEC) + lifetime;
  rv = permMgr->AddFromPrincipal(
      principal, "https-only-load-insecure"_ns,
      nsIHttpsOnlyModePermission::HTTPSFIRST_LOAD_INSECURE_ALLOW,
      nsIPermissionManager::EXPIRE_TIME, expirationTime);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

/* static */
uint32_t nsHTTPSOnlyUtils::GetStatusForSubresourceLoad(
    uint32_t aHttpsOnlyStatus) {
  return aHttpsOnlyStatus & ~nsILoadInfo::HTTPS_ONLY_UPGRADED_HTTPS_FIRST;
}

/////////////////////////////////////////////////////////////////////
// Implementation of TestHTTPAnswerRunnable

NS_IMPL_ISUPPORTS_INHERITED(TestHTTPAnswerRunnable, mozilla::Runnable,
                            nsIStreamListener, nsIInterfaceRequestor,
                            nsITimerCallback)

TestHTTPAnswerRunnable::TestHTTPAnswerRunnable(
    nsIURI* aURI, mozilla::net::DocumentLoadListener* aDocumentLoadListener)
    : mozilla::Runnable("TestHTTPAnswerRunnable"),
      mURI(aURI),
      mDocumentLoadListener(aDocumentLoadListener) {}

/* static */
bool TestHTTPAnswerRunnable::IsBackgroundRequestRedirected(
    nsIHttpChannel* aChannel) {
  // If there is no background request (aChannel), then there is nothing
  // to do here.
  if (!aChannel) {
    return false;
  }
  // If the request was not redirected, then there is nothing to do here.
  nsCOMPtr<nsILoadInfo> loadinfo = aChannel->LoadInfo();
  if (loadinfo->RedirectChain().IsEmpty()) {
    return false;
  }

  // If the final URI is not targeting an https scheme, then we definitely not
  // dealing with a 'same-origin' redirect.
  nsCOMPtr<nsIURI> finalURI;
  nsresult rv = NS_GetFinalChannelURI(aChannel, getter_AddRefs(finalURI));
  NS_ENSURE_SUCCESS(rv, false);
  if (!finalURI->SchemeIs("https")) {
    return false;
  }

  // If the background request was not http, then there is nothing to do here.
  nsCOMPtr<nsIPrincipal> firstURIPrincipal;
  loadinfo->RedirectChain()[0]->GetPrincipal(getter_AddRefs(firstURIPrincipal));
  if (!firstURIPrincipal || !firstURIPrincipal->SchemeIs("http")) {
    return false;
  }

  // By now we have verified that the initial background request was http and
  // that the redirected scheme is https. We want to find the following case
  // where the background channel redirects to the https version of the
  // top-level request.
  // --> background channel: http://example.com
  //      |--> redirects to: https://example.com
  // Now we have to check that the hosts are 'same-origin'.
  nsAutoCString redirectHost;
  nsAutoCString finalHost;
  firstURIPrincipal->GetAsciiHost(redirectHost);
  finalURI->GetAsciiHost(finalHost);
  return finalHost.Equals(redirectHost);
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::OnStartRequest(nsIRequest* aRequest) {
  // If the request status is not OK, it means it encountered some
  // kind of error in which case we do not want to do anything.
  nsresult requestStatus;
  aRequest->GetStatus(&requestStatus);
  if (requestStatus != NS_OK) {
    return NS_OK;
  }

  // Check if the original top-level channel which https-only is trying
  // to upgrade is already in progress or if the channel is an auth channel.
  // If it is in progress or Auth is in progress, then all good, if not
  // then let's cancel that channel so we can dispaly the exception page.
  nsCOMPtr<nsIChannel> docChannel = mDocumentLoadListener->GetChannel();
  nsCOMPtr<nsIHttpChannel> httpsOnlyChannel = do_QueryInterface(docChannel);
  if (httpsOnlyChannel) {
    nsCOMPtr<nsILoadInfo> loadInfo = httpsOnlyChannel->LoadInfo();
    uint32_t topLevelLoadInProgress =
        loadInfo->GetHttpsOnlyStatus() &
        nsILoadInfo::HTTPS_ONLY_TOP_LEVEL_LOAD_IN_PROGRESS;

    nsCOMPtr<nsIHttpChannelInternal> httpChannelInternal =
        do_QueryInterface(httpsOnlyChannel);
    bool isAuthChannel = false;
    (void)httpChannelInternal->GetIsAuthChannel(&isAuthChannel);
    // some server configurations need a long time to respond to an https
    // connection, but also redirect any http connection to the https version of
    // it. If the top-level load has not started yet, but the http background
    // request redirects to https, then do not show the error page, but keep
    // waiting for the https response of the upgraded top-level request.
    if (!topLevelLoadInProgress) {
      nsCOMPtr<nsIHttpChannel> backgroundHttpChannel =
          do_QueryInterface(aRequest);
      topLevelLoadInProgress =
          IsBackgroundRequestRedirected(backgroundHttpChannel);
    }
    if (!topLevelLoadInProgress && !isAuthChannel) {
      // Only really cancel the original top-level channel if it's
      // status is still NS_OK, otherwise it might have already
      // encountered some other error and was cancelled.
      nsresult httpsOnlyChannelStatus;
      httpsOnlyChannel->GetStatus(&httpsOnlyChannelStatus);
      if (httpsOnlyChannelStatus == NS_OK) {
        httpsOnlyChannel->Cancel(NS_ERROR_NET_TIMEOUT_EXTERNAL);
      }
    }
  }

  // Cancel this http request because it has reached the end of it's
  // lifetime at this point.
  aRequest->Cancel(NS_ERROR_ABORT);
  return NS_ERROR_ABORT;
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::OnDataAvailable(nsIRequest* aRequest,
                                        nsIInputStream* aStream,
                                        uint64_t aOffset, uint32_t aCount) {
  // TestHTTPAnswerRunnable only cares about ::OnStartRequest which
  // will also cancel the request, so we should in fact never even
  // get here.
  MOZ_ASSERT(false, "how come we get to ::OnDataAvailable");
  return NS_OK;
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::OnStopRequest(nsIRequest* aRequest,
                                      nsresult aStatusCode) {
  // TestHTTPAnswerRunnable only cares about ::OnStartRequest
  return NS_OK;
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::GetInterface(const nsIID& aIID, void** aResult) {
  return QueryInterface(aIID, aResult);
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::Run() {
  {
    // Before we start our timer we kick of a DNS request for HTTPS RR. If we
    // find a HTTPS RR we will not downgrade later.
    nsCOMPtr<nsIChannel> origChannel = mDocumentLoadListener->GetChannel();
    mozilla::OriginAttributes originAttributes;
    mozilla::StoragePrincipalHelper::GetOriginAttributesForHTTPSRR(
        origChannel, originAttributes);
    RefPtr<nsDNSPrefetch> resolver =
        new nsDNSPrefetch(mURI, originAttributes, origChannel->GetTRRMode());
    nsCOMPtr<nsIHttpChannelInternal> internalChannel =
        do_QueryInterface(origChannel);
    // If the channel will be proxied and the proxy is responsible for DNS
    // resolution, skip the HTTPS RR lookup to avoid leaking the host name
    nsIHttpChannelInternal::ProxyDNSStrategy dnsStrategy =
        nsIHttpChannelInternal::PROXY_DNS_STRATEGY_ORIGIN;
    if (internalChannel) {
      (void)internalChannel->GetProxyDNSStrategy(&dnsStrategy);
    }
    uint32_t caps;
    if (dnsStrategy != nsIHttpChannelInternal::PROXY_DNS_STRATEGY_PROXY &&
        internalChannel && NS_SUCCEEDED(internalChannel->GetCaps(&caps))) {
      (void)resolver->FetchHTTPSSVC(
          caps & NS_HTTP_REFRESH_DNS, false,
          [self = RefPtr{this}](nsIDNSHTTPSSVCRecord* aRecord) {
            self->mHasHTTPSRR = (aRecord != nullptr);
          });
    }
  }

  // Wait N milliseconds to give the original https request a heads start
  // before firing up this http request in the background. If the https request
  // has not received any signal from the server during that time, than it's
  // almost certain the upgraded request will result in time out.
  uint32_t background_timer_ms = mozilla::StaticPrefs::
      dom_security_https_only_fire_http_request_background_timer_ms();

  return NS_NewTimerWithCallback(getter_AddRefs(mTimer), this,
                                 background_timer_ms, nsITimer::TYPE_ONE_SHOT);
}

NS_IMETHODIMP
TestHTTPAnswerRunnable::Notify(nsITimer* aTimer) {
  if (mTimer) {
    mTimer->Cancel();
    mTimer = nullptr;
  }

  // If the original channel has already started loading at this point
  // then there is no need to do the dance.
  nsCOMPtr<nsIChannel> origChannel = mDocumentLoadListener->GetChannel();
  nsCOMPtr<nsILoadInfo> origLoadInfo = origChannel->LoadInfo();
  uint32_t origHttpsOnlyStatus = origLoadInfo->GetHttpsOnlyStatus();
  uint32_t topLevelLoadInProgress =
      origHttpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_TOP_LEVEL_LOAD_IN_PROGRESS;
  uint32_t downloadInProgress =
      origHttpsOnlyStatus & nsILoadInfo::HTTPS_ONLY_DOWNLOAD_IN_PROGRESS;

  // If the upgrade is caused by HSTS or HTTPS RR we do not allow downgrades
  // so we do not need to start a racing request.
  bool isClientRequestedUpgrade =
      origHttpsOnlyStatus &
          (nsILoadInfo::HTTPS_ONLY_UPGRADED_LISTENER_NOT_REGISTERED |
           nsILoadInfo::HTTPS_ONLY_UPGRADED_LISTENER_REGISTERED |
           nsILoadInfo::HTTPS_ONLY_UPGRADED_HTTPS_FIRST) &&
      !mHasHTTPSRR;

  if (topLevelLoadInProgress || downloadInProgress ||
      !isClientRequestedUpgrade) {
    return NS_OK;
  }

  mozilla::OriginAttributes attrs = origLoadInfo->GetOriginAttributes();
  RefPtr<nsIPrincipal> nullPrincipal = mozilla::NullPrincipal::Create(attrs);

  uint32_t loadFlags =
      nsIRequest::LOAD_ANONYMOUS | nsIRequest::INHIBIT_CACHING |
      nsIRequest::INHIBIT_PERSISTENT_CACHING | nsIRequest::LOAD_BYPASS_CACHE |
      nsIChannel::LOAD_BYPASS_SERVICE_WORKER;

  // No need to connect to the URI including the path because we only care about
  // the round trip time if a server responds to an http request.
  nsCOMPtr<nsIURI> backgroundChannelURI;
  nsAutoCString prePathStr;
  nsresult rv = mURI->GetPrePath(prePathStr);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }
  rv = NS_NewURI(getter_AddRefs(backgroundChannelURI), prePathStr);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  // we are using TYPE_OTHER because TYPE_DOCUMENT might have side effects
  nsCOMPtr<nsIChannel> testHTTPChannel;
  rv = NS_NewChannel(getter_AddRefs(testHTTPChannel), backgroundChannelURI,
                     nullPrincipal,
                     nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                     nsIContentPolicy::TYPE_OTHER, nullptr, nullptr, nullptr,
                     nullptr, loadFlags);

  if (NS_WARN_IF(NS_FAILED(rv))) {
    return rv;
  }

  // We have exempt that load from HTTPS-Only to avoid getting upgraded
  // to https as well. Additionally let's not log that request to the console
  // because it might confuse end users.
  nsCOMPtr<nsILoadInfo> loadInfo = testHTTPChannel->LoadInfo();
  uint32_t httpsOnlyStatus = loadInfo->GetHttpsOnlyStatus();
  httpsOnlyStatus |= nsILoadInfo::HTTPS_ONLY_EXEMPT |
                     nsILoadInfo::HTTPS_ONLY_DO_NOT_LOG_TO_CONSOLE |
                     nsILoadInfo::HTTPS_ONLY_BYPASS_ORB;
  loadInfo->SetHttpsOnlyStatus(httpsOnlyStatus);

  testHTTPChannel->SetNotificationCallbacks(this);
  testHTTPChannel->AsyncOpen(this);
  return NS_OK;
}
