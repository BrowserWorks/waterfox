/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "SSLTokensCache.h"

#include <cstring>

#include "mozilla/Components.h"

#include "CertVerifier.h"
#include "brotli/decode.h"
#include "brotli/encode.h"
#include "CommonSocketControl.h"
#include "mozilla/EndianUtils.h"
#include "TransportSecurityInfo.h"
#include "mozilla/ArrayAlgorithm.h"
#include "mozilla/BrotliUtils.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/glean/NetwerkMetrics.h"
#include "mozilla/Logging.h"
#include "mozilla/Preferences.h"
#include "mozilla/OriginAttributes.h"
#include "mozilla/Services.h"
#include "mozilla/StaticPrefs_privacy.h"
#include "nsAppDirectoryServiceDefs.h"
#include "nsDirectoryServiceUtils.h"
#include "nsIOService.h"
#include "nsIEventTarget.h"
#include "nsThreadUtils.h"
#include "nsIObserverService.h"
#include "prtime.h"
#include "ssl.h"
#include "sslexp.h"
#include "mozilla/net/ssl_tokens_cache.h"
#include "mozilla/ipc/ByteBuf.h"
#include "mozilla/net/SocketProcessChild.h"
#include "mozilla/net/SocketProcessParent.h"

namespace mozilla {
namespace net {

static LazyLogModule gSSLTokensCacheLog("SSLTokensCache");
#undef LOG
#define LOG(args) MOZ_LOG(gSSLTokensCacheLog, mozilla::LogLevel::Debug, args)
#undef LOG5_ENABLED
#define LOG5_ENABLED() \
  MOZ_LOG_TEST(mozilla::net::gSSLTokensCacheLog, mozilla::LogLevel::Verbose)

class ExpirationComparator {
 public:
  bool Equals(SSLTokensCache::TokenCacheRecord* a,
              SSLTokensCache::TokenCacheRecord* b) const {
    return a->mExpirationTime == b->mExpirationTime;
  }
  bool LessThan(SSLTokensCache::TokenCacheRecord* a,
                SSLTokensCache::TokenCacheRecord* b) const {
    return a->mExpirationTime < b->mExpirationTime;
  }
};

static nsTArray<nsTArray<uint8_t>> CloneCertChain(
    const nsTArray<nsTArray<uint8_t>>& aSrc) {
  return TransformIntoNewArray(aSrc, [](const auto& c) { return c.Clone(); });
}

SessionCacheInfo SessionCacheInfo::Clone() const {
  SessionCacheInfo result;
  result.mEVStatus = mEVStatus;
  result.mCertificateTransparencyStatus = mCertificateTransparencyStatus;
  result.mServerCertBytes = mServerCertBytes.Clone();
  result.mSucceededCertChainBytes =
      mSucceededCertChainBytes.map(CloneCertChain);
  result.mIsBuiltCertChainRootBuiltInRoot = mIsBuiltCertChainRootBuiltInRoot;
  result.mOverridableErrorCategory = mOverridableErrorCategory;
  result.mHandshakeCertificatesBytes =
      mHandshakeCertificatesBytes.map(CloneCertChain);
  return result;
}

// Serialized payload layout (all integers little-endian):
//   [4: token_len][token bytes]
//   [1: ev_status]
//   [2: ct_status]
//   [1: overridable_error]
//   [1: builtin_root] (0=Nothing, 1=Some(false), 2=Some(true))
//   [4: server_cert_len][server_cert bytes]
//   [1: has_succeeded_chain] if 1: [1: count] then for each [4: len][bytes]
//   [1: has_handshake_certs] if 1: [1: count] then for each [4: len][bytes]
//
// Stored compressed with a 4-byte LE original-size prefix.

template <typename T>
static void AppendLE(nsTArray<uint8_t>& aBuf, T aVal) {
  T le = mozilla::NativeEndian::swapToLittleEndian(aVal);
  aBuf.AppendElements(reinterpret_cast<const uint8_t*>(&le), sizeof(T));
}

static nsTArray<uint8_t> SerializeRecord(Span<const uint8_t> aToken,
                                         const SessionCacheInfo& aInfo) {
  nsTArray<uint8_t> buf;
  AppendLE(buf, AssertedCast<uint32_t>(aToken.Length()));
  buf.AppendElements(aToken.Elements(), aToken.Length());
  buf.AppendElement(aInfo.mEVStatus == psm::EVStatus::EV ? 1 : 0);
  AppendLE(buf, aInfo.mCertificateTransparencyStatus);
  buf.AppendElement(static_cast<uint8_t>(aInfo.mOverridableErrorCategory));
  if (aInfo.mIsBuiltCertChainRootBuiltInRoot.isNothing()) {
    buf.AppendElement(0);
  } else {
    buf.AppendElement(*aInfo.mIsBuiltCertChainRootBuiltInRoot ? 2 : 1);
  }
  AppendLE(buf, AssertedCast<uint32_t>(aInfo.mServerCertBytes.Length()));
  buf.AppendElements(aInfo.mServerCertBytes.Elements(),
                     aInfo.mServerCertBytes.Length());
  auto appendChain = [&](const Maybe<nsTArray<nsTArray<uint8_t>>>& aChain) {
    if (aChain.isNothing()) {
      buf.AppendElement(0);
      return;
    }
    buf.AppendElement(1);
    MOZ_RELEASE_ASSERT(aChain->Length() <= 0xFF);
    buf.AppendElement(static_cast<uint8_t>(aChain->Length()));
    for (const auto& cert : *aChain) {
      AppendLE(buf, AssertedCast<uint32_t>(cert.Length()));
      buf.AppendElements(cert.Elements(), cert.Length());
    }
  };
  appendChain(aInfo.mSucceededCertChainBytes);
  appendChain(aInfo.mHandshakeCertificatesBytes);
  return buf;
}

// Returns empty array on failure.
static nsTArray<uint8_t> CompressRecord(Span<const uint8_t> aPayload) {
  if (aPayload.Length() > 256 * 1024) {
    return {};
  }
  size_t bound = BrotliEncoderMaxCompressedSize(aPayload.Length());
  CheckedInt<size_t> length = CheckedInt<size_t>(bound) + 4;
  nsTArray<uint8_t> result;
  if (!bound || !length.isValid() ||
      !result.SetLength(length.value(), fallible)) {
    return {};
  }
  uint32_t originalLen = AssertedCast<uint32_t>(aPayload.Length());
  LittleEndian::writeUint32(result.Elements(), originalLen);
  std::memset(result.Elements() + 4, 0, bound);
  size_t encodedSize = bound;
  if (!BrotliEncoderCompress(5, BROTLI_DEFAULT_WINDOW, BROTLI_MODE_GENERIC,
                             aPayload.Length(), aPayload.Elements(),
                             &encodedSize, result.Elements() + 4)) {
    return {};
  }
  result.TruncateLength(4 + encodedSize);
  return result;
}

// Returns empty array on failure.
static nsTArray<uint8_t> DecompressRecord(Span<const uint8_t> aCompressed) {
  if (aCompressed.Length() < 4) {
    return {};
  }
  uint32_t originalLen = LittleEndian::readUint32(aCompressed.Elements());
  if (originalLen > 256 * 1024) {
    LOG(("SSLTokensCache: implausible payload originalLen %" PRIu32,
         originalLen));
    return {};
  }
  nsTArray<uint8_t> result;
  if (!result.SetLength(originalLen, fallible)) {
    return {};
  }
  size_t decodedSize = originalLen;
  BrotliDecoderResult r = MozBrotliDecoderDecompress(
      aCompressed.Length() - 4, aCompressed.Elements() + 4, &decodedSize,
      result.Elements());
  if (r != BROTLI_DECODER_RESULT_SUCCESS || decodedSize != originalLen) {
    return {};
  }
  return result;
}

struct PayloadReader {
  Span<const uint8_t> buf;
  size_t pos = 0;

  template <typename T>
  bool Read(T& out) {
    if (buf.Length() - pos < sizeof(T)) return false;
    if constexpr (sizeof(T) == 1) {
      out = static_cast<T>(buf[pos]);
    } else {
      T le;
      memcpy(&le, buf.Elements() + pos, sizeof(T));
      out = mozilla::NativeEndian::swapFromLittleEndian(le);
    }
    pos += sizeof(T);
    return true;
  }
  bool Bytes(nsTArray<uint8_t>& out, uint32_t len) {
    if (buf.Length() - pos < len) return false;
    if (!out.SetLength(len, fallible)) return false;
    memcpy(out.Elements(), buf.Elements() + pos, len);
    pos += len;
    return true;
  }
  bool AtEnd() const { return pos == buf.Length(); }
};

static bool DeserializeRecord(Span<const uint8_t> aBuf,
                              nsTArray<uint8_t>& aToken,
                              SessionCacheInfo& aInfo) {
  PayloadReader r{aBuf};

  uint32_t tokenLen;
  if (!r.Read(tokenLen)) return false;
  if (tokenLen > 256 * 1024) return false;
  if (!r.Bytes(aToken, tokenLen)) return false;

  uint8_t evStatus;
  if (!r.Read(evStatus)) return false;
  aInfo.mEVStatus = evStatus ? psm::EVStatus::EV : psm::EVStatus::NotEV;

  uint16_t ctStatus;
  if (!r.Read(ctStatus)) return false;
  aInfo.mCertificateTransparencyStatus = ctStatus;

  uint8_t overridableError;
  if (!r.Read(overridableError)) return false;
  aInfo.mOverridableErrorCategory =
      static_cast<nsITransportSecurityInfo::OverridableErrorCategory>(
          overridableError);

  uint8_t builtinRoot;
  if (!r.Read(builtinRoot)) return false;
  if (builtinRoot == 0) {
    aInfo.mIsBuiltCertChainRootBuiltInRoot = Nothing();
  } else if (builtinRoot == 1) {
    aInfo.mIsBuiltCertChainRootBuiltInRoot = Some(false);
  } else if (builtinRoot == 2) {
    aInfo.mIsBuiltCertChainRootBuiltInRoot = Some(true);
  } else {
    return false;
  }

  uint32_t serverCertLen;
  if (!r.Read(serverCertLen)) return false;
  if (serverCertLen > 64 * 1024) return false;
  if (!r.Bytes(aInfo.mServerCertBytes, serverCertLen)) return false;

  auto readChain = [&](Maybe<nsTArray<nsTArray<uint8_t>>>& aChain) -> bool {
    uint8_t present;
    if (!r.Read(present)) return false;
    if (!present) {
      aChain = Nothing();
      return true;
    }
    uint8_t count;
    if (!r.Read(count)) return false;
    nsTArray<nsTArray<uint8_t>> chain;
    for (uint8_t i = 0; i < count; i++) {
      uint32_t certLen;
      if (!r.Read(certLen)) return false;
      if (certLen > 64 * 1024) return false;
      nsTArray<uint8_t> cert;
      if (!r.Bytes(cert, certLen)) return false;
      chain.AppendElement(std::move(cert));
    }
    aChain = Some(std::move(chain));
    return true;
  };

  if (!readChain(aInfo.mSucceededCertChainBytes)) return false;
  if (!readChain(aInfo.mHandshakeCertificatesBytes)) return false;
  return r.AtEnd();
}

StaticRefPtr<SSLTokensCache> SSLTokensCache::gInstance;
StaticMutex SSLTokensCache::sLock;
uint64_t SSLTokensCache::sRecordId = 0;

SSLTokensCache::TokenCacheRecord::~TokenCacheRecord() {
  if (!gInstance) {
    return;
  }
  gInstance->OnRecordDestroyed(this);
}

uint32_t SSLTokensCache::TokenCacheRecord::Size() const {
  return mKey.Length() + mCompressedPayload.Length();
}

uint32_t SSLTokensCache::TokenCacheEntry::Size() const {
  uint32_t size = 0;
  for (const auto& rec : mRecords) {
    size += rec->Size();
  }
  return size;
}

void SSLTokensCache::TokenCacheEntry::AddRecord(
    UniquePtr<SSLTokensCache::TokenCacheRecord>&& aRecord,
    nsTArray<TokenCacheRecord*>& aExpirationArray) {
  if (mRecords.Length() ==
      StaticPrefs::network_ssl_tokens_cache_records_per_entry()) {
    aExpirationArray.RemoveElement(mRecords[0].get());
    mRecords.RemoveElementAt(0);
  }

  aExpirationArray.AppendElement(aRecord.get());
  for (int32_t i = mRecords.Length() - 1; i >= 0; --i) {
    if (aRecord->mExpirationTime > mRecords[i]->mExpirationTime) {
      mRecords.InsertElementAt(i + 1, std::move(aRecord));
      return;
    }
  }
  mRecords.InsertElementAt(0, std::move(aRecord));
}

UniquePtr<SSLTokensCache::TokenCacheRecord>
SSLTokensCache::TokenCacheEntry::RemoveWithId(uint64_t aId) {
  for (int32_t i = mRecords.Length() - 1; i >= 0; --i) {
    if (mRecords[i]->mId == aId) {
      UniquePtr<TokenCacheRecord> record = std::move(mRecords[i]);
      mRecords.RemoveElementAt(i);
      return record;
    }
  }
  return nullptr;
}

const UniquePtr<SSLTokensCache::TokenCacheRecord>&
SSLTokensCache::TokenCacheEntry::Get() {
  return mRecords[0];
}

NS_IMPL_ISUPPORTS(SSLTokensCache, nsIMemoryReporter, nsIObserver,
                  nsIAsyncShutdownBlocker)

template <typename Pred>
void SSLTokensCache::RemoveMatchingLocked(Pred&& aPredicate) {
  sLock.AssertCurrentThreadOwns();
  AutoTArray<nsCString, 4> keysToRemove;
  for (const auto& entry : mTokenCacheRecords) {
    if (aPredicate(entry.GetKey())) {
      keysToRemove.AppendElement(entry.GetKey());
    }
  }
  for (const auto& key : keysToRemove) {
    (void)RemoveAllLocked(key);
  }
}

// static
void SSLTokensCache::PutFromPersistedCallback(
    void* aCtx, const SslTokensPersistedRecord* aRec) {
  (void)PutFromPersisted(aRec, *static_cast<uint32_t*>(aCtx));
}

// static
void SSLTokensCache::LoadCallback(void* aCtx,
                                  const SslTokensPersistedRecord* aRec) {
  auto* ctx = static_cast<LoadCtx*>(aCtx);
  if (PutFromPersisted(aRec, ctx->loadGen)) {
    ctx->count++;
  }
}

void SSLTokensCache::ClearCacheLocked() {
  sLock.AssertCurrentThreadOwns();
  mLoadGeneration++;
  mExpirationArray.Clear();
  mTokenCacheRecords.Clear();
  mCacheSize = 0;
}

// static
nsTArray<uint8_t> SSLTokensCache::SerializeForIPC() {
  StaticMutexAutoLock lock(sLock);
  return SerializeSnapshotLocked();
}

// static
void SSLTokensCache::DeserializeFromIPC(Span<const uint8_t> aData) {
  if (aData.IsEmpty()) {
    return;
  }
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    gInstance->ClearCacheLocked();
    loadGen = gInstance->mLoadGeneration;
  }
  // callback is invoked synchronously within ssl_tokens_cache_deserialize_ipc,
  // so &loadGen remains valid for the entire call.
  ssl_tokens_cache_deserialize_ipc(aData.data(), aData.Length(), PR_Now(),
                                   PutFromPersistedCallback, &loadGen);
}

// static
void SSLTokensCache::DeserializeFromIPCAsync(mozilla::ipc::ByteBuf&& aBuf) {
  if (aBuf.mLen == 0) {
    return;
  }
  NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "SSLTokensCache::DeserializeFromIPCAsync", [buf = std::move(aBuf)]() {
        DeserializeFromIPC(Span(buf.mData, buf.mLen));
      }));
}

// static
nsDependentCSubstring SSLTokensCache::BasePartFromKey(const nsACString& aKey) {
  int32_t caretPos = aKey.FindChar('^');
  return nsDependentCSubstring(
      aKey, 0, caretPos == kNotFound ? aKey.Length() : caretPos);
}

// static
// Extracts the host from a key's base part ("host:port" or "prefix:host:port").
// Returns an empty string if no colon is found.
nsDependentCSubstring SSLTokensCache::HostFromBasePart(
    const nsDependentCSubstring& aBasePart) {
  int32_t lastColon = aBasePart.RFindChar(':');
  if (lastColon == kNotFound) {
    return nsDependentCSubstring();
  }
  return nsDependentCSubstring(aBasePart, 0, lastColon);
}

// static
OriginAttributes SSLTokensCache::OAFromPeerId(const nsACString& aPeerId) {
  OriginAttributes oa;
  int32_t caretPos = aPeerId.FindChar('^');
  if (caretPos != kNotFound) {
    nsAutoCString suffix(Substring(aPeerId, caretPos + 1));
    (void)oa.PopulateFromSuffix(suffix);
  }
  return oa;
}

// static
nsCString SSLTokensCache::SetupPersistenceLocked(uint32_t& aLoadGen) {
  sLock.AssertCurrentThreadOwns();
  MOZ_ASSERT(gInstance);
  MOZ_ASSERT(!gInstance->mBackingFile);

  nsCOMPtr<nsIFile> profileDir;
  if (NS_FAILED(NS_GetSpecialDirectory(NS_APP_USER_PROFILE_50_DIR,
                                       getter_AddRefs(profileDir)))) {
    return ""_ns;
  }
  profileDir->Clone(getter_AddRefs(gInstance->mBackingFile));
  gInstance->mBackingFile->AppendNative("ssl_tokens_cache.bin"_ns);

  nsCOMPtr<nsISerialEventTarget> writeQueue;
  NS_CreateBackgroundTaskQueue("SslTokensCachePersist",
                               getter_AddRefs(writeQueue));
  gInstance->mWriteTaskQueue = writeQueue;

  gInstance->mLoadStartTime = TimeStamp::Now();
  aLoadGen = gInstance->mLoadGeneration;

  nsAutoString widePath;
  gInstance->mBackingFile->GetPath(widePath);
  return NS_ConvertUTF16toUTF8(widePath);
}

// static
nsresult SSLTokensCache::Init() {
  MOZ_ASSERT(NS_IsMainThread());
  nsCString backgroundLoadPath;
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);

    // SSLTokensCache is used in both the parent process and the socket process.
    // The socket process runs TLS handshakes and holds the live token cache;
    // the parent process holds the persistence layer (disk I/O) and receives
    // periodic token updates from the socket process via IPC.
    // Some xpcshell tests also use sockets directly in the parent process.
    if (!(XRE_IsSocketProcess() || XRE_IsParentProcess())) {
      return NS_OK;
    }

    MOZ_ASSERT(!gInstance);

    gInstance = new SSLTokensCache();

    RegisterWeakMemoryReporter(gInstance);

    // Register unconditionally: user prefs are applied during
    // profile-after-change, after Init() runs.
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (obs && XRE_IsParentProcess()) {
      obs->AddObserver(gInstance, "profile-after-change", false);
    }

    if (!StaticPrefs::network_ssl_tokens_cache_persistence()) {
      return NS_OK;
    }

    if (obs) {
      obs->AddObserver(gInstance, "application-background", false);
      obs->AddObserver(gInstance, "idle-daily", false);
      gInstance->mWriteObserversRegistered = true;
    }

    if (!XRE_IsParentProcess()) {
      return NS_OK;
    }

    backgroundLoadPath = SetupPersistenceLocked(loadGen);
  }  // sLock released before dispatching

  DispatchLoad(std::move(backgroundLoadPath), loadGen);
  return NS_OK;
}

// static
nsresult SSLTokensCache::Shutdown() {
  RefPtr<SSLTokensCache> instance;
  nsCOMPtr<nsIObserverService> obs;
  bool blockerRegistered = false;
  {
    StaticMutexAutoLock lock(sLock);

    if (!gInstance) {
      return NS_ERROR_UNEXPECTED;
    }

    UnregisterWeakMemoryReporter(gInstance);
    instance = gInstance;
    obs = mozilla::services::GetObserverService();
    blockerRegistered = gInstance->mShutdownBarrier != nullptr;
  }

  // With no blocker, BlockShutdown will never fire: write synchronously
  // (test environments only) and clear gInstance now. Otherwise leave
  // gInstance set so BlockShutdown -> DoWrite -> SerializeSnapshotLocked
  // can build the snapshot; RemoveShutdownBlocker nulls it afterward.
  if (!blockerRegistered) {
#ifdef ENABLE_TESTS
    instance->DoWrite(true);
#endif
    StaticMutexAutoLock lock(sLock);
    gInstance = nullptr;
  }

  if (obs && instance) {
    bool hadWriteObservers;
    {
      StaticMutexAutoLock lock(sLock);
      hadWriteObservers = instance->mWriteObserversRegistered;
    }
    if (hadWriteObservers) {
      obs->RemoveObserver(instance, "application-background");
      obs->RemoveObserver(instance, "idle-daily");
    }
    if (XRE_IsParentProcess()) {
      obs->RemoveObserver(instance, "profile-after-change");
    }
  }
  return NS_OK;
}

SSLTokensCache::SSLTokensCache() { LOG(("SSLTokensCache::SSLTokensCache")); }

SSLTokensCache::~SSLTokensCache() { LOG(("SSLTokensCache::~SSLTokensCache")); }

nsTArray<SslTokensPersistedRecord> SSLTokensCache::CollectSnapshotLocked()
    const {
  sLock.AssertCurrentThreadOwns();
  nsTArray<SslTokensPersistedRecord> snapshot;
  for (const auto& entry : mTokenCacheRecords.Values()) {
    for (const auto& rec : entry->Records()) {
      if (!ShouldPersistKey(rec->mKey, rec->mOverridableError)) {
        continue;
      }
      auto& ffi = *snapshot.AppendElement();
      ffi.id = rec->mId;
      ffi.key = rec->mKey;
      ffi.expiration_time = static_cast<int64_t>(rec->mExpirationTime);
      ffi.overridable_error = rec->mOverridableError;
      ffi.compressed_payload = rec->mCompressedPayload.Elements();
      ffi.compressed_payload_len = rec->mCompressedPayload.Length();
    }
  }
  return snapshot;
}

// static
nsTArray<uint8_t> SSLTokensCache::SerializeSnapshotLocked() {
  sLock.AssertCurrentThreadOwns();
  if (!gInstance) {
    return {};
  }
  auto snapshot = gInstance->CollectSnapshotLocked();
  if (snapshot.IsEmpty()) {
    return {};
  }
  nsTArray<uint8_t> out;
  ssl_tokens_cache_serialize_snapshot(&snapshot, &out);
  return out;
}

// static
nsresult SSLTokensCache::Put(const nsACString& aKey, const uint8_t* aToken,
                             uint32_t aTokenLen,
                             CommonSocketControl* aSocketControl) {
  PRTime expirationTime;
  SSLResumptionTokenInfo tokenInfo;
  if (SSL_GetResumptionTokenInfo(aToken, aTokenLen, &tokenInfo,
                                 sizeof(tokenInfo)) != SECSuccess) {
    LOG(("  cannot get expiration time from the token, NSS error %d",
         PORT_GetError()));
    return NS_ERROR_FAILURE;
  }

  expirationTime = tokenInfo.expirationTime;
  SSL_DestroyResumptionTokenInfo(&tokenInfo);

  return Put(aKey, aToken, aTokenLen, aSocketControl, expirationTime);
}

// static
nsresult SSLTokensCache::Put(const nsACString& aKey, const uint8_t* aToken,
                             uint32_t aTokenLen,
                             CommonSocketControl* aSocketControl,
                             PRTime aExpirationTime) {
  LOG(("SSLTokensCache::Put [key=%s, tokenLen=%u]",
       PromiseFlatCString(aKey).get(), aTokenLen));

  if (!aSocketControl) {
    return NS_ERROR_FAILURE;
  }

  nsCOMPtr<nsITransportSecurityInfo> securityInfo;
  nsresult rv = aSocketControl->GetSecurityInfo(getter_AddRefs(securityInfo));
  if (NS_FAILED(rv)) {
    return rv;
  }

  nsCOMPtr<nsIX509Cert> cert;
  securityInfo->GetServerCert(getter_AddRefs(cert));
  if (!cert) {
    return NS_ERROR_FAILURE;
  }

  nsTArray<uint8_t> certBytes;
  rv = cert->GetRawDER(certBytes);
  if (NS_FAILED(rv)) {
    return rv;
  }

  Maybe<nsTArray<nsTArray<uint8_t>>> succeededCertChainBytes;
  nsTArray<RefPtr<nsIX509Cert>> succeededCertArray;
  rv = securityInfo->GetSucceededCertChain(succeededCertArray);
  if (NS_FAILED(rv)) {
    return rv;
  }

  auto getRawDerAll = [](nsTArray<RefPtr<nsIX509Cert>>& aCerts)
      -> Result<nsTArray<nsTArray<uint8_t>>, nsresult> {
    return TransformIntoNewArrayAbortOnErr(
        aCerts,
        [](const RefPtr<nsIX509Cert>& aCert)
            -> Result<nsTArray<uint8_t>, nsresult> {
          nsTArray<uint8_t> raw;
          MOZ_TRY(aCert->GetRawDER(raw));
          return std::move(raw);
        },
        fallible);
  };

  Maybe<bool> isBuiltCertChainRootBuiltInRoot;
  if (!succeededCertArray.IsEmpty()) {
    auto result = getRawDerAll(succeededCertArray);
    if (result.isErr()) return result.unwrapErr();
    succeededCertChainBytes.emplace(result.unwrap());

    bool builtInRoot = false;
    rv = securityInfo->GetIsBuiltCertChainRootBuiltInRoot(&builtInRoot);
    if (NS_FAILED(rv)) {
      return rv;
    }
    isBuiltCertChainRootBuiltInRoot.emplace(builtInRoot);
  }

  bool isEV;
  rv = securityInfo->GetIsExtendedValidation(&isEV);
  if (NS_FAILED(rv)) {
    return rv;
  }

  uint16_t certificateTransparencyStatus;
  rv = securityInfo->GetCertificateTransparencyStatus(
      &certificateTransparencyStatus);
  if (NS_FAILED(rv)) {
    return rv;
  }

  nsITransportSecurityInfo::OverridableErrorCategory overridableErrorCategory;
  rv = securityInfo->GetOverridableErrorCategory(&overridableErrorCategory);
  if (NS_FAILED(rv)) {
    return rv;
  }

  Maybe<nsTArray<nsTArray<uint8_t>>> handshakeCertificatesBytes;
  nsTArray<RefPtr<nsIX509Cert>> handshakeCertificates;
  rv = securityInfo->GetHandshakeCertificates(handshakeCertificates);
  if (NS_FAILED(rv)) {
    return rv;
  }
  if (!handshakeCertificates.IsEmpty()) {
    auto result = getRawDerAll(handshakeCertificates);
    if (result.isErr()) return result.unwrapErr();
    handshakeCertificatesBytes.emplace(result.unwrap());
  }

  SessionCacheInfo info;
  info.mEVStatus = isEV ? psm::EVStatus::EV : psm::EVStatus::NotEV;
  info.mCertificateTransparencyStatus = certificateTransparencyStatus;
  info.mOverridableErrorCategory = overridableErrorCategory;
  info.mIsBuiltCertChainRootBuiltInRoot = isBuiltCertChainRootBuiltInRoot;
  info.mServerCertBytes = std::move(certBytes);
  info.mSucceededCertChainBytes = std::move(succeededCertChainBytes);
  info.mHandshakeCertificatesBytes = std::move(handshakeCertificatesBytes);

  nsTArray<uint8_t> payload = SerializeRecord({aToken, aTokenLen}, info);
  nsTArray<uint8_t> compressed = CompressRecord(payload);
  if (compressed.IsEmpty()) {
    LOG(("SSLTokensCache::Put: compression failed"));
    return NS_ERROR_FAILURE;
  }

  {
    StaticMutexAutoLock lock(sLock);

    if (!gInstance) {
      LOG(("  service not initialized"));
      return NS_ERROR_NOT_INITIALIZED;
    }

    auto makeRecord = [&]() MOZ_REQUIRES(sLock) {
      auto rec = MakeUnique<TokenCacheRecord>();
      rec->mKey = aKey;
      rec->mExpirationTime = aExpirationTime;
      rec->mOverridableError = static_cast<uint8_t>(overridableErrorCategory);
      rec->mCompressedPayload = std::move(compressed);
      return rec;
    };

    gInstance->InsertRecordLocked(makeRecord());
    gInstance->LogStats();

  }  // sLock released

  return NS_OK;
}

// static
nsresult SSLTokensCache::Get(const nsACString& aKey, nsTArray<uint8_t>& aToken,
                             SessionCacheInfo& aResult, uint64_t* aTokenId) {
  LOG(("SSLTokensCache::Get [key=%s]", PromiseFlatCString(aKey).get()));

  StaticMutexAutoLock lock(sLock);
  if (!gInstance) {
    LOG(("  service not initialized"));
    return NS_ERROR_NOT_INITIALIZED;
  }
  UniquePtr<TokenCacheRecord> owned =
      gInstance->GetRecordLocked(aKey, aTokenId);
  if (!owned) {
    return NS_ERROR_NOT_AVAILABLE;
  }
  nsTArray<uint8_t> payload = DecompressRecord(owned->mCompressedPayload);
  if (payload.IsEmpty() || !DeserializeRecord(payload, aToken, aResult)) {
    return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

UniquePtr<SSLTokensCache::TokenCacheRecord> SSLTokensCache::GetRecordLocked(
    const nsACString& aKey, uint64_t* aTokenId) {
  sLock.AssertCurrentThreadOwns();

  if (!mLoadComplete && mBackingFile) {
    LOG(("SSLTokensCache::GetRecordLocked: connection before load complete"));
    mozilla::glean::network::ssl_token_cache_early_connections.Add(1);
  }

  TokenCacheEntry* cacheEntry = nullptr;

  if (mTokenCacheRecords.Get(aKey, &cacheEntry)) {
    if (cacheEntry->RecordCount() == 0) {
      MOZ_ASSERT(false, "Found a cacheEntry with no records");
      mTokenCacheRecords.Remove(aKey);
      return nullptr;
    }

    PRTime now = PR_Now();

    while (cacheEntry->RecordCount() > 0) {
      const UniquePtr<TokenCacheRecord>& rec = cacheEntry->Get();

      if (rec->mExpirationTime > now) {
        uint64_t id = rec->mId;
        uint32_t size = rec->Size();
        UniquePtr<TokenCacheRecord> owned = cacheEntry->RemoveWithId(id);
        if (aTokenId) {
          *aTokenId = id;
        }
        mCacheSize -= size;
        if (cacheEntry->RecordCount() == 0) {
          mTokenCacheRecords.Remove(aKey);
        }
        mozilla::glean::network::ssl_token_cache_hits.Get("hit"_ns).Add(1);
        LOG(("SSLTokensCache::GetRecordLocked: hit [key=%s, load_complete=%s]",
             PromiseFlatCString(aKey).get(), mLoadComplete ? "yes" : "no"));
        return owned;
      }

      LOG(("  skipping expired token [expirationTime=%" PRId64 ", now=%" PRId64
           "]",
           rec->mExpirationTime, now));
      mozilla::glean::network::ssl_token_cache_expired.Add(1);
      uint64_t expiredId = rec->mId;
      mCacheSize -= rec->Size();
      cacheEntry->RemoveWithId(expiredId);
    }

    mTokenCacheRecords.Remove(aKey);
  }

  LOG(("  token not found"));
  mozilla::glean::network::ssl_token_cache_hits.Get("miss"_ns).Add(1);
  return nullptr;
}

// static
nsresult SSLTokensCache::Remove(const nsACString& aKey, uint64_t aId) {
  StaticMutexAutoLock lock(sLock);

  LOG(("SSLTokensCache::Remove [key=%s]", PromiseFlatCString(aKey).get()));

  if (!gInstance) {
    LOG(("  service not initialized"));
    return NS_ERROR_NOT_INITIALIZED;
  }

  return gInstance->RemoveLocked(aKey, aId);
}

nsresult SSLTokensCache::RemoveLocked(const nsACString& aKey, uint64_t aId) {
  sLock.AssertCurrentThreadOwns();

  LOG(("SSLTokensCache::RemoveLocked [key=%s, id=%" PRIu64 "]",
       PromiseFlatCString(aKey).get(), aId));

  TokenCacheEntry* cacheEntry;
  if (!mTokenCacheRecords.Get(aKey, &cacheEntry)) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  UniquePtr<TokenCacheRecord> rec = cacheEntry->RemoveWithId(aId);
  if (!rec) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  mCacheSize -= rec->Size();
  if (cacheEntry->RecordCount() == 0) {
    mTokenCacheRecords.Remove(aKey);
  }

  // Release the record immediately, so mExpirationArray can be also updated.
  rec = nullptr;

  LogStats();

  return NS_OK;
}

// static
nsresult SSLTokensCache::RemoveAll(const nsACString& aKey) {
  StaticMutexAutoLock lock(sLock);

  LOG(("SSLTokensCache::RemoveAll [key=%s]", PromiseFlatCString(aKey).get()));

  if (!gInstance) {
    LOG(("  service not initialized"));
    return NS_ERROR_NOT_INITIALIZED;
  }

  return gInstance->RemoveAllLocked(aKey);
}

nsresult SSLTokensCache::RemoveAllLocked(const nsACString& aKey) {
  sLock.AssertCurrentThreadOwns();

  LOG(("SSLTokensCache::RemoveAllLocked [key=%s]",
       PromiseFlatCString(aKey).get()));

  UniquePtr<TokenCacheEntry> cacheEntry;
  if (!mTokenCacheRecords.Remove(aKey, &cacheEntry)) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  mCacheSize -= cacheEntry->Size();
  cacheEntry = nullptr;

  LogStats();

  return NS_OK;
}

void SSLTokensCache::OnRecordDestroyed(TokenCacheRecord* aRec) {
  // Always called from destructors of map entries while sLock is held.
  sLock.AssertCurrentThreadOwns();
  mExpirationArray.RemoveElement(aRec);
}

void SSLTokensCache::EvictIfNecessary() {
  sLock.AssertCurrentThreadOwns();
  // kilobytes to bytes
  uint32_t capacity = StaticPrefs::network_ssl_tokens_cache_capacity() << 10;
  if (mCacheSize <= capacity) {
    return;
  }

  LOG(("SSLTokensCache::EvictIfNecessary: evicting"));

  mExpirationArray.Sort(ExpirationComparator());

  PRTime now = PR_Now();
  while (mCacheSize > capacity && mExpirationArray.Length() > 0) {
    auto* rec = mExpirationArray[0];
    // Only count evictions of tokens that are still valid; already-expired
    // tokens would be discarded on lookup anyway and are tracked separately
    // by ssl_token_cache_expired.
    if (rec->mExpirationTime > now) {
      mozilla::glean::network::ssl_token_cache_evictions.Add(1);
    }
    DebugOnly<nsresult> rv = RemoveLocked(rec->mKey, rec->mId);
    MOZ_ASSERT(NS_SUCCEEDED(rv),
               "mExpirationArray and mTokenCacheRecords are out of sync!");
  }
}

void SSLTokensCache::LogStats() {
  sLock.AssertCurrentThreadOwns();
  if (!LOG5_ENABLED()) {
    return;
  }
  LOG(("SSLTokensCache::LogStats [count=%zu, cacheSize=%u]",
       mExpirationArray.Length(), mCacheSize));
  for (const auto& ent : mTokenCacheRecords.Values()) {
    const UniquePtr<TokenCacheRecord>& rec = ent->Get();
    LOG(("  [key=%s, count=%d]", rec->mKey.get(), ent->RecordCount()));
  }
}

size_t SSLTokensCache::SizeOfIncludingThis(
    mozilla::MallocSizeOf mallocSizeOf) const {
  size_t n = mallocSizeOf(this);

  n += mTokenCacheRecords.ShallowSizeOfExcludingThis(mallocSizeOf);
  n += mExpirationArray.ShallowSizeOfExcludingThis(mallocSizeOf);

  for (const auto* rec : mExpirationArray) {
    n += mallocSizeOf(rec);
    n += rec->mKey.SizeOfExcludingThisIfUnshared(mallocSizeOf);
    n += rec->mCompressedPayload.ShallowSizeOfExcludingThis(mallocSizeOf);
  }

  return n;
}

MOZ_DEFINE_MALLOC_SIZE_OF(SSLTokensCacheMallocSizeOf)

NS_IMETHODIMP
SSLTokensCache::CollectReports(nsIHandleReportCallback* aHandleReport,
                               nsISupports* aData, bool aAnonymize) {
  StaticMutexAutoLock lock(sLock);

  MOZ_COLLECT_REPORT("explicit/network/ssl-tokens-cache", KIND_HEAP,
                     UNITS_BYTES,
                     SizeOfIncludingThis(SSLTokensCacheMallocSizeOf),
                     "Memory used for the SSL tokens cache.");

  return NS_OK;
}

static void RemoveFilesSync(nsIFile* aBackingFile) {
  aBackingFile->Remove(false);
  nsCOMPtr<nsIFile> tmp;
  aBackingFile->Clone(getter_AddRefs(tmp));
  tmp->SetLeafName(u"ssl_tokens_cache.tmp"_ns);
  tmp->Remove(false);
}

static void DispatchFileRemoval(nsCOMPtr<nsIFile> aBackingFile) {
  NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "SSLTokensCache::RemoveFiles", [backingFile = std::move(aBackingFile)]() {
        RemoveFilesSync(backingFile);
      }));
}

// static
void SSLTokensCache::Clear() {
  LOG(("SSLTokensCache::Clear"));

  nsCOMPtr<nsIFile> backingFile;
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      LOG(("  service not initialized"));
      return;
    }

    gInstance->ClearCacheLocked();
    backingFile = gInstance->mBackingFile;
    taskQueue = gInstance->mWriteTaskQueue;
  }

  if (backingFile) {
    if (taskQueue) {
      // Route through the serial write queue so the deletion is ordered after
      // any pending write task and cannot re-create the file after deletion.
      InvokeAsync(taskQueue.get(), __func__,
                  [bf = std::move(backingFile)]() mutable {
                    RemoveFilesSync(bf);
                    return GenericPromise::CreateAndResolve(true, __func__);
                  });
    } else {
      DispatchFileRemoval(std::move(backingFile));
    }
  }
}

void SSLTokensCache::DoWrite(bool aSynchronous) {
  nsCOMPtr<nsIFile> backingFile;
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  nsTArray<uint8_t> serialized;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    backingFile = mBackingFile;
    taskQueue = mWriteTaskQueue;
    serialized = SerializeSnapshotLocked();
  }

  if (!backingFile) {
    if (XRE_IsSocketProcess() && !serialized.IsEmpty()) {
      NS_DispatchToMainThread(NS_NewRunnableFunction(
          "SSLTokensCache::SendToParent", [data = std::move(serialized)]() {
            auto* child = SocketProcessChild::GetSingleton();
            if (child && child->CanSend()) {
              (void)child->SendSSLTokensCacheData(
                  mozilla::ipc::ByteBufFrom(data));
            }
          }));
    }
    return;
  }

  if (serialized.IsEmpty()) {
    if (aSynchronous) {
      RemoveFilesSync(backingFile);
    } else if (!taskQueue) {
      DispatchFileRemoval(std::move(backingFile));
    } else {
      InvokeAsync(taskQueue.get(), __func__,
                  [bf = std::move(backingFile)]() mutable {
                    RemoveFilesSync(bf);
                    return GenericPromise::CreateAndResolve(true, __func__);
                  });
    }
    return;
  }

  nsAutoString widePath;
  if (NS_FAILED(backingFile->GetPath(widePath))) {
    return;
  }
  nsCString pathStr = NS_ConvertUTF16toUTF8(widePath);

  if (aSynchronous) {
    ssl_tokens_cache_write_bytes(&pathStr, &serialized);
  } else {
    if (!taskQueue) {
      return;
    }
    InvokeAsync(taskQueue.get(), __func__,
                [path = std::move(pathStr), data = std::move(serialized)]() {
                  ssl_tokens_cache_write_bytes(&path, &data);
                  return GenericPromise::CreateAndResolve(true, __func__);
                });
  }
}

// static
void SSLTokensCache::DispatchLoad(nsCString aPath, uint32_t aLoadGen) {
  if (aPath.IsEmpty()) {
    return;
  }
  NS_DispatchBackgroundTask(
      NS_NewRunnableFunction("SSLTokensCache::LoadPersisted",
                             [path = std::move(aPath), aLoadGen]() {
                               nsAutoLowPriorityIO lowPriorityIO;
                               LoadCtx ctx{aLoadGen};
                               ssl_tokens_cache_read(&path, PR_Now(),
                                                     LoadCallback, &ctx);
                               OnLoadCompleteNotify(ctx.count);
                             }),
      NS_DISPATCH_EVENT_MAY_BLOCK);
}

// static
void SSLTokensCache::OnLoadCompleteNotify(uint32_t aCount) {
  mozilla::glean::network::ssl_token_cache_persistence_records_loaded.Add(
      AssertedCast<int32_t>(aCount));

  TimeDuration elapsed;
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance) {
      return;
    }
    gInstance->mLoadComplete = true;
    elapsed = TimeStamp::Now() - gInstance->mLoadStartTime;
  }
  mozilla::glean::network::ssl_token_cache_load_time.AccumulateRawDuration(
      elapsed);
  LOG(("SSLTokensCache::OnLoadCompleteNotify [records=%u, time=%.1fms]", aCount,
       elapsed.ToMilliseconds()));

  // Forward persisted tokens to the socket process. Uses
  // CallOrWaitForSocketProcess so it fires immediately if the socket process
  // is already up, or is deferred until it is ready.
  if (StaticPrefs::network_ssl_tokens_cache_persistence()) {
    NS_DispatchToMainThread(
        NS_NewRunnableFunction("SSLTokensCache::ForwardToSocketProcess", []() {
          if (!gIOService || !nsIOService::UseSocketProcess()) {
            return;
          }
          // Serialize on a background thread, then send on the main thread.
          // No captures: CallOrWaitForSocketProcess copies its callable when
          // deferring, so the lambda must remain copyable.
          gIOService->CallOrWaitForSocketProcess([]() {
            NS_DispatchBackgroundTask(NS_NewRunnableFunction(
                "SSLTokensCache::SerializeForSocket", []() {
                  nsTArray<uint8_t> data = SSLTokensCache::SerializeForIPC();
                  if (data.IsEmpty()) {
                    return;
                  }
                  NS_DispatchToMainThread(NS_NewRunnableFunction(
                      "SSLTokensCache::SendToSocket",
                      [data = std::move(data)]() {
                        RefPtr<SocketProcessParent> parent =
                            SocketProcessParent::GetSingleton();
                        if (parent && parent->CanSend()) {
                          (void)parent->SendLoadSSLTokensCache(
                              mozilla::ipc::ByteBufFrom(data));
                        }
                      }));
                }));
          });
        }));
  }
}

// static
bool SSLTokensCache::PutFromPersisted(const SslTokensPersistedRecord* aRec,
                                      uint32_t aExpectedGen) {
  StaticMutexAutoLock lock(sLock);
  if (!gInstance || gInstance->mLoadGeneration != aExpectedGen) {
    return false;
  }
  auto rec = MakeUnique<TokenCacheRecord>();
  rec->mKey = aRec->key;
  rec->mExpirationTime = static_cast<PRTime>(aRec->expiration_time);
  rec->mOverridableError = aRec->overridable_error;
  rec->mCompressedPayload.AppendElements(aRec->compressed_payload,
                                         aRec->compressed_payload_len);
  gInstance->InsertRecordLocked(std::move(rec));
  return true;
}

uint64_t SSLTokensCache::InsertRecordLocked(UniquePtr<TokenCacheRecord> aRec) {
  sLock.AssertCurrentThreadOwns();
  const uint64_t id = ++sRecordId;
  aRec->mId = id;

  // aRec->mKey must be read before AddRecord() moves aRec.
  TokenCacheEntry* cacheEntry = mTokenCacheRecords.GetOrInsertNew(aRec->mKey);
  if (cacheEntry->RecordCount() > 0) {
    mCacheSize -= cacheEntry->Size();
  }
  cacheEntry->AddRecord(std::move(aRec), mExpirationArray);
  mCacheSize += cacheEntry->Size();
  EvictIfNecessary();
  return id;
}

// static
bool SSLTokensCache::ShouldPersistKey(const nsACString& aKey,
                                      uint8_t aOverridableError) {
  return aOverridableError == 0 && OAFromPeerId(aKey).mPrivateBrowsingId == 0;
}

// static
void SSLTokensCache::RemoveByMatchAndOAPattern(
    const nsACString& aValue, const nsACString& aSeparatedValue,
    const mozilla::OriginAttributesPattern& aPattern) {
  StaticMutexAutoLock lock(sLock);
  if (!gInstance) {
    return;
  }
  gInstance->RemoveMatchingLocked(
      [&aValue, &aSeparatedValue, &aPattern](const nsACString& aKey) {
        nsDependentCSubstring host = HostFromBasePart(BasePartFromKey(aKey));
        return !host.IsEmpty() &&
               (host.Equals(aValue) || StringEndsWith(host, aSeparatedValue)) &&
               aPattern.Matches(OAFromPeerId(aKey));
      });
}

// static
void SSLTokensCache::RemoveByHostAndOAPattern(
    const nsACString& aHost, const mozilla::OriginAttributesPattern& aPattern) {
  LOG(("SSLTokensCache::RemoveByHostAndOAPattern"));
  RemoveByMatchAndOAPattern(aHost, ":"_ns + aHost, aPattern);
}

// static
void SSLTokensCache::RemoveBySiteAndOAPattern(
    const nsACString& aSite, const mozilla::OriginAttributesPattern& aPattern) {
  LOG(("SSLTokensCache::RemoveBySiteAndOAPattern"));

  // Three cases for the host part of a key (after HostFromBasePart):
  //   "example.com"       — exact, no prefix        → Equals(aSite)
  //   "sub.example.com"   — subdomain                → ends with "."_ns + aSite
  //   "anon:example.com"  — connection-type prefix   → ends with ":"_ns + aSite
  // (Prefixed subdomains like "anon:sub.example.com" are caught by dotSite.)
  nsAutoCString dotSite("."_ns + aSite);
  nsAutoCString colonSite(":"_ns + aSite);
  StaticMutexAutoLock lock(sLock);
  if (!gInstance) {
    return;
  }
  gInstance->RemoveMatchingLocked(
      [&aSite, &dotSite, &colonSite, &aPattern](const nsACString& aKey) {
        nsDependentCSubstring host = HostFromBasePart(BasePartFromKey(aKey));
        return !host.IsEmpty() &&
               (host.Equals(aSite) || StringEndsWith(host, dotSite) ||
                StringEndsWith(host, colonSite)) &&
               aPattern.Matches(OAFromPeerId(aKey));
      });
}

#ifdef ENABLE_TESTS

// static
void SSLTokensCache::TriggerWriteForTest(const nsACString& aPath) {
  nsTArray<uint8_t> serialized;
  {
    StaticMutexAutoLock lock(sLock);
    serialized = SerializeSnapshotLocked();
  }
  nsCString flatPath(aPath);
  if (serialized.IsEmpty()) {
    nsCOMPtr<nsIFile> file;
    if (NS_SUCCEEDED(NS_NewNativeLocalFile(flatPath, getter_AddRefs(file)))) {
      (void)file->Remove(false);
    }
    return;
  }
  ssl_tokens_cache_write_bytes(&flatPath, &serialized);
}

// static
void SSLTokensCache::LoadForTest(const nsACString& aPath) {
  uint32_t loadGen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (gInstance) {
      loadGen = gInstance->mLoadGeneration;
    }
  }
  nsCString flatPath(aPath);
  ssl_tokens_cache_read(&flatPath, PR_Now(), PutFromPersistedCallback,
                        &loadGen);
}

// static
uint32_t SSLTokensCache::CountForTest() {
  StaticMutexAutoLock lock(sLock);
  if (!gInstance) {
    return 0;
  }
  return gInstance->mTokenCacheRecords.Count();
}

// static
uint32_t SSLTokensCache::CacheSizeForTest() {
  StaticMutexAutoLock lock(sLock);
  return gInstance ? gInstance->mCacheSize : 0;
}

// static
void SSLTokensCache::PutForTest(const nsACString& aKey) {
  uint32_t gen = 0;
  {
    StaticMutexAutoLock lock(sLock);
    if (gInstance) {
      gen = gInstance->mLoadGeneration;
    }
  }
  uint8_t dummyToken[] = {0xDE, 0xAD, 0xBE, 0xEF};
  SessionCacheInfo info;
  nsTArray<uint8_t> payload =
      SerializeRecord({dummyToken, sizeof(dummyToken)}, info);
  nsTArray<uint8_t> compressed = CompressRecord(payload);
  if (compressed.IsEmpty()) {
    return;
  }
  SslTokensPersistedRecord rec{};
  rec.key = aKey;
  rec.expiration_time = PR_Now() + 3600LL * PR_USEC_PER_SEC;
  rec.compressed_payload = compressed.Elements();
  rec.compressed_payload_len = compressed.Length();
  PutFromPersisted(&rec, gen);
}

#endif  // ENABLE_TESTS

NS_IMETHODIMP
SSLTokensCache::Observe(nsISupports* aSubject, const char* aTopic,
                        const char16_t* aData) {
  if (!strcmp(aTopic, "application-background") ||
      !strcmp(aTopic, "idle-daily")) {
    LOG(("SSLTokensCache::Observe [topic=%s]", aTopic));
    DoWrite(false);
  } else if (!strcmp(aTopic, "profile-after-change")) {
    MOZ_ASSERT(XRE_IsParentProcess());
    LOG(("SSLTokensCache::Observe [topic=profile-after-change]"));
    nsCOMPtr<nsIObserverService> obs = mozilla::services::GetObserverService();
    if (!obs) {
      return NS_OK;
    }

    // Reconcile persistence state with the pref, which may differ from
    // what Init() saw (user.js is applied between Init() and here).
    bool wantPersistence = StaticPrefs::network_ssl_tokens_cache_persistence();
    bool addObservers = false;
    bool removeObservers = false;
    nsCString loadPath;
    uint32_t loadGen = 0;
    {
      StaticMutexAutoLock lock(sLock);
      if (gInstance) {
        bool wasRegistered = gInstance->mWriteObserversRegistered;
        gInstance->mWriteObserversRegistered = wantPersistence;
        addObservers = wantPersistence && !wasRegistered;
        removeObservers = !wantPersistence && wasRegistered;
        if (wantPersistence && !gInstance->mBackingFile) {
          loadPath = SetupPersistenceLocked(loadGen);
        }
        if (!wantPersistence) {
          gInstance->mBackingFile = nullptr;
          gInstance->mWriteTaskQueue = nullptr;
          gInstance->ClearCacheLocked();
        }
      }
    }
    if (addObservers) {
      obs->AddObserver(this, "application-background", false);
      obs->AddObserver(this, "idle-daily", false);
    } else if (removeObservers) {
      obs->RemoveObserver(this, "application-background");
      obs->RemoveObserver(this, "idle-daily");
    }
    if (wantPersistence) {
      DispatchLoad(std::move(loadPath), loadGen);
      RegisterShutdownBlocker();
    }
  }
  return NS_OK;
}

// nsIAsyncShutdownBlocker

NS_IMETHODIMP
SSLTokensCache::BlockShutdown(nsIAsyncShutdownClient* /* aClient */) {
  LOG(("SSLTokensCache::BlockShutdown"));

  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(XRE_IsParentProcess());
  nsCOMPtr<nsISerialEventTarget> taskQueue;
  {
    StaticMutexAutoLock lock(sLock);
    taskQueue = mWriteTaskQueue;
  }
  if (!taskQueue) {
    RemoveShutdownBlocker();
    return NS_OK;
  }

  // Deserialize socket tokens (if any) then write; both run on the same serial
  // queue for atomicity. The blocker keeps the main thread alive until done.
  RefPtr<SSLTokensCache> self = this;
  auto writeAndRelease = [taskQueue, self](mozilla::ipc::ByteBuf aBuf) {
    InvokeAsync(
        taskQueue.get(), __func__,
        [self, buf = std::move(aBuf)]() {
          if (buf.mLen > 0) {
            SSLTokensCache::DeserializeFromIPC(Span(buf.mData, buf.mLen));
          }
          self->DoWrite(true);
          return GenericPromise::CreateAndResolve(true, __func__);
        })
        ->Then(
            GetMainThreadSerialEventTarget(), __func__,
            [self](bool) { self->RemoveShutdownBlocker(); },
            [self](nsresult) { self->RemoveShutdownBlocker(); });
  };

  // If the socket process is alive, flush its token cache first so the
  // persisted file reflects the most recent handshake data.
  RefPtr<SocketProcessParent> socketParent =
      SocketProcessParent::GetSingleton();
  if (!socketParent || !socketParent->CanSend()) {
    writeAndRelease(mozilla::ipc::ByteBuf{});
    return NS_OK;
  }

  socketParent->SendFlushSSLTokensCache()->Then(
      GetMainThreadSerialEventTarget(), __func__,
      [writeAndRelease](mozilla::ipc::ByteBuf&& aBuf) {
        writeAndRelease(std::move(aBuf));
      },
      [writeAndRelease](mozilla::ipc::ResponseRejectReason) {
        writeAndRelease(mozilla::ipc::ByteBuf{});
      });
  return NS_OK;
}

NS_IMETHODIMP
SSLTokensCache::GetName(nsAString& aName) {
  aName.AssignLiteral("SSLTokensCache: writing cache to disk");
  return NS_OK;
}

NS_IMETHODIMP
SSLTokensCache::GetState(nsIPropertyBag** aState) {
  *aState = nullptr;
  return NS_OK;
}

void SSLTokensCache::RegisterShutdownBlocker() {
  MOZ_ASSERT(NS_IsMainThread());
  MOZ_ASSERT(XRE_IsParentProcess());
  {
    StaticMutexAutoLock lock(sLock);
    if (!gInstance || !gInstance->mWriteTaskQueue) {
      return;
    }
    if (gInstance->mShutdownBarrier) {
      return;
    }
  }
  // sLock is intentionally released before the AsyncShutdown calls below:
  // Service() and AddBlocker may run JS, which mustn't happen under sLock.
  nsCOMPtr<nsIAsyncShutdownService> svc = components::AsyncShutdown::Service();
  if (!svc) {
    return;
  }
  nsCOMPtr<nsIAsyncShutdownClient> client;
  svc->GetProfileBeforeChange(getter_AddRefs(client));
  if (!client) {
    return;
  }
  {
    StaticMutexAutoLock lock(sLock);
    mShutdownBarrier = client;
  }
  LOG(("SSLTokensCache::RegisterShutdownBlocker"));
  client->AddBlocker(this, NS_LITERAL_STRING_FROM_CSTRING(__FILE__), __LINE__,
                     u""_ns);
}

void SSLTokensCache::RemoveShutdownBlocker() {
  nsCOMPtr<nsIAsyncShutdownClient> barrier;
  {
    StaticMutexAutoLock lock(sLock);
    barrier = std::move(mShutdownBarrier);
    // Shutdown() left gInstance set so BlockShutdown could write; tear it
    // down now that the blocker is releasing.
    gInstance = nullptr;
  }
  if (barrier) {
    barrier->RemoveBlocker(this);
  }
}

}  // namespace net
}  // namespace mozilla
