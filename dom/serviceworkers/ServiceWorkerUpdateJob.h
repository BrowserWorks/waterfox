/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_serviceworkerupdatejob_h
#define mozilla_dom_serviceworkerupdatejob_h

#include "ServiceWorkerJob.h"
#include "ServiceWorkerRegistration.h"
#include "mozilla/dom/ServiceWorkerLifetimeExtension.h"
#include "nsIRequest.h"

namespace mozilla::dom {

namespace serviceWorkerScriptCache {
enum class OnFailure : uint8_t;
}  // namespace serviceWorkerScriptCache

class ServiceWorkerManager;
class ServiceWorkerRegistrationInfo;

// A job class that performs the Update and Install algorithms from the
// service worker spec.  This class is designed to be inherited and customized
// as a different job type.  This is necessary because the register job
// performs largely the same operations as the update job, but has a few
// different starting steps.
class ServiceWorkerUpdateJob : public ServiceWorkerJob {
 public:
  // Construct an update job to be used only for updates.
  ServiceWorkerUpdateJob(
      nsIPrincipal* aPrincipal, const nsACString& aScope, nsCString aScriptSpec,
      ServiceWorkerUpdateViaCache aUpdateViaCache,
      const ServiceWorkerLifetimeExtension& aLifetimeExtension);

  already_AddRefed<ServiceWorkerRegistrationInfo> GetRegistration() const;

 protected:
  // Construct an update job that is overridden as another job type.
  ServiceWorkerUpdateJob(
      Type aType, nsIPrincipal* aPrincipal, const nsACString& aScope,
      nsCString aScriptSpec, ServiceWorkerUpdateViaCache aUpdateViaCache,
      const ServiceWorkerLifetimeExtension& aLifetimeExtension);

  virtual ~ServiceWorkerUpdateJob();

  // FailUpdateJob() must be called if an update job needs Finish() with
  // an error.
  void FailUpdateJob(ErrorResult& aRv);

  void FailUpdateJob(nsresult aRv);

  // The entry point when the update job is being used directly.  Job
  // types overriding this class should override this method to
  // customize behavior.
  virtual void AsyncExecute() override;

  // Set the registration to be operated on by Update() or to be immediately
  // returned as a result of the job.  This must be called before Update().
  void SetRegistration(ServiceWorkerRegistrationInfo* aRegistration);

  // Execute the bulk of the update job logic using the registration defined
  // by a previous SetRegistration() call.  This can be called by the overridden
  // AsyncExecute() to complete the job.  The Update() method will always call
  // Finish().  This method corresponds to the spec Update algorithm.
  void Update();

  ServiceWorkerUpdateViaCache GetUpdateViaCache() const;

 private:
  class CompareCallback;
  class ContinueUpdateRunnable;
  class ContinueInstallRunnable;

  // Utility method called after a script is loaded and compared to
  // our current cached script.
  void ComparisonResult(nsresult aStatus, bool aInCacheAndEqual,
                        serviceWorkerScriptCache::OnFailure aOnFailure,
                        const nsAString& aNewCacheName,
                        const nsACString& aMaxScope, nsLoadFlags aLoadFlags);

  // Utility method called after evaluating the worker script.
  void ContinueUpdateAfterScriptEval(bool aScriptEvaluationResult);

  // Utility method corresponding to the spec Install algorithm.
  void Install();

  // Utility method called after the install event is handled.
  void ContinueAfterInstallEvent(bool aInstallEventSuccess);

  RefPtr<ServiceWorkerRegistrationInfo> mRegistration;
  ServiceWorkerUpdateViaCache mUpdateViaCache;
  // The lifetime extension to be applied each time we interact with the
  // potentially new installing ServiceWorker.  A `FullLifetimeExtension` value
  // here (as used by/on behalf of window clients) means a fresh extension will
  // be granted with every lifecycle event, whereas a
  // `PropagatedLifetimeExtension` for updates initiated via ServiceWorkers will
  // have the same deadline applied each time.
  ServiceWorkerLifetimeExtension mLifetimeExtension;
  serviceWorkerScriptCache::OnFailure mOnFailure;
};

}  // namespace mozilla::dom

#endif  // mozilla_dom_serviceworkerupdatejob_h
