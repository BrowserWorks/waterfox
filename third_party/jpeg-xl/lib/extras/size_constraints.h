// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#ifndef LIB_JXL_SIZE_CONSTRAINTS_H_
#define LIB_JXL_SIZE_CONSTRAINTS_H_

#include <cstdint>
#include <type_traits>

#include "lib/jxl/base/status.h"

namespace jxl {

struct SizeConstraints {
  // Upper limit on pixel dimensions/area, enforced by VerifyDimensions
  // (called from decoders). Fuzzers set smaller values to limit memory use.
  // Default values correspond to JXL level 10.
  uint32_t dec_max_xsize = 1u << 30;
  uint32_t dec_max_ysize = 1u << 30;
  uint64_t dec_max_pixels = static_cast<uint64_t>(1u) << 40;
};

template <typename T,
          class = typename std::enable_if<std::is_unsigned<T>::value>::type>
Status VerifyDimensions(const SizeConstraints* constraints, T xs, T ys) {
  SizeConstraints limit = {};
  if (constraints) limit = *constraints;

  if (xs == 0 || ys == 0) return JXL_FAILURE("Empty image.");
  if (xs > limit.dec_max_xsize) return JXL_FAILURE("Image too wide.");
  if (ys > limit.dec_max_ysize) return JXL_FAILURE("Image too tall.");

  const uint64_t num_pixels = static_cast<uint64_t>(xs) * ys;
  if (num_pixels > limit.dec_max_pixels) {
    return JXL_FAILURE("Image too big.");
  }

  return true;
}

}  // namespace jxl

#endif  // LIB_JXL_SIZE_CONSTRAINTS_H_
