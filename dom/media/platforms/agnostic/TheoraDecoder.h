/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#if !defined(TheoraDecoder_h_)
#  define TheoraDecoder_h_

#  include <theora/theoradec.h>

#  include "PlatformDecoderModule.h"

namespace mozilla {

DDLoggedTypeDeclNameAndBase(TheoraDecoder, MediaDataDecoder);

class TheoraDecoder final : public MediaDataDecoder,
                            public DecoderDoctorLifeLogger<TheoraDecoder> {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(TheoraDecoder, final);

  explicit TheoraDecoder(const CreateDecoderParams& aParams);

  RefPtr<InitPromise> Init() override;
  RefPtr<DecodePromise> Decode(MediaRawData* aSample) override;
  RefPtr<DecodePromise> Drain() override;
  RefPtr<FlushPromise> Flush() override;
  RefPtr<ShutdownPromise> Shutdown() override;

  static bool IsTheora(const nsACString& aMimeType);

  nsCString GetDescriptionName() const override {
    return "theora video decoder"_ns;
  }

  nsCString GetCodecName() const override { return "theora"_ns; }

 private:
  ~TheoraDecoder();
  nsresult DoDecodeHeader(const unsigned char* aData, size_t aLength);

  RefPtr<DecodePromise> ProcessDecode(MediaRawData* aSample);

  const RefPtr<layers::KnowsCompositor> mImageAllocator;
  const RefPtr<layers::ImageContainer> mImageContainer;
  const RefPtr<TaskQueue> mTaskQueue;

  th_info mTheoraInfo = {};
  th_comment mTheoraComment = {};
  th_setup_info* mTheoraSetupInfo = nullptr;
  th_dec_ctx* mTheoraDecoderContext = nullptr;
  int mPacketCount = 0;

  const VideoInfo mInfo;
  const Maybe<TrackingId> mTrackingId;
};

}  // namespace mozilla

#endif
