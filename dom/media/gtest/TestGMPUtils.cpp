/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <string>

#include "GMPUtils.h"
#include "gtest/gtest.h"
#include "nsString.h"

using namespace mozilla;

void TestSplitAt(const char* aInput, const char* aDelims,
                 size_t aNumExpectedTokens, const char* aExpectedTokens[]) {
  nsCString input(aInput);
  nsTArray<nsCString> tokens;
  SplitAt(aDelims, input, tokens);
  EXPECT_EQ(tokens.Length(), aNumExpectedTokens)
      << "Should get expected number of tokens";
  for (size_t i = 0; i < tokens.Length(); i++) {
    EXPECT_TRUE(tokens[i].EqualsASCII(aExpectedTokens[i]))
        << "Tokenize fail; expected=" << aExpectedTokens[i]
        << " got=" << tokens[i].get();
  }
}

TEST(GeckoMediaPlugins, TestSplitAt)
{
  {
    const char* input = "1,2,3,4";
    const char* delims = ",";
    const char* tokens[] = {"1", "2", "3", "4"};
    TestSplitAt(input, delims, std::size(tokens), tokens);
  }

  {
    const char* input = "a simple, comma, separated, list";
    const char* delims = ",";
    const char* tokens[] = {"a simple", " comma", " separated", " list"};
    TestSplitAt(input, delims, std::size(tokens), tokens);
  }

  {
    const char* input =  // Various platform line endings...
        "line1\r\n"      // Windows
        "line2\r"        // Old MacOSX
        "line3\n"        // Unix
        "line4";
    const char* delims = "\r\n";
    const char* tokens[] = {"line1", "line2", "line3", "line4"};
    TestSplitAt(input, delims, std::size(tokens), tokens);
  }
}

TEST(GeckoMediaPlugins, ToHexString)
{
  struct Test {
    nsTArray<uint8_t> bytes;
    std::string hex;
  };

  static const Test tests[] = {
      {{0x00, 0x00}, "0000"},
      {{0xff, 0xff}, "ffff"},
      {{0xff, 0x00}, "ff00"},
      {{0x00, 0xff}, "00ff"},
      {{0xf0, 0x10}, "f010"},
      {{0x05, 0x50}, "0550"},
      {{0xf}, "0f"},
      {{0x10}, "10"},
      {{}, ""},
      {{0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb,
        0xcc, 0xdd, 0xee, 0xff},
       "00112233445566778899aabbccddeeff"},
  };

  for (const Test& test : tests) {
    EXPECT_STREQ(test.hex.c_str(), ToHexString(test.bytes).get());
  }
}
