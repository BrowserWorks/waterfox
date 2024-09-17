// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#include "jxl/compressed_icc.h"

#include <jxl/memory_manager.h>

#include <cstddef>
#include <cstdint>
#include <cstring>

#include "lib/jxl/color_encoding_internal.h"
#include "lib/jxl/test_memory_manager.h"
#include "lib/jxl/test_utils.h"
#include "lib/jxl/testing.h"

namespace jxl {
namespace {

TEST(CompressedIccTest, Roundtrip) {
  JxlMemoryManager* memory_manager = jxl::test::MemoryManager();
  uint8_t* compressed_icc;
  size_t compressed_icc_size;
  const IccBytes icc = jxl::test::GetIccTestProfile();
  ASSERT_TRUE(JxlICCProfileEncode(memory_manager, icc.data(), icc.size(),
                                  &compressed_icc, &compressed_icc_size));

  EXPECT_LT(compressed_icc_size, icc.size());

  uint8_t* decompressed_icc;
  size_t decompressed_icc_size;
  ASSERT_TRUE(JxlICCProfileDecode(memory_manager, compressed_icc,
                                  compressed_icc_size, &decompressed_icc,
                                  &decompressed_icc_size));

  ASSERT_EQ(decompressed_icc_size, icc.size());

  EXPECT_EQ(0, memcmp(decompressed_icc, icc.data(), decompressed_icc_size));

  memory_manager->free(memory_manager->opaque, compressed_icc);
  memory_manager->free(memory_manager->opaque, decompressed_icc);
}

}  // namespace
}  // namespace jxl
