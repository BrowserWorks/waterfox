// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#include <jxl/compressed_icc.h>

#include "lib/jxl/base/span.h"
#include "lib/jxl/enc_aux_out.h"
#include "lib/jxl/enc_icc_codec.h"
#include "lib/jxl/icc_codec.h"

JXL_BOOL JxlICCProfileEncode(const JxlMemoryManager* memory_manager,
                             const uint8_t* icc, size_t icc_size,
                             uint8_t** compressed_icc,
                             size_t* compressed_icc_size) {
  JxlMemoryManager local_memory_manager;
  if (!jxl::MemoryManagerInit(&local_memory_manager, memory_manager)) {
    return JXL_FALSE;
  }
  jxl::BitWriter writer(&local_memory_manager);
  JXL_RETURN_IF_ERROR(jxl::WriteICC(jxl::Span<const uint8_t>(icc, icc_size),
                                    &writer, jxl::LayerType::Header, nullptr));
  writer.ZeroPadToByte();
  jxl::Bytes bytes = writer.GetSpan();
  *compressed_icc_size = bytes.size();
  *compressed_icc = static_cast<uint8_t*>(
      jxl::MemoryManagerAlloc(&local_memory_manager, *compressed_icc_size));
  memcpy(*compressed_icc, bytes.data(), bytes.size());
  return JXL_TRUE;
}

JXL_BOOL JxlICCProfileDecode(const JxlMemoryManager* memory_manager,
                             const uint8_t* compressed_icc,
                             size_t compressed_icc_size, uint8_t** icc,
                             size_t* icc_size) {
  JxlMemoryManager local_memory_manager;
  if (!jxl::MemoryManagerInit(&local_memory_manager, memory_manager)) {
    return JXL_FALSE;
  }
  jxl::ICCReader icc_reader(&local_memory_manager);
  jxl::PaddedBytes decompressed(&local_memory_manager);
  jxl::BitReader bit_reader(
      jxl::Span<const uint8_t>(compressed_icc, compressed_icc_size));
  JXL_RETURN_IF_ERROR(icc_reader.Init(&bit_reader));
  JXL_RETURN_IF_ERROR(icc_reader.Process(&bit_reader, &decompressed));
  JXL_RETURN_IF_ERROR(bit_reader.Close());
  *icc_size = decompressed.size();
  *icc = static_cast<uint8_t*>(
      jxl::MemoryManagerAlloc(&local_memory_manager, *icc_size));
  memcpy(*icc, decompressed.data(), *icc_size);
  return JXL_TRUE;
}
