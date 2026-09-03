/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef mozilla_OwnedRustBuffer_h
#define mozilla_OwnedRustBuffer_h

#include "mozilla/ErrorResult.h"
#include "mozilla/dom/TypedArray.h"
#include "mozilla/uniffi/Rust.h"

namespace mozilla::uniffi {

// RustBuffer that's owned by the JS code and handles the memory management
class OwnedRustBuffer final {
 private:
  RustBuffer mBuf;

  void FreeData();

 public:
  // The default constructor creates an invalid OwnedRustBuffer
  OwnedRustBuffer() : mBuf{0} {};

  // Constructor for creating an OwnedRustBuffer from a raw RustBuffer struct
  // that was returned by Rust (therefore we now own the RustBuffer).
  explicit OwnedRustBuffer(const RustBuffer& aBuf);

  // Manual implementation of move constructor and assignment operator.
  OwnedRustBuffer(OwnedRustBuffer&& aOther);
  OwnedRustBuffer& operator=(OwnedRustBuffer&& aOther);

  // Delete copy & move constructor as this type is non-copyable.
  OwnedRustBuffer(const OwnedRustBuffer&) = delete;
  OwnedRustBuffer& operator=(const OwnedRustBuffer&) = delete;

  // Destructor that frees the RustBuffer if it is still valid
  ~OwnedRustBuffer();

  // Constructor for creating an OwnedRustBuffer from an ArrayBuffer.
  static OwnedRustBuffer FromArrayBuffer(
      const mozilla::dom::ArrayBuffer& aArrayBuffer);

  // Moves the buffer out of this `OwnedArrayBuffer` into a raw `RustBuffer`
  // struct.  The raw struct must be passed into a Rust function, transferring
  // ownership to Rust.  After this call the buffer will no longer be valid.
  RustBuffer IntoRustBuffer();

  // Moves the buffer out of this `OwnedArrayBuffer` into a JS ArrayBuffer.
  // This transfers ownership into the JS engine.  After this call the buffer
  // will no longer be valid.
  void IntoArrayBuffer(JSContext* cx, JS::MutableHandle<JSObject*> aResult,
                       ErrorResult& aError);

  // Is this RustBuffer pointing to valid data?
  bool IsValid() const { return mBuf.data != nullptr; }

 private:
  // Helper function used by IntoArrayBuffer.
  static void ArrayBufferFreeFunc(void* contents, void* userData);
};

}  // namespace mozilla::uniffi

#endif  // mozilla_OwnedRustBuffer_h
