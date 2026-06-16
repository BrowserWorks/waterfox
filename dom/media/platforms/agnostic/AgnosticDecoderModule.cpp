/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "AgnosticDecoderModule.h"

#include "AOMDecoder.h"
#include "DAV1DDecoder.h"
#include "TheoraDecoder.h"
#include "VPXDecoder.h"
#include "VideoUtils.h"
#include "mozilla/Logging.h"
#include "mozilla/StaticPrefs_media.h"

namespace mozilla {

enum class DecoderType {
  AV1,
  Opus,
  Theora,
  Vorbis,
  VPX,
  Wave,
};

static bool IsAvailableInDefault(DecoderType type) {
  switch (type) {
    case DecoderType::AV1:
      return StaticPrefs::media_av1_enabled();
    case DecoderType::Theora:
      return StaticPrefs::media_theora_enabled();
    case DecoderType::Opus:
    case DecoderType::Vorbis:
    case DecoderType::VPX:
    case DecoderType::Wave:
      return true;
    default:
      return false;
  }
}

static bool IsAvailableInRdd(DecoderType type) {
  switch (type) {
    case DecoderType::AV1:
      return StaticPrefs::media_av1_enabled();
    case DecoderType::Opus:
      return StaticPrefs::media_rdd_opus_enabled();
    case DecoderType::Theora:
      return StaticPrefs::media_theora_enabled() &&
             StaticPrefs::media_rdd_theora_enabled();
    case DecoderType::Vorbis:
#if defined(__MINGW32__)
      // If this is a MinGW build we need to force AgnosticDecoderModule to
      // handle the decision to support Vorbis decoding (instead of
      // RDD/RemoteDecoderModule) because of Bug 1597408 (Vorbis decoding on
      // RDD causing sandboxing failure on MinGW-clang).  Typically this
      // would be dealt with using defines in StaticPrefList.yaml, but we
      // must handle it here because of Bug 1598426 (the __MINGW32__ define
      // isn't supported in StaticPrefList.yaml).
      return false;
#else
      return StaticPrefs::media_rdd_vorbis_enabled();
#endif
    case DecoderType::VPX:
      return StaticPrefs::media_rdd_vpx_enabled();
    case DecoderType::Wave:
      return StaticPrefs::media_rdd_wav_enabled();
    default:
      return false;
  }
}

static bool IsAvailableInUtility(DecoderType type) {
  switch (type) {
    case DecoderType::Opus:
    case DecoderType::Vorbis:
    case DecoderType::Wave:
      return true;
    // Others are video codecs, don't take care of them
    default:
      return false;
  }
}

// Checks if decoder is available in the current process
static bool IsAvailable(DecoderType type) {
  return XRE_IsRDDProcess()       ? IsAvailableInRdd(type)
         : XRE_IsUtilityProcess() ? IsAvailableInUtility(type)
                                  : IsAvailableInDefault(type);
}

media::DecodeSupportSet AgnosticDecoderModule::SupportsMimeType(
    const nsACString& aMimeType, DecoderDoctorDiagnostics* aDiagnostics) const {
  UniquePtr<TrackInfo> trackInfo = CreateTrackInfoWithMIMEType(aMimeType);
  if (!trackInfo) {
    return media::DecodeSupportSet{};
  }
  return Supports(SupportDecoderParams(*trackInfo), aDiagnostics);
}

media::DecodeSupportSet AgnosticDecoderModule::Supports(
    const SupportDecoderParams& aParams,
    DecoderDoctorDiagnostics* aDiagnostics) const {
  // This should only be supported by MFMediaEngineDecoderModule.
  if (aParams.mMediaEngineId) {
    return media::DecodeSupportSet{};
  }

  const auto& trackInfo = aParams.mConfig;
  const nsACString& mimeType = trackInfo.mMimeType;

  bool supports =
      // We remove support for decoding AV1 here if RDD is enabled so that
      // decoding on the content process doesn't accidentally happen in case
      // something goes wrong with launching the RDD process.
      (AOMDecoder::IsAV1(mimeType) && IsAvailable(DecoderType::AV1)) ||
      (TheoraDecoder::IsTheora(mimeType) && IsAvailable(DecoderType::Theora)) ||
      (VPXDecoder::IsVPX(mimeType) && IsAvailable(DecoderType::VPX));
  MOZ_LOG_FMT(
      sPDMLog, LogLevel::Debug, "Agnostic decoder {} requested type '{}'",
      supports ? "supports" : "rejects", PromiseFlatCString(mimeType).get());
  if (supports) {
    return media::DecodeSupport::SoftwareDecode;
  }
  return media::DecodeSupportSet{};
}

already_AddRefed<MediaDataDecoder> AgnosticDecoderModule::CreateVideoDecoder(
    const CreateDecoderParams& aParams) {
  if (Supports(SupportDecoderParams(aParams), nullptr /* diagnostic */)
          .isEmpty()) {
    return nullptr;
  }
  RefPtr<MediaDataDecoder> m;

  if (TheoraDecoder::IsTheora(aParams.mConfig.mMimeType)) {
    m = new TheoraDecoder(aParams);
  } else if (VPXDecoder::IsVPX(aParams.mConfig.mMimeType)) {
    m = new VPXDecoder(aParams);
  }
  // We remove support for decoding AV1 here if RDD is enabled so that
  // decoding on the content process doesn't accidentally happen in case
  // something goes wrong with launching the RDD process.
  if (StaticPrefs::media_av1_enabled() &&
      (!StaticPrefs::media_rdd_process_enabled() || XRE_IsRDDProcess()) &&
      AOMDecoder::IsAV1(aParams.mConfig.mMimeType)) {
    if (StaticPrefs::media_av1_use_dav1d()) {
      m = new DAV1DDecoder(aParams);
    } else {
      m = new AOMDecoder(aParams);
    }
  }

  return m.forget();
}

already_AddRefed<MediaDataDecoder> AgnosticDecoderModule::CreateAudioDecoder(
    const CreateDecoderParams& aParams) {
  return nullptr;
}

/* static */
already_AddRefed<PlatformDecoderModule> AgnosticDecoderModule::Create() {
  RefPtr<PlatformDecoderModule> pdm = new AgnosticDecoderModule();
  return pdm.forget();
}

}  // namespace mozilla
