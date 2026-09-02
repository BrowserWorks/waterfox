/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsUpdateMutex_h_
#define nsUpdateMutex_h_

#include "nsIUpdateService.h"
#include "nsProfileLock.h"
#include "mozilla/StaticMutex.h"

/**
 * A primitive object type suitable for acquiring the update mutex. It is
 * composed of two parts:
 *  - a nsProfileLock taken on the update directory, to ensure that if two
 *    instances running from the same application path try to acquire the
 *    update mutex simultaneously, only one of them succeeds;
 *  - a StaticMutex, to ensure that even within the same instance of the
 *    application, it is never possible to successfully acquire two
 *    UpdateMutexImpl objects simultaneously.
 *
 * While the second part is not strictly required, it makes reasoning about
 * these objects easier, and it helps us simulate an acquisition coming from
 * another instance in tests.
 *
 * Contrary to a nsIUpdateMutex object, an UpdateMutexImpl object does not
 * keep track of whether it is currently locked or unlocked. Therefore, it is
 * the responsibility of the caller to guarantee the following:
 *  - a call to Unlock() must only occur after a matching successful call to
 *    TryLock();
 *  - no second call to TryLock() should ever occur after a successful first
 *    call to TryLock(), unless a call to Unlock() occurred in the middle.
 */
class MOZ_CAPABILITY("mutex") UpdateMutexImpl {
 public:
  [[nodiscard]] bool TryLock() MOZ_TRY_ACQUIRE(true);

  void Unlock() MOZ_CAPABILITY_RELEASE();

 private:
  static mozilla::StaticMutex sInProcessMutex;

  nsProfileLock mCrossProcessLock;
};

/**
 * An XPCOM wrapper for the UpdateMutexImpl primitive type, achieving the same
 * goals but through a safe XPCOM-compatible nsIUpdateMutex interface.
 *
 * Contrary to UpdateMutexImpl objects, nsUpdateMutex objects track whether
 * they are currently locked or unlocked. It is therefore always safe to call
 * TryLock() or Unlock() on a nsUpdateMutex object.
 *
 * See nsIUpdateMutex in nsUpdateService.idl for more details.
 */
class nsUpdateMutex final : public nsIUpdateMutex {
 public:
  explicit nsUpdateMutex() = default;

  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIUPDATEMUTEX

 private:
  UpdateMutexImpl mUpdateMutexImpl;
  bool mIsLocked{};

  virtual ~nsUpdateMutex() {
    if (mIsLocked) {
      Unlock();
    }
  }
};

#endif  // nsUpdateMutex_h_
