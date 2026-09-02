/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RemoteMediaData.h"

#include "PerformanceRecorder.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/dom/MediaIPCUtils.h"
#include "mozilla/ipc/Shmem.h"

namespace mozilla {

bool RemoteArrayOfByteBuffer::AllocateShmem(
    size_t aSize, std::function<ShmemBuffer(size_t)>& aAllocator) {
  ShmemBuffer buffer = aAllocator(aSize);
  if (!buffer.Valid()) {
    return false;
  }
  mBuffers.emplace(std::move(buffer.Get()));
  return true;
}

uint8_t* RemoteArrayOfByteBuffer::BuffersStartAddress() const {
  MOZ_ASSERT(mBuffers);
  return mBuffers->get<uint8_t>();
}

bool RemoteArrayOfByteBuffer::Check(size_t aOffset, size_t aSizeInBytes) const {
  if (!mBuffers || !mBuffers->IsReadable()) {
    return false;
  }
  auto size = CheckedInt<size_t>(aOffset) + aSizeInBytes;
  return size.isValid() && size.value() <= mBuffers->Size<uint8_t>();
}

void RemoteArrayOfByteBuffer::Write(size_t aOffset, const void* aSourceAddr,
                                    size_t aSizeInBytes) {
  if (!aSizeInBytes) {
    return;
  }
  MOZ_DIAGNOSTIC_ASSERT(Check(aOffset, aSizeInBytes),
                        "Allocated Shmem is too small");
  memcpy(BuffersStartAddress() + aOffset, aSourceAddr, aSizeInBytes);
}

RemoteArrayOfByteBuffer::RemoteArrayOfByteBuffer() = default;

RemoteArrayOfByteBuffer::RemoteArrayOfByteBuffer(
    const nsTArray<RefPtr<MediaByteBuffer>>& aArray,
    std::function<ShmemBuffer(size_t)>& aAllocator) {
  // Determine the total size we will need for this object.
  size_t totalSize = 0;
  for (const auto& buffer : aArray) {
    if (buffer) {
      totalSize += buffer->Length();
    }
  }
  if (totalSize) {
    if (!AllocateShmem(totalSize, aAllocator)) {
      return;
    }
  }
  size_t offset = 0;
  for (const auto& buffer : aArray) {
    size_t sizeBuffer = buffer ? buffer->Length() : 0;
    if (totalSize && sizeBuffer) {
      Write(offset, buffer->Elements(), sizeBuffer);
    }
    mOffsets.AppendElement(OffsetEntry{offset, sizeBuffer});
    offset += sizeBuffer;
  }
  mIsValid = true;
}

RemoteArrayOfByteBuffer& RemoteArrayOfByteBuffer::operator=(
    RemoteArrayOfByteBuffer&& aOther) noexcept {
  mIsValid = aOther.mIsValid;
  mBuffers = std::move(aOther.mBuffers);
  mOffsets = std::move(aOther.mOffsets);
  aOther.mIsValid = false;
  return *this;
}

RemoteArrayOfByteBuffer::~RemoteArrayOfByteBuffer() = default;

already_AddRefed<MediaByteBuffer> RemoteArrayOfByteBuffer::MediaByteBufferAt(
    size_t aIndex) const {
  MOZ_ASSERT(aIndex < Count());
  const OffsetEntry& entry = mOffsets[aIndex];
  if (!mBuffers || !std::get<1>(entry)) {
    // It's an empty one.
    return nullptr;
  }
  size_t entrySize = std::get<1>(entry);
  if (!Check(std::get<0>(entry), entrySize)) {
    // This Shmem is corrupted and can't contain the data we are about to
    // retrieve. We return an empty array instead of asserting to allow for
    // recovery.
    return nullptr;
  }
  RefPtr<MediaByteBuffer> buffer = new MediaByteBuffer(entrySize);
  buffer->SetLength(entrySize);
  memcpy(buffer->Elements(), mBuffers->get<uint8_t>() + std::get<0>(entry),
         entrySize);
  return buffer.forget();
}

}  // namespace mozilla

/*static */ void IPC::ParamTraits<mozilla::RemoteArrayOfByteBuffer>::Write(
    IPC::MessageWriter* aWriter, const mozilla::RemoteArrayOfByteBuffer& aVar) {
  WriteParam(aWriter, aVar.mIsValid);
  // We need the following gymnastic as the Shmem transferred over IPC will be
  // revoked. We must create a temporary one instead so that it can be recycled
  // later back into the original ShmemPool.
  if (aVar.mBuffers) {
    WriteParam(aWriter, mozilla::Some(mozilla::ipc::Shmem(*aVar.mBuffers)));
  } else {
    WriteParam(aWriter, mozilla::Maybe<mozilla::ipc::Shmem>());
  }
  WriteParam(aWriter, aVar.mOffsets);
}

/* static */ bool IPC::ParamTraits<mozilla::RemoteArrayOfByteBuffer>::Read(
    IPC::MessageReader* aReader, mozilla::RemoteArrayOfByteBuffer* aVar) {
  return ReadParam(aReader, &aVar->mIsValid) &&
         ReadParam(aReader, &aVar->mBuffers) &&
         ReadParam(aReader, &aVar->mOffsets);
}

namespace mozilla {

bool ArrayOfRemoteMediaRawData::Fill(
    const nsTArray<RefPtr<MediaRawData>>& aData,
    std::function<ShmemBuffer(size_t)>&& aAllocator) {
  nsTArray<AlignedByteBuffer> dataBuffers(aData.Length());
  nsTArray<AlignedByteBuffer> alphaBuffers(aData.Length());
  nsTArray<RefPtr<MediaByteBuffer>> extraDataBuffers(aData.Length());
  int32_t height = 0;
  for (auto&& entry : aData) {
    dataBuffers.AppendElement(std::move(entry->mBuffer));
    alphaBuffers.AppendElement(std::move(entry->mAlphaBuffer));
    extraDataBuffers.AppendElement(std::move(entry->mExtraData));
    if (auto&& info = entry->mTrackInfo; info && info->GetAsVideoInfo()) {
      height = info->GetAsVideoInfo()->mImage.height;
    }
    mSamples.AppendElement(RemoteMediaRawData{
        MediaDataIPDL(entry->mOffset, entry->mTime, entry->mTimecode,
                      entry->mDuration, entry->mKeyframe),
        entry->mEOS, height, entry->mTemporalLayerId,
        entry->mOriginalPresentationWindow,
        entry->mCrypto.IsEncrypted() && entry->mShouldCopyCryptoToRemoteRawData
            ? Some(CryptoInfo{
                  entry->mCrypto.mCryptoScheme,
                  entry->mCrypto.mIV,
                  entry->mCrypto.mConstantIV,
                  entry->mCrypto.mKeyId,
                  entry->mCrypto.mPlainSizes,
                  entry->mCrypto.mEncryptedSizes,
                  entry->mCrypto.mCryptByteBlock,
                  entry->mCrypto.mSkipByteBlock,
              })
            : Nothing()});
  }
  PerformanceRecorder<PlaybackStage> perfRecorder(MediaStage::CopyDemuxedData,
                                                  height);
  mBuffers = RemoteArrayOfByteBuffer(dataBuffers, aAllocator);
  if (!mBuffers.IsValid()) {
    return false;
  }
  mAlphaBuffers = RemoteArrayOfByteBuffer(alphaBuffers, aAllocator);
  if (!mAlphaBuffers.IsValid()) {
    return false;
  }
  mExtraDatas = RemoteArrayOfByteBuffer(extraDataBuffers, aAllocator);
  if (!mExtraDatas.IsValid()) {
    return false;
  }
  perfRecorder.Record();
  return true;
}

already_AddRefed<MediaRawData> ArrayOfRemoteMediaRawData::ElementAt(
    size_t aIndex) const {
  if (!IsValid()) {
    return nullptr;
  }
  MOZ_ASSERT(aIndex < Count());
  MOZ_DIAGNOSTIC_ASSERT(mBuffers.Count() == Count() &&
                            mAlphaBuffers.Count() == Count() &&
                            mExtraDatas.Count() == Count(),
                        "Something ain't right here");
  const auto& sample = mSamples[aIndex];
  PerformanceRecorder<PlaybackStage> perfRecorder(MediaStage::CopyDemuxedData,
                                                  sample.mHeight);
  AlignedByteBuffer data = mBuffers.AlignedBufferAt<uint8_t>(aIndex);
  if (mBuffers.SizeAt(aIndex) && !data) {
    // OOM
    return nullptr;
  }
  AlignedByteBuffer alphaData = mAlphaBuffers.AlignedBufferAt<uint8_t>(aIndex);
  if (mAlphaBuffers.SizeAt(aIndex) && !alphaData) {
    // OOM
    return nullptr;
  }
  RefPtr<MediaRawData> rawData;
  if (mAlphaBuffers.SizeAt(aIndex)) {
    rawData = new MediaRawData(std::move(data), std::move(alphaData));
  } else {
    rawData = new MediaRawData(std::move(data));
  }
  rawData->mOffset = sample.mBase.offset();
  rawData->mTime = sample.mBase.time();
  rawData->mTimecode = sample.mBase.timecode();
  rawData->mDuration = sample.mBase.duration();
  rawData->mKeyframe = sample.mBase.keyframe();
  rawData->mEOS = sample.mEOS;
  rawData->mTemporalLayerId = sample.mTemporalLayerId;
  rawData->mExtraData = mExtraDatas.MediaByteBufferAt(aIndex);
  if (sample.mCryptoConfig) {
    CryptoSample& cypto = rawData->GetWritableCrypto();
    cypto.mCryptoScheme = sample.mCryptoConfig->mEncryptionScheme();
    cypto.mIV = std::move(sample.mCryptoConfig->mIV());
    cypto.mConstantIV = std::move(sample.mCryptoConfig->mConstantIV());
    cypto.mIVSize = cypto.mIV.Length();
    cypto.mKeyId = std::move(sample.mCryptoConfig->mKeyId());
    cypto.mPlainSizes = std::move(sample.mCryptoConfig->mClearBytes());
    cypto.mEncryptedSizes = std::move(sample.mCryptoConfig->mCipherBytes());
    cypto.mCryptByteBlock = sample.mCryptoConfig->mCryptByteBlock();
    cypto.mSkipByteBlock = sample.mCryptoConfig->mSkipByteBlock();
  }
  perfRecorder.Record();
  return rawData.forget();
}

}  // namespace mozilla

/*static */ void IPC::ParamTraits<mozilla::ArrayOfRemoteMediaRawData*>::Write(
    MessageWriter* aWriter, mozilla::ArrayOfRemoteMediaRawData* aVar) {
  WriteParam(aWriter, std::move(aVar->mSamples));
  WriteParam(aWriter, std::move(aVar->mBuffers));
  WriteParam(aWriter, std::move(aVar->mAlphaBuffers));
  WriteParam(aWriter, std::move(aVar->mExtraDatas));
}

/* static */ bool IPC::ParamTraits<mozilla::ArrayOfRemoteMediaRawData*>::Read(
    MessageReader* aReader, RefPtr<mozilla::ArrayOfRemoteMediaRawData>* aVar) {
  auto array = mozilla::MakeRefPtr<mozilla::ArrayOfRemoteMediaRawData>();
  if (!ReadParam(aReader, &array->mSamples) ||
      !ReadParam(aReader, &array->mBuffers) ||
      !ReadParam(aReader, &array->mAlphaBuffers) ||
      !ReadParam(aReader, &array->mExtraDatas)) {
    return false;
  }
  if (array->mSamples.Length() != array->mBuffers.Count() ||
      array->mSamples.Length() != array->mAlphaBuffers.Count() ||
      array->mSamples.Length() != array->mExtraDatas.Count()) {
    return false;
  }
  *aVar = std::move(array);
  return true;
}

/* static */ void
IPC::ParamTraits<mozilla::ArrayOfRemoteMediaRawData::RemoteMediaRawData>::Write(
    MessageWriter* aWriter, const paramType& aVar) {
  WriteParam(aWriter, aVar.mBase);
  WriteParam(aWriter, aVar.mEOS);
  WriteParam(aWriter, aVar.mHeight);
  WriteParam(aWriter, aVar.mTemporalLayerId);
  WriteParam(aWriter, aVar.mOriginalPresentationWindow);
  WriteParam(aWriter, aVar.mCryptoConfig);
}

/* static */ bool
IPC::ParamTraits<mozilla::ArrayOfRemoteMediaRawData::RemoteMediaRawData>::Read(
    MessageReader* aReader, paramType* aVar) {
  return ReadParam(aReader, &aVar->mBase) && ReadParam(aReader, &aVar->mEOS) &&
         ReadParam(aReader, &aVar->mHeight) &&
         ReadParam(aReader, &aVar->mTemporalLayerId) &&
         ReadParam(aReader, &aVar->mOriginalPresentationWindow) &&
         ReadParam(aReader, &aVar->mCryptoConfig);
};

namespace mozilla {

bool ArrayOfRemoteAudioData::Fill(
    const AudioData* aData, std::function<ShmemBuffer(size_t)>&& aAllocator) {
  mSamples.AppendElement(RemoteAudioData{
      MediaDataIPDL(aData->mOffset, aData->mTime, aData->mTimecode,
                    aData->mDuration, aData->mKeyframe),
      aData->mChannels, aData->mRate, uint32_t(aData->mChannelMap),
      aData->mOriginalTime, aData->mTrimWindow, aData->mFrames,
      aData->mDataOffset});
  mBuffers = RemoteArrayOfByteBuffer(aData->mAudioData, aAllocator);
  if (!mBuffers.IsValid()) {
    return false;
  }
  return true;
}

bool ArrayOfRemoteAudioData::Fill(
    const nsTArray<RefPtr<AudioData>>& aData,
    std::function<ShmemBuffer(size_t)>&& aAllocator) {
  nsTArray<AlignedAudioBuffer> dataBuffers(aData.Length());
  for (auto&& entry : aData) {
    dataBuffers.AppendElement(std::move(entry->mAudioData));
    mSamples.AppendElement(RemoteAudioData{
        MediaDataIPDL(entry->mOffset, entry->mTime, entry->mTimecode,
                      entry->mDuration, entry->mKeyframe),
        entry->mChannels, entry->mRate, uint32_t(entry->mChannelMap),
        entry->mOriginalTime, entry->mTrimWindow, entry->mFrames,
        entry->mDataOffset});
  }
  mBuffers = RemoteArrayOfByteBuffer(dataBuffers, aAllocator);
  if (!mBuffers.IsValid()) {
    return false;
  }
  return true;
}

already_AddRefed<AudioData> ArrayOfRemoteAudioData::ElementAt(
    size_t aIndex) const {
  if (!IsValid()) {
    return nullptr;
  }
  MOZ_ASSERT(aIndex < Count());
  MOZ_DIAGNOSTIC_ASSERT(mBuffers.Count() == Count(),
                        "Something ain't right here");
  const auto& sample = mSamples[aIndex];
  AlignedAudioBuffer data = mBuffers.AlignedBufferAt<AudioDataValue>(aIndex);
  if (mBuffers.SizeAt(aIndex) && !data) {
    // OOM
    return nullptr;
  }
  auto audioData = MakeRefPtr<AudioData>(
      sample.mBase.offset(), sample.mBase.time(), std::move(data),
      sample.mChannels, sample.mRate, sample.mChannelMap);
  // An AudioData's duration is set at construction time based on the size of
  // the provided buffer. However, if a trim window is set, this value will be
  // incorrect. We have to re-set it to what it actually was.
  audioData->mDuration = sample.mBase.duration();
  audioData->mOriginalTime = sample.mOriginalTime;
  audioData->mTrimWindow = sample.mTrimWindow;
  CheckedInt<size_t> requiredLen =
      CheckedInt<size_t>(sample.mDataOffset) +
      CheckedInt<size_t>(sample.mFrames) * CheckedInt<size_t>(sample.mChannels);
  if (!requiredLen.isValid() ||
      requiredLen.value() > audioData->mAudioData.Length()) {
    NS_WARNING("Malformed RemoteAudioData");
    return nullptr;
  }
  audioData->mFrames = sample.mFrames;
  audioData->mDataOffset = sample.mDataOffset;
  return audioData.forget();
}

}  // namespace mozilla

/*static */ void IPC::ParamTraits<mozilla::ArrayOfRemoteAudioData*>::Write(
    IPC::MessageWriter* aWriter, mozilla::ArrayOfRemoteAudioData* aVar) {
  WriteParam(aWriter, std::move(aVar->mSamples));
  WriteParam(aWriter, std::move(aVar->mBuffers));
}

/* static */ bool IPC::ParamTraits<mozilla::ArrayOfRemoteAudioData*>::Read(
    IPC::MessageReader* aReader,
    RefPtr<mozilla::ArrayOfRemoteAudioData>* aVar) {
  auto array = mozilla::MakeRefPtr<mozilla::ArrayOfRemoteAudioData>();
  if (!ReadParam(aReader, &array->mSamples) ||
      !ReadParam(aReader, &array->mBuffers)) {
    return false;
  }
  *aVar = std::move(array);
  return true;
}

/* static */ void
IPC::ParamTraits<mozilla::ArrayOfRemoteAudioData::RemoteAudioData>::Write(
    IPC::MessageWriter* aWriter, const paramType& aVar) {
  WriteParam(aWriter, aVar.mBase);
  WriteParam(aWriter, aVar.mChannels);
  WriteParam(aWriter, aVar.mRate);
  WriteParam(aWriter, aVar.mChannelMap);
  WriteParam(aWriter, aVar.mOriginalTime);
  WriteParam(aWriter, aVar.mTrimWindow);
  WriteParam(aWriter, aVar.mFrames);
  WriteParam(aWriter, aVar.mDataOffset);
}

/* static */ bool
IPC::ParamTraits<mozilla::ArrayOfRemoteAudioData::RemoteAudioData>::Read(
    IPC::MessageReader* aReader, paramType* aVar) {
  return ReadParam(aReader, &aVar->mBase) &&
         ReadParam(aReader, &aVar->mChannels) && aVar->mChannels > 0 &&
         ReadParam(aReader, &aVar->mRate) && aVar->mRate > 0 &&
         ReadParam(aReader, &aVar->mChannelMap) &&
         ReadParam(aReader, &aVar->mOriginalTime) &&
         ReadParam(aReader, &aVar->mTrimWindow) &&
         ReadParam(aReader, &aVar->mFrames) &&
         ReadParam(aReader, &aVar->mDataOffset);
};
