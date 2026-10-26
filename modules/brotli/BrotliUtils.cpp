/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "BrotliUtils.h"

#include <cstdlib>
#include <cstring>

#include "mozilla/CheckedInt.h"
#include "mozilla/ScopeExit.h"

namespace {

void* BrotliAlloc(void*, size_t aSize) { return std::calloc(1, aSize); }

void BrotliFree(void*, void* aAddress) { std::free(aAddress); }

}  // namespace

extern "C" BrotliDecoderState* MozBrotliDecoderCreateInstance() {
  auto* state = BrotliDecoderCreateInstance(BrotliAlloc, BrotliFree, nullptr);
  if (state && !BrotliDecoderSetParameter(
                   state, BROTLI_DECODER_PARAM_LARGE_WINDOW, 0)) {
    BrotliDecoderDestroyInstance(state);
    return nullptr;
  }
  return state;
}

extern "C" BrotliDecoderResult MozBrotliDecoderDecompress(
    size_t aEncodedSize, const uint8_t* aEncodedBuffer, size_t* aDecodedSize,
    uint8_t* aDecodedBuffer) {
  if (!aDecodedSize) {
    return BROTLI_DECODER_RESULT_ERROR;
  }
  const size_t capacity = *aDecodedSize;
  *aDecodedSize = 0;
  if ((aEncodedSize && !aEncodedBuffer) || (capacity && !aDecodedBuffer)) {
    return BROTLI_DECODER_RESULT_ERROR;
  }
  if (aEncodedSize && capacity) {
    const auto inputBegin = reinterpret_cast<uintptr_t>(aEncodedBuffer);
    const auto outputBegin = reinterpret_cast<uintptr_t>(aDecodedBuffer);
    const auto inputEnd = mozilla::CheckedInt<uintptr_t>(inputBegin) + aEncodedSize;
    const auto outputEnd = mozilla::CheckedInt<uintptr_t>(outputBegin) + capacity;
    if (!inputEnd.isValid() || !outputEnd.isValid() ||
        (inputBegin < outputEnd.value() && outputBegin < inputEnd.value())) {
      return BROTLI_DECODER_RESULT_ERROR;
    }
  }

  auto* state = MozBrotliDecoderCreateInstance();
  if (!state) {
    return BROTLI_DECODER_RESULT_ERROR;
  }
  auto cleanup =
      mozilla::MakeScopeExit([&] { BrotliDecoderDestroyInstance(state); });
  // The Rust FFI borrows the entire output capacity as an initialized byte slice.
  if (capacity) {
    std::memset(aDecodedBuffer, 0, capacity);
  }
  size_t availableIn = aEncodedSize;
  const uint8_t* nextIn = aEncodedBuffer;
  size_t availableOut = capacity;
  uint8_t* nextOut = aDecodedBuffer;
  const auto result = BrotliDecoderDecompressStream(
      state, &availableIn, &nextIn, &availableOut, &nextOut, nullptr);
  *aDecodedSize = capacity - availableOut;
  return result == BROTLI_DECODER_RESULT_SUCCESS ? result
                                               : BROTLI_DECODER_RESULT_ERROR;
}
