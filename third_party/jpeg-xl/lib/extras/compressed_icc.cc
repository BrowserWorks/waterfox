// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#include <jxl/compressed_icc.h>

#include "lib/jxl/enc_aux_out.h"
#include "lib/jxl/enc_icc_codec.h"
#include "lib/jxl/icc_codec.h"

JXL_BOOL JxlICCProfileEncode(JxlMemoryManager* memory_manager,
                             const uint8_t* icc, size_t icc_size,
                             uint8_t** compressed_icc,
                             size_t* compressed_icc_size) {
  jxl::BitWriter writer(memory_manager);
  JXL_RETURN_IF_ERROR(jxl::WriteICC(jxl::Span<const uint8_t>(icc, icc_size),
                                    &writer, jxl::LayerType::Header, nullptr));
  writer.ZeroPadToByte();
  *compressed_icc_size = writer.GetSpan().size();
  *compressed_icc = static_cast<uint8_t*>(
      memory_manager->alloc(memory_manager->opaque, *compressed_icc_size));
  memcpy(*compressed_icc, writer.GetSpan().data(), *compressed_icc_size);
  return JXL_TRUE;
}

JXL_BOOL JxlICCProfileDecode(JxlMemoryManager* memory_manager,
                             const uint8_t* compressed_icc,
                             size_t compressed_icc_size, uint8_t** icc,
                             size_t* icc_size) {
  jxl::ICCReader icc_reader(memory_manager);
  jxl::PaddedBytes decompressed(memory_manager);
  jxl::BitReader bit_reader(
      jxl::Span<const uint8_t>(compressed_icc, compressed_icc_size));
  JXL_RETURN_IF_ERROR(icc_reader.Init(&bit_reader, /*output_limit=*/0));
  JXL_RETURN_IF_ERROR(icc_reader.Process(&bit_reader, &decompressed));
  JXL_RETURN_IF_ERROR(bit_reader.Close());
  *icc_size = decompressed.size();
  *icc = static_cast<uint8_t*>(
      memory_manager->alloc(memory_manager->opaque, *icc_size));
  memcpy(*icc, decompressed.data(), *icc_size);
  return JXL_TRUE;
}
