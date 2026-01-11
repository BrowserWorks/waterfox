/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "PerformanceRecorder.h"

#include "base/process_util.h"
#include "mozilla/Logging.h"
#include "mozilla/gfx/Types.h"
#include "nsPrintfCString.h"

namespace mozilla {

TrackingId::TrackingId() : mSource(Source::Unimplemented), mUniqueInProcId(0) {}

TrackingId::TrackingId(
    Source aSource, uint32_t aUniqueInProcId,
    TrackAcrossProcesses aTrack /* = TrackAcrossProcesses::NO */)
    : mSource(aSource),
      mUniqueInProcId(aUniqueInProcId),
      mProcId(aTrack == TrackAcrossProcesses::Yes
                  ? Some(base::GetCurrentProcId())
                  : Nothing()) {}

nsCString TrackingId::ToString() const {
  if (mProcId) {
    return nsPrintfCString("%s-%u-%u", EnumValueToString(mSource), *mProcId,
                           mUniqueInProcId);
  }
  return nsPrintfCString("%s-%u", EnumValueToString(mSource), mUniqueInProcId);
}

static void AppendMediaInfoFlagToName(nsCString& aName, MediaInfoFlag aFlag) {
  if (aFlag & MediaInfoFlag::KeyFrame) {
    aName.Append("kf,");
  }
  // Decoding
  if (aFlag & MediaInfoFlag::SoftwareDecoding) {
    aName.Append("sw,");
  } else if (aFlag & MediaInfoFlag::HardwareDecoding) {
    aName.Append("hw,");
  }
  // Codec type
  if (aFlag & MediaInfoFlag::VIDEO_AV1) {
    aName.Append("av1,");
  } else if (aFlag & MediaInfoFlag::VIDEO_H264) {
    aName.Append("h264,");
  } else if (aFlag & MediaInfoFlag::VIDEO_VP8) {
    aName.Append("vp8,");
  } else if (aFlag & MediaInfoFlag::VIDEO_VP9) {
    aName.Append("vp9,");
  } else if (aFlag & MediaInfoFlag::VIDEO_THEORA) {
    aName.Append("theora,");
  } else if (aFlag & MediaInfoFlag::VIDEO_HEVC) {
    aName.Append("hevc,");
  }
}

static void AppendImageFormatToName(nsCString& aName,
                                    DecodeStage::ImageFormat aFormat) {
  aName.AppendPrintf("%s,", DecodeStage::EnumValueToString(aFormat));
}

static void AppendYUVColorSpaceToName(nsCString& aName,
                                      gfx::YUVColorSpace aSpace) {
  aName.Append([&] {
    switch (aSpace) {
      case gfx::YUVColorSpace::BT601:
        return "space=BT.601,";
      case gfx::YUVColorSpace::BT709:
        return "space=BT.709,";
      case gfx::YUVColorSpace::BT2020:
        return "space=BT.2020,";
      case gfx::YUVColorSpace::Identity:
        return "space=Identity,";
    }
    MOZ_ASSERT_UNREACHABLE("Unhandled gfx::YUVColorSpace");
    return "";
  }());
}

static void AppendColorRangeToName(nsCString& aName, gfx::ColorRange aRange) {
  aName.Append([&] {
    switch (aRange) {
      case gfx::ColorRange::LIMITED:
        return "range=Limited,";
      case gfx::ColorRange::FULL:
        return "range=Full,";
    }
    MOZ_ASSERT_UNREACHABLE("Unhandled gfx::ColorRange");
    return "";
  }());
}

static void AppendColorDepthToName(nsCString& aName, gfx::ColorDepth aDepth) {
  aName.Append([&] {
    switch (aDepth) {
      case gfx::ColorDepth::COLOR_8:
        return "depth=8,";
      case gfx::ColorDepth::COLOR_10:
        return "depth=10,";
      case gfx::ColorDepth::COLOR_12:
        return "depth=12,";
      case gfx::ColorDepth::COLOR_16:
        return "depth=16,";
    }
    MOZ_ASSERT_UNREACHABLE("Unhandled gfx::ColorDepth");
    return "";
  }());
}

/* static */
const char* FindMediaResolution(int32_t aHeight) {
  static const struct {
    const int32_t mH;
    const nsCString mRes;
  } sResolutions[] = {{0, "A:0"_ns},  // other followings are for video
                      {240, "V:0<h<=240"_ns},
                      {480, "V:240<h<=480"_ns},
                      {576, "V:480<h<=576"_ns},
                      {720, "V:576<h<=720"_ns},
                      {1080, "V:720<h<=1080"_ns},
                      {1440, "V:1080<h<=1440"_ns},
                      {2160, "V:1440<h<=2160"_ns},
                      {INT_MAX, "V:h>2160"_ns}};
  const char* resolution = sResolutions[0].mRes.get();
  for (auto&& res : sResolutions) {
    if (aHeight <= res.mH) {
      resolution = res.mRes.get();
      break;
    }
  }
  return resolution;
}

/* static */
bool PerformanceRecorderBase::IsMeasurementEnabled() {
  return profiler_thread_is_being_profiled_for_markers() ||
         PerformanceRecorderBase::sEnableMeasurementForTesting;
}

/* static */
TimeStamp PerformanceRecorderBase::GetCurrentTimeForMeasurement() {
  // The system call to get the clock is rather expensive on Windows. As we
  // only report the measurement report via markers, if the marker isn't enabled
  // then we won't do any measurement in order to save CPU time.
  return IsMeasurementEnabled() ? TimeStamp::Now() : TimeStamp();
}

ProfilerString8View PlaybackStage::Name() const {
  if (!mName) {
    mName.emplace(EnumValueToString(mStage));
    mName->Append(":");
    mName->Append(FindMediaResolution(mHeight));
    mName->Append(":");
    AppendMediaInfoFlagToName(*mName, mFlag);
  }
  return *mName;
}

void PlaybackStage::AddMarker(MarkerOptions&& aOption) {
  if (mStartAndEndTimeUs) {
    auto& pair = *mStartAndEndTimeUs;
    profiler_add_marker(Name(), Category(),
                        std::forward<MarkerOptions&&>(aOption),
                        geckoprofiler::markers::MediaSampleMarker{}, pair.first,
                        pair.second, 1 /* queue length */);
  } else {
    profiler_add_marker(Name(), Category(),
                        std::forward<MarkerOptions&&>(aOption));
  }
}

void PlaybackStage::AddFlag(MediaInfoFlag aFlag) { mFlag |= aFlag; }

ProfilerString8View CaptureStage::Name() const {
  if (!mName) {
    mName = Some(nsPrintfCString(
        "CaptureVideoFrame %s %dx%d %s %s", mSource.Data(), mWidth, mHeight,
        EnumValueToString(mImageType), mTrackingId.ToString().get()));
  }
  return *mName;
}

ProfilerString8View CopyVideoStage::Name() const {
  if (!mName) {
    mName =
        Some(nsPrintfCString("CopyVideoFrame %s %dx%d %s", mSource.Data(),
                             mWidth, mHeight, mTrackingId.ToString().get()));
  }
  return *mName;
}

ProfilerString8View DecodeStage::Name() const {
  if (!mName) {
    nsCString extras;
    AppendMediaInfoFlagToName(extras, mFlag);
    mImageFormat.apply(
        [&](ImageFormat aFormat) { AppendImageFormatToName(extras, aFormat); });
    mColorDepth.apply([&](gfx::ColorDepth aDepth) {
      AppendColorDepthToName(extras, aDepth);
    });
    mColorRange.apply([&](gfx::ColorRange aRange) {
      AppendColorRangeToName(extras, aRange);
    });
    mYUVColorSpace.apply([&](gfx::YUVColorSpace aColorSpace) {
      AppendYUVColorSpaceToName(extras, aColorSpace);
    });
    mName = Some(nsPrintfCString("DecodeFrame %s %dx%d %s %s", mSource.Data(),
                                 mWidth.valueOr(-1), mHeight.valueOr(-1),
                                 extras.get(), mTrackingId.ToString().get()));
  }
  return *mName;
}

void DecodeStage::AddMarker(MarkerOptions&& aOption) {
  if (mStartAndEndTimeUs) {
    auto& pair = *mStartAndEndTimeUs;
    profiler_add_marker(Name(), Category(),
                        std::forward<MarkerOptions&&>(aOption),
                        geckoprofiler::markers::MediaSampleMarker{}, pair.first,
                        pair.second, 1 /* queue length */);
  } else {
    profiler_add_marker(Name(), Category(),
                        std::forward<MarkerOptions&&>(aOption));
  }
}

}  // namespace mozilla
