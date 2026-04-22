/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef WaterfoxPrincipalUtils_h
#define WaterfoxPrincipalUtils_h

#include "nsString.h"

class nsIPrincipal;
class nsIEffectiveTLDService;

namespace mozilla {
namespace waterfox {

// Returns the schemeless site (eTLD+1) for a given principal.
// Falls back gracefully through siteOriginNoSuffix → host → raw origin.
nsresult GetPrincipalSchemelessSite(nsIPrincipal* aPrincipal,
                                    nsIEffectiveTLDService* aETLDService,
                                    nsACString& aOutSite);

}  // namespace waterfox
}  // namespace mozilla

#endif  // WaterfoxPrincipalUtils_h
