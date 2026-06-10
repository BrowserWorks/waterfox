/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "gtest/gtest.h"
#include "mozilla/ContentClassifierService.h"
#include "mozilla/ScopeExit.h"
#include "mozilla/SpinEventLoopUntil.h"
#include "nsContentUtils.h"
#include "nsIClassOfService.h"
#include "nsIContentPolicy.h"
#include "nsILoadInfo.h"
#include "nsISupportsPriority.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsThreadUtils.h"

using namespace mozilla;

TEST(AdEnginePublication, IndependentImmutableSnapshots)
{
  RefPtr<ContentClassifierService> service =
      ContentClassifierService::GetForAdBlocking();
  ASSERT_TRUE(service);
  const bool etpEnabled = ContentClassifierService::IsEnabled();
  auto previous = service->GetAdBlockingEngineSnapshot();
  RefPtr<ContentClassifierEngine> first = new ContentClassifierEngine();
  RefPtr<ContentClassifierEngine> second = new ContentClassifierEngine();
  uint64_t firstGeneration = 0;
  uint64_t secondGeneration = 0;
  auto cleanup = MakeScopeExit([&] {
    service->UnpublishAdBlockingEngine(first, firstGeneration);
    service->UnpublishAdBlockingEngine(second, secondGeneration);
    if (previous.mEngine) {
      uint64_t generation;
      service->PublishAdBlockingEngine(previous.mEngine, &generation);
    }
  });

  nsTArray<nsCString> rules{"||ads.example^"_ns};
  ASSERT_EQ(first->InitFromRules(rules), NS_OK);
  EXPECT_EQ(service->PublishAdBlockingEngine(first, &firstGeneration),
            NS_ERROR_NOT_INITIALIZED);
  ASSERT_EQ(first->UseResources("[]"_ns), NS_OK);
  ASSERT_EQ(service->PublishAdBlockingEngine(first, &firstGeneration), NS_OK);
  EXPECT_EQ(ContentClassifierService::IsEnabled(), etpEnabled);
  auto captured = service->GetAdBlockingEngineSnapshot();
  EXPECT_EQ(captured.mEngine, first);
  EXPECT_EQ(captured.mGeneration, firstGeneration);
  EXPECT_EQ(first->UseResources("[]"_ns), NS_ERROR_NOT_AVAILABLE);
  EXPECT_EQ(first->InitFromRules(rules), NS_ERROR_NOT_AVAILABLE);

  nsTArray<uint8_t> cache;
  ASSERT_EQ(first->Serialize(cache), NS_OK);
  ASSERT_EQ(second->InitFromCache(cache), NS_OK);
  ASSERT_EQ(second->UseResources("[]"_ns), NS_OK);
  ASSERT_EQ(service->PublishAdBlockingEngine(second, &secondGeneration), NS_OK);
  EXPECT_GT(secondGeneration, firstGeneration);
  service->UnpublishAdBlockingEngine(first, firstGeneration);
  service->UnpublishAdBlockingEngine(second, firstGeneration);
  auto current = service->GetAdBlockingEngineSnapshot();
  EXPECT_EQ(current.mEngine, second);
  EXPECT_EQ(current.mGeneration, secondGeneration);
  EXPECT_EQ(ContentClassifierService::IsEnabled(), etpEnabled);

  AdBlockingRequestSnapshot request;
  request.mPolicyFlags =
      AdPolicyEnabled | AdPolicyPrivate | AdPolicyDomainAllowed;
  request.mUrl = "https://ads.example/ad.js"_ns;
  request.mSourceHostname = "ads.example"_ns;
  request.mHostname = "ads.example"_ns;
  request.mRequestType = "script"_ns;
  request.mRequestMethod = "GET"_ns;
  request.mBrowserId = 42;
  request.mNavigationId = 7;
  ASSERT_EQ(service->CaptureAdBlockingRequest(request), NS_OK);
  EXPECT_TRUE(request.CanMatch());
  EXPECT_FALSE(request.CanBlock());
  EXPECT_TRUE(service->IsCurrentAdBlockingRequest(request));
  service->InvalidateAdBlockingPolicy();
  EXPECT_FALSE(service->IsCurrentAdBlockingRequest(request));

  nsCOMPtr<nsISerialEventTarget> queue;
  ASSERT_EQ(
      NS_CreateBackgroundTaskQueue("AdPublicationTest", getter_AddRefs(queue)),
      NS_OK);
  bool completed = false;
  bool matched = false;
  ASSERT_EQ(
      queue->Dispatch(NS_NewRunnableFunction(
          "AdPublicationTest",
          [request, captured, &completed, &matched] {
            ContentClassifierDetailedResult result;
            nsresult rv = ContentClassifierService::ClassifyAdBlockingRequest(
                request, result);
            ContentClassifierDetailedResult retired;
            nsresult retiredRv = captured.mEngine->CheckNetworkRequestDetailed(
                request.mUrl, request.mSourceHostname, request.mHostname,
                request.mRequestType, request.mRequestMethod, false, retired);
            NS_DispatchToMainThread(NS_NewRunnableFunction(
                "AdPublicationResult",
                [rv, retiredRv, retired = std::move(retired),
                 result = std::move(result), &completed, &matched] {
                  matched = NS_SUCCEEDED(rv) && result.mMatched &&
                            NS_SUCCEEDED(retiredRv) && retired.mMatched;
                  completed = true;
                }));
          })),
      NS_OK);
  ASSERT_TRUE(
      SpinEventLoopUntil("AdPublicationTest"_ns, [&] { return completed; }));
  EXPECT_TRUE(matched);
  completed = false;
  service->ClassifyAdBlockingRequestAsync(request)->Then(
      GetMainThreadSerialEventTarget(), "AdPublicationAsyncTest",
      [&](ContentClassifierService::AdClassificationPromise::
              ResolveOrRejectValue&& aValue) {
        EXPECT_TRUE(NS_IsMainThread());
        completed = true;
        ASSERT_TRUE(aValue.IsResolve());
        EXPECT_TRUE(aValue.ResolveValue().mMatched);
        EXPECT_FALSE(service->IsCurrentAdBlockingRequest(request));
      });
  ASSERT_TRUE(SpinEventLoopUntil("AdPublicationAsyncTest"_ns,
                                 [&] { return completed; }));
  AdBlockingRequestSnapshot missingEngine;
  missingEngine.mPolicyFlags = AdPolicyEnabled;
  completed = false;
  service->ClassifyAdBlockingRequestAsync(missingEngine)
      ->Then(GetMainThreadSerialEventTarget(), "AdPublicationAsyncErrorTest",
             [&](ContentClassifierService::AdClassificationPromise::
                     ResolveOrRejectValue&& aValue) {
               EXPECT_TRUE(aValue.IsReject());
               if (aValue.IsReject()) {
                 EXPECT_EQ(aValue.RejectValue(), NS_ERROR_NOT_INITIALIZED);
               }
               completed = true;
             });
  ASSERT_TRUE(SpinEventLoopUntil("AdPublicationAsyncErrorTest"_ns,
                                 [&] { return completed; }));
  request.mPolicyFlags |= AdPolicyBypass;
  ContentClassifierDetailedResult bypassed;
  ASSERT_EQ(
      ContentClassifierService::ClassifyAdBlockingRequest(request, bypassed),
      NS_OK);
  EXPECT_FALSE(bypassed.mMatched);
  request.mPolicyFlags = AdPolicyEnabled;
  request.mValidUntil = 1;
  ASSERT_EQ(service->CaptureAdBlockingRequest(request), NS_OK);
  EXPECT_FALSE(service->IsCurrentAdBlockingRequest(request));
  service->UnpublishAdBlockingEngine(second, secondGeneration);
  current = service->GetAdBlockingEngineSnapshot();
  EXPECT_FALSE(current.mEngine);
  EXPECT_GT(current.mGeneration, secondGeneration);
}

TEST(AdEnginePublication, ChannelTaskPriority)
{
  nsCOMPtr<nsIURI> uri;
  ASSERT_EQ(NS_NewURI(getter_AddRefs(uri), "https://ads.example/ad.js"_ns),
            NS_OK);
  nsCOMPtr<nsIChannel> channel;
  ASSERT_EQ(
      NS_NewChannel(getter_AddRefs(channel), uri,
                    nsContentUtils::GetSystemPrincipal(),
                    nsILoadInfo::SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
                    nsIContentPolicy::TYPE_SCRIPT),
      NS_OK);
  nsCOMPtr<nsIClassOfService> classOfService = do_QueryInterface(channel);
  nsCOMPtr<nsISupportsPriority> supportsPriority = do_QueryInterface(channel);
  ASSERT_TRUE(classOfService);
  ASSERT_TRUE(supportsPriority);

  constexpr uint32_t normal = nsIRunnablePriority::PRIORITY_NORMAL;
  constexpr uint32_t mediumHigh = nsIRunnablePriority::PRIORITY_MEDIUMHIGH;
  const struct {
    const char* mName;
    uint32_t mFlags;
    int32_t mPriority;
    uint32_t mExpected;
  } cases[] = {
      {"normal", 0, nsISupportsPriority::PRIORITY_NORMAL, normal},
      {"below high threshold", 0, nsISupportsPriority::PRIORITY_HIGH + 1,
       normal},
      {"high", 0, nsISupportsPriority::PRIORITY_HIGH, mediumHigh},
      {"leader", nsIClassOfService::Leader,
       nsISupportsPriority::PRIORITY_NORMAL, mediumHigh},
      {"urgent start with low priority", nsIClassOfService::UrgentStart,
       nsISupportsPriority::PRIORITY_LOW, mediumHigh},
      {"unblocked with lowest priority", nsIClassOfService::Unblocked,
       nsISupportsPriority::PRIORITY_LOWEST, mediumHigh},
      {"unrelated flag", nsIClassOfService::Throttleable,
       nsISupportsPriority::PRIORITY_NORMAL, normal},
      {"leader with unrelated flag",
       nsIClassOfService::Leader | nsIClassOfService::Throttleable,
       nsISupportsPriority::PRIORITY_LOWEST, mediumHigh},
  };
  for (const auto& test : cases) {
    SCOPED_TRACE(test.mName);
    ASSERT_EQ(classOfService->SetClassFlags(test.mFlags), NS_OK);
    ASSERT_EQ(supportsPriority->SetPriority(test.mPriority), NS_OK);
    EXPECT_EQ(
        ContentClassifierService::GetAdBlockingChannelTaskPriority(channel),
        test.mExpected);
  }
}
