/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ContentClassifierService.h"

#include "ErrorList.h"
#include "mozilla/Logging.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/net/HttpBaseChannel.h"
#include "mozilla/net/ChannelClassifierUtils.h"
#include "MainThreadUtils.h"
#include "nsDebug.h"
#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/BasePrincipal.h"
#include "mozilla/ContentBlockingAllowList.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/dom/Promise.h"
#include "mozilla/dom/Promise-inl.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/ErrorResult.h"
#include "mozilla/Preferences.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_privacy.h"

#include "mozilla/Components.h"
#include "mozilla/MozPromise.h"
#include "mozilla/StaticPtr.h"
#include "nsIAsyncShutdown.h"
#include "nsIChannel.h"
#include "nsIClassifiedChannel.h"
#include "nsIClassOfService.h"
#include "nsIHttpChannel.h"
#include "nsHttpChannel.h"
#include "nsQueryObject.h"
#include "nsIWritablePropertyBag2.h"
#include "nsIContentPolicy.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsIPermissionManager.h"
#include "nsIEffectiveTLDService.h"
#include "mozIThirdPartyUtil.h"
#include "nsIStreamLoader.h"
#include "nsIURI.h"
#include "nsISupportsPriority.h"
#include "nsNetUtil.h"
#include "nsContentUtils.h"
#include "nsProxyRelease.h"
#include "nsHashPropertyBag.h"
#include "nsEscape.h"
#include "nsIWebProgressListener.h"
#include "nsStringFwd.h"
#include "nsTArray.h"
#include "nsThreadUtils.h"
#include "prtime.h"

namespace mozilla {

static LazyLogModule gContentClassifierLog("ContentClassifier");

StaticRefPtr<ContentClassifierService> ContentClassifierService::sInstance;
bool ContentClassifierService::sEnabled = false;

namespace {

constexpr nsLiteralCString kTrackersListIds[] = {"disconnect-tracker-base"_ns};
constexpr nsLiteralCString kTrackersContentListIds[] = {
    "disconnect-tracker-content"_ns};
constexpr nsLiteralCString kSocialTrackersListIds[] = {"mozilla-social"_ns};
constexpr nsLiteralCString kFingerprintersListIds[] = {
    "disconnect-fingerprinters-base"_ns};
constexpr nsLiteralCString kEmailTrackersListIds[] = {
    "disconnect-email-base"_ns};
constexpr nsLiteralCString kCryptominersListIds[] = {
    "disconnect-cryptominer-base"_ns};
constexpr nsLiteralCString kMajorExceptionListIds[] = {
    "mozilla-major-exceptions"_ns};
constexpr nsLiteralCString kMinorExceptionListIds[] = {
    "mozilla-minor-exceptions"_ns};
constexpr nsLiteralCString kTestBlockListIds[] = {"test_block"_ns};
constexpr nsLiteralCString kTestAnnotateListIds[] = {"test_annotate"_ns};

constexpr ContentClassifierFeature kFeatures[] = {
    {"trackers"_ns, Span<const nsLiteralCString>(kTrackersListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING,
     nsIWebProgressListener::STATE_LOADED_LEVEL_1_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_TRACKING_URI, false},
    // The annotation variant adds content-track-digest256, which mirrors
    // url-classifier's promotion to STATE_LOADED_LEVEL_2_TRACKING_CONTENT
    // when a content-track-* table matches.
    {"trackers-content"_ns,
     Span<const nsLiteralCString>(kTrackersContentListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING,
     nsIWebProgressListener::STATE_LOADED_LEVEL_2_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_TRACKING_URI, false},
    {"social-trackers"_ns, Span<const nsLiteralCString>(kSocialTrackersListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_SOCIALTRACKING,
     nsIWebProgressListener::STATE_LOADED_SOCIALTRACKING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_SOCIALTRACKING_URI, false},
    {"fingerprinters"_ns, Span<const nsLiteralCString>(kFingerprintersListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_FINGERPRINTING,
     nsIWebProgressListener::STATE_LOADED_FINGERPRINTING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_FINGERPRINTING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_FINGERPRINTING_CONTENT,
     NS_ERROR_FINGERPRINTING_URI, false},
    {"email-trackers"_ns, Span<const nsLiteralCString>(kEmailTrackersListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_EMAILTRACKING,
     nsIWebProgressListener::STATE_LOADED_EMAILTRACKING_LEVEL_1_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_EMAILTRACKING_URI, false},
    {"cryptominers"_ns, Span<const nsLiteralCString>(kCryptominersListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_CRYPTOMINING,
     nsIWebProgressListener::STATE_LOADED_CRYPTOMINING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_CRYPTOMINING_URI, false},
    {"minor-exceptions"_ns,
     Span<const nsLiteralCString>(kMinorExceptionListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING, 0, 0, 0,
     NS_OK, true},
    {"major-exceptions"_ns,
     Span<const nsLiteralCString>(kMajorExceptionListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING, 0, 0, 0,
     NS_OK, true},
    // Test-only features. Their engines are built directly by the HTTP
    // test loader (driven by the *.test_list_urls prefs) and installed
    // into mEngines under these names. They behave like any other
    // feature once built and do not go through the RS client.
    {"test_block"_ns, Span<const nsLiteralCString>(kTestBlockListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING,
     nsIWebProgressListener::STATE_LOADED_LEVEL_1_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT,
     NS_ERROR_TRACKING_URI, false},
    {"test_annotate"_ns, Span<const nsLiteralCString>(kTestAnnotateListIds),
     nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING,
     nsIWebProgressListener::STATE_LOADED_LEVEL_1_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_REPLACED_TRACKING_CONTENT,
     nsIWebProgressListener::STATE_ALLOWED_TRACKING_CONTENT, NS_OK, false},
};

// Prefs that name feature engines built into mEngines.
constexpr const char* kFeatureEnginesPrefs[] = {
    "privacy.trackingprotection.content.protection.engines",
    "privacy.trackingprotection.content.protection.engines.pbmode",
    "privacy.trackingprotection.content.annotation.engines",
    "privacy.trackingprotection.content.annotation.engines.pbmode",
};

constexpr nsLiteralCString kObservedPrefs[] = {
    "privacy.trackingprotection.content.protection.enabled"_ns,
    "privacy.trackingprotection.content.annotation.enabled"_ns,
    "privacy.trackingprotection.content.protection.test_list_urls"_ns,
    "privacy.trackingprotection.content.annotation.test_list_urls"_ns,
    "privacy.trackingprotection.content.protection.engines"_ns,
    "privacy.trackingprotection.content.annotation.engines"_ns,
    "privacy.trackingprotection.content.protection.engines.pbmode"_ns,
    "privacy.trackingprotection.content.annotation.engines.pbmode"_ns,
};

bool HasAnyActiveRemoteSettingsFeatures() {
  nsTArray<nsCString> names;
  for (const char* pref : kFeatureEnginesPrefs) {
    names.Clear();
    EnginesPrefsSnapshot::AppendFeatureNamesFromPref(pref, names);
    for (const auto& name : names) {
      if (!name.Equals("test_block") && !name.Equals("test_annotate")) {
        return true;
      }
    }
  }
  return false;
}

void NotifyListsLoadedForTesting() {
  if (!StaticPrefs::privacy_trackingprotection_content_testing()) {
    return;
  }
  nsCOMPtr<nsIObserverService> obs = services::GetObserverService();
  if (obs) {
    obs->NotifyObservers(
        nullptr, NS_CONTENT_CLASSIFIER_FILTER_LISTS_LOADED_TOPIC, nullptr);
  }
}

}  // namespace

NS_IMPL_ISUPPORTS(ContentClassifierService, nsIAsyncShutdownBlocker,
                  nsIContentClassifierService, nsIObserver)

ContentClassifierService::ContentClassifierService()
    : mLock("ContentClassifierService::mLock"),
      mInitPhase(InitPhase::NotInited) {
  sEnabled =
      Preferences::GetBool(
          "privacy.trackingprotection.content.protection.enabled", false) ||
      Preferences::GetBool(
          "privacy.trackingprotection.content.annotation.enabled", false);
}

ContentClassifierService::~ContentClassifierService() = default;

// static
bool ContentClassifierService::IsEnabled() {
  if (!sInstance) {
    return false;
  }

  return sEnabled;
}

// static
Span<const ContentClassifierFeature> ContentClassifierService::GetFeatures() {
  return Span<const ContentClassifierFeature>(kFeatures);
}

// static
Maybe<const ContentClassifierFeature&>
ContentClassifierService::GetFeatureByName(const nsACString& aName) {
  for (const auto& feature : kFeatures) {
    if (feature.mName.Equals(aName)) {
      return SomeRef(feature);
    }
  }
  return Nothing();
}

// static
bool ContentClassifierService::IsInitialized() {
  if (!sInstance) {
    return false;
  }

  MutexAutoLock lock(sInstance->mLock);
  return sInstance->mInitPhase == InitPhase::InitSucceeded;
}

// static
void ContentClassifierService::OnPrefChange(const char* aPref, void*) {
  MOZ_ASSERT(NS_IsMainThread());
  // Access sInstance directly rather than GetInstance(), because
  // GetInstance() returns nullptr when the feature is disabled, but we
  // need to handle enable/disable transitions here.
  RefPtr<ContentClassifierService> service = sInstance;
  if (!service) {
    return;
  }

  if (!IsInitialized()) {
    return;
  }

  bool wasEnabled = sEnabled;
  sEnabled =
      Preferences::GetBool(
          "privacy.trackingprotection.content.protection.enabled", false) ||
      Preferences::GetBool(
          "privacy.trackingprotection.content.annotation.enabled", false);

  // mRSClient is main-thread only (see header); the NS_IsMainThread
  // assert at the top of this function covers this read and the
  // subsequent Init/Shutdown calls.
  const bool hasRSClient = !!service->mRSClient;

  if (!wasEnabled && sEnabled && !hasRSClient) {
    // Feature just became enabled. Start the RS client if list names are set.
    if (HasAnyActiveRemoteSettingsFeatures()) {
      service->InitRSClient();
    }
    return;
  }

  if (wasEnabled && !sEnabled) {
    // Feature just became disabled. Tear down the RS client and engines.
    service->ShutdownRSClient();
    return;
  }

  // Feature enabled state unchanged. Handle individual pref changes.
  const nsDependentCString prefStr(aPref);
  const bool isFeatureSelectionPref =
      prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.protection.engines") ||
      prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.protection.engines.pbmode") ||
      prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.annotation.engines") ||
      prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.annotation.engines.pbmode");

  if (isFeatureSelectionPref) {
    if (!sEnabled) {
      // The feature is disabled; nothing to rebuild or fetch. Enabling
      // will pick up the new pref.
      return;
    }
    // Active feature selection changed. Start RS client if needed; its
    // init will deliver onListsChanged notifications and trigger builds.
    if (!hasRSClient && HasAnyActiveRemoteSettingsFeatures()) {
      service->InitRSClient();
      return;
    }
    if (hasRSClient && !HasAnyActiveRemoteSettingsFeatures()) {
      service->ShutdownRSClient();
      return;
    }
    // Reshuffles into the per-mode arrays and picks up any newly-active
    // feature whose engine isn't built.
    service->ProcessListChanges({}, {});
    return;
  }

  // Redownload the test_* rule lists when the prefs controlling them are
  // updated
  nsTArray<nsCString> testEnginesToUpdate;
  if (prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.protection.test_list_urls")) {
    testEnginesToUpdate.AppendElement("test_block"_ns);
  }
  if (prefStr.EqualsLiteral(
          "privacy.trackingprotection.content.annotation.test_list_urls")) {
    testEnginesToUpdate.AppendElement("test_annotate"_ns);
  }

  if (!testEnginesToUpdate.IsEmpty()) {
    service->ProcessListChanges(testEnginesToUpdate, {});
    return;
  }

  // An .enabled pref changed but the combined enabled state didn't flip
  // (e.g. one was already true). Nothing to do - engines are already
  // populated via whichever path is active.
}

void ContentClassifierService::Init() {
  MOZ_ASSERT(XRE_IsParentProcess());
  AssertIsOnMainThread();

  {
    MutexAutoLock lock(mLock);

    if (mInitPhase != InitPhase::NotInited) {
      return;
    }

    if (NS_FAILED(ContentClassifierEngine::InitializeDomainResolver())) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    MOZ_LOG(gContentClassifierLog, LogLevel::Info,
            ("ContentClassifierService::Init - initializing"));

    nsCOMPtr<nsIAsyncShutdownClient> shutdownBarrier =
        GetAsyncShutdownBarrier();
    if (!shutdownBarrier) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    bool closed;
    nsresult rv = shutdownBarrier->GetIsClosed(&closed);
    if (NS_FAILED(rv) || closed) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    rv = shutdownBarrier->AddBlocker(
        this, NS_LITERAL_STRING_FROM_CSTRING(__FILE__), __LINE__, u""_ns);
    if (NS_FAILED(rv)) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    for (const auto& pref : kObservedPrefs) {
      rv = Preferences::RegisterCallback(
          &ContentClassifierService::OnPrefChange, pref);
      if (NS_FAILED(rv)) {
        mInitPhase = InitPhase::InitFailed;
        return;
      }
    }

    rv = NS_CreateBackgroundTaskQueue("ContentClassifier",
                                      getter_AddRefs(mBuildThread));
    if (NS_FAILED(rv)) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    rv = NS_CreateBackgroundTaskQueue("AdClassification",
                                      getter_AddRefs(mAdClassificationThread));
    if (NS_FAILED(rv)) {
      mInitPhase = InitPhase::InitFailed;
      return;
    }

    mInitPhase = InitPhase::InitSucceeded;
  }

  // Lock released; safe to call into JS.
  // Only initialize the RS client if list_names prefs are set,
  // to avoid interfering with the test-only HTTP loading path.
  if (sEnabled && HasAnyActiveRemoteSettingsFeatures()) {
    InitRSClient();
  }
}

void ContentClassifierService::InitRSClient() {
  MOZ_ASSERT(NS_IsMainThread());

  if (mRSClient) {
    return;
  }

  MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Info,
              "InitRSClient - creating RS client");

  nsresult rv;
  mRSClient =
      do_GetService(NS_CONTENTCLASSIFIERREMOTESETTINGSCLIENT_CONTRACTID, &rv);
  if (NS_WARN_IF(NS_FAILED(rv))) {
    MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Error,
                "InitRSClient - failed to get RS client service: {:#x}",
                static_cast<uint32_t>(rv));
    return;
  }

  // The returned Promise is ignored: C++ doesn't need to await the
  // initial import. Callers that do (such as tests) observe the
  // NS_CONTENT_CLASSIFIER_FILTER_LISTS_LOADED_TOPIC notification.
  RefPtr<dom::Promise> unused;
  rv = mRSClient->Init(this, getter_AddRefs(unused));
  if (NS_WARN_IF(NS_FAILED(rv))) {
    MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Error,
                "InitRSClient - failed to init RS client: {:#x}",
                static_cast<uint32_t>(rv));
    mRSClient = nullptr;
    return;
  }
}

void ContentClassifierService::ShutdownRSClient() {
  MOZ_ASSERT(NS_IsMainThread());

  MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Info, "ShutdownRSClient");

  if (mRSClient) {
    // Release mRSClient before reacquiring mLock. The JS Shutdown()
    // implementation does not call back into us, but drop the strong
    // reference first to be defensive.
    nsCOMPtr<nsIContentClassifierRemoteSettingsClient> client =
        std::move(mRSClient);
    client->Shutdown();
  }

  MutexAutoLock lock(mLock);
  mEngines.Clear();
  mCancelEngines.Clear();
  mCancelEnginesPBM.Clear();
  mAnnotateEngines.Clear();
  mAnnotateEnginesPBM.Clear();
}

// static
already_AddRefed<ContentClassifierService>
ContentClassifierService::GetInstance() {
  RefPtr<ContentClassifierService> service = GetForAdBlocking();
  if (!service || !IsEnabled()) {
    return nullptr;
  }
  return service.forget();
}

already_AddRefed<ContentClassifierService>
ContentClassifierService::GetForAdBlocking() {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_TRUE(XRE_IsParentProcess(), nullptr);
  if (!sInstance) {
    sInstance = new ContentClassifierService();
    ClearOnShutdown(&sInstance);
    sInstance->Init();
  }

  if (!IsInitialized()) {
    return nullptr;
  }

  return do_AddRef(sInstance);
}

nsresult ContentClassifierService::PublishAdBlockingEngine(
    RefPtr<ContentClassifierEngine> aEngine, uint64_t* aGeneration) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aGeneration);
  NS_ENSURE_TRUE(aEngine, NS_ERROR_INVALID_ARG);
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(mInitPhase == InitPhase::InitSucceeded,
                 NS_ERROR_NOT_AVAILABLE);
  nsresult rv = aEngine->PrepareForPublication();
  NS_ENSURE_SUCCESS(rv, rv);
  if (mAdBlockingEngine.mEngine != aEngine) {
    mAdBlockingEngine.mEngine = std::move(aEngine);
    ++mAdBlockingEngine.mGeneration;
  }
  *aGeneration = mAdBlockingEngine.mGeneration;
  return NS_OK;
}

void ContentClassifierService::UnpublishAdBlockingEngine(
    ContentClassifierEngine* aEngine, uint64_t aGeneration) {
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mLock);
  if (aEngine && mAdBlockingEngine.mEngine == aEngine &&
      mAdBlockingEngine.mGeneration == aGeneration) {
    mAdBlockingEngine.mEngine = nullptr;
    ++mAdBlockingEngine.mGeneration;
  }
}

AdBlockingEngineSnapshot
ContentClassifierService::GetAdBlockingEngineSnapshot() {
  MutexAutoLock lock(mLock);
  return mAdBlockingEngine;
}

nsresult AdBlockingRequestSnapshot::InitFromLoad(nsIURI* aUri,
                                                 nsILoadInfo* aLoadInfo,
                                                 nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG(aUri);
  NS_ENSURE_ARG(aLoadInfo);
  nsresult rv = aUri->GetSpec(mUrl);
  NS_ENSURE_SUCCESS(rv, rv);
  if (NS_FAILED(aUri->GetHost(mHostname))) {
    mHostname.Truncate();
  }
  mSourceHostname.Truncate();
  nsCOMPtr<nsIPrincipal> principal = aLoadInfo->GetLoadingPrincipal();
  if (principal) {
    nsCOMPtr<nsIURI> sourceUri;
    if (NS_SUCCEEDED(principal->GetURI(getter_AddRefs(sourceUri))) &&
        sourceUri) {
      if (NS_FAILED(sourceUri->GetHost(mSourceHostname))) {
        mSourceHostname.Truncate();
      }
    }
  }
  mRequestMethod.Truncate();
  nsCOMPtr<nsIHttpChannel> httpChannel = do_QueryInterface(aChannel);
  if (httpChannel && NS_FAILED(httpChannel->GetRequestMethod(mRequestMethod))) {
    mRequestMethod.Truncate();
  }
  switch (aLoadInfo->GetExternalContentPolicyType()) {
    case ExtContentPolicy::TYPE_DOCUMENT:
      mRequestType.AssignLiteral("document");
      break;
    case ExtContentPolicy::TYPE_SUBDOCUMENT:
      mRequestType.AssignLiteral("subdocument");
      break;
    case ExtContentPolicy::TYPE_STYLESHEET:
      mRequestType.AssignLiteral("stylesheet");
      break;
    case ExtContentPolicy::TYPE_SCRIPT:
      mRequestType.AssignLiteral("script");
      break;
    case ExtContentPolicy::TYPE_IMAGE:
    case ExtContentPolicy::TYPE_IMAGESET:
      mRequestType.AssignLiteral("image");
      break;
    case ExtContentPolicy::TYPE_MEDIA:
      mRequestType.AssignLiteral("media");
      break;
    case ExtContentPolicy::TYPE_FONT:
      mRequestType.AssignLiteral("font");
      break;
    case ExtContentPolicy::TYPE_FETCH:
    case ExtContentPolicy::TYPE_XMLHTTPREQUEST:
      mRequestType.AssignLiteral("xmlhttprequest");
      break;
    case ExtContentPolicy::TYPE_WEBSOCKET:
      mRequestType.AssignLiteral("websocket");
      break;
    case ExtContentPolicy::TYPE_PING:
    case ExtContentPolicy::TYPE_BEACON:
      mRequestType.AssignLiteral("ping");
      break;
    case ExtContentPolicy::TYPE_CSP_REPORT:
      mRequestType.AssignLiteral("csp_report");
      break;
    case ExtContentPolicy::TYPE_OBJECT:
      mRequestType.AssignLiteral("object");
      break;
    default:
      mRequestType.AssignLiteral("other");
      break;
  }
  mThirdParty = true;
  if (aChannel) {
    nsCOMPtr<mozIThirdPartyUtil> thirdPartyUtil =
        components::ThirdPartyUtil::Service();
    if (thirdPartyUtil && NS_FAILED(thirdPartyUtil->IsThirdPartyChannel(
                              aChannel, nullptr, &mThirdParty))) {
      mThirdParty = true;
    }
  } else {
    bool thirdPartyToTop = true;
    bool thirdPartyContext = true;
    if (NS_SUCCEEDED(
            aLoadInfo->GetIsThirdPartyContextToTopWindow(&thirdPartyToTop)) &&
        (thirdPartyToTop || NS_SUCCEEDED(aLoadInfo->GetIsInThirdPartyContext(
                                &thirdPartyContext)))) {
      mThirdParty = thirdPartyToTop || thirdPartyContext;
    }
  }
  return NS_OK;
}

nsresult ContentClassifierService::CaptureAdBlockingRequest(
    AdBlockingRequestSnapshot& aRequest) {
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mLock);
  NS_ENSURE_TRUE(
      mInitPhase == InitPhase::InitSucceeded && mAdBlockingEngine.mEngine,
      NS_ERROR_NOT_AVAILABLE);
  aRequest.mEngine = mAdBlockingEngine;
  aRequest.mPolicyGeneration = mAdPolicyGeneration;
  return NS_OK;
}

bool AdBlockingRequestSnapshot::ShouldBypassHost(const nsACString& aHost,
                                                 bool aIsPrivate) {
  MOZ_ASSERT(NS_IsMainThread());
  nsAutoCString host(aHost);
  if (StringEndsWith(host, "."_ns)) {
    host.Truncate(host.Length() - 1);
  }
  if (host.IsEmpty()) {
    return false;
  }
  nsAutoString permissionHost16 = NS_ConvertUTF8toUTF16(host);
  auto isTrimWhitespace = [](char16_t aChar) {
    return (aChar >= 0x09 && aChar <= 0x0D) || aChar == 0x20 || aChar == 0xA0 ||
           aChar == 0x1680 || (aChar >= 0x2000 && aChar <= 0x200A) ||
           aChar == 0x2028 || aChar == 0x2029 || aChar == 0x202F ||
           aChar == 0x205F || aChar == 0x3000 || aChar == 0xFEFF;
  };
  uint32_t start = 0;
  uint32_t end = permissionHost16.Length();
  while (start < end && isTrimWhitespace(permissionHost16[start])) {
    ++start;
  }
  while (start < end && isTrimWhitespace(permissionHost16[end - 1])) {
    --end;
  }
  nsAutoCString permissionHost =
      NS_ConvertUTF16toUTF8(Substring(permissionHost16, start, end - start));
  ToLowerCase(permissionHost);
  if (StringEndsWith(permissionHost, "."_ns)) {
    permissionHost.Truncate(permissionHost.Length() - 1);
  }
  nsCOMPtr<nsIURI> uri;
  nsresult rv = NS_NewURI(getter_AddRefs(uri), "https://"_ns + permissionHost);
  if (NS_SUCCEEDED(rv)) {
    nsCOMPtr<nsIPrincipal> documentPrincipal =
        BasePrincipal::CreateContentPrincipal(uri, OriginAttributes());
    nsCOMPtr<nsIPrincipal> principal;
    if (documentPrincipal) {
      ContentBlockingAllowList::ComputePrincipal(documentPrincipal,
                                                 getter_AddRefs(principal));
    }
    nsCOMPtr<nsIPermissionManager> permissions =
        services::GetPermissionManager();
    uint32_t permission = nsIPermissionManager::UNKNOWN_ACTION;
    if (principal && permissions &&
        NS_SUCCEEDED(permissions->TestPermissionFromPrincipal(
            principal,
            aIsPrivate ? "waterfox-blocker-pb"_ns : "waterfox-blocker"_ns,
            &permission)) &&
        permission == nsIPermissionManager::ALLOW_ACTION) {
      return true;
    }
  }
  return Preferences::GetBool("waterfox.blocker.allowSearchPartnerAds", true) &&
         (host.EqualsLiteral("qwant.com") ||
          StringEndsWith(host, ".qwant.com"_ns) ||
          host.EqualsLiteral("search.waterfox.com") ||
          StringEndsWith(host, ".search.waterfox.com"_ns));
}

nsresult AdBlockingRequestSnapshot::ResolvePolicy(
    const nsTArray<nsCString>& aBypassHosts,
    const nsTArray<nsCString>& aAllowedDomains) {
  MOZ_ASSERT(NS_IsMainThread());
  constexpr uint32_t contextFlags =
      AdPolicyPrivate | AdPolicyTopLevel | AdPolicyBypass;
  NS_ENSURE_TRUE(!(mPolicyFlags & ~contextFlags), NS_ERROR_INVALID_ARG);
  if (Preferences::GetBool("waterfox.blocker.enabled", true)) {
    mPolicyFlags |= AdPolicyEnabled;
  }
  for (const auto& host : aBypassHosts) {
    if (ShouldBypassHost(host, mPolicyFlags & AdPolicyPrivate)) {
      mPolicyFlags |= AdPolicyBypass;
      break;
    }
  }
  if (!(mPolicyFlags & AdPolicyTopLevel) && !aAllowedDomains.IsEmpty()) {
    nsAutoCString host(mHostname);
    if (StringEndsWith(host, "."_ns)) {
      host.Truncate(host.Length() - 1);
    }
    ToLowerCase(host);
    if (!host.IsEmpty()) {
      nsAutoCString baseDomain;
      nsCOMPtr<nsIEffectiveTLDService> tld =
          components::EffectiveTLD::Service();
      if (!tld || NS_FAILED(tld->GetBaseDomainFromHost(host, 0, baseDomain))) {
        baseDomain = host;
      }
      if (aAllowedDomains.Contains(baseDomain)) {
        mPolicyFlags |= AdPolicyDomainAllowed;
      }
    }
  }
  return NS_OK;
}

void ContentClassifierService::InvalidateAdBlockingPolicy() {
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mLock);
  ++mAdPolicyGeneration;
}

bool ContentClassifierService::IsCurrentAdBlockingRequest(
    const AdBlockingRequestSnapshot& aRequest) {
  MOZ_ASSERT(NS_IsMainThread());
  MutexAutoLock lock(mLock);
  return mInitPhase == InitPhase::InitSucceeded && aRequest.mEngine.mEngine &&
         mAdBlockingEngine.mEngine == aRequest.mEngine.mEngine &&
         mAdBlockingEngine.mGeneration == aRequest.mEngine.mGeneration &&
         mAdPolicyGeneration == aRequest.mPolicyGeneration &&
         (!aRequest.mContextGeneration ||
          mAdPolicy.Generation() == aRequest.mContextGeneration) &&
         (!aRequest.mValidUntil ||
          aRequest.mValidUntil > uint64_t(PR_Now() / PR_USEC_PER_MSEC));
}

nsresult ContentClassifierService::ClassifyAdBlockingRequest(
    const AdBlockingRequestSnapshot& aRequest,
    ContentClassifierDetailedResult& aResult) {
  aResult = ContentClassifierDetailedResult{};
  if (!aRequest.CanMatch()) {
    return NS_OK;
  }
  NS_ENSURE_TRUE(aRequest.mEngine.mEngine, NS_ERROR_NOT_INITIALIZED);
  return aRequest.mEngine.mEngine->CheckNetworkRequestDetailed(
      aRequest.mUrl, aRequest.mSourceHostname, aRequest.mHostname,
      aRequest.mRequestType, aRequest.mRequestMethod, aRequest.mThirdParty,
      aResult);
}

RefPtr<ContentClassifierService::AdClassificationPromise>
ContentClassifierService::ClassifyAdBlockingRequestAsync(
    AdBlockingRequestSnapshot aRequest, uint32_t aTaskPriority) {
  MOZ_ASSERT(NS_IsMainThread());
  RefPtr<AdClassificationPromise::Private> promise =
      new AdClassificationPromise::Private(__func__);
  promise->SetTaskPriority(aTaskPriority, __func__);
  nsCOMPtr<nsISerialEventTarget> queue;
  {
    MutexAutoLock lock(mLock);
    if (mInitPhase != InitPhase::InitSucceeded || !mAdClassificationThread) {
      promise->Reject(NS_ERROR_NOT_AVAILABLE, __func__);
      return promise;
    }
    queue = mAdClassificationThread;
  }
  const TimeStamp queued = TimeStamp::Now();
  nsresult rv = queue->Dispatch(NS_NewRunnableFunction(
      "ContentClassifierService::ClassifyAdBlockingRequestAsync",
      [request = std::move(aRequest), promise, queued] {
        MOZ_ASSERT(!NS_IsMainThread());
        const TimeStamp started = TimeStamp::Now();
        ContentClassifierDetailedResult result;
        nsresult rv = ClassifyAdBlockingRequest(request, result);
        MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
                ("Ad classification url=%s queue_ms=%.3f match_ms=%.3f",
                 request.mUrl.get(), (started - queued).ToMilliseconds(),
                 (TimeStamp::Now() - started).ToMilliseconds()));
        if (NS_FAILED(rv)) {
          promise->Reject(rv, __func__);
        } else {
          promise->Resolve(std::move(result), __func__);
        }
      }));
  if (NS_FAILED(rv)) {
    promise->Reject(rv, __func__);
  }
  return promise;
}

namespace {

uint64_t AdChannelId(nsIChannel* aChannel) {
  nsCOMPtr<nsIIdentChannel> identified = do_QueryInterface(aChannel);
  uint64_t id = 0;
  if (identified) {
    (void)identified->GetChannelId(&id);
  }
  return id;
}

bool ReadAdNumber(nsIPropertyBag2* aProperties, const nsAString& aName,
                  uint64_t* aValue) {
  uint32_t high;
  uint32_t low;
  if (!aProperties ||
      NS_FAILED(aProperties->GetPropertyAsUint32(aName + u".hi"_ns, &high)) ||
      NS_FAILED(aProperties->GetPropertyAsUint32(aName + u".lo"_ns, &low))) {
    return false;
  }
  *aValue = (uint64_t(high) << 32) | low;
  return true;
}

void WriteAdNumber(nsIWritablePropertyBag2* aProperties, const nsAString& aName,
                   uint64_t aValue) {
  (void)aProperties->SetPropertyAsUint32(aName + u".hi"_ns,
                                         uint32_t(aValue >> 32));
  (void)aProperties->SetPropertyAsUint32(aName + u".lo"_ns, uint32_t(aValue));
}

bool AdChannelHasMark(nsIChannel* aChannel, const nsAString& aProperty) {
  nsCOMPtr<nsIPropertyBag2> properties = do_QueryInterface(aChannel);
  uint64_t markedId = 0;
  nsCString markedUrl;
  nsCString markedMethod;
  nsCOMPtr<nsIURI> uri;
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  nsAutoCString method;
  (void)aChannel->GetURI(getter_AddRefs(uri));
  return properties && uri && http &&
         NS_SUCCEEDED(http->GetRequestMethod(method)) &&
         ReadAdNumber(properties, aProperty, &markedId) && markedId &&
         markedId == AdChannelId(aChannel) &&
         NS_SUCCEEDED(properties->GetPropertyAsACString(aProperty + u".url"_ns,
                                                        markedUrl)) &&
         NS_SUCCEEDED(properties->GetPropertyAsACString(
             aProperty + u".method"_ns, markedMethod)) &&
         markedUrl == uri->GetSpecOrDefault() && markedMethod == method;
}

void ClearPendingAdAction(nsIChannel* aChannel) {
  nsCOMPtr<nsIWritablePropertyBag> properties = do_QueryInterface(aChannel);
  if (properties) {
    for (const auto& name : {u"waterfox.adblocking.pendingBlock"_ns,
                             u"waterfox.adblocking.pendingRedirect"_ns,
                             u"waterfox.adblocking.pendingRewrite"_ns}) {
      (void)properties->DeleteProperty(name);
    }
  }
}

void MarkAdChannel(nsIChannel* aChannel, const nsAString& aProperty,
                   const AdBlockingRequestSnapshot* aRequest = nullptr) {
  nsCOMPtr<nsIWritablePropertyBag2> properties = do_QueryInterface(aChannel);
  nsCOMPtr<nsIURI> uri;
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  nsAutoCString method;
  (void)aChannel->GetURI(getter_AddRefs(uri));
  if (!properties || !uri || !http ||
      NS_FAILED(http->GetRequestMethod(method))) {
    return;
  }
  WriteAdNumber(properties, aProperty, AdChannelId(aChannel));
  (void)properties->SetPropertyAsACString(aProperty + u".url"_ns,
                                          uri->GetSpecOrDefault());
  (void)properties->SetPropertyAsACString(aProperty + u".method"_ns, method);
  if (aRequest) {
    for (const auto& field :
         {std::pair{u".engine"_ns, aRequest->mEngine.mGeneration},
          std::pair{u".policy"_ns, aRequest->mPolicyGeneration},
          std::pair{u".context"_ns, aRequest->mContextGeneration},
          std::pair{u".browser"_ns, aRequest->mBrowserId},
          std::pair{u".navigation"_ns, aRequest->mNavigationId},
          std::pair{u".until"_ns, aRequest->mValidUntil},
          std::pair{u".flags"_ns, uint64_t(aRequest->mPolicyFlags)}}) {
      WriteAdNumber(properties, aProperty + field.first, field.second);
    }
  }
}

}  // namespace

uint32_t ContentClassifierService::GetAdBlockingChannelTaskPriority(
    nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());
  if (nsCOMPtr<net::HttpBaseChannel> baseChannel =
          do_QueryInterface(aChannel)) {
    uint32_t classOfServiceFlags = 0;
    baseChannel->GetClassFlags(&classOfServiceFlags);
    if (classOfServiceFlags &
        (nsIClassOfService::Leader | nsIClassOfService::UrgentStart |
         nsIClassOfService::Unblocked)) {
      return nsIRunnablePriority::PRIORITY_MEDIUMHIGH;
    }
  }
  if (nsCOMPtr<nsISupportsPriority> supportsPriority =
          do_QueryInterface(aChannel)) {
    int32_t priority = nsISupportsPriority::PRIORITY_NORMAL;
    supportsPriority->GetPriority(&priority);
    if (priority <= nsISupportsPriority::PRIORITY_HIGH) {
      return nsIRunnablePriority::PRIORITY_MEDIUMHIGH;
    }
  }
  return nsIRunnablePriority::PRIORITY_NORMAL;
}

bool ContentClassifierService::ShouldClassifyAdBlockingChannel(
    nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!sInstance || !sInstance->mAdBridge ||
      !Preferences::GetBool("waterfox.blocker.enabled", true)) {
    return false;
  }
  nsCOMPtr<nsIURI> uri;
  if (!aChannel || NS_FAILED(aChannel->GetURI(getter_AddRefs(uri))) || !uri ||
      (!uri->SchemeIs("http") && !uri->SchemeIs("https"))) {
    return false;
  }
  MutexAutoLock lock(sInstance->mLock);
  return sInstance->mInitPhase == InitPhase::InitSucceeded &&
         sInstance->mAdBlockingEngine.mEngine;
}

bool ContentClassifierService::ShouldSkipAdBlockingChannel(
    nsIChannel* aChannel) {
  MOZ_ASSERT(NS_IsMainThread());
  nsresult status;
  if (!aChannel || NS_FAILED(aChannel->GetStatus(&status)) ||
      NS_FAILED(status)) {
    return true;
  }
  RefPtr<net::nsHttpChannel> channel = do_QueryObject(aChannel);
  return channel && channel->IsURLClassifierCancellationInProgress();
}

void ContentClassifierService::SetAdBlockingBridge(
    nsIContentClassifierAdBlockingBridge* aBridge) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsIObserverService> observers = services::GetObserverService();
  if (observers && bool(mAdBridge) != bool(aBridge)) {
    for (const char* topic :
         {"http-on-modify-request", "http-on-examine-response",
          "http-on-examine-cached-response",
          "http-on-examine-merged-response"}) {
      if (aBridge) {
        observers->AddObserver(this, topic, false);
      } else {
        observers->RemoveObserver(this, topic);
      }
    }
  }
  mAdBridge = aBridge;
  InvalidateAdBlockingPolicy();
}

nsresult ContentClassifierService::CaptureAdBlockingLoad(
    AdBlockingRequestSnapshot& aRequest, nsIURI* aUri, nsILoadInfo* aLoadInfo,
    nsIChannel* aChannel, AdBlockingPhase aPhase, bool aDiscoverNavigation) {
  MOZ_ASSERT(NS_IsMainThread());
  nsresult rv = mAdPolicy.Capture(aRequest, aUri, aLoadInfo, aChannel, aPhase,
                                  aDiscoverNavigation);
  NS_ENSURE_SUCCESS(rv, rv);
  return CaptureAdBlockingRequest(aRequest);
}

void ContentClassifierService::NotifyAdBlockingAction(
    const AdBlockingRequestSnapshot& aRequest) {
  MOZ_ASSERT(NS_IsMainThread());
  if (mAdBridge && aRequest.mBrowserId) {
    (void)mAdBridge->OnAdBlockingAction(
        aRequest.mBrowserId, aRequest.mHostname, aRequest.mRequestType,
        aRequest.mPolicyFlags & AdPolicyPrivate,
        aRequest.mPolicyFlags & AdPolicyTopLevel);
  }
}

void ContentClassifierService::ApplyAdBlockingChannel(
    nsIChannel* aChannel, const AdBlockingRequestSnapshot& aRequest,
    const ContentClassifierDetailedResult& aResult, bool aAtModify) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  if (!ShouldClassifyAdBlockingChannel(aChannel) ||
      ShouldSkipAdBlockingChannel(aChannel) ||
      !IsCurrentAdBlockingRequest(aRequest) ||
      !AdBlockingPolicy::IsCurrentContext(aRequest, loadInfo, aChannel) ||
      AdChannelHasMark(aChannel, u"waterfox.adblocking.appliedChannelId"_ns)) {
    return;
  }
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(aChannel);
  if (!http) {
    return;
  }
  auto mark = MakeScopeExit([&] {
    auto marked = aRequest;
    marked.mContextGeneration = mAdPolicy.Generation();
    MarkAdChannel(aChannel, u"waterfox.adblocking.classifiedChannelId"_ns,
                  &marked);
  });
  ClearPendingAdAction(aChannel);
  const bool topLevel = aRequest.mPolicyFlags & AdPolicyTopLevel;
  if (!aRequest.CanMatch()) {
    if (topLevel) {
      if (AdBlockingRequestSnapshot::ShouldBypassHost(
              aRequest.mHostname, aRequest.mPolicyFlags & AdPolicyPrivate)) {
        mAdPolicy.RememberTopHost(aRequest.mBrowserId, aRequest.mHostname);
      }
      mAdPolicy.ForgetBlockedDocument(aRequest.mBrowserId);
    }
    return;
  }
  const bool blocking = aResult.mMatched && aResult.mException.IsEmpty();
  if (!aAtModify && ((blocking && aRequest.CanBlock() &&
                      (topLevel || !aResult.mRedirect.IsEmpty())) ||
                     (!topLevel && !blocking && aResult.mException.IsEmpty() &&
                      !aResult.mRewrittenUrl.IsEmpty() &&
                      aResult.mRewrittenUrl != aRequest.mUrl))) {
    nsCOMPtr<nsIWritablePropertyBag2> properties = do_QueryInterface(aChannel);
    if (properties) {
      (void)properties->SetPropertyAsBool(
          u"waterfox.adblocking.pendingBlock"_ns, blocking);
      (void)properties->SetPropertyAsACString(
          u"waterfox.adblocking.pendingRedirect"_ns, aResult.mRedirect);
      (void)properties->SetPropertyAsACString(
          u"waterfox.adblocking.pendingRewrite"_ns, aResult.mRewrittenUrl);
    }
    return;
  }
  if (topLevel && !blocking) {
    mAdPolicy.RememberTopHost(aRequest.mBrowserId, aRequest.mHostname);
    mAdPolicy.ForgetBlockedDocument(aRequest.mBrowserId);
    return;
  }
  nsresult rv = NS_ERROR_FAILURE;
  if (blocking && aRequest.CanBlock()) {
    nsCString target;
    if (topLevel) {
      size_t escapedLength;
      char* escaped = nsEscape(aRequest.mUrl.get(), aRequest.mUrl.Length(),
                               &escapedLength, url_XPAlphas);
      if (escaped) {
        target = "about:contentblocked?url="_ns;
        target.Append(escaped, escapedLength);
        free(escaped);
      }
    } else {
      target = aResult.mRedirect;
    }
    nsCOMPtr<nsIURI> uri;
    if (!target.IsEmpty() &&
        NS_SUCCEEDED(NS_NewURI(getter_AddRefs(uri), target))) {
      rv = http->RedirectTo(uri);
      if (NS_SUCCEEDED(rv) && !topLevel && uri->SchemeIs("data")) {
        loadInfo->SetAllowInsecureRedirectToDataURI(true);
      }
      if (NS_SUCCEEDED(rv) && topLevel) {
        mAdPolicy.RememberBlockedDocument(aRequest.mBrowserId,
                                          aRequest.mHostname, aRequest.mUrl);
      }
    }
    if (NS_FAILED(rv)) {
      rv = aChannel->Cancel(NS_ERROR_ABORT);
    }
    if (NS_SUCCEEDED(rv)) {
      MarkAdChannel(aChannel, u"waterfox.adblocking.appliedChannelId"_ns);
      NotifyAdBlockingAction(aRequest);
    }
  } else if (!topLevel && !blocking && aResult.mException.IsEmpty() &&
             !aResult.mRewrittenUrl.IsEmpty() &&
             aResult.mRewrittenUrl != aRequest.mUrl) {
    nsCOMPtr<nsIURI> uri;
    if (NS_SUCCEEDED(NS_NewURI(getter_AddRefs(uri), aResult.mRewrittenUrl))) {
      RefPtr<net::nsHttpChannel> native = do_QueryObject(http);
      if (native && NS_SUCCEEDED(native->RedirectForContentClassifier(uri))) {
        MarkAdChannel(aChannel, u"waterfox.adblocking.appliedChannelId"_ns);
      }
    }
  }
}

nsresult ContentClassifierService::CheckAdBlockingChannel(
    nsIChannel* aChannel, std::function<void()> aCallback) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_TRUE(aCallback, NS_ERROR_INVALID_ARG);
  NS_ENSURE_TRUE(ShouldClassifyAdBlockingChannel(aChannel),
                 NS_ERROR_NOT_AVAILABLE);
  if (ShouldSkipAdBlockingChannel(aChannel)) {
    aCallback();
    return NS_OK;
  }
  nsCOMPtr<nsIURI> uri;
  nsresult rv = aChannel->GetURI(getter_AddRefs(uri));
  NS_ENSURE_SUCCESS(rv, rv);
  AdBlockingRequestSnapshot request;
  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  rv = CaptureAdBlockingLoad(request, uri, loadInfo, aChannel,
                             AdBlockingPhase::Request);
  NS_ENSURE_SUCCESS(rv, rv);
  CheckAdBlockingChannelWithSnapshot(aChannel, std::move(request),
                                     std::move(aCallback), 0);
  return NS_OK;
}

void ContentClassifierService::CheckAdBlockingChannelWithSnapshot(
    nsIChannel* aChannel, AdBlockingRequestSnapshot aRequest,
    std::function<void()> aCallback, uint32_t aRetries) {
  MOZ_ASSERT(NS_IsMainThread());
  ClassifyAdBlockingRequestAsync(aRequest,
                                 GetAdBlockingChannelTaskPriority(aChannel))
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [self = RefPtr{this},
           channel = nsMainThreadPtrHandle<nsIChannel>(
               new nsMainThreadPtrHolder<nsIChannel>("AdBlockingChannel",
                                                     aChannel)),
           request = std::move(aRequest), callback = std::move(aCallback),
           aRetries](
              AdClassificationPromise::ResolveOrRejectValue&& aValue) mutable {
            MOZ_ASSERT(NS_IsMainThread());
            MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
                    ("Ad continuation url=%s retries=%u resolved=%d",
                     request.mUrl.get(), aRetries, aValue.IsResolve()));
            nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
            if (ShouldSkipAdBlockingChannel(channel)) {
              callback();
              return;
            }
            // Refresh inputs, never the owning top-level navigation.
            if (!AdBlockingPolicy::IsCurrentContext(request, loadInfo,
                                                    nullptr)) {
              (void)channel->Cancel(NS_BINDING_ABORTED);
              callback();
              return;
            }
            if (aValue.IsResolve() &&
                self->IsCurrentAdBlockingRequest(request) &&
                AdBlockingPolicy::IsCurrentContext(request, loadInfo,
                                                   channel)) {
              self->ApplyAdBlockingChannel(channel, request,
                                           aValue.ResolveValue());
            } else if (ShouldClassifyAdBlockingChannel(channel)) {
              nsCOMPtr<nsIURI> uri;
              (void)channel->GetURI(getter_AddRefs(uri));
              AdBlockingRequestSnapshot fresh;
              if (NS_SUCCEEDED(self->CaptureAdBlockingLoad(
                      fresh, uri, loadInfo, channel, AdBlockingPhase::Request,
                      false))) {
                if (aRetries < 3 && aValue.IsResolve()) {
                  self->CheckAdBlockingChannelWithSnapshot(
                      channel, std::move(fresh), std::move(callback),
                      aRetries + 1);
                  return;
                }
                MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
                        ("Ad synchronous fallback url=%s retries=%u",
                         fresh.mUrl.get(), aRetries));
                ContentClassifierDetailedResult result;
                if (NS_SUCCEEDED(ClassifyAdBlockingRequest(fresh, result))) {
                  self->ApplyAdBlockingChannel(channel, fresh, result);
                }
              }
            }
            callback();
          });
}

nsresult ContentClassifierService::CheckAdBlockingLoad(nsIURI* aUri,
                                                       nsILoadInfo* aLoadInfo,
                                                       int16_t* aDecision) {
  MOZ_ASSERT(NS_IsMainThread());
  NS_ENSURE_ARG_POINTER(aDecision);
  *aDecision = nsIContentPolicy::ACCEPT;
  NS_ENSURE_TRUE(mAdBridge, NS_ERROR_NOT_AVAILABLE);
  AdBlockingRequestSnapshot request;
  nsresult rv = CaptureAdBlockingLoad(request, aUri, aLoadInfo, nullptr,
                                      AdBlockingPhase::CachedLoad);
  NS_ENSURE_SUCCESS(rv, rv);
  ContentClassifierDetailedResult result;
  rv = ClassifyAdBlockingRequest(request, result);
  NS_ENSURE_SUCCESS(rv, rv);
  if (request.CanBlock() && result.mMatched && result.mException.IsEmpty() &&
      IsCurrentAdBlockingRequest(request) &&
      AdBlockingPolicy::IsCurrentContext(request, aLoadInfo, nullptr)) {
    *aDecision = nsIContentPolicy::REJECT_TYPE;
    if (aLoadInfo->GetRequestBlockingReason() !=
        nsILoadInfo::BLOCKING_REASON_CONTENT_POLICY_CONTENT_BLOCKED) {
      aLoadInfo->SetRequestBlockingReason(
          nsILoadInfo::BLOCKING_REASON_CONTENT_POLICY_CONTENT_BLOCKED);
      NotifyAdBlockingAction(request);
    }
  }
  return NS_OK;
}

NS_IMETHODIMP ContentClassifierService::Observe(nsISupports* aSubject,
                                                const char* aTopic,
                                                const char16_t*) {
  MOZ_ASSERT(NS_IsMainThread());
  nsCOMPtr<nsIChannel> channel = do_QueryInterface(aSubject);
  if (!channel || !ShouldClassifyAdBlockingChannel(channel)) {
    return NS_OK;
  }
  if (!strcmp(aTopic, "http-on-modify-request")) {
    if (ShouldSkipAdBlockingChannel(channel) ||
        AdChannelHasMark(channel, u"waterfox.adblocking.appliedChannelId"_ns)) {
      return NS_OK;
    }
    bool classified = AdChannelHasMark(
        channel, u"waterfox.adblocking.classifiedChannelId"_ns);
    if (classified) {
      AdBlockingRequestSnapshot marked;
      marked.mEngine = GetAdBlockingEngineSnapshot();
      nsCOMPtr<nsIPropertyBag2> properties = do_QueryInterface(channel);
      uint64_t engineGeneration = 0;
      uint64_t flags = 0;
      bool valid =
          properties &&
          ReadAdNumber(properties,
                       u"waterfox.adblocking.classifiedChannelId.engine"_ns,
                       &engineGeneration);
      for (const auto& field :
           {std::pair{u".policy"_ns, &marked.mPolicyGeneration},
            std::pair{u".context"_ns, &marked.mContextGeneration},
            std::pair{u".browser"_ns, &marked.mBrowserId},
            std::pair{u".navigation"_ns, &marked.mNavigationId},
            std::pair{u".until"_ns, &marked.mValidUntil},
            std::pair{u".flags"_ns, &flags}}) {
        valid = valid &&
                ReadAdNumber(
                    properties,
                    u"waterfox.adblocking.classifiedChannelId"_ns + field.first,
                    field.second);
      }
      marked.mPolicyFlags = uint32_t(flags);
      nsCOMPtr<nsIURI> markedUri;
      (void)channel->GetURI(getter_AddRefs(markedUri));
      marked.mUrl = markedUri->GetSpecOrDefault();
      nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(channel);
      (void)http->GetRequestMethod(marked.mRequestMethod);
      nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
      if (valid && engineGeneration == marked.mEngine.mGeneration &&
          IsCurrentAdBlockingRequest(marked) &&
          AdBlockingPolicy::IsCurrentContext(marked, loadInfo, channel)) {
        bool pendingBlock = false;
        ContentClassifierDetailedResult pending;
        bool hasPending = NS_SUCCEEDED(properties->GetPropertyAsBool(
            u"waterfox.adblocking.pendingBlock"_ns, &pendingBlock));
        if (hasPending) {
          pending.mMatched = pendingBlock;
          (void)properties->GetPropertyAsACString(
              u"waterfox.adblocking.pendingRedirect"_ns, pending.mRedirect);
          (void)properties->GetPropertyAsACString(
              u"waterfox.adblocking.pendingRewrite"_ns, pending.mRewrittenUrl);
          AdBlockingRequestSnapshot fresh;
          if (NS_SUCCEEDED(
                  CaptureAdBlockingLoad(fresh, markedUri, loadInfo, channel,
                                        AdBlockingPhase::Request, false)) &&
              fresh.mEngine.mGeneration == marked.mEngine.mGeneration &&
              fresh.mPolicyGeneration == marked.mPolicyGeneration &&
              fresh.mContextGeneration == marked.mContextGeneration) {
            ApplyAdBlockingChannel(channel, fresh, pending, true);
            return NS_OK;
          }
        } else {
          return NS_OK;
        }
      }
    }
    ClearPendingAdAction(channel);
    nsCOMPtr<nsIURI> uri;
    (void)channel->GetURI(getter_AddRefs(uri));
    nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
    AdBlockingRequestSnapshot fresh;
    ContentClassifierDetailedResult result;
    if (NS_SUCCEEDED(CaptureAdBlockingLoad(fresh, uri, loadInfo, channel,
                                           AdBlockingPhase::Request,
                                           !classified)) &&
        NS_SUCCEEDED(ClassifyAdBlockingRequest(fresh, result))) {
      ApplyAdBlockingChannel(channel, fresh, result, true);
    }
    return NS_OK;
  }
  nsCOMPtr<nsIHttpChannel> http = do_QueryInterface(channel);
  RefPtr<net::nsHttpChannel> native = do_QueryObject(channel);
  uint32_t responseStatus = 0;
  if (!http || NS_FAILED(http->GetResponseStatus(&responseStatus)) ||
      (!strcmp(aTopic, "http-on-examine-response") &&
       (responseStatus == 304 ||
        (responseStatus == 206 && native &&
         native->WillMergeContentClassifierResponse()))) ||
      AdChannelHasMark(channel, u"waterfox.adblocking.responseChannelId"_ns)) {
    return NS_OK;
  }
  nsCOMPtr<nsIURI> uri;
  (void)channel->GetURI(getter_AddRefs(uri));
  AdBlockingRequestSnapshot request;
  nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
  if (NS_FAILED(CaptureAdBlockingLoad(request, uri, loadInfo, channel,
                                      AdBlockingPhase::Response))) {
    return NS_OK;
  }
  MarkAdChannel(channel, u"waterfox.adblocking.responseChannelId"_ns);
  if (request.CanMatch()) {
    nsAutoCString directives;
    if ((request.mRequestType.EqualsLiteral("document") ||
         request.mRequestType.EqualsLiteral("subdocument")) &&
        NS_FAILED(request.mEngine.mEngine->GetCspDirectives(
            request.mUrl, request.mSourceHostname, request.mHostname,
            request.mRequestType, request.mRequestMethod, request.mThirdParty,
            directives))) {
      directives.Truncate();
    }
    nsAutoCString resources("{}"_ns);
    nsAutoCString replace("[]"_ns);
    if (request.mRequestType.EqualsLiteral("document") ||
        request.mRequestType.EqualsLiteral("subdocument")) {
      (void)request.mEngine.mEngine->GetCosmeticResources(request.mUrl,
                                                          resources);
    }
    (void)request.mEngine.mEngine->GetReplaceDirectives(
        request.mUrl, request.mSourceHostname, request.mHostname,
        request.mRequestType, request.mRequestMethod, request.mThirdParty,
        replace);
    if (mAdBridge && IsCurrentAdBlockingRequest(request)) {
      (void)mAdBridge->FilterAdBlockingResponse(
          channel, request.mUrl, request.mRequestType, resources, replace);
    }
    if (!directives.IsEmpty() && IsCurrentAdBlockingRequest(request)) {
      if (native) {
        (void)native->SetContentClassifierCsp(directives);
      }
    }
  }
  mAdPolicy.FinishResponse(channel, request);
  return NS_OK;
}

already_AddRefed<nsIAsyncShutdownClient>
ContentClassifierService::GetAsyncShutdownBarrier() const {
  nsCOMPtr<nsIAsyncShutdownService> svc = components::AsyncShutdown::Service();
  MOZ_RELEASE_ASSERT(svc);

  nsCOMPtr<nsIAsyncShutdownClient> client;
  nsresult rv = svc->GetProfileBeforeChange(getter_AddRefs(client));
  MOZ_RELEASE_ASSERT(NS_SUCCEEDED(rv));
  MOZ_RELEASE_ASSERT(client);

  return client.forget();
}

NS_IMETHODIMP ContentClassifierService::BlockShutdown(
    nsIAsyncShutdownClient* aClient) {
  MOZ_ASSERT(NS_IsMainThread());
  {
    MutexAutoLock lock(mLock);
    if (mInitPhase == InitPhase::ShutdownStarted ||
        mInitPhase == InitPhase::ShutdownEnded) {
      return NS_OK;
    }
    mInitPhase = InitPhase::ShutdownStarted;
  }

  MOZ_LOG(gContentClassifierLog, LogLevel::Info,
          ("ContentClassifierService::BlockShutdown - shutting down"));

  // ShutdownRSClient clears the filter list data and engines. It also
  // tears down the RS client if one was created (the HTTP-only test
  // path leaves mRSClient null).
  ShutdownRSClient();
  SetAdBlockingBridge(nullptr);
  mAdPolicy.Clear();

  nsCOMPtr<nsISerialEventTarget> buildThread;
  nsCOMPtr<nsISerialEventTarget> classificationThread;
  {
    MutexAutoLock lock(mLock);

    mInitPhase = InitPhase::ShutdownStarted;
    mAdBlockingEngine.mEngine = nullptr;
    ++mAdBlockingEngine.mGeneration;
    // Clearing mBuildThread closes the dispatch window for any
    // subsequent UpdateFeatures call. In-flight closures on the queue
    // are gated by the mInitPhase check above before they touch state.
    buildThread = std::move(mBuildThread);
    classificationThread = std::move(mAdClassificationThread);

    for (const auto& pref : kObservedPrefs) {
      Preferences::UnregisterCallback(&ContentClassifierService::OnPrefChange,
                                      pref);
    }

    mPendingShutdownQueues =
        uint32_t(bool(buildThread)) + uint32_t(bool(classificationThread));
    if (!mPendingShutdownQueues) {
      RemoveBlocker();
      return NS_OK;
    }
  }

  RefPtr<ContentClassifierService> self = this;
  for (const auto& queue : {buildThread, classificationThread}) {
    if (!queue) {
      continue;
    }
    nsresult rv = queue->Dispatch(NS_NewRunnableFunction(
        "ContentClassifierService::ShutdownFence", [self] {
          NS_DispatchToMainThread(NS_NewRunnableFunction(
              "ContentClassifierService::FinishShutdown", [self] {
                MutexAutoLock lock(self->mLock);
                if (!--self->mPendingShutdownQueues) {
                  self->RemoveBlocker();
                }
              }));
        }));
    MOZ_RELEASE_ASSERT(NS_SUCCEEDED(rv));
  }

  return NS_OK;
}

void ContentClassifierService::RemoveBlocker() {
  MOZ_ASSERT(NS_IsMainThread());
  mLock.AssertCurrentThreadOwns();
  nsCOMPtr<nsIAsyncShutdownClient> asc = GetAsyncShutdownBarrier();
  MOZ_ASSERT(asc);
  DebugOnly<nsresult> rv = asc->RemoveBlocker(this);
  MOZ_ASSERT(NS_SUCCEEDED(rv));
  mInitPhase = InitPhase::ShutdownEnded;
}

// Fold a single per-engine outcome into the aggregate. All matched engine
// results are appended so callers can attribute per-feature annotations,
// but the aggregate Status is promoted monotonically: a later
// non-Important Hit cannot demote an earlier Exception, and Important
// pins the status.
void ContentClassifierResult::Accumulate(
    ContentClassifierEngineResult aEngineResult) {
  Status engineStatus = Status::Miss;
  if (aEngineResult.Exception()) {
    engineStatus = aEngineResult.Important() ? Status::ImportantException
                                             : Status::Exception;
  } else if (aEngineResult.Matched()) {
    engineStatus =
        aEngineResult.Important() ? Status::ImportantHit : Status::Hit;
  }

  if (engineStatus > mStatus) {
    mStatus = engineStatus;
  }
  mEngineResults.AppendElement(std::move(aEngineResult));
}

ContentClassifierResult ContentClassifierService::ClassifyWithEngines(
    const nsTArray<RefPtr<ContentClassifierEngine>>& aEngines,
    const ContentClassifierRequest& aRequest, bool aIndependentEngines) {
  MOZ_ASSERT(!NS_IsMainThread());
  mLock.AssertCurrentThreadOwns();
  ContentClassifierResult result;
  if (mInitPhase != InitPhase::InitSucceeded) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Warning,
            ("ClassifyWithEngines - service not initialized; returning Miss"));
    return result;
  }
  if (!aRequest.Valid()) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Warning,
            ("ClassifyWithEngines - invalid request; returning Miss"));
    return result;
  }
  // ETP excludes first-party requests; the shared engine also serves ad rules.
  if (!aRequest.ThirdParty()) {
    return result;
  }
  bool matchedSoFar = false;
  for (const auto& engine : aEngines) {
    ContentClassifierEngineResult er = engine->CheckNetworkRequest(
        aRequest, aIndependentEngines ? false : matchedSoFar);
    result.Accumulate(er);
    const auto status = result.GetStatus();
    if (!aIndependentEngines &&
        (status == ContentClassifierResult::Status::ImportantException ||
         status == ContentClassifierResult::Status::ImportantHit)) {
      break;
    }
    if (er.Matched() && !er.Exception()) {
      matchedSoFar = true;
    }
  }
  return result;
}

NS_IMETHODIMP ContentClassifierService::GetName(nsAString& aName) {
  aName.AssignLiteral("ContentClassifierService: Shutting down");
  return NS_OK;
}

NS_IMETHODIMP ContentClassifierService::GetState(nsIPropertyBag** aState) {
  NS_ENSURE_ARG_POINTER(aState);
  RefPtr<nsHashPropertyBag> state = new nsHashPropertyBag();
  {
    MutexAutoLock lock(mLock);
    state->SetPropertyAsUint32(u"phase"_ns, uint32_t(mInitPhase));
    state->SetPropertyAsUint32(u"pendingQueues"_ns, mPendingShutdownQueues);
  }
  nsCOMPtr<nsIPropertyBag> bag =
      static_cast<nsIWritablePropertyBag*>(state.get());
  bag.forget(aState);
  return NS_OK;
}

ContentClassifierResult ContentClassifierService::ClassifyForAnnotate(
    const ContentClassifierRequest& aRequest) {
  MutexAutoLock lock(mLock);
  const nsTArray<RefPtr<ContentClassifierEngine>>& engines =
      aRequest.PrivateBrowsing() ? mAnnotateEnginesPBM : mAnnotateEngines;
  ContentClassifierResult result =
      ClassifyWithEngines(engines, aRequest, /* aIndependentEngines */ true);
  MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
          ("ClassifyForAnnotate - url=%s hit=%d exception=%d",
           aRequest.Url().get(), result.Hit(), result.Exception()));
  return result;
}

ContentClassifierResult ContentClassifierService::ClassifyForCancel(
    const ContentClassifierRequest& aRequest) {
  MutexAutoLock lock(mLock);
  const nsTArray<RefPtr<ContentClassifierEngine>>& engines =
      aRequest.PrivateBrowsing() ? mCancelEnginesPBM : mCancelEngines;
  // Cancel mode threads matchedSoFar across engines so trailing exception
  // engines can suppress an earlier hit, but ClassifyWithEngines bails out
  // as soon as the aggregated status reaches ImportantHit / ImportantException
  // because either pins the outcome.
  ContentClassifierResult result =
      ClassifyWithEngines(engines, aRequest, /* aIndependentEngines */ false);
  MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
          ("ClassifyForCancel - url=%s hit=%d exception=%d",
           aRequest.Url().get(), result.Hit(), result.Exception()));
  return result;
}

void ContentClassifierService::MaybeAnnotateChannel(
    nsIChannel* aChannel, const ContentClassifierResult& aResult) {
  NS_ENSURE_TRUE_VOID(aChannel);
  if (!aResult.Hit()) {
    return;
  }

  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));

  for (const auto& engineResult : aResult.EngineResults()) {
    if (!engineResult.Matched() || engineResult.Exception()) {
      continue;
    }
    const ContentClassifierFeature& feature = engineResult.Feature();
    if (feature.mLoadedState == 0) {
      continue;
    }
    if (uri) {
      MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Debug,
                  "MaybeAnnotateChannel - url={} feature={}",
                  uri->GetSpecOrDefault(), feature.mName);
    }
    net::ChannelClassifierUtils::AnnotateChannel(
        aChannel, feature.mClassificationFlag, feature.mLoadedState);
  }
}

net::ChannelBlockDecision ContentClassifierService::MaybeCancelChannel(
    nsIChannel* aChannel, const ContentClassifierResult& aResult) {
  NS_ENSURE_TRUE(aChannel, net::ChannelBlockDecision::Allowed);
  if (!aResult.Hit()) {
    return net::ChannelBlockDecision::Allowed;
  }

  // Closest analogue to the URLClassifier's "first cancelling feature
  // wins" rule. Classification itself keeps evaluating all engines (so
  // exception rules can suppress a Hit), but at decision time we pick
  // the first matched feature whose definition carries a non-NS_OK
  // blocking error code. Iteration order is the order in
  // ClassifyWithEngines, which is the order of the engines pref.
  const ContentClassifierFeature* blockingFeature = nullptr;
  for (const auto& engineResult : aResult.EngineResults()) {
    if (!engineResult.Matched() || engineResult.Exception()) {
      continue;
    }
    const ContentClassifierFeature& feature = engineResult.Feature();
    if (feature.mBlockingErrorCode != NS_OK) {
      blockingFeature = &feature;
      break;
    }
  }
  if (!blockingFeature) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Warning,
            ("MaybeCancelChannel - no matched feature carries a blocking error "
             "code; nothing to cancel"));
    return net::ChannelBlockDecision::Allowed;
  }

  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));
  if (uri) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
            ("MaybeCancelChannel - url=%s", uri->GetSpecOrDefault().get()));
  }

  if (net::ChannelClassifierUtils::IsAllowListed(aChannel)) {
    return net::ChannelBlockDecision::Allowed;
  }

  net::ChannelBlockDecision decision = net::ChannelBlockDecision::Allowed;
  net::ChannelClassifierUtils::MaybeBlockChannel(
      aChannel, "content-classifier"_ns, "content-classifier-block"_ns,
      blockingFeature->mBlockingErrorCode, blockingFeature->mReplacedState,
      blockingFeature->mAllowedState, &decision);
  return decision;
}

// nsIContentClassifierService

NS_IMETHODIMP ContentClassifierService::OnListsChanged(
    const nsTArray<nsCString>& aUpdated, const nsTArray<nsCString>& aRemoved) {
  MOZ_ASSERT(NS_IsMainThread());

  MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Debug,
              "OnListsChanged - updated={} removed={}", aUpdated.Length(),
              aRemoved.Length());

  {
    MutexAutoLock lock(mLock);
    if (mInitPhase != InitPhase::InitSucceeded) {
      return NS_ERROR_NOT_INITIALIZED;
    }
  }
  ProcessListChanges(aUpdated, aRemoved);
  return NS_OK;
}

NS_IMETHODIMP ContentClassifierService::GetFeatureNames(
    nsTArray<nsCString>& aNames) {
  aNames.Clear();
  for (const auto& feature : GetFeatures()) {
    aNames.AppendElement(feature.mName);
  }
  return NS_OK;
}

// Parses a byte buffer of adblock-format filter list text into rules.
// Tolerates both LF and CRLF line endings; skips empty lines.
static void ParseFilterListRules(const nsTArray<uint8_t>& aData,
                                 nsTArray<nsCString>& aRules) {
  nsDependentCSubstring content(reinterpret_cast<const char*>(aData.Elements()),
                                aData.Length());
  for (const auto& line : content.Split('\n')) {
    nsCString rule(line);
    // Trim trailing CR for CRLF line endings.
    if (!rule.IsEmpty() && rule.Last() == '\r') {
      rule.Truncate(rule.Length() - 1);
    }
    if (!rule.IsEmpty()) {
      aRules.AppendElement(std::move(rule));
    }
  }
}

// MozPromise resolved with the parsed rules for one feature's list IDs,
// rejected with the first nsresult error we encountered. Used to fan in
// the per-list getListBytes calls before building the engine.
using ListBytesPromise = MozPromise<nsTArray<uint8_t>, nsresult,
                                    /* IsExclusive = */ true>;

// Convert the JS Promise returned by getListBytes into a MozPromise
// resolved with the raw bytes (Uint8Array contents).
static RefPtr<ListBytesPromise> FetchListBytesFromRemoteSettings(
    nsIContentClassifierRemoteSettingsClient* aClient,
    const nsACString& aName) {
  MOZ_ASSERT(NS_IsMainThread());

  RefPtr<dom::Promise> jsPromise;
  nsresult rv = aClient->GetListBytes(aName, getter_AddRefs(jsPromise));
  if (NS_FAILED(rv) || !jsPromise) {
    return ListBytesPromise::CreateAndReject(
        NS_FAILED(rv) ? rv : NS_ERROR_FAILURE, __func__);
  }

  RefPtr<ListBytesPromise::Private> result =
      new ListBytesPromise::Private(__func__);
  jsPromise->AddCallbacksWithCycleCollectedArgs(
      [result](JSContext* aCx, JS::Handle<JS::Value> aValue, ErrorResult&) {
        if (!aValue.isObject()) {
          result->Reject(NS_ERROR_FAILURE, __func__);
          return;
        }
        JS::Rooted<JSObject*> jsObj(aCx, &aValue.toObject());
        dom::Uint8Array arr;
        if (!arr.Init(jsObj)) {
          result->Reject(NS_ERROR_FAILURE, __func__);
          return;
        }
        nsTArray<uint8_t> bytes;
        if (!arr.AppendDataTo(bytes)) {
          result->Reject(NS_ERROR_OUT_OF_MEMORY, __func__);
          return;
        }
        result->Resolve(std::move(bytes), __func__);
      },
      [result](JSContext*, JS::Handle<JS::Value>, ErrorResult&) {
        result->Reject(NS_ERROR_FAILURE, __func__);
      });
  return result;
}

nsresult BuildEngineFromRules(const ContentClassifierFeature& aFeature,
                              const nsTArray<nsCString>& aRules,
                              RefPtr<ContentClassifierEngine>& aEngineOutput) {
  if (aRules.IsEmpty()) {
    MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Info,
                "BuildEngineFromRules - no rules for feature \"{}\"; ",
                aFeature.mName);
    aEngineOutput = nullptr;
    return NS_OK;
  }
  aEngineOutput = new ContentClassifierEngine(aFeature);
  nsresult rv = aEngineOutput->InitFromRules(aRules);
  if (NS_FAILED(rv)) {
    MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Warning,
                "BuildEngineFromRules - InitFromRules failed for feature "
                "\"{}\": {:#x}",
                aFeature.mName, static_cast<uint32_t>(rv));
    aEngineOutput = nullptr;
  }
  return rv;
}

nsresult ContentClassifierService::InstallEngine(
    const nsACString& aFeatureName, RefPtr<ContentClassifierEngine>&& aEngine) {
  mLock.AssertCurrentThreadOwns();
  if (!aEngine) {
    mEngines.Remove(nsCString(aFeatureName));
  } else {
    MOZ_ASSERT(aEngine->Feature().mName.Equals(aFeatureName));
    mEngines.InsertOrUpdate(nsCString(aFeatureName), std::move(aEngine));
  }
  return NS_OK;
}

void ContentClassifierService::PopulateAllActiveEnginesFromPreferenceSnapshot(
    const EnginesPrefsSnapshot& aPreferenceSnapshot) {
  mLock.AssertCurrentThreadOwns();
  PopulateActiveEngineListFromFeatureNames(aPreferenceSnapshot.mCancel,
                                           mCancelEngines);
  PopulateActiveEngineListFromFeatureNames(aPreferenceSnapshot.mCancelPBM,
                                           mCancelEnginesPBM);
  PopulateActiveEngineListFromFeatureNames(aPreferenceSnapshot.mAnnotate,
                                           mAnnotateEngines);
  PopulateActiveEngineListFromFeatureNames(aPreferenceSnapshot.mAnnotatePBM,
                                           mAnnotateEnginesPBM);
}

void ContentClassifierService::PopulateActiveEngineListFromFeatureNames(
    const nsTArray<nsCString>& aFeatureNames,
    nsTArray<RefPtr<ContentClassifierEngine>>& aEngineList) {
  mLock.AssertCurrentThreadOwns();
  aEngineList.Clear();
  bool sawExceptionOnly = false;
  for (const auto& name : aFeatureNames) {
    auto entry = mEngines.Lookup(name);
    if (entry) {
      RefPtr<ContentClassifierEngine> engine = entry.Data();
      MOZ_ASSERT(engine);
      if (sawExceptionOnly && !engine->Feature().mExceptionOnly) {
        MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Warning,
                    "PopulateActiveEngineListFromFeatureNames - pref lists "
                    "non-exception feature \"{}\" after an exception-only "
                    "feature; matched_rule state will not reach it",
                    name);
      }
      if (engine->Feature().mExceptionOnly) {
        sawExceptionOnly = true;
      }
      aEngineList.AppendElement(engine);
    }
  }
}

nsTHashSet<nsCString> ContentClassifierService::ActiveFeatureNames(
    const EnginesPrefsSnapshot& aPreferenceSnapshot) {
  nsTHashSet<nsCString> names;
  for (const auto& name : aPreferenceSnapshot.mCancel) {
    names.Insert(name);
  }
  for (const auto& name : aPreferenceSnapshot.mCancelPBM) {
    names.Insert(name);
  }
  for (const auto& name : aPreferenceSnapshot.mAnnotate) {
    names.Insert(name);
  }
  for (const auto& name : aPreferenceSnapshot.mAnnotatePBM) {
    names.Insert(name);
  }
  return names;
}

void ContentClassifierService::PruneInactiveEngines(
    const EnginesPrefsSnapshot& aPreferenceSnapshot) {
  mLock.AssertCurrentThreadOwns();
  nsTHashSet<nsCString> activeFeatureNames =
      ActiveFeatureNames(aPreferenceSnapshot);
  for (auto iter = mEngines.Iter(); !iter.Done(); iter.Next()) {
    if (!activeFeatureNames.Contains(iter.Key())) {
      MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Debug,
                  "PruneInactiveEngines - dropping engine for \"{}\"",
                  iter.Key());
      iter.Remove();
    }
  }
  for (auto iter = mFeatureVersions.Iter(); !iter.Done(); iter.Next()) {
    if (!activeFeatureNames.Contains(iter.Key())) {
      iter.Remove();
    }
  }
}

void ContentClassifierService::ProcessListChanges(
    const nsTArray<nsCString>& aUpdated, const nsTArray<nsCString>& aRemoved) {
  MOZ_ASSERT(NS_IsMainThread());

  EnginesPrefsSnapshot snapshot;
  nsTHashSet<nsCString> activeNames = ActiveFeatureNames(snapshot);

  nsTArray<const ContentClassifierFeature*> toUpdate;
  {
    MutexAutoLock lock(mLock);
    for (const auto& feature : GetFeatures()) {
      if (!activeNames.Contains(nsCString(feature.mName))) {
        continue;
      }
      bool removed = false;
      for (const auto& listId : feature.mListIds) {
        if (aRemoved.Contains(listId)) {
          mEngines.Remove(nsCString(feature.mName));
          ++mFeatureVersions.LookupOrInsert(feature.mName);
          removed = true;
          break;
        }
      }
      if (removed) {
        PopulateAllActiveEnginesFromPreferenceSnapshot(snapshot);
        continue;
      }
      bool affected = !mEngines.Contains(nsCString(feature.mName));
      if (!affected) {
        for (const auto& listId : feature.mListIds) {
          if (aUpdated.Contains(listId) || aRemoved.Contains(listId)) {
            affected = true;
            break;
          }
        }
      }
      if (affected) {
        toUpdate.AppendElement(&feature);
      }
    }
  }

  UpdateFeatures(toUpdate, std::move(snapshot));
}

void ContentClassifierService::UpdateFeatures(
    const nsTArray<const ContentClassifierFeature*>& aFeatures,
    EnginesPrefsSnapshot aPreferenceSnapshot) {
  MOZ_ASSERT(NS_IsMainThread());

  // Drop inactive features before issuing fetches: their engines will be
  // removed by PruneInactiveEngines below, so fetching list bytes just to
  // throw the engine away would be wasted work.
  nsTHashSet<nsCString> activeNames = ActiveFeatureNames(aPreferenceSnapshot);
  nsTArray<const ContentClassifierFeature*> features;
  nsTArray<RefPtr<EngineRulesPromise>> fetches;
  for (const auto* feature : aFeatures) {
    if (!activeNames.Contains(nsCString(feature->mName))) {
      continue;
    }
    features.AppendElement(feature);
    fetches.AppendElement(FetchEngineDataForFeature(*feature));
  }

  // mBuildThread is non-null iff mInitPhase == InitSucceeded. A null
  // value here means we're either pre-Init, init failed, or shutdown
  // has already extracted the queue; in all of those cases the rebuild
  // has nothing useful to do.
  nsCOMPtr<nsISerialEventTarget> buildThread = mBuildThread;
  if (!buildThread) {
    return;
  }

  // Bump the global generation and (where applicable) per-feature
  // versions under the lock. The build closure compares each captured
  // version against the current one before installing, so a later
  // UpdateFeatures call for the same feature can't be overwritten by
  // an earlier in-flight rebuild. The global generation gates
  // Populate / Prune / Notify so an older closure's stale snapshot
  // can't clobber the active-engine lists set up by a newer call.
  nsTArray<uint64_t> featureVersions;
  featureVersions.SetCapacity(features.Length());
  uint64_t generation;
  {
    MutexAutoLock lock(mLock);
    generation = ++mUpdateGeneration;
    for (const auto* feature : features) {
      uint64_t& v = mFeatureVersions.LookupOrInsert(feature->mName);
      featureVersions.AppendElement(++v);
    }
  }

  RefPtr<ContentClassifierService> self = this;

  if (features.IsEmpty()) {
    // No fetches needed; still refresh the active lists and prune in
    // case the snapshot changed. Run the lock-holding work on the
    // build thread so it never blocks the main thread. The Notify is
    // dispatched only when this is still the latest UpdateFeatures
    // call — otherwise a newer call's closure will fire it.
    buildThread->Dispatch(NS_NewRunnableFunction(
        "ContentClassifierService::UpdateFeaturesNoFetch",
        [self, snapshot = std::move(aPreferenceSnapshot), generation]() {
          {
            MutexAutoLock lock(self->mLock);
            if (self->mInitPhase != InitPhase::InitSucceeded) {
              return;
            }
            if (self->mUpdateGeneration != generation) {
              return;
            }
            self->PopulateAllActiveEnginesFromPreferenceSnapshot(snapshot);
            self->PruneInactiveEngines(snapshot);
          }
          NS_DispatchToMainThread(NS_NewRunnableFunction(
              "ContentClassifierService::NotifyListsLoaded",
              [self]() { NotifyListsLoadedForTesting(); }));
        }));
    return;
  }

  EngineRulesPromise::AllSettled(GetMainThreadSerialEventTarget(), fetches)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [self, features = std::move(features),
           featureVersions = std::move(featureVersions),
           snapshot = std::move(aPreferenceSnapshot),
           buildThread = std::move(buildThread), generation](
              EngineRulesPromise::AllSettledPromiseType::ResolveOrRejectValue&&
                  aValue) mutable {
            MOZ_ASSERT(NS_IsMainThread());

            // Collect per-feature rule arrays out of the settled promises;
            // defer the expensive parsing / InitFromRules to mBuildThread.
            nsTArray<Maybe<nsTArray<nsCString>>> perFeatureRules;
            perFeatureRules.SetLength(features.Length());
            if (aValue.IsResolve()) {
              auto& settled = aValue.ResolveValue();
              MOZ_ASSERT(settled.Length() == features.Length());
              for (size_t i = 0; i < settled.Length(); ++i) {
                if (settled[i].IsReject()) {
                  MOZ_LOG_FMT(
                      gContentClassifierLog, LogLevel::Warning,
                      "UpdateFeatures - fetch rejected for feature \"{}\"",
                      features[i]->mName);
                  continue;
                }
                perFeatureRules[i].emplace(
                    std::move(settled[i].ResolveValue()));
              }
            }

            buildThread->Dispatch(NS_NewRunnableFunction(
                "ContentClassifierService::UpdateFeaturesBuild",
                [self, features = std::move(features),
                 featureVersions = std::move(featureVersions),
                 perFeatureRules = std::move(perFeatureRules),
                 snapshot = std::move(snapshot), generation]() mutable {
                  MOZ_ASSERT(!NS_IsMainThread());

                  // Build engines outside the lock; InitFromRules can be
                  // expensive. Failed fetches/builds preserve installed
                  // engines; successful empty rules remove them.
                  nsTArray<RefPtr<ContentClassifierEngine>> builtEngines;
                  builtEngines.SetLength(features.Length());
                  nsTArray<bool> installEngines;
                  installEngines.SetLength(features.Length());
                  for (size_t i = 0; i < features.Length(); ++i) {
                    installEngines[i] = false;
                    if (perFeatureRules[i].isNothing()) {
                      continue;
                    }
                    RefPtr<ContentClassifierEngine> engine;
                    if (NS_FAILED(BuildEngineFromRules(
                            *features[i], *perFeatureRules[i], engine))) {
                      continue;
                    }
                    builtEngines[i] = std::move(engine);
                    installEngines[i] = true;
                  }

                  bool didFullWork = false;
                  {
                    MutexAutoLock lock(self->mLock);
                    if (self->mInitPhase != InitPhase::InitSucceeded) {
                      // Shutdown raced us; drop everything we built.
                      return;
                    }
                    // Install non-stale engines (per-feature versioning).
                    for (size_t i = 0; i < builtEngines.Length(); ++i) {
                      if (!installEngines[i]) {
                        continue;
                      }
                      uint64_t current =
                          self->mFeatureVersions.Get(features[i]->mName);
                      if (current != featureVersions[i]) {
                        MOZ_LOG_FMT(
                            gContentClassifierLog, LogLevel::Debug,
                            "UpdateFeatures - skipping stale install for "
                            "feature \"{}\" (have v{}, current v{})",
                            features[i]->mName, featureVersions[i], current);
                        continue;
                      }
                      self->InstallEngine(features[i]->mName,
                                          std::move(builtEngines[i]));
                    }
                    // Only run Populate / Prune (and the Notify below)
                    // when this is still the latest UpdateFeatures call.
                    // A newer call's closure will run those itself with
                    // its own (more recent) snapshot.
                    if (self->mUpdateGeneration == generation) {
                      self->PopulateAllActiveEnginesFromPreferenceSnapshot(
                          snapshot);
                      self->PruneInactiveEngines(snapshot);
                      didFullWork = true;
                    }
                  }

                  if (didFullWork) {
                    NS_DispatchToMainThread(NS_NewRunnableFunction(
                        "ContentClassifierService::NotifyListsLoaded",
                        [self]() { NotifyListsLoadedForTesting(); }));
                  }
                }));
          });
}

class FilterListLoader final : public nsIStreamLoaderObserver {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS

  explicit FilterListLoader(nsTArray<nsCString>* aRules) : mRules(aRules) {}

  NS_IMETHOD
  OnStreamComplete(nsIStreamLoader* aLoader, nsISupports* aCtxt,
                   nsresult aStatus, uint32_t aResultLength,
                   const uint8_t* aResult) override {
    MOZ_ASSERT(NS_IsMainThread());

    NS_ENSURE_SUCCESS(aStatus, aStatus);
    if (NS_FAILED(aStatus)) {
      MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
              ("FilterListLoader::OnStreamComplete - failed with status 0x%x",
               static_cast<uint32_t>(aStatus)));
      mPromiseHolder.RejectIfExists(aStatus, __func__);
      return aStatus;
    }

    nsAutoCString content(reinterpret_cast<const char*>(aResult),
                          aResultLength);

    for (const auto& line : content.Split('\n')) {
      if (!line.IsEmpty()) {
        mRules->AppendElement(line);
      }
    }

    MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
            ("FilterListLoader::OnStreamComplete - loaded %zu rules",
             mRules->Length()));

    mPromiseHolder.ResolveIfExists(true, __func__);

    return NS_OK;
  }

  RefPtr<GenericPromise> Load(const nsACString& aURL) {
    MOZ_ASSERT(NS_IsMainThread());

    nsCOMPtr<nsIURI> uri;
    nsresult rv = NS_NewURI(getter_AddRefs(uri), aURL);
    NS_ENSURE_SUCCESS(rv, GenericPromise::CreateAndReject(rv, __func__));

    nsCOMPtr<nsIChannel> channel;
    uint32_t loadFlags = nsIChannel::LOAD_BYPASS_URL_CLASSIFIER;
    rv = NS_NewChannel(getter_AddRefs(channel), uri,
                       nsContentUtils::GetSystemPrincipal(),
                       nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                       nsIContentPolicy::TYPE_OTHER,
                       nullptr,  // nsICookieJarSettings
                       nullptr,  // aPerformanceStorage
                       nullptr,  // aLoadGroup
                       nullptr,  // aInterfaceRequestor
                       loadFlags);
    NS_ENSURE_SUCCESS(rv, GenericPromise::CreateAndReject(rv, __func__));

    nsCOMPtr<nsIStreamLoader> loader;
    rv = NS_NewStreamLoader(getter_AddRefs(loader), this);
    NS_ENSURE_SUCCESS(rv, GenericPromise::CreateAndReject(rv, __func__));

    rv = channel->AsyncOpen(loader);
    NS_ENSURE_SUCCESS(rv, GenericPromise::CreateAndReject(rv, __func__));

    return mPromiseHolder.Ensure(__func__);
  }

 private:
  ~FilterListLoader() {
    mPromiseHolder.RejectIfExists(NS_ERROR_ABORT, __func__);
  }

  nsTArray<nsCString>* mRules;
  MozPromiseHolder<GenericPromise> mPromiseHolder;
};

NS_IMPL_ISUPPORTS(FilterListLoader, nsIStreamLoaderObserver)

RefPtr<ContentClassifierService::EngineRulesPromise>
ContentClassifierService::FetchEngineDataForFeature(
    const ContentClassifierFeature& aFeature) {
  if (aFeature.mName.Equals("test_block") ||
      aFeature.mName.Equals("test_annotate")) {
    return FetchEngineDataForTestFeature(aFeature);
  }

  if (!mRSClient) {
    return EngineRulesPromise::CreateAndReject(NS_ERROR_NOT_AVAILABLE,
                                               __func__);
  }

  nsTArray<RefPtr<ListBytesPromise>> fetches;
  nsTArray<nsCString> listIdsInOrder;
  for (const auto& listId : aFeature.mListIds) {
    listIdsInOrder.AppendElement(listId);
    fetches.AppendElement(FetchListBytesFromRemoteSettings(mRSClient, listId));
  }

  if (fetches.IsEmpty()) {
    return EngineRulesPromise::CreateAndResolve(nsTArray<nsCString>{},
                                                __func__);
  }

  RefPtr<EngineRulesPromise::Private> result =
      new EngineRulesPromise::Private(__func__);
  RefPtr<ContentClassifierService> self = this;
  ListBytesPromise::AllSettled(GetMainThreadSerialEventTarget(), fetches)
      ->Then(GetMainThreadSerialEventTarget(), __func__,
             [self, result, feature = &aFeature,
              listIdsInOrder = std::move(listIdsInOrder)](
                 const ListBytesPromise::AllSettledPromiseType::
                     ResolveOrRejectValue& aValue) mutable {
               if (aValue.IsReject()) {
                 MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Error,
                             "FetchEngineDataForFeature - failed to fetch "
                             "list bytes for feature \"{}\"",
                             feature->mName);
                 result->Reject(NS_ERROR_NOT_AVAILABLE, __func__);
                 return;
               }

               const auto& fetchPromises = aValue.ResolveValue();
               nsTArray<nsCString> rules;
               for (size_t i = 0; i < fetchPromises.Length(); ++i) {
                 if (fetchPromises[i].IsReject()) {
                   MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Warning,
                               "FetchEngineDataForFeature - list \"{}\" for "
                               "feature \"{}\" rejected",
                               listIdsInOrder[i], feature->mName);
                   result->Reject(fetchPromises[i].RejectValue(), __func__);
                   return;
                 }
                 const auto& fetchResult = fetchPromises[i].ResolveValue();
                 if (fetchResult.IsEmpty()) {
                   MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Warning,
                               "FetchEngineDataForFeature - list \"{}\" for "
                               "feature \"{}\" returned no bytes",
                               listIdsInOrder[i], feature->mName);
                   continue;
                 }
                 ParseFilterListRules(fetchResult, rules);
               }
               result->Resolve(std::move(rules), __func__);
             });
  return result;
}

RefPtr<ContentClassifierService::EngineRulesPromise>
ContentClassifierService::FetchEngineDataForTestFeature(
    const ContentClassifierFeature& aFeature) {
  MOZ_LOG_FMT(gContentClassifierLog, LogLevel::Debug,
              "FetchEngineDataForTestFeature - loading filter lists for "
              "feature \"{}\"",
              aFeature.mName);

  nsAutoCString testListURLPref;
  if (aFeature.mName.Equals("test_annotate")) {
    Preferences::GetCString(
        "privacy.trackingprotection.content.annotation.test_list_urls",
        testListURLPref);

  } else if (aFeature.mName.Equals("test_block")) {
    Preferences::GetCString(
        "privacy.trackingprotection.content.protection.test_list_urls",
        testListURLPref);

  } else {
    MOZ_LOG(gContentClassifierLog, LogLevel::Warning,
            ("FetchEngineDataForTestFeature - incorrect feature name"));
    return EngineRulesPromise::CreateAndResolve(nsTArray<nsCString>{},
                                                __func__);
  }

  nsTArray<nsCString> listURLS;
  for (const nsACString& url : testListURLPref.Split('|')) {
    if (!url.IsEmpty()) {
      listURLS.AppendElement(url);
      MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
              ("FetchEngineDataForTestFeature - test list URL: %s",
               nsAutoCString(url).get()));
    }
  }

  nsTArray<RefPtr<GenericPromise>> promises;
  nsTArray<nsTArray<nsCString>> filterRules;
  filterRules.SetLength(listURLS.Length());

  for (size_t i = 0; i < listURLS.Length(); ++i) {
    RefPtr<FilterListLoader> loader = new FilterListLoader(&filterRules[i]);
    promises.AppendElement(loader->Load(listURLS[i]));
  }

  RefPtr<EngineRulesPromise::Private> result =
      new EngineRulesPromise::Private(__func__);

  GenericPromise::AllSettled(GetMainThreadSerialEventTarget(), promises)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [self = RefPtr{this}, result, filterRules = std::move(filterRules)](
              const GenericPromise::AllSettledPromiseType::ResolveOrRejectValue&
                  aResults) {
            nsTArray<nsCString> rules;
            for (const auto& fromUrl : filterRules) {
              rules.AppendElements(fromUrl);
            }
            result->Resolve(std::move(rules), __func__);
          });
  return result;
}

}  // namespace mozilla
