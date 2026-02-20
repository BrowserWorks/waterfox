/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ContentClassifierService.h"

#include "mozilla/Logging.h"
#include "mozilla/net/HttpBaseChannel.h"
#include "mozilla/net/UrlClassifierCommon.h"
#include "MainThreadUtils.h"
#include "nsDebug.h"
#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/Preferences.h"
#include "mozilla/Components.h"
#include "mozilla/MozPromise.h"
#include "mozilla/StaticPtr.h"
#include "nsIAsyncShutdown.h"
#include "nsIChannel.h"
#include "nsIStreamLoader.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsContentUtils.h"
#include "nsIWebProgressListener.h"

namespace mozilla {

static LazyLogModule gContentClassifierLog("ContentClassifier");

StaticRefPtr<ContentClassifierService> ContentClassifierService::sInstance;

NS_IMPL_ISUPPORTS(ContentClassifierService, nsIAsyncShutdownBlocker)

ContentClassifierService::ContentClassifierService()
    : mLock("ContentClassifierService::mLock"),
      mInitPhase(InitPhase::NotInited) {}

ContentClassifierService::~ContentClassifierService() = default;

// static
bool ContentClassifierService::IsEnabled() {
  return Preferences::GetBool(
             "privacy.trackingprotection.content.protection.enabled", false) ||
         Preferences::GetBool(
             "privacy.trackingprotection.content.annotation.enabled", false);
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
void ContentClassifierService::OnPrefChange(const char* aPref, void* aData) {
  RefPtr<ContentClassifierService> service = GetInstance();
  if (service) {
    MutexAutoLock lock(service->mLock);
    service->LoadFilterLists();
  }
}

void ContentClassifierService::Init() {
  MOZ_ASSERT(XRE_IsParentProcess());
  AssertIsOnMainThread();
  MutexAutoLock lock(mLock);

  if (mInitPhase != InitPhase::NotInited) {
    return;
  }

  MOZ_LOG(gContentClassifierLog, LogLevel::Info,
          ("ContentClassifierService::Init - initializing"));

  nsCOMPtr<nsIAsyncShutdownClient> shutdownBarrier = GetAsyncShutdownBarrier();
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

  rv = Preferences::RegisterCallback(
      &ContentClassifierService::OnPrefChange,
      "privacy.trackingprotection.content.protection.test_list_urls"_ns);
  if (NS_FAILED(rv)) {
    mInitPhase = InitPhase::InitFailed;
    return;
  }

  rv = Preferences::RegisterCallback(
      &ContentClassifierService::OnPrefChange,
      "privacy.trackingprotection.content.annotation.test_list_urls"_ns);
  if (NS_FAILED(rv)) {
    mInitPhase = InitPhase::InitFailed;
    return;
  }

  LoadFilterLists();

  mInitPhase = InitPhase::InitSucceeded;
}

// static
already_AddRefed<ContentClassifierService>
ContentClassifierService::GetInstance() {
  if (!sInstance) {
    sInstance = new ContentClassifierService();
    ClearOnShutdown(&sInstance);
    sInstance->Init();
  }

  if (!IsInitialized() || !IsEnabled()) {
    return nullptr;
  }

  return do_AddRef(sInstance);
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

  MOZ_LOG(gContentClassifierLog, LogLevel::Info,
          ("ContentClassifierService::BlockShutdown - shutting down"));

  MutexAutoLock lock(mLock);

  mInitPhase = InitPhase::ShutdownStarted;

  Preferences::UnregisterCallback(
      &ContentClassifierService::OnPrefChange,
      "privacy.trackingprotection.content.protection.test_list_urls"_ns);
  Preferences::UnregisterCallback(
      &ContentClassifierService::OnPrefChange,
      "privacy.trackingprotection.content.annotation.test_list_urls"_ns);

  mBlockEngines.Clear();
  mAnnotateEngines.Clear();

  content_classifier_teardown_domain_resolver();

  RemoveBlocker();

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

ContentClassifierResult ContentClassifierService::ClassifyWithEngines(
    const nsTArray<UniquePtr<ContentClassifierEngine>>& aEngines,
    const ContentClassifierRequest& aRequest) {
  MOZ_ASSERT(!NS_IsMainThread());
  mLock.AssertCurrentThreadOwns();
  if (mInitPhase != InitPhase::InitSucceeded) {
    return ContentClassifierResult(NS_ERROR_NOT_INITIALIZED);
  }
  if (!aRequest.Valid()) {
    return ContentClassifierResult(NS_ERROR_INVALID_ARG);
  }
  ContentClassifierResult result(NS_OK);
  for (const auto& engine : aEngines) {
    ContentClassifierResult thisResult = engine->CheckNetworkRequest(aRequest);
    result.Accumulate(thisResult);
    if (result.Important()) {
      break;
    }
  }
  return result;
}

NS_IMETHODIMP ContentClassifierService::GetName(nsAString& aName) {
  aName.AssignLiteral("ContentClassifierService: Shutting down");
  return NS_OK;
}

NS_IMETHODIMP ContentClassifierService::GetState(nsIPropertyBag** aState) {
  *aState = nullptr;
  return NS_OK;
}

ContentClassifierResult ContentClassifierService::ClassifyForAnnotate(
    const ContentClassifierRequest& aRequest) {
  MutexAutoLock lock(mLock);
  ContentClassifierResult result =
      ClassifyWithEngines(mAnnotateEngines, aRequest);
  MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
          ("ClassifyForAnnotate - url=%s hit=%d exception=%d",
           aRequest.Url().get(), result.Hit(), result.Exception()));
  return result;
}

ContentClassifierResult ContentClassifierService::ClassifyForCancel(
    const ContentClassifierRequest& aRequest) {
  MutexAutoLock lock(mLock);
  ContentClassifierResult result = ClassifyWithEngines(mBlockEngines, aRequest);
  MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
          ("ClassifyForCancel - url=%s hit=%d exception=%d",
           aRequest.Url().get(), result.Hit(), result.Exception()));
  return result;
}

void ContentClassifierService::AnnotateChannel(nsIChannel* aChannel) {
  NS_ENSURE_TRUE_VOID(aChannel);

  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));
  if (uri) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
            ("AnnotateChannel - url=%s", uri->GetSpecOrDefault().get()));
  }

  net::UrlClassifierCommon::AnnotateChannel(
      aChannel, nsIClassifiedChannel::ClassificationFlags::CLASSIFIED_TRACKING,
      nsIWebProgressListener::STATE_LOADED_LEVEL_2_TRACKING_CONTENT);
}

void ContentClassifierService::CancelChannel(nsIChannel* aChannel) {
  NS_ENSURE_TRUE_VOID(aChannel);

  nsCOMPtr<nsIURI> uri;
  aChannel->GetURI(getter_AddRefs(uri));
  if (uri) {
    MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
            ("CancelChannel - url=%s", uri->GetSpecOrDefault().get()));
  }

  net::UrlClassifierCommon::SetBlockedContent(aChannel, NS_ERROR_TRACKING_URI,
                                              "content-classifier-block"_ns,
                                              "content-classifier"_ns, ""_ns);

  nsCOMPtr<nsIHttpChannelInternal> httpChannel = do_QueryInterface(aChannel);

  if (httpChannel) {
    (void)httpChannel->CancelByURLClassifier(NS_ERROR_TRACKING_URI);
  } else {
    (void)aChannel->Cancel(NS_ERROR_TRACKING_URI);
  }
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
  ~FilterListLoader() = default;

  nsTArray<nsCString>* mRules;
  MozPromiseHolder<GenericPromise> mPromiseHolder;
};

NS_IMPL_ISUPPORTS(FilterListLoader, nsIStreamLoaderObserver)

void ContentClassifierService::LoadFilterLists() {
  MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
          ("ContentClassifierService::LoadFilterLists - loading filter lists"));

  nsTArray<RefPtr<GenericPromise>> promises;
  mLock.AssertCurrentThreadOwns();

  nsAutoCString blockListPref;
  Preferences::GetCString(
      "privacy.trackingprotection.content.protection.test_list_urls",
      blockListPref);

  nsTArray<nsCString> blockListURLs;
  for (const nsACString& url : blockListPref.Split('|')) {
    if (!url.IsEmpty()) {
      blockListURLs.AppendElement(url);
      MOZ_LOG(
          gContentClassifierLog, LogLevel::Debug,
          ("LoadFilterLists - block list URL: %s", nsAutoCString(url).get()));
    }
  }

  nsAutoCString annotationListPref;
  Preferences::GetCString(
      "privacy.trackingprotection.content.annotation.test_list_urls",
      annotationListPref);

  nsTArray<nsCString> annotationListURLs;
  for (const nsACString& url : annotationListPref.Split('|')) {
    if (!url.IsEmpty()) {
      annotationListURLs.AppendElement(url);
      MOZ_LOG(gContentClassifierLog, LogLevel::Debug,
              ("LoadFilterLists - annotation list URL: %s",
               nsAutoCString(url).get()));
    }
  }

  nsTArray<nsTArray<nsCString>> blockFilterRules;
  nsTArray<nsTArray<nsCString>> annotateFilterRules;
  blockFilterRules.SetLength(blockListURLs.Length());
  annotateFilterRules.SetLength(annotationListURLs.Length());

  for (size_t i = 0; i < blockListURLs.Length(); ++i) {
    RefPtr<FilterListLoader> loader =
        new FilterListLoader(&blockFilterRules[i]);
    promises.AppendElement(loader->Load(blockListURLs[i]));
  }

  for (size_t i = 0; i < annotationListURLs.Length(); ++i) {
    RefPtr<FilterListLoader> loader =
        new FilterListLoader(&annotateFilterRules[i]);
    promises.AppendElement(loader->Load(annotationListURLs[i]));
  }

  GenericPromise::AllSettled(GetMainThreadSerialEventTarget(), promises)
      ->Then(
          GetMainThreadSerialEventTarget(), __func__,
          [self = RefPtr{this},
           annotateFilterRules = std::move(annotateFilterRules),
           blockFilterRules = std::move(blockFilterRules)](
              const GenericPromise::AllSettledPromiseType::ResolveOrRejectValue&
                  aResults) {
            MutexAutoLock lock(self->mLock);
            self->mBlockEngines.Clear();
            self->mAnnotateEngines.Clear();

            for (const auto& rules : blockFilterRules) {
              auto engine = MakeUnique<ContentClassifierEngine>();
              nsresult rv = engine->InitFromRules(rules);
              if (NS_FAILED(rv)) {
                continue;
              }
              self->mBlockEngines.AppendElement(std::move(engine));
            }

            for (const auto& rules : annotateFilterRules) {
              auto engine = MakeUnique<ContentClassifierEngine>();
              nsresult rv = engine->InitFromRules(rules);
              if (NS_FAILED(rv)) {
                continue;
              }
              self->mAnnotateEngines.AppendElement(std::move(engine));
            }
          });
}

}  // namespace mozilla
