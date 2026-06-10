/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_AdBlockingPolicy_h
#define mozilla_AdBlockingPolicy_h

#include "nsString.h"
#include "nsTArray.h"
#include "nsTHashMap.h"

class nsIChannel;
class nsILoadInfo;
class nsIURI;

namespace mozilla {

struct AdBlockingRequestSnapshot;
enum class AdBlockingPhase { Request, CachedLoad, Response };

class AdBlockingPolicy final {
 public:
  nsresult Capture(AdBlockingRequestSnapshot& aRequest, nsIURI* aUri,
                   nsILoadInfo* aLoadInfo, nsIChannel* aChannel,
                   AdBlockingPhase aPhase, bool aDiscoverNavigation = true);
  static bool IsCurrentContext(const AdBlockingRequestSnapshot& aRequest,
                               nsILoadInfo* aLoadInfo, nsIChannel* aChannel);
  uint64_t Generation() const { return mGeneration; }
  void SetDomainAllowances(const nsTArray<nsCString>& aSites,
                           const nsTArray<nsCString>& aDomains);
  void RememberTopHost(uint64_t aBrowserId, const nsACString& aHost);
  void RememberBlockedDocument(uint64_t aBrowserId, const nsACString& aHost,
                               const nsACString& aUrl);
  bool ConsumeBlockedDocument(uint64_t aBrowserId, const nsACString& aHost,
                              const nsACString& aUrl);
  void ForgetBlockedDocument(uint64_t aBrowserId);
  nsCString TopHost(uint64_t aBrowserId) const;
  bool HasNavigationBypass(uint64_t aBrowserId, bool aIsPrivate);
  void FinishResponse(nsIChannel* aChannel,
                      const AdBlockingRequestSnapshot& aRequest);
  void Clear();

 private:
  struct BlockedDocument {
    nsCString mHost;
    nsCString mUrl;
  };
  struct NavigationBypass {
    nsCString mSourceHost;
    uint64_t mUntil = 0;
  };
  static nsCString NormalizeHost(const nsACString& aHost);
  void RememberBypass(uint64_t aBrowserId, const nsACString& aSourceHost);
  bool ResolveNavigationBypass(AdBlockingRequestSnapshot& aRequest,
                               const nsTArray<nsCString>& aCandidates,
                               const nsTArray<nsCString>& aSources,
                               bool aCanUseSource, bool aDiscover);

  uint64_t mGeneration = 1;
  nsTHashMap<nsUint64HashKey, nsCString> mTopHosts;
  nsTArray<uint64_t> mTopHostOrder;
  nsTHashMap<nsUint64HashKey, BlockedDocument> mBlockedDocuments;
  nsTArray<uint64_t> mBlockedDocumentOrder;
  nsTHashMap<nsUint64HashKey, NavigationBypass> mNavigationBypasses;
  nsTHashMap<nsCStringHashKey, nsTArray<nsCString>> mDomainAllowances;
};

}  // namespace mozilla

#endif
