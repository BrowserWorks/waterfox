/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_workers_WorkerLoadInfo_h
#define mozilla_dom_workers_WorkerLoadInfo_h

#include "mozilla/OriginAttributes.h"
#include "mozilla/OriginTrials.h"
#include "mozilla/StorageAccess.h"
#include "mozilla/UniquePtr.h"
#include "mozilla/dom/ChannelInfo.h"
#include "mozilla/dom/OffThreadCSPContext.h"
#include "mozilla/dom/ServiceWorkerRegistrationDescriptor.h"
#include "mozilla/dom/WorkerCommon.h"
#include "mozilla/ipc/PBackgroundSharedTypes.h"
#include "mozilla/net/NeckoChannelParams.h"
#include "nsIInterfaceRequestor.h"
#include "nsILoadContext.h"
#include "nsIRequest.h"
#include "nsISupportsImpl.h"
#include "nsIWeakReferenceUtils.h"
#include "nsRFPService.h"
#include "nsTArray.h"

class nsIChannel;
class nsIContentSecurityPolicy;
class nsICookieJarSettings;
class nsILoadGroup;
class nsIPrincipal;
class nsIReferrerInfo;
class nsIRunnable;
class nsIScriptContext;
class nsIBrowserChild;
class nsIURI;
class nsPIDOMWindowInner;

namespace mozilla {

namespace ipc {
class PrincipalInfo;
}  // namespace ipc

namespace dom {

class WorkerPrivate;

struct WorkerLoadInfoData {
  // All of these should be released in
  // WorkerPrivateParent::ForgetMainThreadObjects.
  nsCOMPtr<nsIURI> mBaseURI;
  nsCOMPtr<nsIURI> mResolvedScriptURI;

  // This is the principal of the global (parent worker or a window) loading
  // the worker. It can be null if we are executing a ServiceWorker, otherwise,
  // except for data: URL, it must subsumes the worker principal.
  // If we load a data: URL, mPrincipal will be a null principal.
  nsCOMPtr<nsIPrincipal> mLoadingPrincipal;
  nsCOMPtr<nsIPrincipal> mPrincipal;
  nsCOMPtr<nsIPrincipal> mPartitionedPrincipal;

  // Taken from the parent context.
  nsCOMPtr<nsICookieJarSettings> mCookieJarSettings;

  // The CookieJarSettingsArgs of mCookieJarSettings.
  // This is specific for accessing on worker thread.
  net::CookieJarSettingsArgs mCookieJarSettingsArgs;

  nsCOMPtr<nsIScriptContext> mScriptContext;
  nsCOMPtr<nsPIDOMWindowInner> mWindow;
  nsCOMPtr<nsIContentSecurityPolicy> mCSP;
  UniquePtr<OffThreadCSPContext> mCSPContext;

  // IP address space inherited from the parent document's policy container.
  // Stored as uint16_t to avoid including nsILoadInfo.h in this header.
  // Maps to nsILoadInfo::IPAddressSpace enum values.
  uint16_t mIPAddressSpace = 0;  // nsILoadInfo::Unknown

  nsCOMPtr<nsIChannel> mChannel;
  nsCOMPtr<nsILoadGroup> mLoadGroup;

  class InterfaceRequestor final : public nsIInterfaceRequestor {
    NS_DECL_ISUPPORTS

   public:
    InterfaceRequestor(nsIPrincipal* aPrincipal, nsILoadGroup* aLoadGroup);
    void MaybeAddBrowserChild(nsILoadGroup* aLoadGroup);
    NS_IMETHOD GetInterface(const nsIID& aIID, void** aSink) override;

    void SetOuterRequestor(nsIInterfaceRequestor* aOuterRequestor) {
      MOZ_ASSERT(!mOuterRequestor);
      MOZ_ASSERT(aOuterRequestor);
      mOuterRequestor = aOuterRequestor;
    }

   private:
    ~InterfaceRequestor() = default;

    already_AddRefed<nsIBrowserChild> GetAnyLiveBrowserChild();

    nsCOMPtr<nsILoadContext> mLoadContext;
    nsCOMPtr<nsIInterfaceRequestor> mOuterRequestor;

    // Array of weak references to nsIBrowserChild.  We do not want to keep
    // BrowserChild actors alive for long after their ActorDestroy() methods are
    // called.
    nsTArray<nsWeakPtr> mBrowserChildList;
  };

  // Only set if we have a custom overridden load group
  RefPtr<InterfaceRequestor> mInterfaceRequestor;

  UniquePtr<mozilla::ipc::PrincipalInfo> mPrincipalInfo;
  UniquePtr<mozilla::ipc::PrincipalInfo> mPartitionedPrincipalInfo;
  nsCString mDomain;

  nsString mServiceWorkerCacheName;
  Maybe<ServiceWorkerDescriptor> mServiceWorkerDescriptor;
  Maybe<ServiceWorkerRegistrationDescriptor>
      mServiceWorkerRegistrationDescriptor;
  Maybe<ClientInfo> mSourceInfo;

  Maybe<ServiceWorkerDescriptor> mParentController;

  nsID mAgentClusterId;

  ChannelInfo mChannelInfo;
  nsLoadFlags mLoadFlags;

  uint64_t mWindowID;
  uint64_t mAssociatedBrowsingContextID;

  // mLanguageOverrideLocale and mLanguageOverride are used to propagate JS
  // locale and navigator.language/s overrides in workers if the override is set
  // on a related browsing context via browsingContext.languageOverride. They're
  // set for the new workers and updated if the browsingContext.languageOverride
  // is changed. At the moment it will only affect dedicated and shared workers.
  // Service workers will be handled in bug 2040904. For the SharedWorker the
  // behavior is if page A with override A creates a SharedWorker S and then
  // page B with override B also tries to create the same SharedWorker S, S has
  // already been created with the A overrides and will not automatically change
  // to the overrides on B. However, any page with a live SharedWorker binding
  // that experiences a change to its overrides will then send an update to all
  // related SharedWorkers.
  nsCString mLanguageOverrideLocale;
  nsTArray<nsString> mLanguageOverride;
  // mTimezoneOverride is used to propagate JS timezone override in workers
  // if the override is set on a related browsing context via
  // browsingContext.timezoneOverride. It's applied the same was as for
  // mLanguageOverrideLocale and mLanguageOverride.
  nsString mTimezoneOverride;

  nsCOMPtr<nsIReferrerInfo> mReferrerInfo;
  OriginTrials mTrials;
  bool mFromWindow;
  bool mXHRParamsAllowed;
  bool mWatchedByDevTools;
  StorageAccess mStorageAccess;
  bool mUseRegularPrincipal;
  bool mUsingStorageAccess;
  bool mSerialAllowed;
  bool mServiceWorkersTestingInWindow;
  bool mShouldResistFingerprinting;
  Maybe<RFPTargetSet> mOverriddenFingerprintingSettings;
  OriginAttributes mOriginAttributes;
  bool mIsThirdPartyContext;
  bool mIsOn3PCBExceptionList;

  // The header the main script was served with.
  nsCString mReportingEndpointsHeader;

  enum {
    eNotSet,
    eInsecureContext,
    eSecureContext,
  } mSecureContext;

  WorkerLoadInfoData();
  WorkerLoadInfoData(WorkerLoadInfoData&& aOther) = default;

  WorkerLoadInfoData& operator=(WorkerLoadInfoData&& aOther) = default;
};

struct WorkerLoadInfo : WorkerLoadInfoData {
  WorkerLoadInfo();
  WorkerLoadInfo(WorkerLoadInfo&& aOther) noexcept;
  ~WorkerLoadInfo();

  WorkerLoadInfo& operator=(WorkerLoadInfo&& aOther) = default;

  nsresult SetPrincipalsAndCSPOnMainThread(nsIPrincipal* aPrincipal,
                                           nsIPrincipal* aPartitionedPrincipal,
                                           nsILoadGroup* aLoadGroup,
                                           nsIContentSecurityPolicy* aCSP);

  nsresult GetPrincipalsAndLoadGroupFromChannel(
      nsIChannel* aChannel, nsIPrincipal** aPrincipalOut,
      nsIPrincipal** aPartitionedPrincipalOut, nsILoadGroup** aLoadGroupOut);

  nsresult SetPrincipalsAndCSPFromChannel(nsIChannel* aChannel);

  bool FinalChannelPrincipalIsValid(nsIChannel* aChannel);

#ifdef MOZ_DIAGNOSTIC_ASSERT_ENABLED
  bool PrincipalIsValid() const;

  bool PrincipalURIMatchesScriptURL();
#endif

  bool ProxyReleaseMainThreadObjects(WorkerPrivate* aWorkerPrivate);

  bool ProxyReleaseMainThreadObjects(
      WorkerPrivate* aWorkerPrivate,
      nsCOMPtr<nsILoadGroup>&& aLoadGroupToCancel);
};

}  // namespace dom
}  // namespace mozilla

#endif  // mozilla_dom_workers_WorkerLoadInfo_h
