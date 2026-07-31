/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsImageModule.h"

#include "mozilla/ModuleUtils.h"
#include "mozilla/Preferences.h"
#include "mozilla/StaticPrefs_image.h"

#include "DecodePool.h"
#include "ImageFactory.h"
#include "nsICategoryManager.h"
#include "nsServiceManagerUtils.h"
#include "ShutdownTracker.h"
#include "SurfaceCache.h"
#include "imgLoader.h"

using namespace mozilla::image;

#ifdef MOZ_JXL
namespace mozilla::image {
// Defined in image/decoders/JxlDecodePool.cpp.
void ClearJxlDecodePoolOnShutdown();
}  // namespace mozilla::image
#endif

struct ImageEnablementCookie {
  bool (*mIsEnabled)();
  const nsLiteralCString mMimeType;
};

#ifdef MOZ_JXL
static void UpdateDocumentViewerRegistration(const char* aPref, void* aData) {
  auto* cookie = static_cast<ImageEnablementCookie*>(aData);

  nsCOMPtr<nsICategoryManager> catMan =
      do_GetService(NS_CATEGORYMANAGER_CONTRACTID);
  if (!catMan) {
    return;
  }

  static nsLiteralCString kCategory = "Gecko-Content-Viewers"_ns;
  static nsLiteralCString kContractId =
      "@mozilla.org/content/document-loader-factory;1"_ns;

  if (cookie->mIsEnabled()) {
    catMan->AddCategoryEntry(kCategory, cookie->mMimeType, kContractId,
                             false /* aPersist */, true /* aReplace */);
  } else {
    catMan->DeleteCategoryEntry(
        kCategory, cookie->mMimeType, false /* aPersist */
    );
  }
}
#endif

static bool sInitialized = false;
nsresult mozilla::image::EnsureModuleInitialized() {
  MOZ_ASSERT(NS_IsMainThread());

  if (sInitialized) {
    return NS_OK;
  }

#ifdef MOZ_JXL
  static ImageEnablementCookie kJXLCookie = {
      mozilla::StaticPrefs::image_jxl_enabled, "image/jxl"_ns};
  Preferences::RegisterCallbackAndCall(UpdateDocumentViewerRegistration,
                                       "image.jxl.enabled", &kJXLCookie);
  ClearJxlDecodePoolOnShutdown();
#endif

  mozilla::image::ShutdownTracker::Initialize();
  mozilla::image::ImageFactory::Initialize();
  mozilla::image::DecodePool::Initialize();
  mozilla::image::SurfaceCache::Initialize();
  imgLoader::GlobalInit();
  sInitialized = true;
  return NS_OK;
}

void mozilla::image::ShutdownModule() {
  if (!sInitialized) {
    return;
  }
  imgLoader::Shutdown();
  mozilla::image::SurfaceCache::Shutdown();
  sInitialized = false;
}
