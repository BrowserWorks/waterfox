/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_BrotliUtils_h
#define mozilla_BrotliUtils_h

#include "brotli/decode.h"

extern "C" {

BrotliDecoderState* MozBrotliDecoderCreateInstance();

// Zero-initializes the output buffer and rejects overlapping input/output ranges.
BrotliDecoderResult MozBrotliDecoderDecompress(size_t aEncodedSize,
                                               const uint8_t* aEncodedBuffer,
                                               size_t* aDecodedSize,
                                               uint8_t* aDecodedBuffer);

}

#endif  // mozilla_BrotliUtils_h
