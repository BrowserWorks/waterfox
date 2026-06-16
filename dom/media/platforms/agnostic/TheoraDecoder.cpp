/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "TheoraDecoder.h"

#include <ogg/ogg.h>

#include "ImageContainer.h"
#include "PerformanceRecorder.h"
#include "TimeUnits.h"
#include "VideoUtils.h"
#include "XiphExtradata.h"
#include "gfx2DGlue.h"
#include "mozilla/TaskQueue.h"
#include "nsError.h"

#undef LOG
#define LOG(arg, ...)                                                  \
  DDMOZ_LOG(sPDMLog, mozilla::LogLevel::Debug, "::%s: " arg, __func__, \
            ##__VA_ARGS__)

namespace mozilla {

using namespace gfx;
using namespace layers;

static ogg_packet InitTheoraPacket(const unsigned char* aData, size_t aLength,
                                   bool aBOS, bool aEOS, int64_t aGranulepos,
                                   int64_t aPacketNo) {
  ogg_packet packet;
  packet.packet = const_cast<unsigned char*>(aData);
  packet.bytes = aLength;
  packet.b_o_s = aBOS;
  packet.e_o_s = aEOS;
  packet.granulepos = aGranulepos;
  packet.packetno = aPacketNo;
  return packet;
}

TheoraDecoder::TheoraDecoder(const CreateDecoderParams& aParams)
    : mImageAllocator(aParams.mKnowsCompositor),
      mImageContainer(aParams.mImageContainer),
      mTaskQueue(TaskQueue::Create(
          GetMediaThreadPool(MediaThreadType::PLATFORM_DECODER),
          "TheoraDecoder")),
      mInfo(aParams.VideoConfig()),
      mTrackingId(aParams.mTrackingId) {
  MOZ_COUNT_CTOR(TheoraDecoder);
}

TheoraDecoder::~TheoraDecoder() {
  MOZ_COUNT_DTOR(TheoraDecoder);
  if (mTheoraDecoderContext) {
    th_decode_free(mTheoraDecoderContext);
    mTheoraDecoderContext = nullptr;
  }
  th_setup_free(mTheoraSetupInfo);
  th_comment_clear(&mTheoraComment);
  th_info_clear(&mTheoraInfo);
}

RefPtr<ShutdownPromise> TheoraDecoder::Shutdown() {
  RefPtr<TheoraDecoder> self = this;
  return InvokeAsync(mTaskQueue, __func__, [self]() {
    AUTO_PROFILER_LABEL("TheoraDecoder::Shutdown", MEDIA_PLAYBACK);
    if (self->mTheoraDecoderContext) {
      th_decode_free(self->mTheoraDecoderContext);
      self->mTheoraDecoderContext = nullptr;
    }
    return self->mTaskQueue->BeginShutdown();
  });
}

RefPtr<MediaDataDecoder::InitPromise> TheoraDecoder::Init() {
  AUTO_PROFILER_LABEL("TheoraDecoder::Init", MEDIA_PLAYBACK);
  th_comment_init(&mTheoraComment);
  th_info_init(&mTheoraInfo);

  if (!mInfo.mCodecSpecificConfig || mInfo.mCodecSpecificConfig->IsEmpty()) {
    return InitPromise::CreateAndReject(
        MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                    RESULT_DETAIL("Missing Theora codec headers")),
        __func__);
  }

  nsTArray<unsigned char*> headers;
  nsTArray<size_t> headerLens;
  if (!XiphExtradataToHeaders(headers, headerLens,
                              mInfo.mCodecSpecificConfig->Elements(),
                              mInfo.mCodecSpecificConfig->Length())) {
    return InitPromise::CreateAndReject(
        MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                    RESULT_DETAIL("Could not parse Theora codec headers")),
        __func__);
  }

  for (size_t i = 0; i < headers.Length(); i++) {
    if (NS_FAILED(DoDecodeHeader(headers[i], headerLens[i]))) {
      return InitPromise::CreateAndReject(
          MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                      RESULT_DETAIL("Could not decode Theora codec header")),
          __func__);
    }
  }

  if (mPacketCount != 3) {
    return InitPromise::CreateAndReject(
        MediaResult(NS_ERROR_DOM_MEDIA_FATAL_ERR,
                    RESULT_DETAIL("Unexpected Theora header count")),
        __func__);
  }

  mTheoraDecoderContext = th_decode_alloc(&mTheoraInfo, mTheoraSetupInfo);
  if (!mTheoraDecoderContext) {
    return InitPromise::CreateAndReject(
        MediaResult(NS_ERROR_OUT_OF_MEMORY,
                    RESULT_DETAIL("Could not allocate Theora decoder")),
        __func__);
  }

  return InitPromise::CreateAndResolve(TrackInfo::kVideoTrack, __func__);
}

RefPtr<MediaDataDecoder::FlushPromise> TheoraDecoder::Flush() {
  return InvokeAsync(mTaskQueue, __func__, []() {
    AUTO_PROFILER_LABEL("TheoraDecoder::Flush", MEDIA_PLAYBACK);
    return FlushPromise::CreateAndResolve(true, __func__);
  });
}

nsresult TheoraDecoder::DoDecodeHeader(const unsigned char* aData,
                                       size_t aLength) {
  bool bos = mPacketCount == 0;
  ogg_packet packet =
      InitTheoraPacket(aData, aLength, bos, false, 0, mPacketCount++);

  int rv = th_decode_headerin(&mTheoraInfo, &mTheoraComment, &mTheoraSetupInfo,
                              &packet);
  return rv > 0 ? NS_OK : NS_ERROR_FAILURE;
}

RefPtr<MediaDataDecoder::DecodePromise> TheoraDecoder::ProcessDecode(
    MediaRawData* aSample) {
  AUTO_PROFILER_LABEL("TheoraDecoder::ProcessDecode", MEDIA_PLAYBACK);
  MOZ_ASSERT(mTaskQueue->IsOnCurrentThread());

  MediaInfoFlag flag = MediaInfoFlag::None;
  flag |=
      aSample->mKeyframe ? MediaInfoFlag::KeyFrame : MediaInfoFlag::NonKeyFrame;
  flag |= MediaInfoFlag::SoftwareDecoding;
  flag |= MediaInfoFlag::VIDEO_THEORA;
  auto recorder = mTrackingId.map([&](const auto& aId) {
    return PerformanceRecorder<DecodeStage>("TheoraDecoder"_ns, aId, flag);
  });

  ogg_packet packet =
      InitTheoraPacket(aSample->Data(), aSample->Size(), false, false,
                       aSample->mTimecode.ToMicroseconds(), mPacketCount++);

  int rv = th_decode_packetin(mTheoraDecoderContext, &packet, nullptr);
  if (rv != 0 && rv != TH_DUPFRAME) {
    LOG("Theora decode error: %d", rv);
    return DecodePromise::CreateAndReject(
        MediaResult(NS_ERROR_DOM_MEDIA_DECODE_ERR,
                    RESULT_DETAIL("Theora decode error: %d", rv)),
        __func__);
  }

  th_ycbcr_buffer ycbcr;
  th_decode_ycbcr_out(mTheoraDecoderContext, ycbcr);

  int hdec = !(mTheoraInfo.pixel_fmt & 1);
  int vdec = !(mTheoraInfo.pixel_fmt & 2);

  VideoData::YCbCrBuffer buffer;
  buffer.mPlanes[0].mData = ycbcr[0].data;
  buffer.mPlanes[0].mStride = ycbcr[0].stride;
  buffer.mPlanes[0].mHeight = mTheoraInfo.frame_height;
  buffer.mPlanes[0].mWidth = mTheoraInfo.frame_width;
  buffer.mPlanes[0].mSkip = 0;

  buffer.mPlanes[1].mData = ycbcr[1].data;
  buffer.mPlanes[1].mStride = ycbcr[1].stride;
  buffer.mPlanes[1].mHeight = mTheoraInfo.frame_height >> vdec;
  buffer.mPlanes[1].mWidth = mTheoraInfo.frame_width >> hdec;
  buffer.mPlanes[1].mSkip = 0;

  buffer.mPlanes[2].mData = ycbcr[2].data;
  buffer.mPlanes[2].mStride = ycbcr[2].stride;
  buffer.mPlanes[2].mHeight = mTheoraInfo.frame_height >> vdec;
  buffer.mPlanes[2].mWidth = mTheoraInfo.frame_width >> hdec;
  buffer.mPlanes[2].mSkip = 0;

  if (vdec) {
    buffer.mChromaSubsampling = gfx::ChromaSubsampling::HALF_WIDTH_AND_HEIGHT;
  } else if (hdec) {
    buffer.mChromaSubsampling = gfx::ChromaSubsampling::HALF_WIDTH;
  } else {
    buffer.mChromaSubsampling = gfx::ChromaSubsampling::FULL;
  }
  buffer.mYUVColorSpace =
      DefaultColorSpace({mTheoraInfo.frame_width, mTheoraInfo.frame_height});
  buffer.mColorRange = gfx::ColorRange::LIMITED;
  buffer.mColorDepth = gfx::ColorDepth::COLOR_8;

  Result<already_AddRefed<VideoData>, MediaResult> result =
      VideoData::CreateAndCopyData(
          mInfo, mImageContainer, aSample->mOffset, aSample->mTime,
          aSample->mDuration, buffer, aSample->mKeyframe, aSample->mTimecode,
          mInfo.ScaledImageRect(mTheoraInfo.frame_width,
                                mTheoraInfo.frame_height),
          mImageAllocator);
  if (result.isErr()) {
    LOG("Image allocation error source %ux%u display %ux%u picture %ux%u",
        mTheoraInfo.frame_width, mTheoraInfo.frame_height, mInfo.mDisplay.width,
        mInfo.mDisplay.height, mInfo.mImage.width, mInfo.mImage.height);
    return DecodePromise::CreateAndReject(result.unwrapErr(), __func__);
  }

  RefPtr<VideoData> video = result.unwrap();
  MOZ_ASSERT(video);

  recorder.apply([&](auto& aRecorder) {
    aRecorder.Record([&](DecodeStage& aStage) {
      aStage.SetResolution(static_cast<int>(mTheoraInfo.frame_width),
                           static_cast<int>(mTheoraInfo.frame_height));
      auto format = [&]() -> Maybe<DecodeStage::ImageFormat> {
        switch (mTheoraInfo.pixel_fmt) {
          case TH_PF_420:
            return Some(DecodeStage::YUV420P);
          case TH_PF_422:
            return Some(DecodeStage::YUV422P);
          case TH_PF_444:
            return Some(DecodeStage::YUV444P);
          default:
            return Nothing();
        }
      }();
      format.apply([&](auto& aFormat) { aStage.SetImageFormat(aFormat); });
      aStage.SetYUVColorSpace(buffer.mYUVColorSpace);
      aStage.SetColorRange(buffer.mColorRange);
      aStage.SetColorDepth(buffer.mColorDepth);
      aStage.SetStartTimeAndEndTime(video->mTime.ToMicroseconds(),
                                    video->GetEndTime().ToMicroseconds());
    });
  });

  return DecodePromise::CreateAndResolve(DecodedData{video}, __func__);
}

RefPtr<MediaDataDecoder::DecodePromise> TheoraDecoder::Decode(
    MediaRawData* aSample) {
  return InvokeAsync<MediaRawData*>(mTaskQueue, this, __func__,
                                    &TheoraDecoder::ProcessDecode, aSample);
}

RefPtr<MediaDataDecoder::DecodePromise> TheoraDecoder::Drain() {
  return InvokeAsync(mTaskQueue, __func__, [] {
    AUTO_PROFILER_LABEL("TheoraDecoder::Drain", MEDIA_PLAYBACK);
    return DecodePromise::CreateAndResolve(DecodedData(), __func__);
  });
}

/* static */
bool TheoraDecoder::IsTheora(const nsACString& aMimeType) {
  return aMimeType.EqualsLiteral("video/theora");
}

}  // namespace mozilla
#undef LOG
