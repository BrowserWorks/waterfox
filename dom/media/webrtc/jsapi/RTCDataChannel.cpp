/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "RTCDataChannel.h"

#include "DataChannel.h"
#include "DataChannelLog.h"
#include "RTCDataChannelDeclarations.h"
#include "base/basictypes.h"
#include "mozilla/DOMEventTargetHelper.h"
#include "mozilla/EventListenerManager.h"
#include "mozilla/Logging.h"
#include "mozilla/dom/Blob.h"
#include "mozilla/dom/File.h"
#include "mozilla/dom/MessageEvent.h"
#include "mozilla/dom/MessageEventBinding.h"
#include "mozilla/dom/RTCStatsReportBinding.h"
#include "mozilla/dom/ScriptSettings.h"
#include "mozilla/dom/ToJSValue.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/dom/WorkerCommon.h"
#include "mozilla/dom/WorkerRef.h"
#include "nsContentUtils.h"
#include "nsCycleCollectionParticipant.h"
#include "nsError.h"
#include "nsIScriptContext.h"
#include "nsIScriptObjectPrincipal.h"
#include "nsProxyRelease.h"
#include "nsThreadManager.h"

// Since we've moved the windows.h include down here, we have to explicitly
// undef GetBinaryType, otherwise we'll get really odd conflicts
#ifdef GetBinaryType
#  undef GetBinaryType
#endif

namespace mozilla {
namespace dom {

static constexpr const char* ToString(RTCDataChannelState state) {
  switch (state) {
    case RTCDataChannelState::Connecting:
      return "connecting";
    case RTCDataChannelState::Open:
      return "open";
    case RTCDataChannelState::Closing:
      return "closing";
    case RTCDataChannelState::Closed:
      return "closed";
  }
  return "";
};

RTCDataChannel::~RTCDataChannel() {
  DC_INFO(("%p: RTCDataChannel destroyed", this));
  if (NS_IsMainThread()) {
    mDataChannel->UnsetMainthreadDomDataChannel();
  } else {
    mDataChannel->UnsetWorkerDomDataChannel();
  }
}

/* virtual */
JSObject* RTCDataChannel::WrapObject(JSContext* aCx,
                                     JS::Handle<JSObject*> aGivenProto) {
  return RTCDataChannel_Binding::Wrap(aCx, this, aGivenProto);
}

NS_IMPL_CYCLE_COLLECTION_CLASS(RTCDataChannel)

NS_IMPL_CYCLE_COLLECTION_TRAVERSE_BEGIN_INHERITED(RTCDataChannel,
                                                  DOMEventTargetHelper)
NS_IMPL_CYCLE_COLLECTION_TRAVERSE_END

NS_IMPL_CYCLE_COLLECTION_UNLINK_BEGIN_INHERITED(RTCDataChannel,
                                                DOMEventTargetHelper)
NS_IMPL_CYCLE_COLLECTION_UNLINK_END

NS_IMPL_ADDREF_INHERITED(RTCDataChannel, DOMEventTargetHelper)
NS_IMPL_RELEASE_INHERITED(RTCDataChannel, DOMEventTargetHelper)

NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(RTCDataChannel)
NS_INTERFACE_MAP_END_INHERITING(DOMEventTargetHelper)

RTCDataChannel::RTCDataChannel(const nsACString& aLabel,
                               const nsAString& aOrigin, bool aOrdered,
                               Nullable<uint16_t> aMaxLifeTime,
                               Nullable<uint16_t> aMaxRetransmits,
                               const nsACString& aProtocol, bool aNegotiated,
                               already_AddRefed<DataChannel>& aDataChannel,
                               nsPIDOMWindowInner* aWindow)
    : DOMEventTargetHelper(aWindow),
      mUuid(nsID::GenerateUUID()),
      mOrigin(aOrigin),
      mLabel(aLabel),
      mOrdered(aOrdered),
      mMaxPacketLifeTime(aMaxLifeTime),
      mMaxRetransmits(aMaxRetransmits),
      mDataChannelProtocol(aProtocol),
      mNegotiated(aNegotiated),
      mDataChannel(aDataChannel),
      mEventTarget(GetCurrentSerialEventTarget()) {
  DC_INFO(("%p: RTCDataChannel created on main (necko channel %p)", this,
           mDataChannel.get()));
  mDataChannel->SetMainthreadDomDataChannel(this);
}

nsresult RTCDataChannel::Init() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  UpdateMustKeepAlive();

  if (WorkerPrivate* workerPrivate = GetCurrentThreadWorkerPrivate()) {
    // When the callback is executed, we cannot process messages anymore because
    // we cannot dispatch new runnables. Let's force a Close().
    RefPtr<StrongWorkerRef> strongWorkerRef = StrongWorkerRef::Create(
        workerPrivate, "RTCDataChannel::Init",
        [this, self = RefPtr<RTCDataChannel>(this)]() {
          // Make absolutely certain we do not get more
          // callbacks.
          DC_INFO(("%p: Worker is going away, breaking cycles", this));
          mDataChannel->UnsetWorkerDomDataChannel();
          // Also allow ourselves to be GC'ed
          UnsetWorkerNeedsUs();
          DontKeepAliveAnyMore();
        });
    if (NS_WARN_IF(!strongWorkerRef)) {
      DC_WARN(("%p: Could not get worker ref, breaking cycles", this));
      // The worker is shutting down.
      // Make absolutely certain we do not get more callbacks.
      mDataChannel->UnsetWorkerDomDataChannel();
      // Also allow ourselves to be GC'ed
      UnsetWorkerNeedsUs();
      return NS_ERROR_FAILURE;
    }

    MOZ_ASSERT(!mWorkerRef);
    mWorkerRef = std::move(strongWorkerRef);
  }

  if (NS_IsMainThread()) {
    // Queue a task to run the following step:
    GetMainThreadSerialEventTarget()->Dispatch(NS_NewRunnableFunction(
        __func__, [this, self = RefPtr<RTCDataChannel>(this)]() {
          DisableWorkerTransfer();
        }));
  }

  // Attempt to kill "ghost" DataChannel (if one can happen): but usually too
  // early for check to fail
  nsresult rv = CheckCurrentGlobalCorrectness();
  NS_ENSURE_SUCCESS(rv, rv);

  DC_DEBUG(("%p: %s: origin = %s\n", this, __FUNCTION__,
            NS_LossyConvertUTF16toASCII(mOrigin).get()));
  return NS_OK;
}

// Most of the GetFoo()/SetFoo()s don't need to touch shared resources and
// are safe after Close()
void RTCDataChannel::GetLabel(nsACString& aLabel) const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  aLabel = mLabel;
}

void RTCDataChannel::GetProtocol(nsACString& aProtocol) const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  aProtocol = mDataChannelProtocol;
}

Nullable<uint16_t> RTCDataChannel::GetId() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mDataChannelId;
}

// https://w3c.github.io/webrtc-pc/#transferring-a-data-channel
RTCDataChannel::DataHolder::DataHolder(const RTCDataChannel& aValue)
    :  // Set dataHolder.[[ReadyState]] to value.[[ReadyState]].
      mReadyState(aValue.mReadyState),
      // Set dataHolder.[[DataChannelLabel]] to value.[[DataChannelLabel]].
      mLabel(aValue.mLabel),
      // Set dataHolder.[[Ordered]] to value.[[Ordered]].
      mOrdered(aValue.mOrdered),
      // Set dataHolder.[[MaxPacketLifeTime]] to value..[[MaxPacketLifeTime]]
      mMaxPacketLifeTime(aValue.mMaxPacketLifeTime),
      // Set dataHolder.[[MaxRetransmits]] to value.[[MaxRetransmits]].
      mMaxRetransmits(aValue.mMaxRetransmits),
      // Set dataHolder.[[DataChannelProtocol]] to
      // value.[[DataChannelProtocol]].
      mDataChannelProtocol(aValue.mDataChannelProtocol),
      // Set dataHolder.[[Negotiated]] to value.[[Negotiated]].
      mNegotiated(aValue.mNegotiated),
      // Set dataHolder.[[DataChannelId]] to value.[[DataChannelId]].
      mDataChannelId(aValue.mDataChannelId),
      // Set dataHolder’s underlying data transport to value underlying data
      // transport.
      mDataChannel(aValue.mDataChannel),
      // We should keep track of this too
      mMaxMessageSize(aValue.mMaxMessageSize),
      mOrigin(aValue.mOrigin) {}

RTCDataChannel::DataHolder::~DataHolder() = default;

// https://w3c.github.io/webrtc-pc/#transferring-a-data-channel
UniquePtr<RTCDataChannel::DataHolder> RTCDataChannel::Transfer() {
  MOZ_ASSERT(NS_IsMainThread());
  // The RTCDataChannel transfer steps, given value and dataHolder, are:

  // If value.[[IsTransferable]] is false, throw a DataCloneError DOMException.
  // (Failure in this function does appear to cause this up the callchain)
  if (!mIsTransferable) {
    return nullptr;
  }

  // Set dataHolder.**** yadda yadda ****
  UniquePtr<DataHolder> dataHolder = MakeUnique<DataHolder>(*this);

  // Set value.[[IsTransferable]] to false.
  mIsTransferable = false;

  // Set value.[[ReadyState]] to "closed".
  mReadyState = RTCDataChannelState::Closed;

  mDataChannel->OnWorkerTransferStarted();

  return dataHolder;
}

// https://w3c.github.io/webrtc-pc/#transferring-a-data-channel
// The RTCDataChannel transfer-receiving steps, given dataHolder and channel,
// are:
RTCDataChannel::RTCDataChannel(nsIGlobalObject* aGlobal,
                               const DataHolder& aDataHolder)
    : DOMEventTargetHelper(aGlobal),
      mUuid(nsID::GenerateUUID()),
      mOrigin(aDataHolder.mOrigin),
      // Initialize channel.[[DataChannelLabel]] to
      // dataHolder.[[DataChannelLabel]].
      mLabel(aDataHolder.mLabel),
      // Initialize channel.[[Ordered]] to dataHolder.[[Ordered]].
      mOrdered(aDataHolder.mOrdered),
      // Initialize channel.[[MaxPacketLifeTime]] to
      // dataHolder.[[MaxPacketLifeTime]].
      mMaxPacketLifeTime(aDataHolder.mMaxPacketLifeTime),
      // Initialize channel.[[MaxRetransmits]] to dataHolder.[[MaxRetransmits]].
      mMaxRetransmits(aDataHolder.mMaxRetransmits),
      // Initialize channel.[[DataChannelProtocol]] to
      // dataHolder.[[DataChannelProtocol]].
      mDataChannelProtocol(aDataHolder.mDataChannelProtocol),
      // Initialize channel.[[Negotiated]] to dataHolder.[[Negotiated]].
      mNegotiated(aDataHolder.mNegotiated),
      // Initialize channel’s underlying data transport to dataHolder’s
      // underlying data transport.
      mDataChannel(aDataHolder.mDataChannel),
      // Initialize channel.[[DataChannelId]] to dataHolder.[[DataChannelId]].
      mDataChannelId(aDataHolder.mDataChannelId),
      // Initialize channel.[[ReadyState]] to dataHolder.[[ReadyState]].
      mReadyState(aDataHolder.mReadyState),
      // The user agent MUST keep a strong reference from channel's Window or
      // WorkerGlobalScope to channel while the RTCDataChannel object that
      // originally created its underlying data transport remains alive.
      mWorkerNeedsUs(true),
      // Spec doesn't say to do this, but this is the only sane value
      mIsTransferable(false),
      // Update this too
      mMaxMessageSize(aDataHolder.mMaxMessageSize),
      mEventTarget(GetCurrentSerialEventTarget()) {
  MOZ_ASSERT(!NS_IsMainThread());
  DC_INFO(("%p: RTCDataChannel created on worker", this));
  mDataChannel->OnWorkerTransferComplete(this);
}

void RTCDataChannel::SetId(uint16_t aId) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mDataChannelId.SetValue(aId);
}

void RTCDataChannel::SetMaxMessageSize(double aMaxMessageSize) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  DC_INFO(("%p: RTCDataChannel updating maximum message size: %f -> %f", this,
           mMaxMessageSize, aMaxMessageSize));
  mMaxMessageSize = aMaxMessageSize;
}

Nullable<uint16_t> RTCDataChannel::GetMaxPacketLifeTime() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mMaxPacketLifeTime;
}

Nullable<uint16_t> RTCDataChannel::GetMaxRetransmits() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mMaxRetransmits;
}

bool RTCDataChannel::Negotiated() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mNegotiated;
}

bool RTCDataChannel::Ordered() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mOrdered;
}

RTCDataChannelState RTCDataChannel::ReadyState() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mReadyState;
}

void RTCDataChannel::SetReadyState(const RTCDataChannelState aState) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  DC_DEBUG(
      ("%p: RTCDataChannel labeled %s (stream %d) changing ready "
       "state "
       "%s -> %s",
       this, mLabel.get(),
       mDataChannelId.IsNull() ? INVALID_STREAM : mDataChannelId.Value(),
       ToString(mReadyState), ToString(aState)));

  mReadyState = aState;
}

size_t RTCDataChannel::BufferedAmount() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mBufferedAmount;
}

size_t RTCDataChannel::BufferedAmountLowThreshold() const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  return mBufferedThreshold;
}

void RTCDataChannel::SetBufferedAmountLowThreshold(size_t aThreshold) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mBufferedThreshold = aThreshold;
}

void RTCDataChannel::Close() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  // When the close method is called, the user agent MUST run the following
  // steps:

  // Let channel be the RTCDataChannel object which is about to be closed.

  // If channel.[[ReadyState]] is "closing" or "closed", then abort these
  // steps.
  if (mReadyState == RTCDataChannelState::Closed ||
      mReadyState == RTCDataChannelState::Closing) {
    DC_DEBUG(("%p: Channel already closing/closed (%s)", this,
              ToString(mReadyState)));
    return;
  }

  // Set channel.[[ReadyState]] to "closing".
  SetReadyState(RTCDataChannelState::Closing);

  // If the closing procedure has not started yet, start it.
  GracefulClose();

  UpdateMustKeepAlive();
}

void RTCDataChannel::Send(const nsAString& aData, ErrorResult& aRv) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  DisableWorkerTransfer();
  if (!CheckReadyState(aRv)) {
    return;
  }

  if (!CheckSendSize(aData.Length(), aRv)) {
    return;
  }

  nsCString msgString;
  if (!AppendUTF16toUTF8(aData, msgString, fallible_t())) {
    // Hmm, our max size was smaller than we thought...
    aRv.Throw(NS_ERROR_FILE_TOO_BIG);
    return;
  }

  size_t length = msgString.Length();
  mDataChannel->SendMsg(std::move(msgString));
  ++mMessagesSent;
  mBytesSent += length;
  IncrementBufferedAmount(length);
}

void RTCDataChannel::Send(Blob& aData, ErrorResult& aRv) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  DisableWorkerTransfer();
  if (!CheckReadyState(aRv)) {
    return;
  }

  uint64_t msgLength = aData.GetSize(aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return;
  }

  if (!CheckSendSize(msgLength, aRv)) {
    return;
  }

  nsCOMPtr<nsIInputStream> msgStream;
  aData.CreateInputStream(getter_AddRefs(msgStream), aRv);
  if (NS_WARN_IF(aRv.Failed())) {
    return;
  }

  // TODO: If we cannot support this, it needs to be declared during negotiation
  if (msgLength > UINT32_MAX) {
    aRv.Throw(NS_ERROR_FILE_TOO_BIG);
    return;
  }

  mDataChannel->SendBinaryBlob(msgStream);
  ++mMessagesSent;
  mBytesSent += msgLength;
  IncrementBufferedAmount(msgLength);
}

void RTCDataChannel::Send(const ArrayBuffer& aData, ErrorResult& aRv) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  DisableWorkerTransfer();
  if (!CheckReadyState(aRv)) {
    return;
  }

  nsCString msgString;
  if (!aData.AppendDataTo(msgString)) {
    aRv.Throw(NS_ERROR_FILE_TOO_BIG);
    return;
  }

  if (!CheckSendSize(msgString.Length(), aRv)) {
    return;
  }

  size_t length = msgString.Length();
  mDataChannel->SendBinaryMsg(std::move(msgString));
  ++mMessagesSent;
  mBytesSent += length;
  IncrementBufferedAmount(length);
}

void RTCDataChannel::Send(const ArrayBufferView& aData, ErrorResult& aRv) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  DisableWorkerTransfer();
  if (!CheckReadyState(aRv)) {
    return;
  }

  nsCString msgString;
  if (!aData.AppendDataTo(msgString)) {
    aRv.Throw(NS_ERROR_FILE_TOO_BIG);
    return;
  }

  if (!CheckSendSize(msgString.Length(), aRv)) {
    return;
  }

  size_t length = msgString.Length();
  mDataChannel->SendBinaryMsg(std::move(msgString));
  ++mMessagesSent;
  mBytesSent += length;
  IncrementBufferedAmount(length);
}

void RTCDataChannel::GracefulClose() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  // An RTCDataChannel object's underlying data transport may be torn down in a
  // non-abrupt manner by running the closing procedure. When that happens the
  // user agent MUST queue a task to run the following steps:

  GetCurrentSerialEventTarget()->Dispatch(NS_NewRunnableFunction(
      __func__, [this, self = RefPtr<RTCDataChannel>(this)]() {
        // Let channel be the RTCDataChannel object whose underlying data
        // transport was closed.

        // Let connection be the RTCPeerConnection object associated with
        // channel.

        // Remove channel from connection.[[DataChannels]].
        // Note: We don't really have this slot. Reading the spec, it does not
        // appear this serves any function other than holding a ref to the
        // RTCDataChannel, which in our case is handled by mSelfRef.

        // Unless the procedure was initiated by channel.close, set
        // channel.[[ReadyState]] to "closing" and fire an event named closing
        // at channel. Note: channel.close will set [[ReadyState]] to Closing.
        // We also check for closed, just as belt and suspenders.
        if (mReadyState != RTCDataChannelState::Closing &&
            mReadyState != RTCDataChannelState::Closed) {
          SetReadyState(RTCDataChannelState::Closing);
          OnSimpleEvent(u"closing"_ns);
        }

        // Run the following steps in parallel:
        // Finish sending all currently pending messages of the channel.
        // Note: We detect when all pending messages are sent with
        // mBufferedAmount. We do an initial check here, and subsequent checks
        // in DecrementBufferedAmount.
        // Caveat(bug 1979692): mBufferedAmount is decremented when the bytes
        // are first transmitted, _not_ when they are acked. We might need to do
        // some work to ensure that the SCTP stack has delivered these last
        // bytes to the other end before that channel/connection is fully
        // closed.
        if (!mBufferedAmount && mReadyState != RTCDataChannelState::Closed &&
            mDataChannel) {
          mDataChannel->EndOfStream();
        }
      }));
}

void RTCDataChannel::AnnounceOpen() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  // If the associated RTCPeerConnection object's [[IsClosed]] slot is true,
  // abort these steps.
  // TODO(bug 1978901): Fix this

  // Let channel be the RTCDataChannel object to be announced.

  // If channel.[[ReadyState]] is "closing" or "closed", abort these steps.
  if (mReadyState != RTCDataChannelState::Closing &&
      mReadyState != RTCDataChannelState::Closed) {
    // Set channel.[[ReadyState]] to "open".
    SetReadyState(RTCDataChannelState::Open);
    // Fire an event named open at channel.
    DC_INFO(("%p: sending open for %s/%s: %u", this, mLabel.get(),
             mDataChannelProtocol.get(), mDataChannelId.Value()));
    OnSimpleEvent(u"open"_ns);
  }
}

void RTCDataChannel::AnnounceClosed() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  // Let channel be the RTCDataChannel object whose
  // underlying data transport was closed. If
  // channel.[[ReadyState]] is "closed", abort
  // these steps.
  if (mReadyState == RTCDataChannelState::Closed) {
    return;
  }

  // Set channel.[[ReadyState]] to "closed".
  SetReadyState(RTCDataChannelState::Closed);

  // Remove channel from
  // connection.[[DataChannels]] if it is still
  // there. Note: We don't really have this slot.
  // Reading the spec, it does not appear this
  // serves any function other than holding a ref
  // to the RTCDataChannel, which in our case is
  // handled by a self ref in nsDOMDataChannel.

  // If the transport was closed with an error,
  // fire an event named error using the
  // RTCErrorEvent interface with its errorDetail
  // attribute set to "sctp-failure" at channel.
  // Note: We don't support this yet.

  // Fire an event named close at channel.
  OnSimpleEvent(u"close"_ns);
  DontKeepAliveAnyMore();
}

dom::RTCDataChannelStats RTCDataChannel::GetStats(
    const DOMHighResTimeStamp aTimestamp) const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mozilla::dom::RTCDataChannelStats stats;
  nsString id = u"dc"_ns;
  id.Append(NS_ConvertASCIItoUTF16(mUuid.ToString().get()));
  stats.mId.Construct(id);
  stats.mTimestamp.Construct(aTimestamp);
  stats.mType.Construct(mozilla::dom::RTCStatsType::Data_channel);
  // webrtc-stats says the stats are DOMString, but webrtc-pc says the
  // attributes are USVString.
  stats.mLabel.Construct(NS_ConvertUTF8toUTF16(mLabel));
  stats.mProtocol.Construct(NS_ConvertUTF8toUTF16(mDataChannelProtocol));
  if (!mDataChannelId.IsNull()) {
    stats.mDataChannelIdentifier.Construct(mDataChannelId.Value());
  }
  stats.mState.Construct(mReadyState);

  stats.mMessagesSent.Construct(mMessagesSent);
  stats.mBytesSent.Construct(mBytesSent);
  stats.mMessagesReceived.Construct(mMessagesReceived);
  stats.mBytesReceived.Construct(mBytesReceived);
  return stats;
}

void RTCDataChannel::UnsetWorkerNeedsUs() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mWorkerNeedsUs = false;
  DC_INFO(("%p: Unsetting mWorkerNeedsUs", this));
  UpdateMustKeepAlive();
}

void RTCDataChannel::IncrementBufferedAmount(size_t aSize) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mBufferedAmount += aSize;
}

void RTCDataChannel::DecrementBufferedAmount(size_t aSize) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  MOZ_ASSERT(aSize <= mBufferedAmount);
  aSize = std::min(aSize, mBufferedAmount);
  bool wasLow = mBufferedAmount <= mBufferedThreshold;
  mBufferedAmount -= aSize;
  if (!wasLow && mBufferedAmount <= mBufferedThreshold) {
    DC_DEBUG(("%p: sending bufferedamountlow for %s/%s: %u", this, mLabel.get(),
              mDataChannelProtocol.get(), mDataChannelId.Value()));
    OnSimpleEvent(u"bufferedamountlow"_ns);
  }
  if (mBufferedAmount == 0) {
    DC_DEBUG(("%p: no queued sends for %s/%s: %u", this, mLabel.get(),
              mDataChannelProtocol.get(), mDataChannelId.Value()));
    // In the rare case that we held off GC to let the buffer drain
    UpdateMustKeepAlive();
    if (mReadyState == RTCDataChannelState::Closing) {
      if (mDataChannel) {
        // We're done sending
        mDataChannel->EndOfStream();
      }
    }
  }
}

bool RTCDataChannel::CheckSendSize(uint64_t aSize, ErrorResult& aRv) const {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  if (aSize > mMaxMessageSize) {
    nsPrintfCString err("Message size (%" PRIu64 ") exceeds maxMessageSize",
                        aSize);
    aRv.ThrowTypeError(err);
    return false;
  }
  return true;
}

void RTCDataChannel::DisableWorkerTransfer() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  // If this is false, that means this has been transferred. Nothing to
  // do.
  if (mIsTransferable) {
    // Set channel.[[IsTransferable]] to false.
    mIsTransferable = false;
    // This task needs to run before any task enqueued by the receiving
    // messages on a data channel algorithm for channel. This ensures
    // that no message is lost during the transfer of a RTCDataChannel.
    mDataChannel->OnWorkerTransferDisabled();
  }
}

bool RTCDataChannel::CheckReadyState(ErrorResult& aRv) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  // In reality, the DataChannel protocol allows this, but we want it to
  // look like WebSockets
  if (mReadyState == RTCDataChannelState::Connecting) {
    aRv.Throw(NS_ERROR_DOM_INVALID_STATE_ERR);
    return false;
  }

  if (mReadyState == RTCDataChannelState::Closing ||
      mReadyState == RTCDataChannelState::Closed) {
    return false;
  }

  MOZ_ASSERT(mReadyState == RTCDataChannelState::Open,
             "Unknown state in RTCDataChannel::Send");

  return true;
}

nsresult RTCDataChannel::DoOnMessageAvailable(const nsACString& aData,
                                              bool aBinary) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  if (mReadyState == RTCDataChannelState::Closed ||
      mReadyState == RTCDataChannelState::Closing) {
    // Closed by JS, probably
    return NS_OK;
  }

  MOZ_ASSERT(mReadyState == RTCDataChannelState::Open);

  DC_VERBOSE(("%p: DoOnMessageAvailable%s\n", this,
              aBinary
                  ? ((mBinaryType == RTCDataChannelType::Blob) ? " (blob)"
                                                               : " (binary)")
                  : ""));

  nsresult rv = CheckCurrentGlobalCorrectness();
  if (NS_FAILED(rv)) {
    DC_ERROR(("%p: RTCDataChannel::%s: CheckCurrentGlobalCorrectness failed",
              this, __func__));
    return NS_OK;
  }

  AutoJSAPI jsapi;
  if (NS_WARN_IF(!jsapi.Init(GetParentObject()))) {
    DC_ERROR(("%p: RTCDataChannel::%s: jsapi.Init failed", this, __func__));
    return NS_ERROR_FAILURE;
  }
  JSContext* cx = jsapi.cx();

  JS::Rooted<JS::Value> jsData(cx);

  if (aBinary) {
    if (mBinaryType == RTCDataChannelType::Blob) {
      RefPtr<Blob> blob =
          Blob::CreateStringBlob(GetRelevantGlobal(), aData, u""_ns);
      if (NS_WARN_IF(!blob)) {
        DC_ERROR(("%p: RTCDataChannel::%s: CreateStringBlob failed", this,
                  __func__));
        return NS_ERROR_FAILURE;
      }

      if (!ToJSValue(cx, blob, &jsData)) {
        DC_ERROR(("%p: RTCDataChannel::%s: ToJSValue failed", this, __func__));
        return NS_ERROR_FAILURE;
      }
    } else if (mBinaryType == RTCDataChannelType::Arraybuffer) {
      ErrorResult error;
      JS::Rooted<JSObject*> arrayBuf(cx, ArrayBuffer::Create(cx, aData, error));
      RETURN_NSRESULT_ON_FAILURE(error);
      jsData.setObject(*arrayBuf);
    } else {
      MOZ_CRASH("Unknown binary type!");
      return NS_ERROR_UNEXPECTED;
    }
  } else {
    NS_ConvertUTF8toUTF16 utf16data(aData);
    JSString* jsString =
        JS_NewUCStringCopyN(cx, utf16data.get(), utf16data.Length());
    NS_ENSURE_TRUE(jsString, NS_ERROR_FAILURE);

    jsData.setString(jsString);
  }

  RefPtr event = MakeRefPtr<MessageEvent>(this, nullptr, nullptr);

  event->InitMessageEvent(nullptr, u"message"_ns, CanBubble::eNo,
                          Cancelable::eNo, jsData, mOrigin, u""_ns, nullptr,
                          Sequence<OwningNonNull<MessagePort>>());
  event->SetTrusted(true);

  ++mMessagesReceived;
  mBytesReceived += aData.Length();

  // Log message events, but stop after 5
  if (mMessagesReceived < 5) {
    DC_INFO(("%p: Firing \"message\" event #%zu", this, mMessagesReceived));
  } else if (mMessagesReceived == 5) {
    DC_INFO(
        ("%p: Firing \"message\" event #%zu, will not log more message events",
         this, mMessagesReceived));
  }

  DC_DEBUG(("%p: %s - Dispatching message event\n", this, __FUNCTION__));
  ErrorResult err;
  DispatchEvent(*event, err);
  if (err.Failed()) {
    DC_ERROR(("%p: %s - Failed to dispatch message", this, __FUNCTION__));
    NS_WARNING("Failed to dispatch the message event!!!");
  }
  return err.StealNSResult();
}

nsresult RTCDataChannel::OnSimpleEvent(const nsAString& aName) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  nsresult rv = CheckCurrentGlobalCorrectness();
  if (NS_FAILED(rv)) {
    return NS_OK;
  }

  if (MOZ_LOG_TEST(mozilla::gDataChannelLog, mozilla::LogLevel::Info)) {
    // The "message" event does not go through here; that would be overkill at
    // Info.
    DC_INFO(
        ("%p: Firing \"%s\" event", this, NS_ConvertUTF16toUTF8(aName).get()));
  }

  RefPtr<Event> event = NS_NewDOMEvent(this, nullptr, nullptr);

  event->InitEvent(aName, CanBubble::eNo, Cancelable::eNo);
  event->SetTrusted(true);

  ErrorResult err;
  DispatchEvent(*event, err);
  return err.StealNSResult();
}

//-----------------------------------------------------------------------------
// Methods that keep alive the DataChannel object when:
//   1. the object has registered event listeners that can be triggered
//      ("strong event listeners");
//   2. there are outgoing not sent messages.
//-----------------------------------------------------------------------------

void RTCDataChannel::UpdateMustKeepAlive() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());

  if (!mCheckMustKeepAlive) {
    return;
  }

  bool shouldKeepAlive = mWorkerNeedsUs;

  if (!shouldKeepAlive) {
    switch (mReadyState) {
      case RTCDataChannelState::Connecting: {
        if (mListenerManager &&
            (mListenerManager->HasListenersFor(nsGkAtoms::onopen) ||
             mListenerManager->HasListenersFor(nsGkAtoms::onmessage) ||
             mListenerManager->HasListenersFor(nsGkAtoms::onerror) ||
             mListenerManager->HasListenersFor(
                 nsGkAtoms::onbufferedamountlow) ||
             mListenerManager->HasListenersFor(nsGkAtoms::onclose))) {
          shouldKeepAlive = true;
        }
      } break;

      case RTCDataChannelState::Open:
      case RTCDataChannelState::Closing: {
        if (mBufferedAmount != 0 ||
            (mListenerManager &&
             (mListenerManager->HasListenersFor(nsGkAtoms::onmessage) ||
              mListenerManager->HasListenersFor(nsGkAtoms::onerror) ||
              mListenerManager->HasListenersFor(
                  nsGkAtoms::onbufferedamountlow) ||
              mListenerManager->HasListenersFor(nsGkAtoms::onclose)))) {
          shouldKeepAlive = true;
        }
      } break;

      case RTCDataChannelState::Closed:;
    }
  }

  if (mSelfRef && !shouldKeepAlive) {
    DC_INFO(("%p: RTCDataChannel is no longer protected from GC.", this));
    ReleaseSelf();
  } else if (!mSelfRef && shouldKeepAlive) {
    DC_INFO(("%p: RTCDataChannel is protected from GC.", this));
    mSelfRef = this;
  }
}

void RTCDataChannel::DontKeepAliveAnyMore() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  mCheckMustKeepAlive = false;

  if (mSelfRef) {
    // Force an eventloop trip to avoid deleting ourselves.
    ReleaseSelf();
  }

  if (mWorkerRef) {
    // Release this after we've released mSelfRef
    NS_ProxyRelease("RTCDataChannel::mWorkerRef", mEventTarget,
                    mWorkerRef.forget(), true);
  }
}

void RTCDataChannel::ReleaseSelf() {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  DC_INFO(("%p: Releasing self-ref", this));
  // release our self-reference (safely) by putting it in an event (always)
  NS_ProxyRelease("RTCDataChannel::mSelfRef", mEventTarget, mSelfRef.forget(),
                  true);
}

void RTCDataChannel::EventListenerAdded(nsAtom* aType) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  if (MOZ_LOG_TEST(mozilla::gDataChannelLog, mozilla::LogLevel::Info)) {
    nsString name;
    aType->ToString(name);
    DC_INFO(
        ("%p: RTCDataChannel \"%s\" event listener added, calling "
         "UpdateMustKeepAlive.",
         this, NS_ConvertUTF16toUTF8(name).get()));
  }
  UpdateMustKeepAlive();
}

void RTCDataChannel::EventListenerRemoved(nsAtom* aType) {
  MOZ_ASSERT(mEventTarget->IsOnCurrentThread());
  if (MOZ_LOG_TEST(mozilla::gDataChannelLog, mozilla::LogLevel::Info)) {
    nsString name;
    aType->ToString(name);
    DC_INFO(
        ("%p: RTCDataChannel \"%s\" event listener removed, calling "
         "UpdateMustKeepAlive.",
         this, NS_ConvertUTF16toUTF8(name).get()));
  }
  UpdateMustKeepAlive();
}

/* static */
nsresult NS_NewDOMDataChannel(already_AddRefed<DataChannel> aDataChannel,
                              const nsACString& aLabel,
                              const nsAString& aOrigin, bool aOrdered,
                              Nullable<uint16_t> aMaxLifeTime,
                              Nullable<uint16_t> aMaxRetransmits,
                              const nsACString& aProtocol, bool aNegotiated,
                              nsPIDOMWindowInner* aWindow,
                              RTCDataChannel** aDomDataChannel) {
  RefPtr domdc = MakeRefPtr<RTCDataChannel>(
      aLabel, aOrigin, aOrdered, aMaxLifeTime, aMaxRetransmits, aProtocol,
      aNegotiated, aDataChannel, aWindow);

  nsresult rv = domdc->Init();
  NS_ENSURE_SUCCESS(rv, rv);

  domdc.forget(aDomDataChannel);
  return NS_OK;
}

}  // end namespace dom
}  // end namespace mozilla
