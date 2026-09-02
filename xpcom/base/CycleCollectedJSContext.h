/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_CycleCollectedJSContext_h
#define mozilla_CycleCollectedJSContext_h

#include "js/TracingAPI.h"
#include "mozilla/Attributes.h"
#include "mozilla/LinkedList.h"
#include "mozilla/MemoryReporting.h"
#include "mozilla/dom/AtomList.h"
#include "mozilla/dom/Promise.h"
#include "js/GCVector.h"
#include "js/Promise.h"
#include "js/friend/MicroTask.h"

#include "nsCOMPtr.h"
#include "nsRefPtrHashtable.h"
#include "nsTArray.h"

class nsCycleCollectionNoteRootCallback;
class nsIRunnable;
class nsThread;

namespace mozilla {
class AutoSlowOperation;

class CycleCollectedJSContext;
class CycleCollectedJSRuntime;

namespace dom {
class Exception;
class WorkerJSContext;
class WorkletJSContext;
}  // namespace dom

// Contains various stats about the cycle collection.
struct CycleCollectorResults {
  CycleCollectorResults() {
    // Initialize here so when we increment mNumSlices the first time we're
    // not using uninitialized memory.
    Init();
  }

  void Init() {
    mForcedGC = false;
    mSuspectedAtCCStart = 0;
    mMergedZones = false;
    mAnyManual = false;
    mVisitedRefCounted = 0;
    mVisitedGCed = 0;
    mFreedRefCounted = 0;
    mFreedGCed = 0;
    mFreedJSZones = 0;
    mNumSlices = 1;
    // mNumSlices is initialized to one, because we call Init() after the
    // per-slice increment of mNumSlices has already occurred.
  }

  bool mForcedGC;
  bool mMergedZones;
  // mAnyManual is true if any slice was manually triggered, and at shutdown.
  bool mAnyManual;
  uint32_t mSuspectedAtCCStart;
  uint32_t mVisitedRefCounted;
  uint32_t mVisitedGCed;
  uint32_t mFreedRefCounted;
  uint32_t mFreedGCed;
  uint32_t mFreedJSZones;
  uint32_t mNumSlices;
};

class MicroTaskRunnable : public LinkedListElement<MicroTaskRunnable> {
 public:
  MicroTaskRunnable() = default;
  NS_INLINE_DECL_REFCOUNTING(MicroTaskRunnable)
  MOZ_CAN_RUN_SCRIPT virtual void Run(AutoSlowOperation& aAso) = 0;
  virtual bool Suppressed() { return false; }
  virtual void TraceMicroTask(JSTracer* aTracer) {}

 protected:
  virtual ~MicroTaskRunnable() {
    if (isInList()) {
      remove();
    }
  }
};

// A wrapper for JS::MicroTaskType. Defines the interface for data access.
// Base class that holds the microtask data and provides information-gathering
// methods. Can't be instantiated directly.
class MOZ_STACK_CLASS MayConsumeMicroTask {
 public:
  virtual ~MayConsumeMicroTask() = default;

  // Check if this holds a "JS Microtask" (see MicroTask.h),
  // which is a task enqueued by the JS engine rather than
  // Gecko.
  bool IsJSMicroTask() const { return JS::IsJSMicroTask(mMicroTask); }

  // Unwrap (without interacting with refcounting) a Gecko MicroTaskRunnable if
  // the task is not a JS MicroTask (see MicroTask.h for "JS MicroTask");
  //  otherwise, return nullptr.
  //
  // This is a non-owning conversion: This class still owns the refcount.
  MicroTaskRunnable* MaybeUnwrapTaskToRunnable() const;

  // Get the execution global for this task without
  // consuming the contents.
  JSObject* GetExecutionGlobalFromJSMicroTask() const {
    MOZ_ASSERT(IsJSMicroTask());
    JS::JSMicroTask* task = JS::ToUnwrappedJSMicroTask(mMicroTask);
    MOZ_ASSERT(task);
    return JS::GetExecutionGlobalFromJSMicroTask(task);
  }

  // Below: A number of wrappers to allow working with a MicroTask without
  // exposing the contained task which could then be misused.
  //
  // These are documented in MicroTask.h.

  bool GetFlowIdFromJSMicroTask(uint64_t* aFlowId) const {
    JS::JSMicroTask* task = JS::ToUnwrappedJSMicroTask(mMicroTask);
    MOZ_ASSERT(task);
    return JS::GetFlowIdFromJSMicroTask(task, aFlowId);
  }

  JSObject* MaybeGetPromiseFromJSMicroTask() const {
    JS::JSMicroTask* task = JS::ToUnwrappedJSMicroTask(mMicroTask);
    MOZ_ASSERT(task);
    return JS::MaybeGetPromiseFromJSMicroTask(task);
  }

  bool MaybeGetHostDefinedDataFromJSMicroTask(
      JS::MutableHandle<JSObject*> aIncumbentGlobal,
      JS::MutableHandle<JSObject*> aOptionalHostDefinedData) const {
    JS::JSMicroTask* task = JS::ToUnwrappedJSMicroTask(mMicroTask);
    if (!task) {
      return false;
    }
    return JS::MaybeGetHostDefinedDataFromJSMicroTask(task, aIncumbentGlobal,
                                                      aOptionalHostDefinedData);
  }

  bool MaybeGetAllocationSiteFromJSMicroTask(
      JS::MutableHandle<JSObject*> out) const {
    JS::JSMicroTask* task = JS::ToUnwrappedJSMicroTask(mMicroTask);
    if (!task) {
      return false;
    }
    return JS::MaybeGetAllocationSiteFromJSMicroTask(task, out);
  }

  void trace(JSTracer* aTrc) {
    TraceRoot(aTrc, &mMicroTask, "MayConsumeMicroTask value");
  }

 protected:
  explicit MayConsumeMicroTask(JS::GenericMicroTask aMicroTask)
      : mMicroTask(aMicroTask) {}

  JS::GenericMicroTask mMicroTask;
};

// A gecko wrapper for the JS::MicroTask type. Used to enforce both
// that this is handled move only, but also that we have successfully
// consumed this microtask before destruction.
//
// This type must be rooted, it holds onto a JS reference.
class MOZ_STACK_CLASS MustConsumeMicroTask : public MayConsumeMicroTask {
 public:
  // We need a public constructor to allow forward declared Rooted
  MustConsumeMicroTask() : MayConsumeMicroTask(JS::GenericMicroTask()) {}

  // The only way to get a (filled) MustConsumeMicroTask is through these
  // mechanisms.
  friend MustConsumeMicroTask DequeueNextMicroTask(JSContext* aCx);
  friend MustConsumeMicroTask DequeueNextRegularMicroTask(JSContext* aCx);
  friend MustConsumeMicroTask DequeueNextDebuggerMicroTask(JSContext* aCx);

  ~MustConsumeMicroTask() override {
    if (!mMicroTask.isUndefined()) {
      MOZ_CRASH("Didn't consume MicroTask");
    }
  }

  // Move only semantics
  MustConsumeMicroTask(const MustConsumeMicroTask&) = delete;
  MustConsumeMicroTask& operator=(const MustConsumeMicroTask&) = delete;
  MustConsumeMicroTask(MustConsumeMicroTask&& other)
      : MayConsumeMicroTask(other.mMicroTask) {
    other.mMicroTask.setUndefined();
  }
  MustConsumeMicroTask& operator=(MustConsumeMicroTask&& other) noexcept {
    if (this != &other) {
      mMicroTask = other.mMicroTask;
      other.mMicroTask.setUndefined();
    }
    return *this;
  }

  // Indicate if this still holds a task or not.
  bool IsConsumed() const { return mMicroTask.isUndefined(); }

  // Allow testing for contentfulness.
  explicit operator bool() const { return !IsConsumed(); }

  // Take ownership of a non-JS task inside a JS::GenericMicroTask - This clears
  // the contents of the value to make it clear that we've transferred ownership.
  // `this` is marked is only edited if unwrapping succeeds, and so
  // you can conditionally try to consume as owned;
  //
  //    MOZ_ASSERT(!mustConsume.IsConsumed())
  //    if (RefPtr<MicroTaskRunnable> geckoTask =
  //    mustConsume.MaybeConsumeAsOwnedRunnable()) {
  //      // mustConsume is now empty
  //    } else {
  //      // mustConsume still holds a JS microtask
  //    }
  //
  already_AddRefed<MicroTaskRunnable> MaybeConsumeAsOwnedRunnable();

  // Intentionally ignore a JS microtask. This can happen when script
  // execution is disallowed during CallSetup
  void IgnoreJSMicroTask() {
    MOZ_ASSERT(IsJSMicroTask());
    mMicroTask.setUndefined();
  }

  // Consume this by prepending this MustConsumeMicroTask back into
  // the MicroTaskQueue.
  void ConsumeByPrependToQueue(JSContext* aCx) {
    MOZ_ASSERT(!IsConsumed(), "Attempting to consume an already-consumed task");
    if (!JS::PrependMicroTask(aCx, mMicroTask)) {
      // Can't lose tasks.
      NS_ABORT_OOM(0);
    }
    mMicroTask.setUndefined();
  }

  bool RunAndConsumeJSMicroTask(JSContext* aCx) {
    MOZ_ASSERT(!JS_IsExceptionPending(aCx));
    JS::Rooted<JS::JSMicroTask*> task(
        aCx, JS::ToMaybeWrappedJSMicroTask(mMicroTask));
    MOZ_ASSERT(task);
    bool v = JS::RunJSMicroTask(aCx, task);
    mMicroTask.setUndefined();
    return v;
  }

 private:
  explicit MustConsumeMicroTask(JS::GenericMicroTask aMicroTask)
      : MayConsumeMicroTask(aMicroTask) {}
};

// To allow using the same accessors for data as MustConsumeMicroTask
// we create this subclass which will never consume the microtask
// for the purposes of peeking.
//
// This type must be rooted, it holds onto a JS reference.
class MOZ_STACK_CLASS WontConsumeMicroTask : public MayConsumeMicroTask {
 public:
  // // We need a public constructor to allow forward declared Rooted
  WontConsumeMicroTask() : MayConsumeMicroTask(JS::GenericMicroTask()) {}

  // The only way to get a (filled) WontConsumeMicroTask is through peeking.
  friend WontConsumeMicroTask PeekNextMicroTask(JSContext* aCx);

  ~WontConsumeMicroTask() = default;

 private:
  explicit WontConsumeMicroTask(JS::GenericMicroTask aMicroTask)
      : MayConsumeMicroTask(aMicroTask) {
    MOZ_RELEASE_ASSERT(!aMicroTask.isNullOrUndefined());
  }
};

class SuppressedMicroTaskList final : public MicroTaskRunnable {
 public:
  SuppressedMicroTaskList() = delete;
  explicit SuppressedMicroTaskList(CycleCollectedJSContext* aContext);

  virtual bool Suppressed() override;
  virtual void Run(AutoSlowOperation& aso) override {
    // Does nothing; the only action occurs as part of the
    // call to Suppressed().
  }

  CycleCollectedJSContext* mContext = nullptr;
  uint64_t mSuppressionGeneration = 0;
  JS::PersistentRooted<JS::GCVector<MustConsumeMicroTask>>
      mSuppressedMicroTaskRunnables;

 private:
  ~SuppressedMicroTaskList();
};

// Support for JS FinalizationRegistry objects, which allow a JS callback to be
// registered that is called when objects die.
//
// We keep a vector of functions that call back into the JS engine along
// with their associated incumbent globals, one per FinalizationRegistry object
// that has pending cleanup work. These are run in their own task.
class FinalizationRegistryCleanup {
 public:
  explicit FinalizationRegistryCleanup(CycleCollectedJSContext* aContext);
  void Init();
  void Destroy();
  void QueueCallback(JSFunction* aDoCleanup, JSObject* aIncumbentGlobal);
  MOZ_CAN_RUN_SCRIPT void DoCleanup();

 private:
  static void QueueCallback(JSFunction* aDoCleanup, JSObject* aIncumbentGlobal,
                            void* aData);

  class CleanupRunnable;

  struct Callback {
    JSFunction* mCallbackFunction;
    JSObject* mIncumbentGlobal;
    void trace(JSTracer* trc);
  };

  // This object is part of CycleCollectedJSContext, so it's safe to have a raw
  // pointer to its containing context here.
  CycleCollectedJSContext* mContext;

  // Weak pointer to a previously dispatched runnable. The CleanupRunnable::Run
  // method will null out this pointer.
  CleanupRunnable* mPendingRunnable = nullptr;

  using CallbackVector = JS::GCVector<Callback, 0, JSInfallibleAllocPolicy>;
  JS::PersistentRooted<CallbackVector> mCallbacks;
};

bool EnqueueMicroTask(JSContext* aCx,
                      already_AddRefed<MicroTaskRunnable> aRunnable);
bool EnqueueDebugMicroTask(JSContext* aCx,
                           already_AddRefed<MicroTaskRunnable> aRunnable);

MustConsumeMicroTask DequeueNextMicroTask(JSContext* aCx);
MustConsumeMicroTask DequeueNextRegularMicroTask(JSContext* aCx);
MustConsumeMicroTask DequeueNextDebuggerMicroTask(JSContext* aCx);

WontConsumeMicroTask PeekNextMicroTask(JSContext* aCx);

class CycleCollectedJSContext : dom::PerThreadAtomCache, public JS::JobQueue {
  friend class CycleCollectedJSRuntime;
  friend class SuppressedMicroTasks;
  friend class SuppressedMicroTaskList;

 protected:
  CycleCollectedJSContext();
  virtual ~CycleCollectedJSContext();

  MOZ_IS_CLASS_INIT
  nsresult Initialize(JSRuntime* aParentRuntime, uint32_t aMaxBytes);

  virtual CycleCollectedJSRuntime* CreateRuntime(JSContext* aCx) = 0;

  size_t SizeOfExcludingThis(mozilla::MallocSizeOf aMallocSizeOf) const;

 private:
  static void PromiseRejectionTrackerCallback(
      JSContext* aCx, bool aMutedErrors, JS::Handle<JSObject*> aPromise,
      JS::PromiseRejectionHandlingState state, void* aData);

  void AfterProcessMicrotasks();

 public:
  void ProcessStableStateQueue();

  void ClearUncaughtRejectionObservers() {
    mUncaughtRejectionObservers.Clear();
  }

 private:
  void CleanupIDBTransactions(uint32_t aRecursionDepth);

 public:
  virtual dom::WorkerJSContext* GetAsWorkerJSContext() { return nullptr; }
  virtual dom::WorkletJSContext* GetAsWorkletJSContext() { return nullptr; }

  CycleCollectedJSRuntime* Runtime() const {
    MOZ_ASSERT(mRuntime);
    return mRuntime;
  }

  already_AddRefed<dom::Exception> GetPendingException() const;
  void SetPendingException(dom::Exception* aException);

  void TraceMicroTasks(JSTracer* aTracer);

  JSContext* Context() const {
    MOZ_ASSERT(mJSContext);
    return mJSContext;
  }

  JS::RootingContext* RootingCx() const {
    MOZ_ASSERT(mJSContext);
    return JS::RootingContext::get(mJSContext);
  }

  void SetTargetedMicroTaskRecursionDepth(uint32_t aDepth) {
    mTargetedMicroTaskRecursionDepth = aDepth;
  }

  void UpdateMicroTaskSuppressionGeneration() { ++mSuppressionGeneration; }

 protected:
  JSContext* MaybeContext() const { return mJSContext; }

 public:
  // nsThread entrypoints
  //
  // MOZ_CAN_RUN_SCRIPT_BOUNDARY so we don't need to annotate
  // nsThread::ProcessNextEvent and all its callers MOZ_CAN_RUN_SCRIPT for now.
  // But we really should!
  MOZ_CAN_RUN_SCRIPT_BOUNDARY
  virtual void BeforeProcessTask(bool aMightBlock);
  // MOZ_CAN_RUN_SCRIPT_BOUNDARY so we don't need to annotate
  // nsThread::ProcessNextEvent and all its callers MOZ_CAN_RUN_SCRIPT for now.
  // But we really should!
  MOZ_CAN_RUN_SCRIPT_BOUNDARY
  virtual void AfterProcessTask(uint32_t aRecursionDepth);

  // Check whether any eager thresholds have been reached, which would mean
  // an idle GC task (minor or major) would be useful.
  virtual void MaybePokeGC();

  uint32_t RecursionDepth() const;

  // Run in stable state (call through nsContentUtils)
  void RunInStableState(already_AddRefed<nsIRunnable> aRunnable);

  void AddPendingIDBTransaction(already_AddRefed<nsIRunnable> aTransaction);

  // Get the CycleCollectedJSContext for a JSContext.
  // Returns null only if Initialize() has not completed on or during
  // destruction of the CycleCollectedJSContext.
  static CycleCollectedJSContext* GetFor(JSContext* aCx);

  // Get the current thread's CycleCollectedJSContext.  Returns null if there
  // isn't one.
  static CycleCollectedJSContext* Get();

  // Queue an async microtask to the current main or worker thread.
  virtual void DispatchToMicroTask(
      already_AddRefed<MicroTaskRunnable> aRunnable);

  // Call EnterMicroTask when you're entering JS execution.
  // Usually the best way to do this is to use nsAutoMicroTask.
  //
  // Returns true if we expect to call PerformMicroTaskCheckpoint
  // will occur on the next call to LeaveMicroTask
  bool EnterMicroTask() { return (mMicroTaskLevel++ == 0); }

  MOZ_CAN_RUN_SCRIPT
  void LeaveMicroTask() {
    if (--mMicroTaskLevel == 0) {
      PerformMicroTaskCheckPoint();
    }
  }

  uint32_t MicroTaskLevel() const { return mMicroTaskLevel; }

  void SetMicroTaskLevel(uint32_t aLevel) { mMicroTaskLevel = aLevel; }

  void EnterSyncOperation() { ++mSyncOperations; }
  void LeaveSyncOperation() { --mSyncOperations; }
  bool IsInSyncOperation() const { return mSyncOperations > 0; }

  bool CheckRecursionDepth(uint32_t aCurrentDepth, bool aForce = false);

  MOZ_CAN_RUN_SCRIPT
  bool PerformMicroTaskCheckPoint(bool aForce = false);

  MOZ_CAN_RUN_SCRIPT
  void PerformDebuggerMicroTaskCheckpoint();

  bool IsInStableOrMetaStableState() const { return mDoingStableStates; }

  // Storage for watching rejected promises waiting for some client to
  // consume their rejection.
  // Promises in this list have been rejected in the last turn of the
  // event loop without the rejection being handled.
  // Note that this can contain nullptrs in place of promises removed because
  // they're consumed before it'd be reported.
  JS::PersistentRooted<JS::GCVector<JSObject*, 0, js::SystemAllocPolicy>>
      mUncaughtRejections;

  // Promises in this list have previously been reported as rejected
  // (because they were in the above list), but the rejection was handled
  // in the last turn of the event loop.
  JS::PersistentRooted<JS::GCVector<JSObject*, 0, js::SystemAllocPolicy>>
      mConsumedRejections;
  nsTArray<nsCOMPtr<nsISupports /* UncaughtRejectionObserver */>>
      mUncaughtRejectionObservers;

  virtual bool IsSystemCaller() const = 0;

  // Unused on main thread.  Used by AutoJSAPI on Worker and Worklet threads.
  virtual void ReportError(JSErrorReport* aReport,
                           JS::ConstUTF8CharsZ aToStringResult) {
    MOZ_ASSERT_UNREACHABLE("Not supported");
  }

  // These two functions control a special flag variable which lets us turn
  // tracing on and off from a thread other than this JSContext's main thread.
  // This is useful because we want to be able to start tracing many threads
  // all at once from the Gecko Profiler in Firefox.
  //
  // NOTE: the caller must ensure that this CycleCollectedJSContext is not
  // being destroyed when this is called. At the time of this API being added,
  // the only consumer is the Gecko Profiler, which guarantees this via a mutex
  // around unregistering the context, which always occurs before the context
  // is destroyed.
  void BeginExecutionTracingAsync();
  void EndExecutionTracingAsync();

 private:
  // JS::JobQueue implementation: see js/public/Promise.h.
  // SpiderMonkey uses some of these methods to enqueue promise resolution jobs.
  // Others protect the debuggee microtask queue from the debugger's
  // interruptions; see the comments on JS::AutoDebuggerJobQueueInterruption for
  // details.
  bool getHostDefinedData(
      JSContext* aCx, JS::MutableHandle<JSObject*> aIncumbentGlobal,
      JS::MutableHandle<JSObject*> aOptionalHostDefinedData) const override;

  // Fills in the JS Object used to represent the current incumbent global.
  // Used when running MicroTasks which don't have host-defined data as
  // they will still need an incumbent global.
  bool getHostDefinedGlobal(JSContext* cx,
                            JS::MutableHandle<JSObject*>) const override;

  // MOZ_CAN_RUN_SCRIPT_BOUNDARY for now so we don't have to change SpiderMonkey
  // headers.  The caller presumably knows this can run script (like everything
  // in SpiderMonkey!) and will deal.
  MOZ_CAN_RUN_SCRIPT_BOUNDARY
  void runJobs(JSContext* cx) override;

  bool isDrainingStopped() const override { return false; }

  // Trace hook for non-GCThing microtask values (e.g., Private values
  // containing MicroTaskRunnable pointers).
  void traceNonGCThingMicroTask(JSTracer* trc, JS::Value* valuePtr) override;

  class SavedMicroTaskQueue;
  js::UniquePtr<SavedJobQueue> saveJobQueue(JSContext*) override;

 private:
  CycleCollectedJSRuntime* mRuntime;

  JSContext* mJSContext;

  nsCOMPtr<dom::Exception> mPendingException;
  nsThread* mOwningThread;  // Manual refcounting to avoid include hell.

  struct PendingIDBTransactionData {
    nsCOMPtr<nsIRunnable> mTransaction;
    uint32_t mRecursionDepth;
  };

  nsTArray<nsCOMPtr<nsIRunnable>> mStableStateEvents;
  nsTArray<PendingIDBTransactionData> mPendingIDBTransactions;
  uint32_t mBaseRecursionDepth;
  bool mDoingStableStates;

  // If set to none 0, microtasks will be processed only when recursion depth
  // is the set value.
  uint32_t mTargetedMicroTaskRecursionDepth;

  uint32_t mMicroTaskLevel;

  uint32_t mSyncOperations;

  RefPtr<SuppressedMicroTaskList> mSuppressedMicroTaskList;

  uint64_t mSuppressionGeneration;

 protected:
  mozilla::LinkedList<MicroTaskRunnable> mMicrotasksToTrace;

 private:
  // How many times the debugger has interrupted execution, possibly creating
  // microtask checkpoints in places that they would not normally occur.
  uint32_t mDebuggerRecursionDepth;

  Maybe<uint32_t> mMicroTaskRecursionDepth;

  // This implements about-to-be-notified rejected promises list in the spec.
  // https://html.spec.whatwg.org/multipage/webappapis.html#about-to-be-notified-rejected-promises-list
  typedef nsTArray<RefPtr<dom::Promise>> PromiseArray;
  PromiseArray mAboutToBeNotifiedRejectedPromises;

  // This is for the "outstanding rejected promises weak set" in the spec,
  // https://html.spec.whatwg.org/multipage/webappapis.html#outstanding-rejected-promises-weak-set
  // We use different data structure and opposite logic here to achieve the same
  // effect. Basically this is used for tracking the rejected promise that does
  // NOT need firing a rejectionhandled event. We will check the table to see if
  // firing rejectionhandled event is required when a rejected promise is being
  // handled.
  //
  // The rejected promise will be stored in the table if
  // - it is unhandled, and
  // - The unhandledrejection is not yet fired.
  //
  // And be removed when
  // - it is handled, or
  // - A unhandledrejection is fired and it isn't being handled in event
  // handler.
  typedef nsRefPtrHashtable<nsUint64HashKey, dom::Promise> PromiseHashtable;
  PromiseHashtable mPendingUnhandledRejections;

  class NotifyUnhandledRejections final : public CancelableRunnable {
   public:
    explicit NotifyUnhandledRejections(PromiseArray&& aPromises)
        : CancelableRunnable("NotifyUnhandledRejections"),
          mUnhandledRejections(std::move(aPromises)) {}

    NS_IMETHOD Run() final;

    nsresult Cancel() final;

   private:
    PromiseArray mUnhandledRejections;
  };

  FinalizationRegistryCleanup mFinalizationRegistryCleanup;
};

class MOZ_STACK_CLASS nsAutoMicroTask {
 public:
  nsAutoMicroTask() {
    CycleCollectedJSContext* ccjs = CycleCollectedJSContext::Get();
    if (ccjs) {
      ccjs->EnterMicroTask();
    }
  }
  MOZ_CAN_RUN_SCRIPT ~nsAutoMicroTask() {
    CycleCollectedJSContext* ccjs = CycleCollectedJSContext::Get();
    if (ccjs) {
      ccjs->LeaveMicroTask();
    }
  }
};

}  // namespace mozilla

#endif  // mozilla_CycleCollectedJSContext_h
