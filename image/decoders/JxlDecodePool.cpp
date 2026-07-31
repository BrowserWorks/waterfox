/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Hands the Rust JXL decoder a thread pool to spread one decode's work over.
//
// This creates the thread pool in C++. nsIThreadPool has Rust bindings, but
// nsThreadPool is not a registered component, so there is no way to construct
// one from Rust. Everything else is done in rust.
//
// Use SharedThreadPool so we get: one singleton threadpool that is lazily
// created, it is shut down for us at xpcom-shutdown-threads, and reaps its
// idle threads after a short timeout.

#include "mozilla/AppShutdown.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/SharedThreadPool.h"
#include "mozilla/StaticMutex.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/image/jxl_decoder_ffi.h"
#include "nsIThreadPool.h"
#include "nsThreadUtils.h"

namespace mozilla::image {

static StaticMutex sPoolMutex;
static StaticRefPtr<nsIThreadPool> sPool MOZ_GUARDED_BY(sPoolMutex);

static void ReleasePool() {
  StaticMutexAutoLock lock(sPoolMutex);
  sPool = nullptr;
}

// Registered from image module initialization, which runs on the main thread
// before anything can decode. RunOnShutdown rather than ClearOnShutdown so the
// release happens under sPoolMutex.
void ClearJxlDecodePoolOnShutdown() {
  MOZ_ASSERT(NS_IsMainThread());
  RunOnShutdown(&ReleasePool);
}

extern "C" {

// Null once the pool would be useless, which the caller takes as "do the work
// on this thread". aThreadLimit only has an effect on the call that creates the
// pool.
//
// The pool is cached here rather than fetched from SharedThreadPool::Get every
// time: Get takes a mutex shared with every other SharedThreadPool user in the
// process, and then the pool's own lock, which every thread dispatching to the
// pool and every worker pulling from it is already contending for.
const nsIThreadPool* JxlGetDecodePool(uint32_t aThreadLimit) {
  if (aThreadLimit == 0) {
    return nullptr;
  }
  StaticMutexAutoLock lock(sPoolMutex);
  if (!sPool) {
    // Past this point Get can only hand back a stub that fails every dispatch,
    // so there is nothing to gain by creating one. It is also what stops sPool
    // being resurrected after its release has run, since that happens later, at
    // XPCOMShutdownFinal.
    if (AppShutdown::IsInOrBeyond(ShutdownPhase::XPCOMShutdownThreads)) {
      return nullptr;
    }

    RefPtr<SharedThreadPool> pool =
        SharedThreadPool::Get("JxlDecode", aThreadLimit);
    sPool = pool.forget();
  }
  return do_AddRef(sPool.get()).take();
}

}  // extern "C"

}  // namespace mozilla::image
