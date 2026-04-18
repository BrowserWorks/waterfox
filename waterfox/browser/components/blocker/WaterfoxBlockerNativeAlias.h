/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef waterfox_blocker_native_alias_h
#define waterfox_blocker_native_alias_h

#include <stdint.h>

#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/RefPtr.h"
#include "nsHashKeys.h"
#include "nsIHttpChannel.h"
#include "nsISupportsImpl.h"
#include "nsString.h"
#include "nsTHashMap.h"

class WaterfoxBlockerNativeAlias final {
 public:
  NS_INLINE_DECL_REFCOUNTING(WaterfoxBlockerNativeAlias)

  bool CheckRequestDetailedWithNativeAliasCache(
      mozilla::ContentClassifierEngine* aEngine, const nsACString& aUrl,
      const nsACString& aSourceHostname, const nsACString& aHostname,
      const nsACString& aRequestType, nsACString& aOutJson);

  nsresult MaybeBlockRequestWithNativeAlias(
      mozilla::ContentClassifierEngine* aEngine, nsIHttpChannel* aChannel,
      const nsACString& aUrl, const nsACString& aSourceHostname,
      const nsACString& aHostname, const nsACString& aRequestType,
      uint64_t aBrowserId);

  // Used by the file-local async DNS listener callback to keep the uncloaked
  // hostname cache and live-channel follow-up in one native helper.
  void CacheCanonicalHostname(const nsACString& aHostname,
                              const nsACString& aCanonicalHostname);
  bool MaybeBlockWithCanonicalHostname(
      mozilla::ContentClassifierEngine* aEngine, nsIHttpChannel* aChannel,
      const nsACString& aUrl, const nsACString& aSourceHostname,
      const nsACString& aHostname, const nsACString& aRequestType,
      const nsACString& aCanonicalHostname, uint64_t aBrowserId);

 private:
  ~WaterfoxBlockerNativeAlias() = default;

  bool ProxySettingsAllowUncloaking() const;
  bool GetCachedCanonicalHostname(const nsACString& aHostname,
                                  nsACString& aOutCanonicalHostname) const;
  bool CheckRequestAgainstCanonicalHostname(
      mozilla::ContentClassifierEngine* aEngine, const nsACString& aUrl,
      const nsACString& aSourceHostname, const nsACString& aRequestType,
      const nsACString& aCanonicalHostname, bool* aOutMatched,
      bool* aOutImportant, nsACString& aOutRedirect,
      nsACString& aOutRewrittenUrl, nsACString& aOutException);
  void NotifyNativeBlockedRequest(uint64_t aBrowserId, const nsACString& aUrl,
                                  const nsACString& aHostname,
                                  const nsACString& aRequestType);

  nsTHashMap<nsCStringHashKey, nsCString> mCanonicalHostByHost;
};

#endif  // waterfox_blocker_native_alias_h
