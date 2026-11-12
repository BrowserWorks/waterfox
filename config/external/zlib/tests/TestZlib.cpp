/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <vector>

#include "mozilla/Assertions.h"
#include "zlib.h"

static void CheckAdler32() {
  std::vector<unsigned char> input(200001);
  for (size_t i = 0; i < input.size(); ++i) {
    input[i] = static_cast<unsigned char>((i * 31) ^ (i >> 8));
  }

  constexpr uLong seed = 0x12345678;
  uint32_t s1 = seed & 0xffff;
  uint32_t s2 = seed >> 16;
  for (size_t i = 1; i < input.size(); ++i) {
    s1 = (s1 + input[i]) % 65521;
    s2 = (s2 + s1) % 65521;
  }
  MOZ_RELEASE_ASSERT(adler32(seed, input.data() + 1, input.size() - 1) ==
                     (s2 << 16 | s1));
}

static void CheckRoundTrip(int aWindowBits) {
  std::vector<unsigned char> input(4097);
  for (size_t i = 0; i < input.size(); ++i) {
    input[i] = static_cast<unsigned char>(i * 31);
  }
  std::vector<unsigned char> compressed(compressBound(input.size()) + 32);

  z_stream encoder{};
  MOZ_RELEASE_ASSERT(deflateInit2(&encoder, Z_DEFAULT_COMPRESSION, Z_DEFLATED,
                                  aWindowBits, 8, Z_DEFAULT_STRATEGY) == Z_OK);
  encoder.next_in = input.data();
  encoder.avail_in = input.size();
  int status;
  do {
    MOZ_RELEASE_ASSERT(encoder.total_out < compressed.size());
    encoder.next_out = compressed.data() + encoder.total_out;
    encoder.avail_out =
        std::min<size_t>(17, compressed.size() - encoder.total_out);
    status = deflate(&encoder, Z_FINISH);
    MOZ_RELEASE_ASSERT(status == Z_OK || status == Z_STREAM_END);
  } while (status != Z_STREAM_END);
  compressed.resize(encoder.total_out);
  MOZ_RELEASE_ASSERT(deflateEnd(&encoder) == Z_OK);

  std::vector<unsigned char> restored(input.size() + 1);
  z_stream decoder{};
  MOZ_RELEASE_ASSERT(inflateInit2(&decoder, aWindowBits) == Z_OK);
  decoder.next_in = compressed.data();
  decoder.avail_in = compressed.size();
  do {
    MOZ_RELEASE_ASSERT(decoder.total_out < restored.size());
    decoder.next_out = restored.data() + decoder.total_out;
    decoder.avail_out =
        std::min<size_t>(11, restored.size() - decoder.total_out);
    status = inflate(&decoder, Z_NO_FLUSH);
    MOZ_RELEASE_ASSERT(status == Z_OK || status == Z_STREAM_END);
  } while (status != Z_STREAM_END);
  MOZ_RELEASE_ASSERT(decoder.avail_in == 0);
  MOZ_RELEASE_ASSERT(decoder.total_out == input.size());
  MOZ_RELEASE_ASSERT(inflateEnd(&decoder) == Z_OK);
  MOZ_RELEASE_ASSERT(std::memcmp(input.data(), restored.data(), input.size()) ==
                     0);
}

int main() {
#ifdef USE_LIBZ_RS
  MOZ_RELEASE_ASSERT(std::strstr(zlibVersion(), "zlib-rs"));
#endif
  CheckAdler32();
  CheckRoundTrip(MAX_WBITS);
  CheckRoundTrip(MAX_WBITS + 16);
  CheckRoundTrip(-MAX_WBITS);
  return 0;
}
