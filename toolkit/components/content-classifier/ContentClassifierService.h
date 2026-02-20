/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim: set ts=8 sts=2 et sw=2 tw=80: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_ContentClassifierService_h
#define mozilla_ContentClassifierService_h

#include "mozilla/Mutex.h"
#include "mozilla/StaticPtr.h"
#include "mozilla/ThreadSafety.h"
#include "mozilla/UniquePtr.h"
#include "nsIAsyncShutdown.h"
#include "nsIChannel.h"
#include "nsISupportsImpl.h"
#include "nsTArray.h"

#include "mozilla/ContentClassifierEngine.h"

namespace mozilla {

enum class ClassifyMode { Annotate, Cancel };

enum class InitPhase {
  NotInited,
  InitSucceeded,
  InitFailed,
  ShutdownStarted,
  ShutdownEnded
};

class ContentClassifierService final : public nsIAsyncShutdownBlocker {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIASYNCSHUTDOWNBLOCKER

  static already_AddRefed<ContentClassifierService> GetInstance();

  static bool IsEnabled();
  static bool IsInitialized();

  ContentClassifierResult ClassifyForCancel(
      const ContentClassifierRequest& aRequest);
  ContentClassifierResult ClassifyForAnnotate(
      const ContentClassifierRequest& aRequest);

  void CancelChannel(nsIChannel* aChannel);
  void AnnotateChannel(nsIChannel* aChannel);

 private:
  ContentClassifierService();
  ~ContentClassifierService();

  void Init();
  static void OnPrefChange(const char* aPref, void* aData);
  void LoadFilterLists();
  void RemoveBlocker();
  already_AddRefed<nsIAsyncShutdownClient> GetAsyncShutdownBarrier() const;

  ContentClassifierResult ClassifyWithEngines(
      const nsTArray<UniquePtr<ContentClassifierEngine>>& aEngines,
      const ContentClassifierRequest& aRequest);

  static StaticRefPtr<ContentClassifierService> sInstance;

  mozilla::Mutex mLock MOZ_UNANNOTATED;
  InitPhase mInitPhase MOZ_GUARDED_BY(mLock);
  nsTArray<UniquePtr<ContentClassifierEngine>> mBlockEngines
      MOZ_GUARDED_BY(mLock);
  nsTArray<UniquePtr<ContentClassifierEngine>> mAnnotateEngines
      MOZ_GUARDED_BY(mLock);
};

}  // namespace mozilla

#endif  // mozilla_ContentClassifierService_h
