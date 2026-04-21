/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Preserved from intended patch to:
// toolkit/components/content-classifier/content_classifier_engine/ContentClassifierEngine.cpp
// Kept here to avoid upstream conflicts.

#include "WaterfoxPrincipalUtils.h"

#include "mozilla/Components.h"
#include "nsIEffectiveTLDService.h"
#include "nsIPrincipal.h"
#include "nsNetUtil.h"

namespace mozilla {
namespace waterfox {

nsresult GetPrincipalSchemelessSite(nsIPrincipal* aPrincipal,
                                    nsIEffectiveTLDService* aETLDService,
                                    nsACString& aOutSite) {
  aOutSite.Truncate();

  if (!aPrincipal || !aETLDService) {
    return NS_OK;
  }

  nsCString siteOriginNoSuffix;
  nsresult rv = aPrincipal->GetSiteOriginNoSuffix(siteOriginNoSuffix);
  NS_ENSURE_SUCCESS(rv, rv);

  if (siteOriginNoSuffix.IsEmpty()) {
    return NS_OK;
  }

  nsCOMPtr<nsIURI> siteURI;
  rv = NS_NewURI(getter_AddRefs(siteURI), siteOriginNoSuffix);
  if (NS_FAILED(rv) || !siteURI) {
    aOutSite.Assign(siteOriginNoSuffix);
    return NS_OK;
  }

  nsCString host;
  rv = siteURI->GetHost(host);
  if (NS_FAILED(rv) || host.IsEmpty()) {
    aOutSite.Assign(siteOriginNoSuffix);
    return NS_OK;
  }

  rv = aETLDService->GetSchemelessSiteFromHost(host, aOutSite);
  if (NS_FAILED(rv) || aOutSite.IsEmpty()) {
    aOutSite.Assign(host);
    return NS_OK;
  }

  return NS_OK;
}

}  // namespace waterfox
}  // namespace mozilla
