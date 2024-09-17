// Copyright (c) the JPEG XL Project Authors. All rights reserved.
//
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

#include <jxl/memory_manager.h>

#include "benchmark/benchmark.h"
#include "lib/extras/tone_mapping.h"
#include "lib/jxl/base/status.h"
#include "lib/jxl/image.h"
#include "tools/no_memory_manager.h"

namespace jxl {

#define QUIT(M)           \
  state.SkipWithError(M); \
  return;

#define BM_CHECK(C) \
  if (!(C)) {       \
    QUIT(#C)        \
  }

static void BM_ToneMapping(benchmark::State& state) {
  JxlMemoryManager* memory_manager = jpegxl::tools::NoMemoryManager();
  JXL_ASSIGN_OR_QUIT(Image3F color, Image3F::Create(memory_manager, 2268, 1512),
                     "Failed to allocate color plane");
  FillImage(0.5f, &color);

  // Use linear Rec. 2020 so that `ToneMapTo` doesn't have to convert to it and
  // we mainly measure the tone mapping itself.
  ColorEncoding linear_rec2020;
  linear_rec2020.SetColorSpace(ColorSpace::kRGB);
  BM_CHECK(linear_rec2020.SetPrimariesType(Primaries::k2100));
  BM_CHECK(linear_rec2020.SetWhitePointType(WhitePoint::kD65));
  linear_rec2020.Tf().SetTransferFunction(TransferFunction::kLinear);
  BM_CHECK(linear_rec2020.CreateICC());

  for (auto _ : state) {
    (void)_;
    state.PauseTiming();
    CodecInOut tone_mapping_input{memory_manager};
    JXL_ASSIGN_OR_QUIT(
        Image3F color2,
        Image3F::Create(memory_manager, color.xsize(), color.ysize()),
        "Failed to allocate color plane");
    BM_CHECK(CopyImageTo(color, &color2));
    BM_CHECK(
        tone_mapping_input.SetFromImage(std::move(color2), linear_rec2020));
    tone_mapping_input.metadata.m.SetIntensityTarget(255);
    state.ResumeTiming();

    BM_CHECK(ToneMapTo({0.1, 100}, &tone_mapping_input));
  }

  state.SetItemsProcessed(state.iterations() * color.xsize() * color.ysize());
}
BENCHMARK(BM_ToneMapping);

}  // namespace jxl
