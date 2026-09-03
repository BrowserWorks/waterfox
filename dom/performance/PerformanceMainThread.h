/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_dom_PerformanceMainThread_h
#define mozilla_dom_PerformanceMainThread_h

#include "LargestContentfulPaint.h"
#include "Performance.h"
#include "PerformanceInteractionMetrics.h"
#include "PerformanceStorage.h"
#include "nsTextFrame.h"

namespace mozilla::dom {

class PerformanceNavigationTiming;
class PerformanceEventTiming;

using TextFrameUnions = nsTHashMap<nsRefPtrHashKey<Element>, nsRect>;

class PerformanceMainThread final : public Performance,
                                    public PerformanceStorage {
 public:
  PerformanceMainThread(nsPIDOMWindowInner* aWindow,
                        nsDOMNavigationTiming* aDOMTiming,
                        nsITimedChannel* aChannel);

  NS_DECL_ISUPPORTS_INHERITED
  NS_DECL_CYCLE_COLLECTION_SCRIPT_HOLDER_CLASS_INHERITED(PerformanceMainThread,
                                                         Performance)

  PerformanceStorage* AsPerformanceStorage() override { return this; }

  virtual PerformanceTiming* Timing() override;

  virtual PerformanceNavigation* Navigation() override;

  virtual void AddEntry(nsIHttpChannel* channel,
                        nsITimedChannel* timedChannel) override;

  // aData must be non-null.
  virtual void AddEntry(const nsString& entryName,
                        const nsString& initiatorType,
                        UniquePtr<PerformanceTimingData>&& aData) override;

  // aPerformanceTimingData must be non-null.
  void AddRawEntry(UniquePtr<PerformanceTimingData> aPerformanceTimingData,
                   const nsAString& aInitiatorType,
                   const nsAString& aEntryName);
  virtual void SetFCPTimingEntry(PerformancePaintTiming* aEntry) override;
  bool HadFCPTimingEntry() const { return mFCPTiming; }

  void InsertEventTimingEntry(PerformanceEventTiming*) override;
  void BufferEventTimingEntryIfNeeded(PerformanceEventTiming*) override;
  void DispatchPendingEventTimingEntries() override;

  PerformanceInteractionMetrics& GetPerformanceInteractionMetrics() override;

  void SetInteractionId(PerformanceEventTiming* aEventTiming,
                        const WidgetEvent* aEvent) override;

  void BufferLargestContentfulPaintEntryIfNeeded(LargestContentfulPaint*);

  TimeStamp CreationTimeStamp() const override;

  DOMHighResTimeStamp CreationTime() const override;

  virtual void GetMozMemory(JSContext* aCx,
                            JS::MutableHandle<JSObject*> aObj) override;

  virtual nsDOMNavigationTiming* GetDOMTiming() const override {
    return mDOMTiming;
  }

  virtual uint64_t GetRandomTimelineSeed() override {
    return GetDOMTiming()->GetRandomTimelineSeed();
  }

  virtual nsITimedChannel* GetChannel() const override { return mChannel; }

  // The GetEntries* methods need to be overridden in order to add the
  // the document entry of type navigation.
  virtual void GetEntries(nsTArray<RefPtr<PerformanceEntry>>& aRetval) override;

  // Return entries which qualify availableFromTimeline boolean check
  virtual void GetEntriesByType(
      const nsAString& aEntryType,
      nsTArray<RefPtr<PerformanceEntry>>& aRetval) override;

  // There are entries that we don't want expose via performance, however
  // we do want PerformanceObserver to get them
  void GetEntriesByTypeForObserver(
      const nsAString& aEntryType,
      nsTArray<RefPtr<PerformanceEntry>>& aRetval) override;
  virtual void GetEntriesByName(
      const nsAString& aName, const Optional<nsAString>& aEntryType,
      nsTArray<RefPtr<PerformanceEntry>>& aRetval) override;

  void UpdateNavigationTimingEntry() override;
  void QueueNavigationTimingEntry() override;
  void QueueLargestContentfulPaintEntry(LargestContentfulPaint* aEntry);

  size_t SizeOfEventEntries(mozilla::MallocSizeOf aMallocSizeOf) const override;

  static constexpr uint32_t kDefaultEventTimingBufferSize = 150;
  static constexpr uint32_t kDefaultEventTimingDurationThreshold = 104;
  static constexpr double kDefaultEventTimingMinDuration = 16.0;

  static constexpr uint32_t kMaxLargestContentfulPaintBufferSize = 150;

  static constexpr size_t kMaxInteractionDurations = 2048;

  // Matches web-vitals.js's INP durationThreshold for RUM comparability.
  static constexpr double kInpEventDurationThreshold = 40.0;

  class EventCounts* EventCounts() override;

  uint64_t InteractionCount() override;

  // Aggregates for the perf.page_load event, populated by
  // UpdateInteractionTelemetry as event-timing entries are finalized.
  struct InteractionTelemetry {
    uint32_t inpLongest = 0;
    uint32_t keypressMaxDuration = 0;
    uint32_t mouseClick = 0;

    // Ascending durations of interaction-tagged events; backs inpP75/inpP98.
    // Values are clamped to UINT16_MAX (~65 s) on insert; inpLongest still
    // tracks the unclamped max.
    nsTArray<uint16_t> interactionEventDurations;
  };
  const InteractionTelemetry& GetInteractionTelemetry() const {
    return mInteractionTelemetry;
  }

  bool IsGlobalObjectWindow() const override { return true; };

  void RecordModalFallbackTime() override;
  DOMHighResTimeStamp GetLastModalFallbackTime() const override {
    return mLastModalFallbackTime;
  }

  void SetCurrentEventTimingEntry(PerformanceEventTiming* aEntry);
  PerformanceEventTiming* GetCurrentEventTimingEntry() const;

  bool HasDispatchedInputEvent() const { return mHasDispatchedInputEvent; }

  void SetHasDispatchedScrollEvent();
  bool HasDispatchedScrollEvent() const { return mHasDispatchedScrollEvent; }

  void ProcessElementTiming();

  void AddImagesPendingRendering(ImagePendingRendering aImagePendingRendering) {
    mImagesPendingRendering.AppendElement(aImagePendingRendering);
  }

  bool IsPendingLCPCandidate(Element* aElement,
                             imgRequestProxy* aImgRequestProxy);

  bool UpdateLargestContentfulPaintSize(double aSize);
  double GetLargestContentfulPaintSize() const {
    return mLargestContentfulPaintSize;
  }

  nsTHashMap<nsRefPtrHashKey<Element>, nsRect>& GetTextFrameUnions() {
    return mTextFrameUnions;
  }

  void FinalizeLCPEntriesForText();

  void ClearGeneratedTempDataForLCP();

 protected:
  ~PerformanceMainThread();

  void CreateNavigationTimingEntry();

  void InsertUserEntry(PerformanceEntry* aEntry) override;

  DOMHighResTimeStamp GetPerformanceTimingFromString(
      const nsAString& aTimingName) override;

  void DispatchResourceTimingBufferFullEvent() override;

  RefPtr<PerformanceNavigationTiming> mDocEntry;
  RefPtr<nsDOMNavigationTiming> mDOMTiming;
  nsCOMPtr<nsITimedChannel> mChannel;
  RefPtr<PerformanceTiming> mTiming;
  RefPtr<PerformanceNavigation> mNavigation;
  RefPtr<PerformancePaintTiming> mFCPTiming;
  JS::Heap<JSObject*> mMozMemory;

  nsTArray<RefPtr<PerformanceEventTiming>> mEventTimingEntries;
  nsTArray<RefPtr<LargestContentfulPaint>> mLargestContentfulPaintEntries;

  AutoCleanLinkedList<RefPtr<PerformanceEventTiming>>
      mPendingEventTimingEntries;
  bool mHasDispatchedInputEvent = false;
  bool mHasDispatchedScrollEvent = false;

  RefPtr<PerformanceEventTiming> mFirstInputEvent;
  RefPtr<PerformanceEventTiming> mPendingPointerDown;

  PerformanceInteractionMetrics mInteractionMetrics;

 private:
  void SetHasDispatchedInputEvent();

  bool mHasQueuedRefreshdriverObserver = false;
  DOMHighResTimeStamp mLastModalFallbackTime = 0;

  // The event timing entry currently being dispatched. Managed by
  // EventDispatcher via SetCurrentEventTimingEntry to support
  // RecordModalFallbackTime being called from modal dialog code.
  RefPtr<PerformanceEventTiming> mCurrentEventTimingEntry;

  RefPtr<class EventCounts> mEventCounts;
  void IncEventCount(const nsAtom* aType);

  PresShell* GetPresShell();

  nsTArray<ImagePendingRendering> mImagesPendingRendering;

  // Keeps track of the rendered size of the largest contentful paint that
  // we have processed so far.
  double mLargestContentfulPaintSize = 0.0;

  // When a text frame is painted, its area (relative to the
  // containing block) is unioned with other text frames that
  // belong to the same containing block.
  // mTextFrameUnions's key is the containing block, and
  // the value is the unioned area.
  TextFrameUnions mTextFrameUnions;

  // Updates mInteractionTelemetry from a popped PerformanceEventTiming entry.
  void UpdateInteractionTelemetry(PerformanceEventTiming* aEntry);
  InteractionTelemetry mInteractionTelemetry;
};

inline void ImplCycleCollectionTraverse(
    nsCycleCollectionTraversalCallback& aCallback,
    const TextFrameUnions& aField, const char* aName, uint32_t aFlags = 0) {
  for (const auto& entry : aField) {
    CycleCollectionNoteChild(aCallback, entry.GetKey(),
                             "TextFrameUnions's key (nsRefPtrHashKey<Element>)",
                             aFlags);
  }
}

}  // namespace mozilla::dom

#endif  // mozilla_dom_PerformanceMainThread_h
