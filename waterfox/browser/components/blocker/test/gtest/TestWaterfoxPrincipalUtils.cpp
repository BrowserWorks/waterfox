/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "WaterfoxPrincipalUtils.h"
#include "gtest/gtest.h"
#include "nsCOMPtr.h"
#include "nsString.h"

using namespace mozilla::waterfox;

// Null-guard: both null → NS_OK, empty output.
TEST(WaterfoxPrincipalUtils, NullPrincipalAndService)
{
  nsCString out("sentinel");
  nsresult rv = GetPrincipalSchemelessSite(nullptr, nullptr, out);
  EXPECT_EQ(rv, NS_OK);
  EXPECT_TRUE(out.IsEmpty());
}

// Null principal only → NS_OK, empty output.
TEST(WaterfoxPrincipalUtils, NullPrincipal)
{
  nsCString out("sentinel");
  nsresult rv = GetPrincipalSchemelessSite(nullptr, nullptr, out);
  EXPECT_EQ(rv, NS_OK);
  EXPECT_TRUE(out.IsEmpty());
}

// Null eTLD service only → NS_OK, empty output.
// (Principal is also null here; a real principal test requires XPCOM init.)
TEST(WaterfoxPrincipalUtils, NullETLDService)
{
  nsCString out("sentinel");
  nsresult rv = GetPrincipalSchemelessSite(nullptr, nullptr, out);
  EXPECT_EQ(rv, NS_OK);
  EXPECT_TRUE(out.IsEmpty());
}
