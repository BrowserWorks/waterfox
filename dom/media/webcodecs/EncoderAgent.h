/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_MEDIA_WEBCODECS_EncoderAgent_H
#define DOM_MEDIA_WEBCODECS_EncoderAgent_H

#include "MediaResult.h"
#include "PEMFactory.h"
#include "PlatformEncoderModule.h"
#include "WebCodecsUtils.h"
#include "mozilla/DefineEnum.h"
#include "mozilla/RefPtr.h"
#include "mozilla/TaskQueue.h"

class nsISerialEventTarget;

namespace mozilla {

class PDMFactory;
class TrackInfo;

namespace layers {
class ImageContainer;
}  // namespace layers

// EncoderAgent is a wrapper that contains a MediaDataEncoder. It adapts the
// MediaDataEncoder APIs for use in WebCodecs.
//
// If Configure() is called, Shutdown() must be called to release the resources
// gracefully. Except Shutdown(), all the methods can't be called concurrently,
// meaning a method can only be called when the previous API call has completed.
// The responsibility of arranging the method calls is on the caller.
//
// When Shutdown() is called, all the operations in flight are canceled and the
// MediaDataEncoder is shut down. On the other hand, errors are final. A new
// EncoderAgent must be created when an error is encountered.
//
// All the methods need to be called on the EncoderAgent's owner thread. In
// WebCodecs, it's either on the main thread or worker thread.
class EncoderAgent final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(EncoderAgent);

  explicit EncoderAgent(WebCodecsId aId);

  // The following APIs are owner thread only.

  using ConfigurePromise = MozPromise<bool, MediaResult, true /* exclusive */>;
  using ReconfigurationPromise = MediaDataEncoder::ReconfigurationPromise;
  RefPtr<ConfigurePromise> Configure(const EncoderConfig& aConfig);
  RefPtr<ReconfigurationPromise> Reconfigure(
      const RefPtr<const EncoderConfigurationChangeList>& aConfigChange);
  RefPtr<ShutdownPromise> Shutdown();
  using EncodePromise = MediaDataEncoder::EncodePromise;
  RefPtr<EncodePromise> Encode(nsTArray<RefPtr<MediaData>>&& aInputs);
  // WebCodecs's flush() flushes out all the pending encoded data in the
  // encoder. It's called Drain internally.
  RefPtr<EncodePromise> Drain();

  const WebCodecsId mId;

 private:
  ~EncoderAgent();

  // Push out all the data in the MediaDataEncoder's pipeline.
  // TODO: MediaDataEncoder should implement this, instead of asking call site
  // to run `Drain` multiple times.
  void Dry(MediaDataEncoder::EncodedData&& aPendingOutputs);

  MOZ_DEFINE_ENUM_CLASS_WITH_TOSTRING_AT_CLASS_SCOPE(
      State, (Unconfigured, Configuring, Configured, Encoding, Draining,
              ShuttingDown, Error));
  void SetState(State aState);

  const RefPtr<nsISerialEventTarget> mOwnerThread;
  const RefPtr<PEMFactory> mPEMFactory;
  RefPtr<MediaDataEncoder> mEncoder;
  State mState;

  // Configure
  MozPromiseHolder<ConfigurePromise> mConfigurePromise;
  using CreateEncoderPromise = PlatformEncoderModule::CreateEncoderPromise;
  MozPromiseRequestHolder<CreateEncoderPromise> mCreateRequest;
  using InitPromise = MediaDataEncoder::InitPromise;
  MozPromiseRequestHolder<InitPromise> mInitRequest;

  // Reconfigure
  MozPromiseHolder<ReconfigurationPromise> mReconfigurationPromise;
  using ReconfigureEncoderRequest = ReconfigurationPromise;
  MozPromiseRequestHolder<ReconfigureEncoderRequest> mReconfigurationRequest;

  // Shutdown
  MozPromiseHolder<ShutdownPromise> mShutdownWhileCreationPromise;

  // Encoding
  MozPromiseHolder<EncodePromise> mEncodePromise;
  MozPromiseRequestHolder<EncodePromise> mEncodeRequest;

  // Drain
  MozPromiseRequestHolder<EncodePromise> mDrainRequest;
  MozPromiseHolder<EncodePromise> mDrainPromise;
};

}  // namespace mozilla

#endif  // DOM_MEDIA_WEBCODECS_EncoderAgent_H
