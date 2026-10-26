/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "FormatBrotli.h"

#include <cstring>
#include <memory>

#include "BaseAlgorithms.h"
#include "brotli/decode.h"
#include "brotli/encode.h"
#include "mozilla/BrotliUtils.h"
#include "mozilla/dom/TransformStreamDefaultController.h"

namespace mozilla::dom::compression {

NS_IMPL_CYCLE_COLLECTION_INHERITED(BrotliCompressionStreamAlgorithms,
                                   TransformerAlgorithmsBase)
NS_IMPL_ADDREF_INHERITED(BrotliCompressionStreamAlgorithms,
                         TransformerAlgorithmsBase)
NS_IMPL_RELEASE_INHERITED(BrotliCompressionStreamAlgorithms,
                          TransformerAlgorithmsBase)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(BrotliCompressionStreamAlgorithms)
NS_INTERFACE_MAP_END_INHERITING(TransformerAlgorithmsBase)

NS_IMPL_CYCLE_COLLECTION_INHERITED(BrotliDecompressionStreamAlgorithms,
                                   TransformerAlgorithmsBase)
NS_IMPL_ADDREF_INHERITED(BrotliDecompressionStreamAlgorithms,
                         TransformerAlgorithmsBase)
NS_IMPL_RELEASE_INHERITED(BrotliDecompressionStreamAlgorithms,
                          TransformerAlgorithmsBase)
NS_INTERFACE_MAP_BEGIN_CYCLE_COLLECTION(BrotliDecompressionStreamAlgorithms)
NS_INTERFACE_MAP_END_INHERITING(TransformerAlgorithmsBase)

inline BrotliEncoderOperation intoBrotliOp(Flush aFlush) {
  switch (aFlush) {
    case Flush::No: {
      return BROTLI_OPERATION_PROCESS;
    }
    case Flush::Yes: {
      return BROTLI_OPERATION_FINISH;
    }
    default: {
      MOZ_ASSERT_UNREACHABLE("Unknown flush mode");
      return BROTLI_OPERATION_PROCESS;
    }
  }
}

Result<already_AddRefed<BrotliCompressionStreamAlgorithms>, nsresult>
BrotliCompressionStreamAlgorithms::Create() {
  RefPtr<BrotliCompressionStreamAlgorithms> alg =
      new BrotliCompressionStreamAlgorithms();
  MOZ_TRY(alg->Init());
  return alg.forget();
}

[[nodiscard]] nsresult BrotliCompressionStreamAlgorithms::Init() {
  mState = std::unique_ptr<BrotliEncoderStateStruct, BrotliDeleter>(
      BrotliEncoderCreateInstance(nullptr, nullptr, nullptr));
  if (!mState) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  return NS_OK;
}

// Shared by:
// https://wicg.github.io/compression/#compress-and-enqueue-a-chunk
// https://wicg.github.io/compression/#compress-flush-and-enqueue
// All data errors throw TypeError by step 2: If this results in an error,
// then throw a TypeError.
void BrotliCompressionStreamAlgorithms::Compress(
    JSContext* aCx, Span<const uint8_t> aInput,
    JS::MutableHandleVector<JSObject*> aOutput, Flush aFlush,
    ErrorResult& aRv) {
  size_t inputLength = aInput.Length();
  const uint8_t* inputBuffer = aInput.Elements();

  do {
    std::unique_ptr<uint8_t[], JS::FreePolicy> buffer(
        static_cast<uint8_t*>(JS_malloc(aCx, kBufferSize)));
    if (!buffer) {
      aRv.ThrowTypeError("Out of memory");
      return;
    }

    std::memset(buffer.get(), 0, kBufferSize);
    size_t outputLength = kBufferSize;
    uint8_t* outputBuffer = buffer.get();
    bool succeeded = BrotliEncoderCompressStream(
        mState.get(), intoBrotliOp(aFlush), &inputLength, &inputBuffer,
        &outputLength, &outputBuffer, nullptr);
    if (!succeeded) {
      aRv.ThrowTypeError("Unexpected compression error");
      return;
    }

    // Step 3: If buffer is empty, return.
    // (We'll implicitly return when the array is empty.)

    // Step 4: Split buffer into one or more non-empty pieces and convert them
    // into Uint8Arrays.
    // (The buffer is 'split' by having a fixed sized buffer above.)

    size_t written = kBufferSize - outputLength;
    if (written > 0) {
      JS::Rooted<JSObject*> view(aCx, nsJSUtils::MoveBufferAsUint8Array(
                                          aCx, written, std::move(buffer)));
      if (!view || !aOutput.append(view)) {
        JS_ClearPendingException(aCx);
        aRv.ThrowTypeError("Out of memory");
        return;
      }
    }
  } while (BrotliEncoderHasMoreOutput(mState.get()));
}

void BrotliCompressionStreamAlgorithms::BrotliDeleter::operator()(
    BrotliEncoderStateStruct* aState) {
  BrotliEncoderDestroyInstance(aState);
}

Result<already_AddRefed<BrotliDecompressionStreamAlgorithms>, nsresult>
BrotliDecompressionStreamAlgorithms::Create() {
  RefPtr<BrotliDecompressionStreamAlgorithms> alg =
      new BrotliDecompressionStreamAlgorithms();
  MOZ_TRY(alg->Init());
  return alg.forget();
}

[[nodiscard]] nsresult BrotliDecompressionStreamAlgorithms::Init() {
  mState = std::unique_ptr<BrotliDecoderStateStruct, BrotliDeleter>(
      MozBrotliDecoderCreateInstance());
  if (!mState) {
    return NS_ERROR_OUT_OF_MEMORY;
  }
  return NS_OK;
}

// Shared by:
// https://wicg.github.io/compression/#decompress-and-enqueue-a-chunk
// https://wicg.github.io/compression/#decompress-flush-and-enqueue
// All data errors throw TypeError by step 2: If this results in an error,
// then throw a TypeError.
bool BrotliDecompressionStreamAlgorithms::Decompress(
    JSContext* aCx, Span<const uint8_t> aInput,
    JS::MutableHandleVector<JSObject*> aOutput, Flush aFlush,
    ErrorResult& aRv) {
  size_t inputLength = aInput.Length();
  const uint8_t* inputBuffer = aInput.Elements();

  do {
    std::unique_ptr<uint8_t[], JS::FreePolicy> buffer(
        static_cast<uint8_t*>(JS_malloc(aCx, kBufferSize)));
    if (!buffer) {
      aRv.ThrowTypeError("Out of memory");
      return false;
    }

    std::memset(buffer.get(), 0, kBufferSize);
    size_t outputLength = kBufferSize;
    uint8_t* outputBuffer = buffer.get();
    BrotliDecoderResult rv =
        BrotliDecoderDecompressStream(mState.get(), &inputLength, &inputBuffer,
                                      &outputLength, &outputBuffer, nullptr);
    switch (rv) {
      case BROTLI_DECODER_RESULT_ERROR:
        aRv.ThrowTypeError("Brotli decompression error: "_ns +
                           nsDependentCString(BrotliDecoderErrorString(
                               BrotliDecoderGetErrorCode(mState.get()))));
        return false;
      case BROTLI_DECODER_RESULT_SUCCESS:
        mObservedStreamEnd = true;
        break;
      case BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT:
      case BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT:
        break;
      default:
        MOZ_ASSERT_UNREACHABLE("Unexpected decompression error code");
        aRv.ThrowTypeError("Unexpected decompression error");
        return false;
    }

    // Step 3: If buffer is empty, return.
    // (We'll implicitly return when the array is empty.)

    // Step 4: Split buffer into one or more non-empty pieces and convert them
    // into Uint8Arrays.
    // (The buffer is 'split' by having a fixed sized buffer above.)

    size_t written = kBufferSize - outputLength;
    if (written > 0) {
      JS::Rooted<JSObject*> view(aCx, nsJSUtils::MoveBufferAsUint8Array(
                                          aCx, written, std::move(buffer)));
      if (!view || !aOutput.append(view)) {
        JS_ClearPendingException(aCx);
        aRv.ThrowTypeError("Out of memory");
        return false;
      }
    }
  } while (BrotliDecoderHasMoreOutput(mState.get()));

  return inputLength == 0;
}

void BrotliDecompressionStreamAlgorithms::BrotliDeleter::operator()(
    BrotliDecoderStateStruct* aState) {
  BrotliDecoderDestroyInstance(aState);
}

}  // namespace mozilla::dom::compression
