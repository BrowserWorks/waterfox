/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef DOM_MEDIA_WEBRTC_RTCDATACHANNEL_H_
#define DOM_MEDIA_WEBRTC_RTCDATACHANNEL_H_

#include "mozilla/DOMEventTargetHelper.h"
#include "mozilla/dom/Nullable.h"
#include "mozilla/dom/RTCDataChannelBinding.h"
#include "mozilla/dom/RTCStatsReportBinding.h"
#include "mozilla/dom/TypedArray.h"
#include "nsID.h"

namespace mozilla {
class DataChannel;

namespace dom {
class Blob;
struct RTCStatsCollection;
class StrongWorkerRef;

class RTCDataChannel final : public DOMEventTargetHelper {
 public:
  RTCDataChannel(const nsACString& aLabel, const nsAString& aOrigin,
                 bool aOrdered, Nullable<uint16_t> aMaxLifeTime,
                 Nullable<uint16_t> aMaxRetransmits,
                 const nsACString& aProtocol, bool aNegotiated,
                 already_AddRefed<DataChannel>& aDataChannel,
                 nsPIDOMWindowInner* aWindow);

  nsresult Init();

  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(RTCDataChannel, DOMEventTargetHelper)

  // EventTarget
  using EventTarget::EventListenerAdded;
  void EventListenerAdded(nsAtom* aType) override;

  using EventTarget::EventListenerRemoved;
  void EventListenerRemoved(nsAtom* aType) override;

  JSObject* WrapObject(JSContext*, JS::Handle<JSObject*> aGivenProto) override;
  nsIGlobalObject* GetParentObject() const { return GetRelevantGlobal(); }

  // WebIDL
  void GetLabel(nsACString& aLabel) const;
  void GetProtocol(nsACString& aProtocol) const;
  Nullable<uint16_t> GetMaxPacketLifeTime() const;
  Nullable<uint16_t> GetMaxRetransmits() const;
  RTCDataChannelState ReadyState() const;
  size_t BufferedAmount() const;
  size_t BufferedAmountLowThreshold() const;
  void SetBufferedAmountLowThreshold(size_t aThreshold);
  IMPL_EVENT_HANDLER(open)
  IMPL_EVENT_HANDLER(error)
  IMPL_EVENT_HANDLER(closing)
  IMPL_EVENT_HANDLER(close)
  void Close();
  IMPL_EVENT_HANDLER(message)
  IMPL_EVENT_HANDLER(bufferedamountlow)
  RTCDataChannelType BinaryType() const { return mBinaryType; }
  void SetBinaryType(RTCDataChannelType aType) { mBinaryType = aType; }
  void Send(const nsAString& aData, ErrorResult& aRv);
  void Send(Blob& aData, ErrorResult& aRv);
  void Send(const ArrayBuffer& aData, ErrorResult& aRv);
  void Send(const ArrayBufferView& aData, ErrorResult& aRv);

  bool Negotiated() const;
  bool Ordered() const;
  Nullable<uint16_t> GetId() const;

  // Transferable support, see
  // https://w3c.github.io/webrtc-pc/#transferring-a-data-channel

  // - Implementation of 'dataHolder'
  struct DataHolder {
   public:
    explicit DataHolder(const RTCDataChannel& aValue);
    ~DataHolder();
    const RTCDataChannelState mReadyState;
    const nsCString mLabel;
    const bool mOrdered;
    const Nullable<uint16_t> mMaxPacketLifeTime;
    const Nullable<uint16_t> mMaxRetransmits;
    const nsCString mDataChannelProtocol;
    const bool mNegotiated;
    const Nullable<uint16_t> mDataChannelId;
    const RefPtr<DataChannel> mDataChannel;
    const double mMaxMessageSize;
    const nsString mOrigin;
  };

  // - Implementation of the 'transfer steps'
  UniquePtr<DataHolder> Transfer();

  // - Implementation of the 'transfer receiving steps'
  explicit RTCDataChannel(nsIGlobalObject* aGlobal,
                          const DataHolder& aDataHolder);

  nsresult DoOnMessageAvailable(const nsACString& aMessage, bool aBinary);

  void SetId(uint16_t aId);
  void SetMaxMessageSize(double aMaxMessageSize);
  void SetReadyState(const RTCDataChannelState aState);

  void AnnounceOpen();
  void AnnounceClosed();
  void GracefulClose();

  void DecrementBufferedAmount(size_t aSize);

  dom::RTCDataChannelStats GetStats(const DOMHighResTimeStamp aTimestamp) const;

  void UnsetWorkerNeedsUs();

 protected:
  ~RTCDataChannel();

 private:
  nsresult OnSimpleEvent(const nsAString& aName);

  // if there are "strong event listeners" or outgoing not sent messages
  // then this method keeps the object alive when js doesn't have strong
  // references to it.
  void UpdateMustKeepAlive();
  // ATTENTION, when calling this method the object can be released
  // (and possibly collected).
  void DontKeepAliveAnyMore();

  void IncrementBufferedAmount(size_t aSize);
  bool CheckReadyState(ErrorResult& aRv);
  bool CheckSendSize(uint64_t aSize, ErrorResult& aRv) const;
  void DisableWorkerTransfer();

  void ReleaseSelf();

  const nsID mUuid;  // Solely for stats. Probably overkill.
  const nsString mOrigin;
  const nsCString mLabel;
  const bool mOrdered;
  const Nullable<uint16_t> mMaxPacketLifeTime;
  const Nullable<uint16_t> mMaxRetransmits;
  const nsCString mDataChannelProtocol;
  const bool mNegotiated;

  // to keep us alive while we have listeners
  RefPtr<RTCDataChannel> mSelfRef;
  RefPtr<StrongWorkerRef> mWorkerRef;
  // Owning reference
  const RefPtr<DataChannel> mDataChannel;
  RTCDataChannelType mBinaryType = RTCDataChannelType::Arraybuffer;

  Nullable<uint16_t> mDataChannelId;
  RTCDataChannelState mReadyState = RTCDataChannelState::Connecting;
  bool mWorkerNeedsUs = false;
  bool mCheckMustKeepAlive = true;
  bool mIsTransferable = true;
  double mMaxMessageSize = 0;
  RefPtr<nsISerialEventTarget> mEventTarget;
  size_t mBufferedAmount = 0;
  size_t mBufferedThreshold = 0;
  size_t mMessagesSent = 0;
  size_t mBytesSent = 0;
  size_t mMessagesReceived = 0;
  size_t mBytesReceived = 0;
};

}  // namespace dom
}  // namespace mozilla
#endif  // DOM_MEDIA_WEBRTC_RTCDATACHANNEL_H_
