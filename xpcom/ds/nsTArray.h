/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef nsTArray_h_
#define nsTArray_h_

#include <string.h>

#include <algorithm>
#include <functional>
#include <initializer_list>
#include <iterator>
#include <new>
#include <ostream>
#include <type_traits>
#include <utility>

#include "mozilla/ArrayIterator.h"
#include "mozilla/Assertions.h"
#include "mozilla/Attributes.h"
#include "mozilla/BinarySearch.h"
#include "mozilla/CheckedInt.h"
#include "mozilla/FunctionTypeTraits.h"
#include "mozilla/MathAlgorithms.h"
#include "mozilla/MemoryReporting.h"
#include "mozilla/NotNull.h"
#include "mozilla/Span.h"
#include "mozilla/fallible.h"
#include "mozilla/mozalloc.h"
#include "nsAlgorithm.h"
#include "nsDebug.h"
#include "nsISupports.h"
#include "nsRegionFwd.h"
#include "nsTArrayForwardDeclare.h"

namespace JS {
template <class T>
class Heap;
} /* namespace JS */

class nsCycleCollectionTraversalCallback;
struct TraceCallbacks;
class nsRegion;

namespace mozilla::a11y {
class BatchData;
}

namespace mozilla {
namespace layers {
class Animation;
class FrameStats;
struct PropertyAnimationGroup;
struct TileClient;
}  // namespace layers
}  // namespace mozilla

namespace mozilla {
struct SerializedStructuredCloneBuffer;
class SourceBufferTask;
}  // namespace mozilla

namespace mozilla::dom::binding_detail {
template <typename, typename>
class RecordEntry;
}

namespace mozilla::dom {
class MessagePortIdentifier;
template <typename T>
struct Nullable;
class OwningFileOrDirectory;
class OwningStringOrBooleanOrObject;
class OwningUTF8StringOrDouble;
class Pref;
class RefMessageData;
class ResponsiveImageCandidate;
class ServiceWorkerRegistrationData;
namespace indexedDB {
class SerializedStructuredCloneReadInfo;
class ObjectStoreCursorResponse;
class IndexCursorResponse;
}  // namespace indexedDB
}  // namespace mozilla::dom

namespace mozilla::ipc {
class ContentSecurityPolicy;
template <class T>
class Endpoint;
}  // namespace mozilla::ipc

class JSStructuredCloneData;

template <class T>
class RefPtr;

//
// nsTArray<E> is a resizable array class, like std::vector.
//
// Unlike std::vector, which follows C++'s construction/destruction rules,
// By default, nsTArray assumes that instances of E can be relocated safely
// using memory utils (memcpy/memmove).
//
// The public classes defined in this header are
//
//   nsTArray<E>,
//   CopyableTArray<E>,
//   FallibleTArray<E>,
//   AutoTArray<E, N>,
//   CopyableAutoTArray<E, N>
//
// nsTArray, CopyableTArray, AutoTArray and CopyableAutoTArray are infallible by
// default. To opt-in to fallible behaviour, use the `mozilla::fallible`
// parameter and check the return value.
//
// CopyableTArray and CopyableAutoTArray< are copy-constructible and
// copy-assignable. Use these only when syntactically necessary to avoid implicit
// unintentional copies. nsTArray/AutoTArray can be conveniently copied using
// the Clone() member function. Consider using std::move where possible.
//
// If you just want to declare the nsTArray types (e.g., if you're in a header
// file and don't need the full nsTArray definitions) consider including
// nsTArrayForwardDeclare.h instead of nsTArray.h.
//
// The template parameter E specifies the type of the elements and has the
// following requirements:
//
//   E MUST be safely memmove()'able.
//   E MUST define a copy-constructor.
//   E MAY define operator< for sorting.
//   E MAY define operator== for searching.
//
// (Note that the memmove requirement may be relaxed for certain types - see
// nsTArray_RelocationStrategy below.)
//
// There is a public type value_type defined as E within each array class, and
// we reference the type under this name below.
//
// For member functions taking a Comparator instance, Comparator must be either
// a functor with a tri-state comparison function with a signature compatible to
//
//   /** @return negative iff a < b, 0 iff a == b, positive iff a > b */
//   int (const value_type& a, const value_type& b);
//
// or a class defining member functions with signatures compatible to:
//
//   class Comparator {
//     public:
//       /** @return True if the elements are equals; false otherwise. */
//       bool Equals(const value_type& a, const value_type& b) const;
//
//       /** @return True if (a < b); false otherwise. */
//       bool LessThan(const value_type& a, const value_type& b) const;
//   };
//
// The Equals member function is used for searching, and the LessThan member
// function is used for searching and sorting.  Note that some member functions,
// e.g. Compare, are templates where a different type Item can be used for the
// element to compare to. In that case, the signatures must be compatible to
// allow those comparisons, but the details are not documented here.
//

//
// nsTArrayFallibleResult and nsTArrayInfallibleResult types are proxy types
// which are used because you cannot use a templated type which is bound to
// void as an argument to a void function.  In order to work around that, we
// encode either a void or a boolean inside these proxy objects, and pass them
// to the aforementioned function instead, and then use the type information to
// decide what to do in the function.
//
// Note that public nsTArray methods should never return a proxy type.  Such
// types are only meant to be used in the internal nsTArray helper methods.
// Public methods returning non-proxy types cannot be called from other
// nsTArray members.
//
struct nsTArrayFallibleResult {
  // Note: allows implicit conversions from and to bool
  MOZ_IMPLICIT constexpr nsTArrayFallibleResult(bool aResult)
      : mResult(aResult) {}

  MOZ_IMPLICIT constexpr operator bool() { return mResult; }

 private:
  bool mResult;
};

struct nsTArrayInfallibleResult {};

//
// nsTArray*Allocators must all use the same |free()|, to allow swap()'ing
// between fallible and infallible variants.
//

struct nsTArrayFallibleAllocatorBase {
  typedef bool ResultType;
  typedef nsTArrayFallibleResult ResultTypeProxy;

  static constexpr ResultType Result(ResultTypeProxy aResult) {
    return aResult;
  }
  static constexpr bool Successful(ResultTypeProxy aResult) { return aResult; }
  static constexpr ResultTypeProxy SuccessResult() { return true; }
  static constexpr ResultTypeProxy FailureResult() { return false; }
  static constexpr ResultType ConvertBoolToResultType(bool aValue) {
    return aValue;
  }
};

struct nsTArrayInfallibleAllocatorBase {
  typedef void ResultType;
  typedef nsTArrayInfallibleResult ResultTypeProxy;

  static constexpr ResultType Result(ResultTypeProxy aResult) {}
  static constexpr bool Successful(ResultTypeProxy) { return true; }
  static constexpr ResultTypeProxy SuccessResult() { return ResultTypeProxy(); }

  [[noreturn]] static ResultTypeProxy FailureResult() {
    MOZ_CRASH("Infallible nsTArray should never fail");
  }

  template <typename T>
  static constexpr ResultType ConvertBoolToResultType(T aValue) {
    if (!aValue) {
      MOZ_CRASH("infallible nsTArray should never convert false to ResultType");
    }
  }

  template <typename T>
  static constexpr ResultType ConvertBoolToResultType(
      const mozilla::NotNull<T>& aValue) {}
};

struct nsTArrayFallibleAllocator : nsTArrayFallibleAllocatorBase {
  static void* Malloc(size_t aSize) { return malloc(aSize); }
  static void* Realloc(void* aPtr, size_t aSize) {
    return realloc(aPtr, aSize);
  }

  static void Free(void* aPtr) { free(aPtr); }
  static void SizeTooBig(size_t) {}
};

struct nsTArrayInfallibleAllocator : nsTArrayInfallibleAllocatorBase {
  static void* Malloc(size_t aSize) MOZ_NONNULL_RETURN {
    return moz_xmalloc(aSize);
  }
  static void* Realloc(void* aPtr, size_t aSize) MOZ_NONNULL_RETURN {
    return moz_xrealloc(aPtr, aSize);
  }

  static void Free(void* aPtr) { free(aPtr); }
  static void SizeTooBig(size_t aSize) { NS_ABORT_OOM(aSize); }
};

// nsTArray_base stores elements into the space allocated beyond
// sizeof(*this).  This is done to minimize the size of the nsTArray
// object when it is empty.
struct nsTArrayHeader {
  uint32_t mLength;
  uint32_t mCapacity : 31;
  uint32_t mIsAutoArray : 1;
};

// Given an nsTArray which is an AutoTArray, this is the offset from the `this`
// pointer to the `mAutoBuf` member. We guarantee this by forcing mAutoBuf to be
// 8-byte aligned, which makes the location independent of the alignment of T
// (since we don't support over-aligned values in nsTArray).
constexpr static size_t kAutoTArrayHeaderOffset = 8;

extern "C" {
extern const nsTArrayHeader sEmptyTArrayHeader;
}

template <class T>
class nsCOMPtr;

namespace mozilla {
template <class T>
class OwningNonNull;
}  // namespace mozilla

namespace detail {
template <typename Iter, typename Comparator>
void AssertStrictWeakOrder(Iter aBegin, Iter aEnd, const Comparator& aCmp) {
  // This check is present in newer libc++ versions, and it is a useful check,
  // so check for it ourselves if we're not using libc++. Ported from:
  // https://github.com/llvm/llvm-project/blob/cf0efb31880dab5f5b2f20bda6634c68a42d6908/libcxx/include/__cxx03/__debug_utils/strict_weak_ordering_check.h#L28
#if defined(DEBUG) && !defined(_LIBCPP_VERSION)
  MOZ_ASSERT(std::is_sorted(aBegin, aEnd, aCmp),
             "Invalid strict-weak ordering comparator");
  // Limit the number of elements we need to check.
  auto size = std::min(size_t(aEnd - aBegin), size_t(100));
  size_t p = 0;
  while (p < size) {
    size_t q = p + size_t(1);
    // Find first element that is greater than *(aBegin+p).
    while (q < size && !aCmp(*(aBegin + p), *(aBegin + q))) {
      ++q;
    }
    // Check that the elements from p to q are equal between each other.
    for (size_t b = p; b < q; ++b) {
      for (size_t a = p; a <= b; ++a) {
        MOZ_ASSERT(!aCmp(*(aBegin + a), *(aBegin + b)),
                   "Your comparator is not a valid strict-weak ordering");
        MOZ_ASSERT(!aCmp(*(aBegin + b), *(aBegin + a)),
                   "Your comparator is not a valid strict-weak ordering");
      }
    }
    // Check that elements between p and q are less than between q and size.
    for (size_t a = p; a < q; ++a) {
      for (size_t b = q; b < size; ++b) {
        MOZ_ASSERT(aCmp(*(aBegin + a), *(aBegin + b)),
                   "Your comparator is not a valid strict-weak ordering");
        MOZ_ASSERT(!aCmp(*(aBegin + b), *(aBegin + a)),
                   "Your comparator is not a valid strict-weak ordering");
      }
    }
    // Skip these equal elements.
    p = q;
  }
#endif
}

template <typename T>
struct SafeElementAtPointerValue;

template <typename T>
struct SafeElementAtPointerValue<T*> {
  using type = T*;
};
template <typename T>
struct SafeElementAtPointerValue<nsCOMPtr<T>> {
  using type = T*;
};
template <typename T>
struct SafeElementAtPointerValue<RefPtr<T>> {
  using type = T*;
};
template <typename T>
struct SafeElementAtPointerValue<mozilla::OwningNonNull<T>> {
  using type = T*;
};
}  // namespace detail

// This class serves as a base class for nsTArray.  It shouldn't be used
// directly.  It holds common implementation code that does not depend on the
// element type of the nsTArray.
//
template <typename RelocationStrategy>
class nsTArray_base {
  // Needed for AppendElements from an array with a different allocator, which
  // calls ShiftData.
  template <typename E, typename Alloc>
  friend class nsTArray_Impl;

 protected:
  using Header = nsTArrayHeader;

 public:
  using size_type = size_t;
  using index_type = size_t;

  // @return The number of elements in the array.
  size_type Length() const { return mHdr->mLength; }

  // @return True if the array is empty or false otherwise.
  bool IsEmpty() const { return Length() == 0; }

  // @return The number of elements that can fit in the array without forcing
  // the array to be re-allocated.  The length of an array is always less
  // than or equal to its capacity.
  size_type Capacity() const { return mHdr->mCapacity; }

#ifdef DEBUG
  void* DebugGetHeader() const { return mHdr; }
#endif

  nsTArray_base(const nsTArray_base&) = delete;
  nsTArray_base& operator=(const nsTArray_base&) = delete;

 protected:
  nsTArray_base() = default;
  ~nsTArray_base();

  // Resize the storage if necessary to achieve the requested capacity.
  // @param aCapacity The requested number of array elements.
  // @param aElemSize The size of an array element.
  // @return False if insufficient memory is available; true otherwise.
  template <typename Alloc>
  typename Alloc::ResultTypeProxy EnsureCapacity(size_type aCapacity,
                                                 size_type aElemSize) {
    // Do this check here so that our callers can inline it.
    if (aCapacity <= mHdr->mCapacity) {
      return Alloc::SuccessResult();
    }
    return EnsureCapacityImpl<Alloc>(aCapacity, aElemSize);
  }

  // The rest of EnsureCapacity. Should only be called if aCapacity >
  // mHdr->mCapacity.
  template <typename Alloc>
  typename Alloc::ResultTypeProxy EnsureCapacityImpl(size_type aCapacity,
                                                     size_type aElemSize);

  // Extend the storage to accommodate aCount extra elements.
  // @param aLength The current size of the array.
  // @param aCount The number of elements to add.
  // @param aElemSize The size of an array element.
  // @return False if insufficient memory is available or the new length
  //   would overflow; true otherwise.
  template <typename Alloc>
  typename Alloc::ResultTypeProxy ExtendCapacity(size_type aLength,
                                                 size_type aCount,
                                                 size_type aElemSize);

  // Tries to resize the storage to the minimum required amount. If this fails,
  // the array is left as-is.
  // @param aElemSize  The size of an array element.
  void ShrinkCapacity(size_type aElemSize);

  // Resizes the storage to 0. This may only be called when Length() is already
  // 0.
  void ShrinkCapacityToZero();

  // This method may be called to resize a "gap" in the array by shifting
  // elements around.  It updates mLength appropriately.  If the resulting
  // array has zero elements, then the array's memory is free'd.
  // @param aStart     The starting index of the gap.
  // @param aOldLen    The current length of the gap.
  // @param aNewLen    The desired length of the gap.
  // @param aElemSize  The size of an array element.
  template <typename Alloc>
  void ShiftData(index_type aStart, size_type aOldLen, size_type aNewLen,
                 size_type aElemSize);

  // This method may be called to swap elements from the end of the array to
  // fill a "gap" in the array. If the resulting array has zero elements, then
  // the array's memory is free'd.
  // @param aStart     The starting index of the gap.
  // @param aCount     The length of the gap.
  // @param aElemSize  The size of an array element.
  template <typename Alloc>
  void SwapFromEnd(index_type aStart, size_type aCount, size_type aElemSize);

  // This method increments the length member of the array's header.
  // Note that mHdr may actually be sEmptyTArrayHeader in the case where a
  // zero-length array is inserted into our array. But then aNum should
  // always be 0.
  void IncrementLength(size_t aNum) {
    if (HasEmptyHeader()) {
      if (MOZ_UNLIKELY(aNum != 0)) {
        // Writing a non-zero length to the empty header would be extremely bad.
        MOZ_CRASH();
      }
    } else {
      mHdr->mLength += aNum;
    }
  }

  // This method inserts blank slots into the array.
  // @param aIndex the place to insert the new elements. This must be no
  //               greater than the current length of the array.
  // @param aCount the number of slots to insert
  // @param aElementSize the size of an array element.
  template <typename Alloc>
  typename Alloc::ResultTypeProxy InsertSlotsAt(index_type aIndex,
                                                size_type aCount,
                                                size_type aElementSize);

  template <typename Alloc>
  typename Alloc::ResultTypeProxy SwapArrayElements(
      nsTArray_base<RelocationStrategy>& aOther, size_type aElemSize);

  void MoveConstructNonAutoArray(nsTArray_base<RelocationStrategy>& aOther,
                                 size_type aElemSize);

  void MoveInit(nsTArray_base<RelocationStrategy>& aOther, size_type aElemSize);

  // Helper function for move construction and SwapArrayElements.
  // Takes the storage from the nsTArray as a non-auto Header pointer.
  // If the array is holding a reference to an AutoTArray buffer,
  // it will be moved to the heap before being returned.
  template <typename Alloc>
  Header* TakeHeaderForMove(size_type aElemSize);

  // Returns whether we're using our auto-array inline buffer.
  bool UsesAutoArrayBuffer() const { return mHdr == GetAutoArrayHeader(); }
  Header* GetAutoArrayHeader() const {
    if (!mHdr->mIsAutoArray) {
      return nullptr;
    }
    return const_cast<Header*>(reinterpret_cast<const Header*>(
        reinterpret_cast<const uint8_t*>(this) + kAutoTArrayHeaderOffset));
  }

  // The array's elements (prefixed with a Header).  This pointer is never
  // null.  If the array is empty, then this will point to sEmptyTArrayHeader.
  Header* mHdr{EmptyHdr()};

  Header* Hdr() const MOZ_NONNULL_RETURN { return mHdr; }
  Header** PtrToHdr() MOZ_NONNULL_RETURN { return &mHdr; }
  static constexpr Header* EmptyHdr() MOZ_NONNULL_RETURN {
    return const_cast<Header*>(&sEmptyTArrayHeader);
  }

  [[nodiscard]] bool HasEmptyHeader() const { return mHdr == EmptyHdr(); }
};

namespace detail {

// Used for argument checking in nsTArrayElementTraits::Emplace.
template <typename... T>
struct ChooseFirst;

template <>
struct ChooseFirst<> {
  // Choose a default type that is guaranteed to not match E* for any
  // nsTArray<E>.
  typedef void Type;
};

template <typename A, typename... Args>
struct ChooseFirst<A, Args...> {
  typedef A Type;
};

}  // namespace detail

//
// This class defines convenience functions for element specific operations.
// Specialize this template if necessary.
//
template <class E>
class nsTArrayElementTraits {
 public:
  // Invoke the default constructor in place.
  static inline void Construct(E* aE) {
    // Do NOT call "E()"! That triggers C++ "default initialization"
    // which zeroes out POD ("plain old data") types such as regular
    // ints.  We don't want that because it can be a performance issue
    // and people don't expect it; nsTArray should work like a regular
    // C/C++ array in this respect.
    new (static_cast<void*>(aE)) E;
  }
  // Invoke the copy-constructor in place.
  template <class A>
  static inline void Construct(E* aE, A&& aArg) {
    using E_NoCV = std::remove_cv_t<E>;
    using A_NoCV = std::remove_cv_t<A>;
    static_assert(!std::is_same_v<E_NoCV*, A_NoCV>,
                  "For safety, we disallow constructing nsTArray<E> elements "
                  "from E* pointers. See bug 960591.");
    new (static_cast<void*>(aE)) E(std::forward<A>(aArg));
  }
  // Construct in place.
  template <class... Args>
  static inline void Emplace(E* aE, Args&&... aArgs) {
    using E_NoCV = std::remove_cv_t<E>;
    using A_NoCV =
        std::remove_cv_t<typename ::detail::ChooseFirst<Args...>::Type>;
    static_assert(!std::is_same_v<E_NoCV*, A_NoCV>,
                  "For safety, we disallow constructing nsTArray<E> elements "
                  "from E* pointers. See bug 960591.");
    new (static_cast<void*>(aE)) E(std::forward<Args>(aArgs)...);
  }
  // Invoke the destructor in place.
  static inline void Destruct(E* aE) { aE->~E(); }
};

// The default comparator used by nsTArray
template <class A, class B>
class nsDefaultComparator {
 public:
  bool Equals(const A& aA, const B& aB) const { return aA == aB; }
  bool LessThan(const A& aA, const B& aB) const { return aA < aB; }
};

//
// Normally elements are copied with memcpy and memmove, but for some element
// types that is problematic.  The nsTArray_RelocationStrategy template class
// can be specialized to ensure that copying calls constructors and destructors
// instead, as is done below for JS::Heap<E> elements.
//

//
// A class that defines how to copy elements using memcpy/memmove.
//
struct nsTArray_RelocateUsingMemutils {
  const static bool allowRealloc = true;

  static void RelocateNonOverlappingRegionWithHeader(void* aDest,
                                                     const void* aSrc,
                                                     size_t aCount,
                                                     size_t aElemSize) {
    memcpy(aDest, aSrc, sizeof(nsTArrayHeader) + aCount * aElemSize);
  }

  static void RelocateOverlappingRegion(void* aDest, void* aSrc, size_t aCount,
                                        size_t aElemSize) {
    memmove(aDest, aSrc, aCount * aElemSize);
  }

  static void RelocateNonOverlappingRegion(void* aDest, void* aSrc,
                                           size_t aCount, size_t aElemSize) {
    memcpy(aDest, aSrc, aCount * aElemSize);
  }
};

//
// A template class that defines how to relocate elements using the type's move
// constructor and destructor appropriately.
//
template <class ElemType>
struct nsTArray_RelocateUsingMoveConstructor {
  typedef nsTArrayElementTraits<ElemType> traits;

  const static bool allowRealloc = false;

  static void RelocateNonOverlappingRegionWithHeader(void* aDest, void* aSrc,
                                                     size_t aCount,
                                                     size_t aElemSize) {
    nsTArrayHeader* destHeader = static_cast<nsTArrayHeader*>(aDest);
    nsTArrayHeader* srcHeader = static_cast<nsTArrayHeader*>(aSrc);
    *destHeader = *srcHeader;
    RelocateNonOverlappingRegion(
        static_cast<uint8_t*>(aDest) + sizeof(nsTArrayHeader),
        static_cast<uint8_t*>(aSrc) + sizeof(nsTArrayHeader), aCount,
        aElemSize);
  }

  // RelocateNonOverlappingRegion and RelocateOverlappingRegion are defined by
  // analogy with memmove and memcpy that are used for relocation of
  // trivially-relocatable types through nsTArray_RelocateUsingMemutils. What
  // they actually do is slightly different: RelocateOverlappingRegion checks to
  // see which direction the movement needs to take place, whether from
  // back-to-front of the range to be moved or from front-to-back.
  // RelocateNonOverlappingRegion assumes that relocating front-to-back is
  // always valid.  They use RelocateRegionForward and RelocateRegionBackward,
  // which are analogous to std::move and std::move_backward respectively,
  // except they don't move-assign the destination from the source but
  // move-construct the destination from the source and destroy the source.
  static void RelocateOverlappingRegion(void* aDest, void* aSrc, size_t aCount,
                                        size_t aElemSize) {
    ElemType* destBegin = static_cast<ElemType*>(aDest);
    ElemType* srcBegin = static_cast<ElemType*>(aSrc);

    // If destination and source are the same, this is a no-op.
    // In practice, we don't do this.
    if (destBegin == srcBegin) {
      return;
    }

    ElemType* srcEnd = srcBegin + aCount;
    ElemType* destEnd = destBegin + aCount;

    // Figure out whether to relocate back-to-front or front-to-back.
    if (srcEnd > destBegin && srcEnd < destEnd) {
      RelocateRegionBackward(srcBegin, srcEnd, destEnd);
    } else {
      RelocateRegionForward(srcBegin, srcEnd, destBegin);
    }
  }

  static void RelocateNonOverlappingRegion(void* aDest, void* aSrc,
                                           size_t aCount, size_t aElemSize) {
    ElemType* destBegin = static_cast<ElemType*>(aDest);
    ElemType* srcBegin = static_cast<ElemType*>(aSrc);
    ElemType* srcEnd = srcBegin + aCount;
#ifdef DEBUG
    ElemType* destEnd = destBegin + aCount;
    MOZ_ASSERT(srcEnd <= destBegin || srcBegin >= destEnd);
#endif
    RelocateRegionForward(srcBegin, srcEnd, destBegin);
  }

 private:
  static void RelocateRegionForward(ElemType* srcBegin, ElemType* srcEnd,
                                    ElemType* destBegin) {
    ElemType* srcElem = srcBegin;
    ElemType* destElem = destBegin;

    while (srcElem != srcEnd) {
      RelocateElement(srcElem, destElem);
      ++destElem;
      ++srcElem;
    }
  }

  static void RelocateRegionBackward(ElemType* srcBegin, ElemType* srcEnd,
                                     ElemType* destEnd) {
    ElemType* srcElem = srcEnd;
    ElemType* destElem = destEnd;
    while (srcElem != srcBegin) {
      --destElem;
      --srcElem;
      RelocateElement(srcElem, destElem);
    }
  }

  static void RelocateElement(ElemType* srcElem, ElemType* destElem) {
    traits::Construct(destElem, std::move(*srcElem));
    traits::Destruct(srcElem);
  }
};

//
// The default behaviour is to use memcpy/memmove for everything.
//
template <class E>
struct MOZ_NEEDS_MEMMOVABLE_TYPE nsTArray_RelocationStrategy {
  using Type = nsTArray_RelocateUsingMemutils;
};

//
// Some classes require constructors/destructors to be called, so they are
// specialized here.
//
#define MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(E)     \
  template <>                                              \
  struct nsTArray_RelocationStrategy<E> {                  \
    using Type = nsTArray_RelocateUsingMoveConstructor<E>; \
  };

#define MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR_FOR_TEMPLATE(T) \
  template <typename S>                                             \
  struct nsTArray_RelocationStrategy<T<S>> {                        \
    using Type = nsTArray_RelocateUsingMoveConstructor<T<S>>;       \
  };

MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR_FOR_TEMPLATE(JS::Heap)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR_FOR_TEMPLATE(std::function)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR_FOR_TEMPLATE(mozilla::ipc::Endpoint)

MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(nsRegion)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(nsIntRegion)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(mozilla::layers::TileClient)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(
    mozilla::SerializedStructuredCloneBuffer)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(
    mozilla::dom::indexedDB::ObjectStoreCursorResponse)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(
    mozilla::dom::indexedDB::IndexCursorResponse)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(
    mozilla::dom::indexedDB::SerializedStructuredCloneReadInfo);
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(JSStructuredCloneData)
MOZ_DECLARE_RELOCATE_USING_MOVE_CONSTRUCTOR(mozilla::SourceBufferTask)

namespace detail {

// These helpers allow us to differentiate between tri-state comparator
// functions and classes with LessThan() and Equal() methods. If an object, when
// called as a function with two instances of our element type, returns an int,
// we treat it as a tri-state comparator.
//
// T is the type of the comparator object we want to check. L and R are the
// types that we'll be comparing.
//
// V is never passed, and is only used to allow us to specialize on the return
// value of the comparator function.
template <typename T, typename L, typename R, typename V = int>
struct IsCompareMethod : std::false_type {};

template <typename T, typename L, typename R>
struct IsCompareMethod<
    T, L, R, decltype(std::declval<T>()(std::declval<L>(), std::declval<R>()))>
    : std::true_type {};

// These two wrappers allow us to use either a tri-state comparator, or an
// object with Equals() and LessThan() methods interchangeably. They provide a
// tri-state Compare() method, and Equals() method, and a LessThan() method.
//
// Depending on the type of the underlying comparator, they either pass these
// through directly, or synthesize them from the methods available on the
// comparator.
//
// Callers should always use the most-specific of these methods that match their
// purpose.

// Comparator wrapper for a tri-state comparator function
template <typename T, typename L, typename R,
          bool IsCompare = IsCompareMethod<T, L, R>::value>
struct CompareWrapper {
#ifdef _MSC_VER
#  pragma warning(push)
#  pragma warning(disable : 4180) /* Silence "qualifier applied to function \
                                     type has no meaning" warning */
#endif
  MOZ_IMPLICIT CompareWrapper(const T& aComparator)
      : mComparator(aComparator) {}

  template <typename A, typename B>
  int Compare(A& aLeft, B& aRight) const {
    return mComparator(aLeft, aRight);
  }

  template <typename A, typename B>
  bool Equals(A& aLeft, B& aRight) const {
    return Compare(aLeft, aRight) == 0;
  }

  template <typename A, typename B>
  bool LessThan(A& aLeft, B& aRight) const {
    return Compare(aLeft, aRight) < 0;
  }

  const T& mComparator;
#ifdef _MSC_VER
#  pragma warning(pop)
#endif
};

// Comparator wrapper for a class with Equals() and LessThan() methods.
template <typename T, typename L, typename R>
struct CompareWrapper<T, L, R, false> {
  MOZ_IMPLICIT CompareWrapper(const T& aComparator)
      : mComparator(aComparator) {}

  template <typename A, typename B>
  int Compare(A& aLeft, B& aRight) const {
    if (LessThan(aLeft, aRight)) {
      return -1;
    }
    if (Equals(aLeft, aRight)) {
      return 0;
    }
    return 1;
  }

  template <typename A, typename B>
  bool Equals(A& aLeft, B& aRight) const {
    return mComparator.Equals(aLeft, aRight);
  }

  template <typename A, typename B>
  bool LessThan(A& aLeft, B& aRight) const {
    return mComparator.LessThan(aLeft, aRight);
  }

  const T& mComparator;
};

}  // namespace detail

enum class SortBoundsCheck { Enable, Disable };

//
// nsTArray_Impl contains most of the guts supporting nsTArray, FallibleTArray,
// AutoTArray.
//
// The only situation in which you might need to use nsTArray_Impl in your code
// is if you're writing code which mutates a TArray which may or may not be
// infallible.
//
// Code which merely reads from a TArray which may or may not be infallible can
// simply cast the TArray to |const nsTArray&|; both fallible and infallible
// TArrays can be cast to |const nsTArray&|.
//
template <class E, class Alloc>
class nsTArray_Impl
    : public nsTArray_base<typename nsTArray_RelocationStrategy<E>::Type> {
 private:
  friend class nsTArray<E>;

  typedef nsTArrayFallibleAllocator FallibleAlloc;
  typedef nsTArrayInfallibleAllocator InfallibleAlloc;

 public:
  typedef typename nsTArray_RelocationStrategy<E>::Type relocation_type;
  typedef nsTArray_base<relocation_type> base_type;
  typedef typename base_type::size_type size_type;
  typedef typename base_type::index_type index_type;
  typedef E value_type;
  typedef nsTArray_Impl<E, Alloc> self_type;
  typedef nsTArrayElementTraits<E> elem_traits;
  typedef mozilla::ArrayIterator<value_type&, self_type> iterator;
  typedef mozilla::ArrayIterator<const value_type&, self_type> const_iterator;
  typedef std::reverse_iterator<iterator> reverse_iterator;
  typedef std::reverse_iterator<const_iterator> const_reverse_iterator;

  using base_type::EmptyHdr;

  // A special value that is used to indicate an invalid or unknown index
  // into the array.
  static const index_type NoIndex = index_type(-1);

  using base_type::Length;

  //
  // Finalization method
  //

  ~nsTArray_Impl() {
    if (!base_type::IsEmpty()) {
      ClearAndRetainStorage();
    }
    // mHdr cleanup will be handled by base destructor
  }

  //
  // Initialization methods
  //

  nsTArray_Impl() = default;

  // Initialize this array and pre-allocate some number of elements.
  explicit nsTArray_Impl(size_type aCapacity) { SetCapacity(aCapacity); }

  // Initialize this array with an r-value.
  // Allow different types of allocators, since the allocator doesn't matter.
  template <typename Allocator>
  explicit nsTArray_Impl(nsTArray_Impl<E, Allocator>&& aOther) noexcept {
    // We cannot be a (Copyable)AutoTArray because that overrides this ctor.
    MOZ_ASSERT(!this->UsesAutoArrayBuffer());

    // This does not use SwapArrayElements because that's unnecessarily complex.
    this->MoveConstructNonAutoArray(aOther, sizeof(value_type));
  }

  // The array's copy-constructor performs a 'deep' copy of the given array.
  // @param aOther The array object to copy.
  //
  // It's very important that we declare this method as taking |const
  // self_type&| as opposed to taking |const nsTArray_Impl<E, OtherAlloc>| for
  // an arbitrary OtherAlloc.
  //
  // If we don't declare a constructor taking |const self_type&|, C++ generates
  // a copy-constructor for this class which merely copies the object's
  // members, which is obviously wrong.
  //
  // You can pass an nsTArray_Impl<E, OtherAlloc> to this method because
  // nsTArray_Impl<E, X> can be cast to const nsTArray_Impl<E, Y>&.  So the
  // effect on the API is the same as if we'd declared this method as taking
  // |const nsTArray_Impl<E, OtherAlloc>&|.
  nsTArray_Impl(const nsTArray_Impl&) = default;

  // Allow converting to a const array with a different kind of allocator,
  // Since the allocator doesn't matter for const arrays
  template <typename Allocator>
  [[nodiscard]] operator const nsTArray_Impl<E, Allocator>&() const& {
    return *reinterpret_cast<const nsTArray_Impl<E, Allocator>*>(this);
  }
  // And we have to do this for our subclasses too
  [[nodiscard]] operator const nsTArray<E>&() const& {
    return *reinterpret_cast<const nsTArray<E>*>(this);
  }
  [[nodiscard]] operator const FallibleTArray<E>&() const& {
    return *reinterpret_cast<const FallibleTArray<E>*>(this);
  }

  // The array's assignment operator performs a 'deep' copy of the given
  // array.  It is optimized to reuse existing storage if possible.
  // @param aOther The array object to copy.
  nsTArray_Impl& operator=(const nsTArray_Impl&) = default;

  // The array's move assignment operator steals the underlying data from
  // the other array.
  // @param other  The array object to move from.
  self_type& operator=(self_type&& aOther) {
    if (this != &aOther) {
      Clear();
      this->MoveInit(aOther, sizeof(value_type));
    }
    return *this;
  }

  // Return true if this array has the same length and the same
  // elements as |aOther|.
  template <typename Allocator>
  [[nodiscard]] bool operator==(
      const nsTArray_Impl<E, Allocator>& aOther) const {
    size_type len = Length();
    if (len != aOther.Length()) {
      return false;
    }

    // XXX std::equal would be as fast or faster here
    for (index_type i = 0; i < len; ++i) {
      if (!(operator[](i) == aOther[i])) {
        return false;
      }
    }

    return true;
  }

  // Return true if this array does not have the same length and the same
  // elements as |aOther|.
  [[nodiscard]] bool operator!=(const self_type& aOther) const {
    return !operator==(aOther);
  }

  // If Alloc == FallibleAlloc, ReplaceElementsAt might fail, without a way to
  // signal this to the caller, so we disallow copying via operator=. Callers
  // should use ReplaceElementsAt with a fallible argument instead, and check
  // the result.
  template <typename Allocator,
            typename = std::enable_if_t<std::is_same_v<Alloc, InfallibleAlloc>,
                                        Allocator>>
  self_type& operator=(const nsTArray_Impl<E, Allocator>& aOther) {
    AssignInternal<InfallibleAlloc>(aOther.Elements(), aOther.Length());
    return *this;
  }

  template <typename Allocator>
  self_type& operator=(nsTArray_Impl<E, Allocator>&& aOther) {
    Clear();
    this->MoveInit(aOther, sizeof(value_type));
    return *this;
  }

  // @return The amount of memory used by this nsTArray_Impl, excluding
  // sizeof(*this). If you want to measure anything hanging off the array, you
  // must iterate over the elements and measure them individually; hence the
  // "Shallow" prefix.
  [[nodiscard]] size_t ShallowSizeOfExcludingThis(
      mozilla::MallocSizeOf aMallocSizeOf) const {
    if (this->UsesAutoArrayBuffer() || this->HasEmptyHeader()) {
      return 0;
    }
    return aMallocSizeOf(this->Hdr());
  }

  // @return The amount of memory used by this nsTArray_Impl, including
  // sizeof(*this). If you want to measure anything hanging off the array, you
  // must iterate over the elements and measure them individually; hence the
  // "Shallow" prefix.
  [[nodiscard]] size_t ShallowSizeOfIncludingThis(
      mozilla::MallocSizeOf aMallocSizeOf) const {
    return aMallocSizeOf(this) + ShallowSizeOfExcludingThis(aMallocSizeOf);
  }

  //
  // Accessor methods
  //

  // This method provides direct access to the array elements.
  // @return A pointer to the first element of the array.  If the array is
  // empty, then this pointer must not be dereferenced.
  [[nodiscard]] value_type* Elements() MOZ_NONNULL_RETURN {
    return reinterpret_cast<value_type*>(Hdr() + 1);
  }

  // This method provides direct, readonly access to the array elements.
  // @return A pointer to the first element of the array.  If the array is
  // empty, then this pointer must not be dereferenced.
  [[nodiscard]] const value_type* Elements() const MOZ_NONNULL_RETURN {
    return reinterpret_cast<const value_type*>(Hdr() + 1);
  }

  // This method provides direct access to an element of the array. The given
  // index must be within the array bounds.
  // @param aIndex The index of an element in the array.
  // @return A reference to the i'th element of the array.
  [[nodiscard]] value_type& ElementAt(index_type aIndex) {
    if (MOZ_UNLIKELY(aIndex >= Length())) {
      mozilla::detail::InvalidArrayIndex_CRASH(aIndex, Length());
    }
    return Elements()[aIndex];
  }

  // This method provides direct, readonly access to an element of the array
  // The given index must be within the array bounds.
  // @param aIndex The index of an element in the array.
  // @return A const reference to the i'th element of the array.
  [[nodiscard]] const value_type& ElementAt(index_type aIndex) const {
    if (MOZ_UNLIKELY(aIndex >= Length())) {
      mozilla::detail::InvalidArrayIndex_CRASH(aIndex, Length());
    }
    return Elements()[aIndex];
  }

  // This method provides direct access to an element of the array in a bounds
  // safe manner. If the requested index is out of bounds the provided default
  // value is returned.
  // @param aIndex The index of an element in the array.
  // @param aDef   The value to return if the index is out of bounds.
  [[nodiscard]] value_type& SafeElementAt(index_type aIndex, value_type& aDef) {
    return aIndex < Length() ? Elements()[aIndex] : aDef;
  }

  // This method provides direct access to an element of the array in a bounds
  // safe manner. If the requested index is out of bounds the provided default
  // value is returned.
  // @param aIndex The index of an element in the array.
  // @param aDef   The value to return if the index is out of bounds.
  [[nodiscard]] const value_type& SafeElementAt(index_type aIndex,
                                                const value_type& aDef) const {
    return aIndex < Length() ? Elements()[aIndex] : aDef;
  }

  [[nodiscard]] auto SafeElementAt(index_type aIndex) const {
    typename ::detail::SafeElementAtPointerValue<E>::type result;
    if (aIndex < Length()) {
      result = Elements()[aIndex];
    } else {
      result = nullptr;
    }
    return result;
  }

  // Shorthand for ElementAt(aIndex)
  [[nodiscard]] value_type& operator[](index_type aIndex) {
    return ElementAt(aIndex);
  }

  // Shorthand for ElementAt(aIndex)
  [[nodiscard]] const value_type& operator[](index_type aIndex) const {
    return ElementAt(aIndex);
  }

  // Shorthand for ElementAt(length - 1)
  [[nodiscard]] value_type& LastElement() { return ElementAt(Length() - 1); }

  // Shorthand for ElementAt(length - 1)
  [[nodiscard]] const value_type& LastElement() const {
    return ElementAt(Length() - 1);
  }

  // Shorthand for SafeElementAt(length - 1, def)
  [[nodiscard]] value_type& SafeLastElement(value_type& aDef) {
    return SafeElementAt(Length() - 1, aDef);
  }

  // Shorthand for SafeElementAt(length - 1, def)
  [[nodiscard]] const value_type& SafeLastElement(
      const value_type& aDef) const {
    return SafeElementAt(Length() - 1, aDef);
  }

  // Methods for range-based for loops.
  [[nodiscard]] iterator begin() { return iterator(*this, 0); }
  [[nodiscard]] const_iterator begin() const {
    return const_iterator(*this, 0);
  }
  [[nodiscard]] const_iterator cbegin() const { return begin(); }
  [[nodiscard]] iterator end() { return iterator(*this, Length()); }
  [[nodiscard]] const_iterator end() const {
    return const_iterator(*this, Length());
  }
  [[nodiscard]] const_iterator cend() const { return end(); }

  // Methods for reverse iterating.
  [[nodiscard]] reverse_iterator rbegin() { return reverse_iterator(end()); }
  [[nodiscard]] const_reverse_iterator rbegin() const {
    return const_reverse_iterator(end());
  }
  [[nodiscard]] const_reverse_iterator crbegin() const { return rbegin(); }
  [[nodiscard]] reverse_iterator rend() { return reverse_iterator(begin()); }
  [[nodiscard]] const_reverse_iterator rend() const {
    return const_reverse_iterator(begin());
  }
  [[nodiscard]] const_reverse_iterator crend() const { return rend(); }

  // Span integration

  [[nodiscard]] operator mozilla::Span<value_type>() {
    return mozilla::Span<value_type>(Elements(), Length());
  }

  [[nodiscard]] operator mozilla::Span<const value_type>() const {
    return mozilla::Span<const value_type>(Elements(), Length());
  }

  //
  // Search methods
  //

  // This method searches for the first element in this array that is equal
  // to the given element.
  // @param aItem  The item to search for.
  // @param aComp  The Comparator used to determine element equality.
  // @return       true if the element was found.
  template <class Item, class Comparator>
  [[nodiscard]] bool Contains(const Item& aItem,
                              const Comparator& aComp) const {
    return ApplyIf(
        aItem, 0, aComp, []() { return true; }, []() { return false; });
  }

  // Like Contains(), but assumes a sorted array.
  template <class Item, class Comparator>
  [[nodiscard]] bool ContainsSorted(const Item& aItem,
                                    const Comparator& aComp) const {
    return BinaryIndexOf(aItem, aComp) != NoIndex;
  }

  // This method searches for the first element in this array that is equal
  // to the given element.  This method assumes that 'operator==' is defined
  // for value_type.
  // @param aItem  The item to search for.
  // @return       true if the element was found.
  template <class Item>
  [[nodiscard]] bool Contains(const Item& aItem) const {
    return Contains(aItem, nsDefaultComparator<value_type, Item>());
  }

  // Like Contains(), but assumes a sorted array.
  template <class Item>
  [[nodiscard]] bool ContainsSorted(const Item& aItem) const {
    return BinaryIndexOf(aItem) != NoIndex;
  }

  // This method searches for the offset of the first element in this
  // array that is equal to the given element.
  // @param aItem  The item to search for.
  // @param aStart The index to start from.
  // @param aComp  The Comparator used to determine element equality.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item, class Comparator>
  [[nodiscard]] index_type IndexOf(const Item& aItem, index_type aStart,
                                   const Comparator& aComp) const {
    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    const value_type* iter = Elements() + aStart;
    const value_type* iend = Elements() + Length();
    for (; iter != iend; ++iter) {
      if (comp.Equals(*iter, aItem)) {
        return index_type(iter - Elements());
      }
    }
    return NoIndex;
  }

  // This method searches for the offset of the first element in this
  // array that is equal to the given element.  This method assumes
  // that 'operator==' is defined for value_type.
  // @param aItem  The item to search for.
  // @param aStart The index to start from.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item>
  [[nodiscard]] index_type IndexOf(const Item& aItem,
                                   index_type aStart = 0) const {
    return IndexOf(aItem, aStart, nsDefaultComparator<value_type, Item>());
  }

  // This method searches for the offset of the last element in this
  // array that is equal to the given element.
  // @param aItem  The item to search for.
  // @param aStart The index to start from.  If greater than or equal to the
  //               length of the array, then the entire array is searched.
  // @param aComp  The Comparator used to determine element equality.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item, class Comparator>
  [[nodiscard]] index_type LastIndexOf(const Item& aItem, index_type aStart,
                                       const Comparator& aComp) const {
    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    size_type endOffset = aStart >= Length() ? Length() : aStart + 1;
    const value_type* iend = Elements() - 1;
    const value_type* iter = iend + endOffset;
    for (; iter != iend; --iter) {
      if (comp.Equals(*iter, aItem)) {
        return index_type(iter - Elements());
      }
    }
    return NoIndex;
  }

  // This method searches for the offset of the last element in this
  // array that is equal to the given element.  This method assumes
  // that 'operator==' is defined for value_type.
  // @param aItem  The item to search for.
  // @param aStart The index to start from.  If greater than or equal to the
  //               length of the array, then the entire array is searched.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item>
  [[nodiscard]] index_type LastIndexOf(const Item& aItem,
                                       index_type aStart = NoIndex) const {
    return LastIndexOf(aItem, aStart, nsDefaultComparator<value_type, Item>());
  }

  // This method searches for the offset for the element in this array
  // that is equal to the given element. The array is assumed to be sorted.
  // If there is more than one equivalent element, there is no guarantee
  // on which one will be returned.
  // @param aItem  The item to search for.
  // @param aComp  The Comparator used.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item, class Comparator>
  [[nodiscard]] index_type BinaryIndexOf(const Item& aItem,
                                         const Comparator& aComp) const {
    using mozilla::BinarySearchIf;
    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    size_t index;
    bool found = BinarySearchIf(
        Elements(), 0, Length(),
        // Note: We pass the Compare() args here in reverse order and negate the
        // results for compatibility reasons. Some existing callers use Equals()
        // functions with first arguments which match aElement but not aItem, or
        // second arguments that match aItem but not aElement. To accommodate
        // those callers, we preserve the argument order of the older version of
        // this API. These callers, however, should be fixed, and this special
        // case removed.
        [&](const value_type& aElement) {
          return -comp.Compare(aElement, aItem);
        },
        &index);
    return found ? index : NoIndex;
  }

  // This method searches for the offset for the element in this array
  // that is equal to the given element. The array is assumed to be sorted.
  // This method assumes that 'operator==' and 'operator<' are defined.
  // @param aItem  The item to search for.
  // @return       The index of the found element or NoIndex if not found.
  template <class Item>
  [[nodiscard]] index_type BinaryIndexOf(const Item& aItem) const {
    return BinaryIndexOf(aItem, nsDefaultComparator<value_type, Item>());
  }

  //
  // Mutation methods
  //
 private:
  template <typename ActualAlloc, class Item>
  typename ActualAlloc::ResultType AssignInternal(const Item* aArray,
                                                  size_type aArrayLen);

 public:
  template <class Allocator, typename ActualAlloc = Alloc>
  [[nodiscard]] typename ActualAlloc::ResultType Assign(
      const nsTArray_Impl<E, Allocator>& aOther) {
    return AssignInternal<ActualAlloc>(aOther.Elements(), aOther.Length());
  }

  template <class Allocator>
  [[nodiscard]] bool Assign(const nsTArray_Impl<E, Allocator>& aOther,
                            const mozilla::fallible_t&) {
    return Assign<Allocator, FallibleAlloc>(aOther);
  }

  template <class Allocator>
  void Assign(nsTArray_Impl<E, Allocator>&& aOther) {
    Clear();
    this->MoveInit(aOther, sizeof(value_type));
  }

  // This method call the destructor on each element of the array, empties it,
  // but does not shrink the array's capacity.
  // See also SetLengthAndRetainStorage.
  // Make sure to call Compact() if needed to avoid keeping a huge array
  // around.
  MOZ_REINITIALIZES void ClearAndRetainStorage() {
    if (this->HasEmptyHeader()) {
      return;
    }

    DestructRange(0, Length());
    base_type::mHdr->mLength = 0;
  }

  // This method modifies the length of the array, but unlike SetLength
  // it doesn't deallocate/reallocate the current internal storage.
  // The new length MUST be shorter than or equal to the current capacity.
  // If the new length is larger than the existing length of the array,
  // then new elements will be constructed using value_type's default
  // constructor.  If shorter, elements will be destructed and removed.
  // See also ClearAndRetainStorage.
  // @param aNewLen  The desired length of this array.
  void SetLengthAndRetainStorage(size_type aNewLen) {
    MOZ_ASSERT(aNewLen <= base_type::Capacity());
    size_type oldLen = Length();
    if (aNewLen > oldLen) {
      /// XXX(Bug 1631367) SetLengthAndRetainStorage should be disabled for
      /// FallibleTArray.
      InsertElementsAtInternal<InfallibleAlloc>(oldLen, aNewLen - oldLen);
      return;
    }
    if (aNewLen < oldLen) {
      DestructRange(aNewLen, oldLen - aNewLen);
      base_type::mHdr->mLength = aNewLen;
    }
  }

  // This method replaces a range of elements in this array.
  // @param aStart    The starting index of the elements to replace.
  // @param aCount    The number of elements to replace.  This may be zero to
  //                  insert elements without removing any existing elements.
  // @param aArray    The values to copy into this array.  Must be non-null,
  //                  and these elements must not already exist in the array
  //                  being modified.
  // @param aArrayLen The number of values to copy into this array.
  // @return          A pointer to the new elements in the array, or null if
  //                  the operation failed due to insufficient memory.
 private:
  template <typename ActualAlloc, class Item>
  value_type* ReplaceElementsAtInternal(index_type aStart, size_type aCount,
                                        const Item* aArray,
                                        size_type aArrayLen);

 public:
  template <class Item>
  [[nodiscard]] value_type* ReplaceElementsAt(index_type aStart,
                                              size_type aCount,
                                              const Item* aArray,
                                              size_type aArrayLen,
                                              const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aStart, aCount, aArray,
                                                    aArrayLen);
  }

  // A variation on the ReplaceElementsAt method defined above.
  template <class Item>
  [[nodiscard]] value_type* ReplaceElementsAt(index_type aStart,
                                              size_type aCount,
                                              const nsTArray<Item>& aArray,
                                              const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aStart, aCount, aArray);
  }

  template <class Item>
  [[nodiscard]] value_type* ReplaceElementsAt(index_type aStart,
                                              size_type aCount,
                                              mozilla::Span<Item> aSpan,
                                              const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aStart, aCount, aSpan);
  }

  // A variation on the ReplaceElementsAt method defined above.
  template <class Item>
  [[nodiscard]] value_type* ReplaceElementsAt(index_type aStart,
                                              size_type aCount,
                                              const Item& aItem,
                                              const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aStart, aCount, aItem);
  }

  // A variation on the ReplaceElementsAt method defined above.
  template <class Item>
  mozilla::NotNull<value_type*> ReplaceElementAt(index_type aIndex,
                                                 Item&& aItem) {
    value_type* const elem = &ElementAt(aIndex);
    elem_traits::Destruct(elem);
    elem_traits::Construct(elem, std::forward<Item>(aItem));
    return mozilla::WrapNotNullUnchecked(elem);
  }

  // InsertElementsAt is ReplaceElementsAt with 0 elements to replace.
  // XXX Provide a proper documentation of InsertElementsAt.
  template <class Item>
  [[nodiscard]] value_type* InsertElementsAt(index_type aIndex,
                                             const Item* aArray,
                                             size_type aArrayLen,
                                             const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aIndex, 0, aArray,
                                                    aArrayLen);
  }

  template <class Item, class Allocator>
  [[nodiscard]] value_type* InsertElementsAt(
      index_type aIndex, const nsTArray_Impl<Item, Allocator>& aArray,
      const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(
        aIndex, 0, aArray.Elements(), aArray.Length());
  }

  template <class Item>
  [[nodiscard]] value_type* InsertElementsAt(index_type aIndex,
                                             mozilla::Span<Item> aSpan,
                                             const mozilla::fallible_t&) {
    return ReplaceElementsAtInternal<FallibleAlloc>(aIndex, 0, aSpan.Elements(),
                                                    aSpan.Length());
  }

 private:
  template <typename ActualAlloc>
  value_type* InsertElementAtInternal(index_type aIndex);

  // Insert a new element without copy-constructing. This is useful to avoid
  // temporaries.
  // @return A pointer to the newly inserted element, or null on OOM.
 public:
  [[nodiscard]] value_type* InsertElementAt(index_type aIndex,
                                            const mozilla::fallible_t&) {
    return InsertElementAtInternal<FallibleAlloc>(aIndex);
  }

 private:
  template <typename ActualAlloc, class Item>
  value_type* InsertElementAtInternal(index_type aIndex, Item&& aItem);

  // Insert a new element, move constructing if possible.
 public:
  template <class Item>
  [[nodiscard]] value_type* InsertElementAt(index_type aIndex, Item&& aItem,
                                            const mozilla::fallible_t&) {
    return InsertElementAtInternal<FallibleAlloc>(aIndex,
                                                  std::forward<Item>(aItem));
  }

  // Reconstruct the element at the given index, and return a pointer to the
  // reconstructed element.  This will destroy the existing element and
  // default-construct a new one, giving you a state much like what single-arg
  // InsertElementAt(), or no-arg AppendElement() does, but without changing the
  // length of the array.
  //
  // array[idx] = value_type()
  //
  // would accomplish the same thing as long as value_type has the appropriate
  // moving operator=, but some types don't for various reasons.
  mozilla::NotNull<value_type*> ReconstructElementAt(index_type aIndex) {
    value_type* elem = &ElementAt(aIndex);
    elem_traits::Destruct(elem);
    elem_traits::Construct(elem);
    return mozilla::WrapNotNullUnchecked(elem);
  }

  // This method searches for the smallest index of an element that is strictly
  // greater than |aItem|. If |aItem| is inserted at this index, the array will
  // remain sorted and |aItem| would come after all elements that are equal to
  // it. If |aItem| is greater than or equal to all elements in the array, the
  // array length is returned.
  //
  // Note that consumers who want to know whether there are existing items equal
  // to |aItem| in the array can just check that the return value here is > 0
  // and indexing into the previous slot gives something equal to |aItem|.
  //
  //
  // @param aItem  The item to search for.
  // @param aComp  The Comparator used.
  // @return        The index of greatest element <= to |aItem|
  // @precondition The array is sorted
  template <class Item, class Comparator>
  [[nodiscard]] index_type IndexOfFirstElementGt(
      const Item& aItem, const Comparator& aComp) const {
    using mozilla::BinarySearchIf;
    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    size_t index;
    BinarySearchIf(
        Elements(), 0, Length(),
        [&](const value_type& aElement) {
          return comp.Compare(aElement, aItem) <= 0 ? 1 : -1;
        },
        &index);
    return index;
  }

  // A variation on the IndexOfFirstElementGt method defined above.
  template <class Item>
  [[nodiscard]] index_type IndexOfFirstElementGt(const Item& aItem) const {
    return IndexOfFirstElementGt(aItem,
                                 nsDefaultComparator<value_type, Item>());
  }

 private:
  template <typename ActualAlloc, class Item, class Comparator>
  value_type* InsertElementSortedInternal(Item&& aItem,
                                          const Comparator& aComp) {
    index_type index = IndexOfFirstElementGt<Item, Comparator>(aItem, aComp);
    return InsertElementAtInternal<ActualAlloc>(index,
                                                std::forward<Item>(aItem));
  }

  // Inserts |aItem| at such an index to guarantee that if the array
  // was previously sorted, it will remain sorted after this
  // insertion.
 public:
  template <class Item, class Comparator>
  [[nodiscard]] value_type* InsertElementSorted(Item&& aItem,
                                                const Comparator& aComp,
                                                const mozilla::fallible_t&) {
    return InsertElementSortedInternal<FallibleAlloc>(std::forward<Item>(aItem),
                                                      aComp);
  }

  // A variation on the InsertElementSorted method defined above.
 public:
  template <class Item>
  [[nodiscard]] value_type* InsertElementSorted(Item&& aItem,
                                                const mozilla::fallible_t&) {
    return InsertElementSortedInternal<FallibleAlloc>(
        std::forward<Item>(aItem), nsDefaultComparator<value_type, Item>{});
  }

 private:
  template <typename ActualAlloc, class Item>
  value_type* AppendElementsInternal(const Item* aArray, size_type aArrayLen);

  // This method appends elements to the end of this array.
  // @param aArray    The elements to append to this array.
  // @param aArrayLen The number of elements to append to this array.
  // @return          A pointer to the new elements in the array, or null if
  //                  the operation failed due to insufficient memory.
 public:
  template <class Item>
  [[nodiscard]] value_type* AppendElements(const Item* aArray,
                                           size_type aArrayLen,
                                           const mozilla::fallible_t&) {
    return AppendElementsInternal<FallibleAlloc>(aArray, aArrayLen);
  }

  template <class Item>
  [[nodiscard]] value_type* AppendElements(mozilla::Span<Item> aSpan,
                                           const mozilla::fallible_t&) {
    return AppendElementsInternal<FallibleAlloc>(aSpan.Elements(),
                                                 aSpan.Length());
  }

  // A variation on the AppendElements method defined above.
  template <class Item, class Allocator>
  [[nodiscard]] value_type* AppendElements(
      const nsTArray_Impl<Item, Allocator>& aArray,
      const mozilla::fallible_t&) {
    return AppendElementsInternal<FallibleAlloc>(aArray.Elements(),
                                                 aArray.Length());
  }

 private:
  template <typename ActualAlloc, class Item, class Allocator>
  value_type* AppendElementsInternal(nsTArray_Impl<Item, Allocator>&& aArray);

  // Move all elements from another array to the end of this array.
  // @return A pointer to the newly appended elements, or null on OOM.
 public:
  template <class Item, class Allocator>
  [[nodiscard]] value_type* AppendElements(
      nsTArray_Impl<Item, Allocator>&& aArray, const mozilla::fallible_t&) {
    return AppendElementsInternal<FallibleAlloc>(std::move(aArray));
  }

  // Append a new element, constructed in place from the provided arguments.
 protected:
  template <typename ActualAlloc, class... Args>
  value_type* EmplaceBackInternal(Args&&... aItem);

 public:
  template <class... Args>
  [[nodiscard]] value_type* EmplaceBack(const mozilla::fallible_t&,
                                        Args&&... aArgs) {
    return EmplaceBackInternal<FallibleAlloc, Args...>(
        std::forward<Args>(aArgs)...);
  }

 private:
  template <typename ActualAlloc, class Item>
  value_type* AppendElementInternal(Item&& aItem);

  // Append a new element, move constructing if possible.
 public:
  template <class Item>
  [[nodiscard]] value_type* AppendElement(Item&& aItem,
                                          const mozilla::fallible_t&) {
    return AppendElementInternal<FallibleAlloc>(std::forward<Item>(aItem));
  }

 private:
  template <typename ActualAlloc>
  value_type* AppendElementsInternal(size_type aCount) {
    if (!ActualAlloc::Successful(this->template ExtendCapacity<ActualAlloc>(
            Length(), aCount, sizeof(value_type)))) {
      return nullptr;
    }
    value_type* elems = Elements() + Length();
    size_type i;
    for (i = 0; i < aCount; ++i) {
      elem_traits::Construct(elems + i);
    }
    this->IncrementLength(aCount);
    return elems;
  }

  // Append new elements without copy-constructing. This is useful to avoid
  // temporaries.
  // @return A pointer to the newly appended elements, or null on OOM.
 public:
  [[nodiscard]] value_type* AppendElements(size_type aCount,
                                           const mozilla::fallible_t&) {
    return AppendElementsInternal<FallibleAlloc>(aCount);
  }

 private:
  // Append a new element without copy-constructing. This is useful to avoid
  // temporaries.
  // @return A pointer to the newly appended element, or null on OOM.
 public:
  [[nodiscard]] value_type* AppendElement(const mozilla::fallible_t&) {
    return AppendElements(1, mozilla::fallible);
  }

  // This method removes a single element from this array, like
  // std::vector::erase.
  // @param pos to the element to remove
  const_iterator RemoveElementAt(const_iterator pos) {
    MOZ_ASSERT(pos.GetArray() == this);

    RemoveElementAt(pos.GetIndex());
    return pos;
  }

  // This method removes a range of elements from this array, like
  // std::vector::erase.
  // @param first iterator to the first of elements to remove
  // @param last iterator to the last of elements to remove
  const_iterator RemoveElementsRange(const_iterator first,
                                     const_iterator last) {
    MOZ_ASSERT(first.GetArray() == this);
    MOZ_ASSERT(last.GetArray() == this);
    MOZ_ASSERT(last.GetIndex() >= first.GetIndex());

    RemoveElementsAt(first.GetIndex(), last.GetIndex() - first.GetIndex());
    return first;
  }

  // This method removes a range of elements from this array.
  // @param aStart The starting index of the elements to remove.
  // @param aCount The number of elements to remove.
  void RemoveElementsAt(index_type aStart, size_type aCount);

 private:
  // Remove a range of elements from this array, but do not check that
  // the range is in bounds.
  // @param aStart The starting index of the elements to remove.
  // @param aCount The number of elements to remove.
  void RemoveElementsAtUnsafe(index_type aStart, size_type aCount);

 public:
  // Similar to the above, but it removes just one element. This does bounds
  // checking only in debug builds.
  void RemoveElementAtUnsafe(index_type aIndex) {
    MOZ_ASSERT(aIndex < Length(), "Trying to remove an invalid element");
    RemoveElementsAtUnsafe(aIndex, 1);
  }

  // A variation on the RemoveElementsAt method defined above.
  void RemoveElementAt(index_type aIndex) { RemoveElementsAt(aIndex, 1); }

  // A variation on RemoveElementAt that removes the last element.
  void RemoveLastElement() { RemoveLastElements(1); }

  // A variation on RemoveElementsAt that removes the last 'aCount' elements.
  void RemoveLastElements(const size_type aCount) {
    // This assertion is redundant, but produces a better error message than the
    // release assertion within TruncateLength.
    MOZ_ASSERT(aCount <= Length());
    TruncateLength(Length() - aCount);
  }

  // Removes the last element of the array and returns a copy of it.
  [[nodiscard]] value_type PopLastElement() {
    // This function intentionally does not call ElementsAt and calls
    // TruncateLengthUnsafe directly to avoid multiple release checks for
    // non-emptiness.
    // This debug assertion is redundant, but produces a better error message
    // than the release assertion below.
    MOZ_ASSERT(!base_type::IsEmpty());
    const size_type oldLen = Length();
    if (MOZ_UNLIKELY(0 == oldLen)) {
      mozilla::detail::InvalidArrayIndex_CRASH(1, 0);
    }
    value_type elem = std::move(Elements()[oldLen - 1]);
    TruncateLengthUnsafe(oldLen - 1);
    return elem;
  }

  // This method performs index-based removals from an array without preserving
  // the order of the array. This is useful if you are using the array as a
  // set-like data structure.
  //
  // These removals are efficient, as they move as few elements as possible. At
  // most N elements, where N is the number of removed elements, will have to
  // be relocated.
  //
  // ## Examples
  //
  // When removing an element from the end of the array, it can be removed in
  // place, by destroying it and decrementing the length.
  //
  // [ 1, 2, 3 ] => [ 1, 2 ]
  //         ^
  //
  // When removing any other single element, it is removed by swapping it with
  // the last element, and then decrementing the length as before.
  //
  // [ 1, 2, 3, 4, 5, 6 ]  => [ 1, 6, 3, 4, 5 ]
  //      ^
  //
  // This method also supports efficiently removing a range of elements. If they
  // are at the end, then they can all be removed like in the one element case.
  //
  // [ 1, 2, 3, 4, 5, 6 ] => [ 1, 2 ]
  //         ^--------^
  //
  // If more elements are removed than exist after the removed section, the
  // remaining elements will be shifted down like in a normal removal.
  //
  // [ 1, 2, 3, 4, 5, 6, 7, 8 ] => [ 1, 2, 7, 8 ]
  //         ^--------^
  //
  // And if fewer elements are removed than exist after the removed section,
  // elements will be moved from the end of the array to fill the vacated space.
  //
  // [ 1, 2, 3, 4, 5, 6, 7, 8 ] => [ 1, 7, 8, 4, 5, 6 ]
  //      ^--^
  //
  // @param aStart The starting index of the elements to remove. @param aCount
  // The number of elements to remove.
  void UnorderedRemoveElementsAt(index_type aStart, size_type aCount);

  // A variation on the UnorderedRemoveElementsAt method defined above to remove
  // a single element. This operation is sometimes called `SwapRemove`.
  //
  // This method is O(1), but does not preserve the order of the elements.
  void UnorderedRemoveElementAt(index_type aIndex) {
    UnorderedRemoveElementsAt(aIndex, 1);
  }

  void Clear() {
    ClearAndRetainStorage();
    base_type::ShrinkCapacityToZero();
  }

  // This method removes elements based on the return value of the
  // callback function aPredicate. If the function returns true for
  // an element, the element is removed. aPredicate will be called
  // for each element in order. It is not safe to access the array
  // inside aPredicate.
  //
  // Returns the number of elements removed.
  template <typename Predicate>
  size_type RemoveElementsBy(Predicate aPredicate);

  // This helper function combines IndexOf with RemoveElementAt to "search
  // and destroy" the first element that is equal to the given element.
  // @param aItem The item to search for.
  // @param aComp The Comparator used to determine element equality.
  // @return true if the element was found
  template <class Item, class Comparator>
  bool RemoveElement(const Item& aItem, const Comparator& aComp) {
    index_type i = IndexOf(aItem, 0, aComp);
    if (i == NoIndex) {
      return false;
    }
    RemoveElementsAtUnsafe(i, 1);
    return true;
  }

  // A variation on the RemoveElement method defined above that assumes
  // that 'operator==' is defined for value_type.
  template <class Item>
  bool RemoveElement(const Item& aItem) {
    return RemoveElement(aItem, nsDefaultComparator<value_type, Item>());
  }

  // Variations for RemoveElement that uses unordered removal.
  template <class Item, class Comparator>
  bool UnorderedRemoveElement(const Item& aItem, const Comparator& aComp) {
    index_type i = IndexOf(aItem, 0, aComp);
    if (i == NoIndex) {
      return false;
    }
    UnorderedRemoveElementAt(i);
    return true;
  }

  template <class Item>
  bool UnorderedRemoveElement(const Item& aItem) {
    return UnorderedRemoveElement(aItem,
                                  nsDefaultComparator<value_type, Item>());
  }

  // This helper function combines IndexOfFirstElementGt with
  // RemoveElementAt to "search and destroy" the last element that
  // is equal to the given element.
  // @param aItem The item to search for.
  // @param aComp The Comparator used to determine element equality.
  // @return true if the element was found
  template <class Item, class Comparator>
  bool RemoveElementSorted(const Item& aItem, const Comparator& aComp) {
    index_type index = IndexOfFirstElementGt(aItem, aComp);
    if (index > 0 && aComp.Equals(ElementAt(index - 1), aItem)) {
      RemoveElementsAtUnsafe(index - 1, 1);
      return true;
    }
    return false;
  }

  // A variation on the RemoveElementSorted method defined above.
  template <class Item>
  bool RemoveElementSorted(const Item& aItem) {
    return RemoveElementSorted(aItem, nsDefaultComparator<value_type, Item>());
  }

  // This method causes the elements contained in this array and the given
  // array to be swapped.
  template <class Allocator>
  void SwapElements(nsTArray_Impl<E, Allocator>& aOther) {
    // The only case this might fail were if someone called this with a
    // AutoTArray upcast to nsTArray_Impl, under the conditions mentioned in the
    // overload for AutoTArray below.
    this->template SwapArrayElements<InfallibleAlloc>(aOther,
                                                      sizeof(value_type));
  }

  template <size_t N>
  void SwapElements(AutoTArray<E, N>& aOther) {
    // Allocation might fail if Alloc==FallibleAlloc and
    // Allocator==InfallibleAlloc and aOther uses auto storage. Allow this for
    // small inline sizes, and crash in the rare case of a small OOM error.
    static_assert(!std::is_same_v<Alloc, FallibleAlloc> ||
                  sizeof(E) * N <= 1024);
    this->template SwapArrayElements<InfallibleAlloc>(aOther,
                                                      sizeof(value_type));
  }

  template <class Allocator>
  [[nodiscard]] auto SwapElements(nsTArray_Impl<E, Allocator>& aOther,
                                  const mozilla::fallible_t&) {
    // Allocation might fail if Alloc==FallibleAlloc and
    // Allocator==InfallibleAlloc and aOther uses auto storage.
    return FallibleAlloc::Result(
        this->template SwapArrayElements<FallibleAlloc>(aOther,
                                                        sizeof(value_type)));
  }

 private:
  // Used by ApplyIf functions to invoke a callable that takes either:
  // - Nothing: F(void)
  // - Index only: F(size_t)
  // - Reference to element only: F(maybe-const value_type&)
  // - Both index and reference: F(size_t, maybe-const value_type&)
  // `value_type` must be const when called from const method.
  template <typename T, typename Param0, typename Param1>
  struct InvokeWithIndexAndOrReferenceHelper {
    static constexpr bool valid = false;
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, void, void> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t, T&) {
      return f();
    }
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, size_t, void> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t i, T&) {
      return f(i);
    }
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, T&, void> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t, T& e) {
      return f(e);
    }
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, const T&, void> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t, T& e) {
      return f(e);
    }
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, size_t, T&> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t i, T& e) {
      return f(i, e);
    }
  };
  template <typename T>
  struct InvokeWithIndexAndOrReferenceHelper<T, size_t, const T&> {
    static constexpr bool valid = true;
    template <typename F>
    static auto Invoke(F&& f, size_t i, T& e) {
      return f(i, e);
    }
  };
  template <typename T, typename F>
  static auto InvokeWithIndexAndOrReference(F&& f, size_t i, T& e) {
    using Invoker = InvokeWithIndexAndOrReferenceHelper<
        T, typename mozilla::FunctionTypeTraits<F>::template ParameterType<0>,
        typename mozilla::FunctionTypeTraits<F>::template ParameterType<1>>;
    static_assert(Invoker::valid,
                  "ApplyIf's Function parameters must match either: (void), "
                  "(size_t), (maybe-const value_type&), or "
                  "(size_t, maybe-const value_type&)");
    return Invoker::Invoke(std::forward<F>(f), i, e);
  }

 public:
  // 'Apply' family of methods.
  //
  // The advantages of using Apply methods with lambdas include:
  // - Safety of accessing elements from within the call, when the array cannot
  //   have been modified between the iteration and the subsequent access.
  // - Avoiding moot conversions: pointer->index during a search, followed by
  //   index->pointer after the search when accessing the element.
  // - Embedding your code into the algorithm, giving the compiler more chances
  //   to optimize.

  // Search for the first element comparing equal to aItem with the given
  // comparator (`==` by default).
  // If such an element exists, return the result of evaluating either:
  // - `aFunction()`
  // - `aFunction(index_type)`
  // - `aFunction(maybe-const? value_type&)`
  // - `aFunction(index_type, maybe-const? value_type&)`
  // (`aFunction` must have one of the above signatures with these exact types,
  //  including references; implicit conversions or generic types not allowed.
  //  If `this` array is const, the referenced `value_type` must be const too;
  //  otherwise it may be either const or non-const.)
  // But if the element is not found, return the result of evaluating
  // `aFunctionElse()`.
  template <class Item, class Comparator, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, index_type aStart, const Comparator& aComp,
               Function&& aFunction, FunctionElse&& aFunctionElse) const {
    static_assert(
        std::is_same_v<
            typename mozilla::FunctionTypeTraits<Function>::ReturnType,
            typename mozilla::FunctionTypeTraits<FunctionElse>::ReturnType>,
        "ApplyIf's `Function` and `FunctionElse` must return the same type.");

    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    const value_type* const elements = Elements();
    const value_type* const iend = elements + Length();
    for (const value_type* iter = elements + aStart; iter != iend; ++iter) {
      if (comp.Equals(*iter, aItem)) {
        return InvokeWithIndexAndOrReference<const value_type>(
            std::forward<Function>(aFunction), iter - elements, *iter);
      }
    }
    return aFunctionElse();
  }
  template <class Item, class Comparator, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, index_type aStart, const Comparator& aComp,
               Function&& aFunction, FunctionElse&& aFunctionElse) {
    static_assert(
        std::is_same_v<
            typename mozilla::FunctionTypeTraits<Function>::ReturnType,
            typename mozilla::FunctionTypeTraits<FunctionElse>::ReturnType>,
        "ApplyIf's `Function` and `FunctionElse` must return the same type.");

    ::detail::CompareWrapper<Comparator, value_type, Item> comp(aComp);

    value_type* const elements = Elements();
    value_type* const iend = elements + Length();
    for (value_type* iter = elements + aStart; iter != iend; ++iter) {
      if (comp.Equals(*iter, aItem)) {
        return InvokeWithIndexAndOrReference<value_type>(
            std::forward<Function>(aFunction), iter - elements, *iter);
      }
    }
    return aFunctionElse();
  }
  template <class Item, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, index_type aStart, Function&& aFunction,
               FunctionElse&& aFunctionElse) const {
    return ApplyIf(aItem, aStart, nsDefaultComparator<value_type, Item>(),
                   std::forward<Function>(aFunction),
                   std::forward<FunctionElse>(aFunctionElse));
  }
  template <class Item, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, index_type aStart, Function&& aFunction,
               FunctionElse&& aFunctionElse) {
    return ApplyIf(aItem, aStart, nsDefaultComparator<value_type, Item>(),
                   std::forward<Function>(aFunction),
                   std::forward<FunctionElse>(aFunctionElse));
  }
  template <class Item, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, Function&& aFunction,
               FunctionElse&& aFunctionElse) const {
    return ApplyIf(aItem, 0, std::forward<Function>(aFunction),
                   std::forward<FunctionElse>(aFunctionElse));
  }
  template <class Item, class Function, class FunctionElse>
  auto ApplyIf(const Item& aItem, Function&& aFunction,
               FunctionElse&& aFunctionElse) {
    return ApplyIf(aItem, 0, std::forward<Function>(aFunction),
                   std::forward<FunctionElse>(aFunctionElse));
  }

  //
  // Allocation
  //

  // This method may increase the capacity of this array object to the
  // specified amount.  This method may be called in advance of several
  // AppendElement operations to minimize heap re-allocations.  This method
  // will not reduce the number of elements in this array.
  // @param aCapacity The desired capacity of this array.
  // @return True if the operation succeeded; false if we ran out of memory
 protected:
  template <typename ActualAlloc = Alloc>
  MOZ_REINITIALIZES typename ActualAlloc::ResultType SetCapacity(
      size_type aCapacity) {
    return ActualAlloc::Result(this->template EnsureCapacity<ActualAlloc>(
        aCapacity, sizeof(value_type)));
  }

 public:
  [[nodiscard]] bool SetCapacity(size_type aCapacity,
                                 const mozilla::fallible_t&) {
    return SetCapacity<FallibleAlloc>(aCapacity);
  }

  // This method modifies the length of the array.  If the new length is
  // larger than the existing length of the array, then new elements will be
  // constructed using value_type's default constructor.  Otherwise, this call
  // removes elements from the array (see also RemoveElementsAt).
  // @param aNewLen The desired length of this array.
  // @return True if the operation succeeded; false otherwise.
  // See also TruncateLength for a more efficient variant if the new length is
  // guaranteed to be smaller than the old.
 protected:
  template <typename ActualAlloc = Alloc>
  typename ActualAlloc::ResultType SetLength(size_type aNewLen) {
    const size_type oldLen = Length();
    if (aNewLen > oldLen) {
      return ActualAlloc::ConvertBoolToResultType(
          InsertElementsAtInternal<ActualAlloc>(oldLen, aNewLen - oldLen) !=
          nullptr);
    }

    TruncateLengthUnsafe(aNewLen);
    return ActualAlloc::ConvertBoolToResultType(true);
  }

 public:
  [[nodiscard]] bool SetLength(size_type aNewLen, const mozilla::fallible_t&) {
    return SetLength<FallibleAlloc>(aNewLen);
  }

  // This method modifies the length of the array, but may only be
  // called when the new length is shorter than the old.  It can
  // therefore be called when value_type has no default constructor,
  // unlike SetLength.  It removes elements from the array (see also
  // RemoveElementsAt).
  // @param aNewLen The desired length of this array.
  void TruncateLength(size_type aNewLen) {
    // This assertion is redundant, but produces a better error message than the
    // release assertion below.
    MOZ_ASSERT(aNewLen <= Length(), "caller should use SetLength instead");

    if (MOZ_UNLIKELY(aNewLen > Length())) {
      mozilla::detail::InvalidArrayIndex_CRASH(aNewLen, Length());
    }

    TruncateLengthUnsafe(aNewLen);
  }

 private:
  void TruncateLengthUnsafe(size_type aNewLen) {
    const size_type oldLen = Length();
    if (oldLen) {
      DestructRange(aNewLen, oldLen - aNewLen);
      base_type::mHdr->mLength = aNewLen;
    }
  }

  // This method ensures that the array has length at least the given
  // length.  If the current length is shorter than the given length,
  // then new elements will be constructed using value_type's default
  // constructor.
  // @param aMinLen The desired minimum length of this array.
  // @return True if the operation succeeded; false otherwise.
 protected:
  template <typename ActualAlloc = Alloc>
  typename ActualAlloc::ResultType EnsureLengthAtLeast(size_type aMinLen) {
    size_type oldLen = Length();
    if (aMinLen > oldLen) {
      return ActualAlloc::ConvertBoolToResultType(
          !!InsertElementsAtInternal<ActualAlloc>(oldLen, aMinLen - oldLen));
    }
    return ActualAlloc::ConvertBoolToResultType(true);
  }

 public:
  [[nodiscard]] bool EnsureLengthAtLeast(size_type aMinLen,
                                         const mozilla::fallible_t&) {
    return EnsureLengthAtLeast<FallibleAlloc>(aMinLen);
  }

  // This method inserts elements into the array, constructing
  // them using value_type's default constructor.
  // @param aIndex the place to insert the new elements. This must be no
  //               greater than the current length of the array.
  // @param aCount the number of elements to insert
 private:
  template <typename ActualAlloc>
  value_type* InsertElementsAtInternal(index_type aIndex, size_type aCount) {
    if (!ActualAlloc::Successful(this->template InsertSlotsAt<ActualAlloc>(
            aIndex, aCount, sizeof(value_type)))) {
      return nullptr;
    }

    // Initialize the extra array elements
    value_type* iter = Elements() + aIndex;
    value_type* iend = iter + aCount;
    for (; iter != iend; ++iter) {
      elem_traits::Construct(iter);
    }

    return Elements() + aIndex;
  }

 public:
  [[nodiscard]] value_type* InsertElementsAt(index_type aIndex,
                                             size_type aCount,
                                             const mozilla::fallible_t&) {
    return InsertElementsAtInternal<FallibleAlloc>(aIndex, aCount);
  }

  // This method inserts elements into the array, constructing them
  // value_type's copy constructor (or whatever one-arg constructor
  // happens to match the Item type).
  // @param aIndex the place to insert the new elements. This must be no
  //               greater than the current length of the array.
  // @param aCount the number of elements to insert.
  // @param aItem the value to use when constructing the new elements.
 private:
  template <typename ActualAlloc, class Item>
  value_type* InsertElementsAtInternal(index_type aIndex, size_type aCount,
                                       const Item& aItem);

 public:
  template <class Item>
  [[nodiscard]] value_type* InsertElementsAt(index_type aIndex,
                                             size_type aCount,
                                             const Item& aItem,
                                             const mozilla::fallible_t&) {
    return InsertElementsAt<Item, FallibleAlloc>(aIndex, aCount, aItem);
  }

  // This method may be called to minimize the memory used by this array.
  void Compact() { ShrinkCapacity(sizeof(value_type)); }

  //
  // Sorting
  //

  // This method sorts the elements of the array.  It uses the LessThan
  // method defined on the given Comparator object to collate elements or
  // it wraps a tri-state comparison lambda into such a comparator.
  // It uses std::sort. It expects value_type to be move assignable and
  // constructible and uses those always, regardless of the chosen
  // nsTArray_RelocationStrategy.
  //
  // @param aComp The Comparator used to collate elements.
  template <SortBoundsCheck Check = SortBoundsCheck::Enable, class Comparator>
  void Sort(const Comparator& aComp) {
    static_assert(std::is_move_assignable_v<value_type>);
    static_assert(std::is_move_constructible_v<value_type>);

    ::detail::CompareWrapper<Comparator, value_type, value_type> comp(aComp);
    auto compFn = [&comp](const auto& left, const auto& right) {
      return comp.LessThan(left, right);
    };
    if constexpr (Check == SortBoundsCheck::Enable) {
      std::sort(begin(), end(), compFn);
    } else {
      std::sort(Elements(), Elements() + Length(), compFn);
    }
    ::detail::AssertStrictWeakOrder(Elements(), Elements() + Length(), compFn);
  }

  // A variation on the Sort method defined above that assumes that
  // 'operator<' is defined for 'value_type'.
  template <SortBoundsCheck Check = SortBoundsCheck::Enable>
  void Sort() {
    Sort(nsDefaultComparator<value_type, value_type>());
  }

  // This method sorts the elements of the array in a stable way (i.e. not
  // changing the relative order of elements considered equal by the
  // Comparator).  It uses the LessThan method defined on the given Comparator
  // object to collate elements.
  // It uses std::stable_sort. It expects value_type to be move assignable and
  // constructible and uses those always, regardless of the chosen
  // nsTArray_RelocationStrategy.
  //
  // @param aComp The Comparator used to collate elements.
  template <SortBoundsCheck Check = SortBoundsCheck::Enable, class Comparator>
  void StableSort(const Comparator& aComp) {
    static_assert(std::is_move_assignable_v<value_type>);
    static_assert(std::is_move_constructible_v<value_type>);

    const ::detail::CompareWrapper<Comparator, value_type, value_type> comp(
        aComp);
    auto compFn = [&comp](const auto& lhs, const auto& rhs) {
      return comp.LessThan(lhs, rhs);
    };
    if constexpr (Check == SortBoundsCheck::Enable) {
      std::stable_sort(begin(), end(), compFn);
    } else {
      std::stable_sort(Elements(), Elements() + Length(), compFn);
    }
    ::detail::AssertStrictWeakOrder(Elements(), Elements() + Length(), compFn);
  }

  // A variation on the StableSort method defined above that assumes that
  // 'operator<' is defined for 'value_type'.
  template <SortBoundsCheck Check = SortBoundsCheck::Enable>
  void StableSort() {
    StableSort(nsDefaultComparator<value_type, value_type>());
  }

  // This method reverses the array in place.
  void Reverse() {
    value_type* elements = Elements();
    const size_type len = Length();
    for (index_type i = 0, iend = len / 2; i < iend; ++i) {
      std::swap(elements[i], elements[len - i - 1]);
    }
  }

 protected:
  using base_type::Hdr;
  using base_type::ShrinkCapacity;

  // This method invokes value_type's destructor on a range of elements.
  // @param aStart The index of the first element to destroy.
  // @param aCount The number of elements to destroy.
  void DestructRange(index_type aStart, size_type aCount) {
    value_type* iter = Elements() + aStart;
    value_type* iend = iter + aCount;
    for (; iter != iend; ++iter) {
      elem_traits::Destruct(iter);
    }
  }

  // This method invokes value_type's copy-constructor on a range of elements.
  // @param aStart  The index of the first element to construct.
  // @param aCount  The number of elements to construct.
  // @param aValues The array of elements to copy.
  template <class Item>
  void AssignRange(index_type aStart, size_type aCount, const Item* aValues) {
    std::uninitialized_copy(aValues, aValues + aCount, Elements() + aStart);
  }
};

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::AssignInternal(const Item* aArray,
                                             size_type aArrayLen) ->
    typename ActualAlloc::ResultType {
  static_assert(std::is_same_v<ActualAlloc, InfallibleAlloc> ||
                std::is_same_v<ActualAlloc, FallibleAlloc>);

  if constexpr (std::is_same_v<ActualAlloc, InfallibleAlloc>) {
    ClearAndRetainStorage();
  }
  // Adjust memory allocation up-front to catch errors in the fallible case.
  // We might relocate the elements to be destroyed unnecessarily. This could be
  // optimized, but would make things more complicated.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          aArrayLen, sizeof(value_type)))) {
    return ActualAlloc::ConvertBoolToResultType(false);
  }

  MOZ_ASSERT_IF(this->HasEmptyHeader(), aArrayLen == 0);
  if (!this->HasEmptyHeader()) {
    if constexpr (std::is_same_v<ActualAlloc, FallibleAlloc>) {
      ClearAndRetainStorage();
    }
    AssignRange(0, aArrayLen, aArray);
    base_type::mHdr->mLength = aArrayLen;
  }

  return ActualAlloc::ConvertBoolToResultType(true);
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::ReplaceElementsAtInternal(index_type aStart,
                                                        size_type aCount,
                                                        const Item* aArray,
                                                        size_type aArrayLen)
    -> value_type* {
  if (MOZ_UNLIKELY(aStart > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aStart, Length());
  }
  if (MOZ_UNLIKELY(aCount > Length() - aStart)) {
    mozilla::detail::InvalidArrayIndex_CRASH(aStart + aCount, Length());
  }

  // Adjust memory allocation up-front to catch errors.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          Length() + aArrayLen - aCount, sizeof(value_type)))) {
    return nullptr;
  }
  DestructRange(aStart, aCount);
  this->template ShiftData<ActualAlloc>(aStart, aCount, aArrayLen,
                                        sizeof(value_type));
  AssignRange(aStart, aArrayLen, aArray);
  return Elements() + aStart;
}

template <typename E, class Alloc>
void nsTArray_Impl<E, Alloc>::RemoveElementsAt(index_type aStart,
                                               size_type aCount) {
  MOZ_ASSERT(aCount == 0 || aStart < Length(), "Invalid aStart index");

  mozilla::CheckedInt<index_type> rangeEnd = aStart;
  rangeEnd += aCount;

  if (MOZ_UNLIKELY(!rangeEnd.isValid() || rangeEnd.value() > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aStart, Length());
  }

  RemoveElementsAtUnsafe(aStart, aCount);
}

template <typename E, class Alloc>
void nsTArray_Impl<E, Alloc>::RemoveElementsAtUnsafe(index_type aStart,
                                                     size_type aCount) {
  DestructRange(aStart, aCount);
  this->template ShiftData<InfallibleAlloc>(aStart, aCount, 0,
                                            sizeof(value_type));
}

template <typename E, class Alloc>
void nsTArray_Impl<E, Alloc>::UnorderedRemoveElementsAt(index_type aStart,
                                                        size_type aCount) {
  MOZ_ASSERT(aCount == 0 || aStart < Length(), "Invalid aStart index");

  mozilla::CheckedInt<index_type> rangeEnd = aStart;
  rangeEnd += aCount;

  if (MOZ_UNLIKELY(!rangeEnd.isValid() || rangeEnd.value() > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aStart, Length());
  }

  // Destroy the elements which are being removed, and then swap elements in to
  // replace them from the end. See the docs on the declaration of this
  // function.
  DestructRange(aStart, aCount);
  this->template SwapFromEnd<InfallibleAlloc>(aStart, aCount,
                                              sizeof(value_type));
}

template <typename E, class Alloc>
template <typename Predicate>
auto nsTArray_Impl<E, Alloc>::RemoveElementsBy(Predicate aPredicate)
    -> size_type {
  if (this->HasEmptyHeader()) {
    return 0;
  }

  index_type j = 0;
  const index_type len = Length();
  value_type* const elements = Elements();
  for (index_type i = 0; i < len; ++i) {
    const bool result = aPredicate(elements[i]);

    // Check that the array has not been modified by the predicate.
    MOZ_DIAGNOSTIC_ASSERT(len == base_type::mHdr->mLength &&
                          elements == Elements());

    if (result) {
      elem_traits::Destruct(elements + i);
    } else {
      if (j < i) {
        relocation_type::RelocateNonOverlappingRegion(
            elements + j, elements + i, 1, sizeof(value_type));
      }
      ++j;
    }
  }

  base_type::mHdr->mLength = j;
  return len - j;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::InsertElementsAtInternal(index_type aIndex,
                                                       size_type aCount,
                                                       const Item& aItem)
    -> value_type* {
  if (!ActualAlloc::Successful(this->template InsertSlotsAt<ActualAlloc>(
          aIndex, aCount, sizeof(value_type)))) {
    return nullptr;
  }

  // Initialize the extra array elements
  value_type* iter = Elements() + aIndex;
  value_type* iend = iter + aCount;
  for (; iter != iend; ++iter) {
    elem_traits::Construct(iter, aItem);
  }

  return Elements() + aIndex;
}

template <typename E, class Alloc>
template <typename ActualAlloc>
auto nsTArray_Impl<E, Alloc>::InsertElementAtInternal(index_type aIndex)
    -> value_type* {
  if (MOZ_UNLIKELY(aIndex > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aIndex, Length());
  }

  // Length() + 1 is guaranteed to not overflow, so EnsureCapacity is OK.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          Length() + 1, sizeof(value_type)))) {
    return nullptr;
  }
  this->template ShiftData<ActualAlloc>(aIndex, 0, 1, sizeof(value_type));
  value_type* elem = Elements() + aIndex;
  elem_traits::Construct(elem);
  return elem;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::InsertElementAtInternal(index_type aIndex,
                                                      Item&& aItem)
    -> value_type* {
  if (MOZ_UNLIKELY(aIndex > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aIndex, Length());
  }

  // Length() + 1 is guaranteed to not overflow, so EnsureCapacity is OK.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          Length() + 1, sizeof(value_type)))) {
    return nullptr;
  }
  this->template ShiftData<ActualAlloc>(aIndex, 0, 1, sizeof(value_type));
  value_type* elem = Elements() + aIndex;
  elem_traits::Construct(elem, std::forward<Item>(aItem));
  return elem;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::AppendElementsInternal(const Item* aArray,
                                                     size_type aArrayLen)
    -> value_type* {
  if (!ActualAlloc::Successful(this->template ExtendCapacity<ActualAlloc>(
          Length(), aArrayLen, sizeof(value_type)))) {
    return nullptr;
  }
  index_type len = Length();
  AssignRange(len, aArrayLen, aArray);
  this->IncrementLength(aArrayLen);
  return Elements() + len;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item, class Allocator>
auto nsTArray_Impl<E, Alloc>::AppendElementsInternal(
    nsTArray_Impl<Item, Allocator>&& aArray) -> value_type* {
  if constexpr (std::is_same_v<Alloc, Allocator>) {
    MOZ_ASSERT(&aArray != this, "argument must be different aArray");
  }
  index_type len = Length();
  if (len == 0) {
    // XXX This might still be optimized. If aArray uses auto-storage but we
    // won't, we might better retain our storage if it's sufficiently large.
    this->ShrinkCapacityToZero();
    this->MoveInit(aArray, sizeof(value_type));
    return Elements();
  }

  index_type otherLen = aArray.Length();
  if (!ActualAlloc::Successful(this->template ExtendCapacity<ActualAlloc>(
          len, otherLen, sizeof(value_type)))) {
    return nullptr;
  }
  relocation_type::RelocateNonOverlappingRegion(
      Elements() + len, aArray.Elements(), otherLen, sizeof(value_type));
  this->IncrementLength(otherLen);
  aArray.template ShiftData<ActualAlloc>(0, otherLen, 0, sizeof(value_type));
  return Elements() + len;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class Item>
auto nsTArray_Impl<E, Alloc>::AppendElementInternal(Item&& aItem)
    -> value_type* {
  // Length() + 1 is guaranteed to not overflow, so EnsureCapacity is OK.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          Length() + 1, sizeof(value_type)))) {
    return nullptr;
  }
  value_type* elem = Elements() + Length();
  elem_traits::Construct(elem, std::forward<Item>(aItem));
  this->mHdr->mLength += 1;
  return elem;
}

template <typename E, class Alloc>
template <typename ActualAlloc, class... Args>
auto nsTArray_Impl<E, Alloc>::EmplaceBackInternal(Args&&... aArgs)
    -> value_type* {
  // Length() + 1 is guaranteed to not overflow, so EnsureCapacity is OK.
  if (!ActualAlloc::Successful(this->template EnsureCapacity<ActualAlloc>(
          Length() + 1, sizeof(value_type)))) {
    return nullptr;
  }
  value_type* elem = Elements() + Length();
  elem_traits::Emplace(elem, std::forward<Args>(aArgs)...);
  this->mHdr->mLength += 1;
  return elem;
}

template <typename E, typename Alloc>
inline void ImplCycleCollectionUnlink(nsTArray_Impl<E, Alloc>& aField) {
  aField.Clear();
}

template <typename E, typename Alloc, typename Callback>
inline void ImplCycleCollectionIndexedContainer(nsTArray_Impl<E, Alloc>& aField,
                                                Callback&& aCallback) {
  for (auto& value : aField) {
    aCallback(value);
  }
}

//
// nsTArray is an infallible vector class.  See the comment at the top of this
// file for more details.
//
template <class E>
class MOZ_GSL_OWNER nsTArray
    : public nsTArray_Impl<E, nsTArrayInfallibleAllocator> {
 public:
  using InfallibleAlloc = nsTArrayInfallibleAllocator;
  using base_type = nsTArray_Impl<E, InfallibleAlloc>;
  using self_type = nsTArray<E>;
  using typename base_type::index_type;
  using typename base_type::size_type;
  using typename base_type::value_type;

  constexpr nsTArray() = default;
  explicit nsTArray(size_type aCapacity) : base_type(aCapacity) {}
  MOZ_IMPLICIT nsTArray(std::initializer_list<E> aIL) {
    AppendElements(aIL.begin(), aIL.size());
  }

  template <class Item>
  nsTArray(const Item* aArray, size_type aArrayLen) {
    AppendElements(aArray, aArrayLen);
  }

  template <class Item>
  explicit nsTArray(mozilla::Span<Item> aSpan) {
    AppendElements(aSpan);
  }

  template <class Allocator>
  explicit nsTArray(const nsTArray_Impl<E, Allocator>& aOther)
      : base_type(aOther) {}
  template <class Allocator>
  MOZ_IMPLICIT nsTArray(nsTArray_Impl<E, Allocator>&& aOther)
      : base_type(std::move(aOther)) {}

  template <class Allocator>
  self_type& operator=(const nsTArray_Impl<E, Allocator>& aOther) {
    base_type::operator=(aOther);
    return *this;
  }
  template <class Allocator>
  self_type& operator=(nsTArray_Impl<E, Allocator>&& aOther) {
    // This is quite complex, since we don't know if we are an AutoTArray. While
    // AutoTArray overrides this operator=, this might be called on a nsTArray&
    // bound to an AutoTArray.
    base_type::operator=(std::move(aOther));
    return *this;
  }

  using base_type::AppendElement;
  using base_type::AppendElements;
  using base_type::EmplaceBack;
  using base_type::EnsureLengthAtLeast;
  using base_type::InsertElementAt;
  using base_type::InsertElementsAt;
  using base_type::InsertElementSorted;
  using base_type::ReplaceElementsAt;
  using base_type::SetCapacity;
  using base_type::SetLength;

  template <class Item>
  mozilla::NotNull<value_type*> AppendElements(const Item* aArray,
                                               size_type aArrayLen) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(aArray,
                                                               aArrayLen));
  }

  template <class Item>
  mozilla::NotNull<value_type*> AppendElements(mozilla::Span<Item> aSpan) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(aSpan.Elements(),
                                                               aSpan.Length()));
  }

  template <class Item, class Allocator>
  mozilla::NotNull<value_type*> AppendElements(
      const nsTArray_Impl<Item, Allocator>& aArray) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(
            aArray.Elements(), aArray.Length()));
  }

  template <class Item, class Allocator>
  mozilla::NotNull<value_type*> AppendElements(
      nsTArray_Impl<Item, Allocator>&& aArray) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(
            std::move(aArray)));
  }

  template <class Item>
  mozilla::NotNull<value_type*> AppendElement(Item&& aItem) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementInternal<InfallibleAlloc>(
            std::forward<Item>(aItem)));
  }

  mozilla::NotNull<value_type*> AppendElements(size_type aCount) {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(aCount));
  }

  mozilla::NotNull<value_type*> AppendElement() {
    return mozilla::WrapNotNullUnchecked(
        this->template AppendElementsInternal<InfallibleAlloc>(1));
  }

  self_type Clone() const {
    self_type result;
    result.Assign(*this);
    return result;
  }

  mozilla::NotNull<value_type*> InsertElementsAt(index_type aIndex,
                                                 size_type aCount) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementsAtInternal<InfallibleAlloc>(aIndex,
                                                                 aCount));
  }

  template <class Item>
  mozilla::NotNull<value_type*> InsertElementsAt(index_type aIndex,
                                                 size_type aCount,
                                                 const Item& aItem) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementsAtInternal<InfallibleAlloc>(aIndex, aCount,
                                                                 aItem));
  }

  template <class Item>
  mozilla::NotNull<value_type*> InsertElementsAt(index_type aIndex,
                                                 const Item* aArray,
                                                 size_type aArrayLen) {
    return mozilla::WrapNotNullUnchecked(
        this->template ReplaceElementsAtInternal<InfallibleAlloc>(
            aIndex, 0, aArray, aArrayLen));
  }

  template <class Item, class Allocator>
  mozilla::NotNull<value_type*> InsertElementsAt(
      index_type aIndex, const nsTArray_Impl<Item, Allocator>& aArray) {
    return mozilla::WrapNotNullUnchecked(
        this->template ReplaceElementsAtInternal<InfallibleAlloc>(
            aIndex, 0, aArray.Elements(), aArray.Length()));
  }

  template <class Item>
  mozilla::NotNull<value_type*> InsertElementsAt(index_type aIndex,
                                                 mozilla::Span<Item> aSpan) {
    return mozilla::WrapNotNullUnchecked(
        this->template ReplaceElementsAtInternal<InfallibleAlloc>(
            aIndex, 0, aSpan.Elements(), aSpan.Length()));
  }

  mozilla::NotNull<value_type*> InsertElementAt(index_type aIndex) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementAtInternal<InfallibleAlloc>(aIndex));
  }

  template <class Item>
  mozilla::NotNull<value_type*> InsertElementAt(index_type aIndex,
                                                Item&& aItem) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementAtInternal<InfallibleAlloc>(
            aIndex, std::forward<Item>(aItem)));
  }

  template <class Item>
  mozilla::NotNull<value_type*> ReplaceElementsAt(index_type aStart,
                                                  size_type aCount,
                                                  const Item* aArray,
                                                  size_type aArrayLen) {
    return mozilla::WrapNotNullUnchecked(
        this->template ReplaceElementsAtInternal<InfallibleAlloc>(
            aStart, aCount, aArray, aArrayLen));
  }

  template <class Item>
  mozilla::NotNull<value_type*> ReplaceElementsAt(
      index_type aStart, size_type aCount, const nsTArray<Item>& aArray) {
    return ReplaceElementsAt(aStart, aCount, aArray.Elements(),
                             aArray.Length());
  }

  template <class Item>
  mozilla::NotNull<value_type*> ReplaceElementsAt(index_type aStart,
                                                  size_type aCount,
                                                  mozilla::Span<Item> aSpan) {
    return ReplaceElementsAt(aStart, aCount, aSpan.Elements(), aSpan.Length());
  }

  template <class Item>
  mozilla::NotNull<value_type*> ReplaceElementsAt(index_type aStart,
                                                  size_type aCount,
                                                  const Item& aItem) {
    return ReplaceElementsAt(aStart, aCount, &aItem, 1);
  }

  template <class Item, class Comparator>
  mozilla::NotNull<value_type*> InsertElementSorted(Item&& aItem,
                                                    const Comparator& aComp) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementSortedInternal<InfallibleAlloc>(
            std::forward<Item>(aItem), aComp));
  }

  template <class Item>
  mozilla::NotNull<value_type*> InsertElementSorted(Item&& aItem) {
    return mozilla::WrapNotNullUnchecked(
        this->template InsertElementSortedInternal<InfallibleAlloc>(
            std::forward<Item>(aItem),
            nsDefaultComparator<value_type, Item>{}));
  }

  template <class... Args>
  mozilla::NotNull<value_type*> EmplaceBack(Args&&... aArgs) {
    return mozilla::WrapNotNullUnchecked(
        this->template EmplaceBackInternal<InfallibleAlloc, Args...>(
            std::forward<Args>(aArgs)...));
  }
};

template <class E>
class MOZ_GSL_OWNER CopyableTArray : public nsTArray<E> {
 public:
  using nsTArray<E>::nsTArray;

  CopyableTArray(const CopyableTArray& aOther) : nsTArray<E>() {
    this->Assign(aOther);
  }
  CopyableTArray& operator=(const CopyableTArray& aOther) {
    if (this != &aOther) {
      this->Assign(aOther);
    }
    return *this;
  }
  template <typename Allocator>
  MOZ_IMPLICIT CopyableTArray(const nsTArray_Impl<E, Allocator>& aOther) {
    this->Assign(aOther);
  }
  template <typename Allocator>
  CopyableTArray& operator=(const nsTArray_Impl<E, Allocator>& aOther) {
    if constexpr (std::is_same_v<Allocator, nsTArrayInfallibleAllocator>) {
      if (this == &aOther) {
        return *this;
      }
    }
    this->Assign(aOther);
    return *this;
  }
  template <typename Allocator>
  MOZ_IMPLICIT CopyableTArray(nsTArray_Impl<E, Allocator>&& aOther)
      : nsTArray<E>{std::move(aOther)} {}
  template <typename Allocator>
  CopyableTArray& operator=(nsTArray_Impl<E, Allocator>&& aOther) {
    static_cast<nsTArray<E>&>(*this) = std::move(aOther);
    return *this;
  }

  CopyableTArray(CopyableTArray&&) = default;
  CopyableTArray& operator=(CopyableTArray&&) = default;
};

//
// FallibleTArray is a fallible vector class.
//
template <class E>
class MOZ_GSL_OWNER FallibleTArray
    : public nsTArray_Impl<E, nsTArrayFallibleAllocator> {
 public:
  typedef nsTArray_Impl<E, nsTArrayFallibleAllocator> base_type;
  typedef FallibleTArray<E> self_type;
  typedef typename base_type::size_type size_type;

  FallibleTArray() = default;
  explicit FallibleTArray(size_type aCapacity) : base_type(aCapacity) {}

  template <class Allocator>
  explicit FallibleTArray(const nsTArray_Impl<E, Allocator>& aOther)
      : base_type(aOther) {}
  template <class Allocator>
  explicit FallibleTArray(nsTArray_Impl<E, Allocator>&& aOther)
      : base_type(std::move(aOther)) {}

  template <class Allocator>
  self_type& operator=(const nsTArray_Impl<E, Allocator>& aOther) {
    base_type::operator=(aOther);
    return *this;
  }
  template <class Allocator>
  self_type& operator=(nsTArray_Impl<E, Allocator>&& aOther) {
    base_type::operator=(std::move(aOther));
    return *this;
  }
};

//
// AutoTArray<E, N> is like nsTArray<E>, but with N elements of inline storage.
// Storing more than N elements is fine, but it will cause a heap allocation.
//
template <class E, size_t N>
class MOZ_NON_MEMMOVABLE MOZ_GSL_OWNER AutoTArray : public nsTArray<E> {
  static_assert(N != 0, "AutoTArray<E, 0> should be specialized");

 public:
  typedef AutoTArray<E, N> self_type;
  typedef nsTArray<E> base_type;
  typedef typename base_type::Header Header;
  typedef typename base_type::value_type value_type;

  AutoTArray() {
    static_assert(alignof(value_type) <= 8,
                  "can't handle alignments greater than 8, "
                  "see nsTArray_base::UsesAutoArrayBuffer()");
    static_assert(offsetof(AutoTArray, mAutoBuf) == kAutoTArrayHeaderOffset);
    this->mHdr = &mAutoBuf.mHdr;
  }

  AutoTArray(self_type&& aOther) : AutoTArray() {
    this->MoveInit(aOther, sizeof(value_type));
    MOZ_ASSERT(!this->HasEmptyHeader());
  }

  explicit AutoTArray(base_type&& aOther) : AutoTArray() {
    this->MoveInit(aOther, sizeof(value_type));
  }

  template <typename Allocator>
  explicit AutoTArray(nsTArray_Impl<value_type, Allocator>&& aOther)
      : AutoTArray() {
    this->MoveInit(aOther, sizeof(value_type));
  }

  MOZ_IMPLICIT AutoTArray(std::initializer_list<E> aIL) : AutoTArray() {
    this->AppendElements(aIL.begin(), aIL.size());
  }

  self_type& operator=(self_type&& aOther) {
    base_type::operator=(std::move(aOther));
    return *this;
  }

  template <typename Allocator>
  self_type& operator=(nsTArray_Impl<value_type, Allocator>&& aOther) {
    base_type::operator=(std::move(aOther));
    return *this;
  }

  // Intentionally hides nsTArray_Impl::Clone to make clones usually be
  // AutoTArray as well.
  self_type Clone() const {
    self_type result;
    result.Assign(*this);
    return result;
  }

 private:
  // Declare mAutoBuf aligned to 8 bytes so we have a constant offset to get
  // from the nsTArray to the buffer. This can create 4 otherwise-unnecessary
  // bytes of padding on 32-bit builds if value_type is not 8-byte aligned, but
  // that seems acceptable.
  struct alignas(8) AutoBuffer {
    nsTArrayHeader mHdr;
    union alignas(value_type) {
      // FIXME: Conceptually `value_type mElements[N]`, but that upsets the
      // hazard analysis, see bug 1880185.
      char mStorage[sizeof(value_type) * N];
    };
    AutoBuffer() : mHdr{.mLength = 0, .mCapacity = N, .mIsAutoArray = true} {}
    ~AutoBuffer() = default;
  } mAutoBuf;
  static_assert(offsetof(AutoBuffer, mStorage) == sizeof(nsTArrayHeader),
                "Shouldn't have padding");
};

//
// Specialization of AutoTArray<E, N> for the case where N == 0.
// AutoTArray<E, 0> behaves exactly like nsTArray<E>, but without this
// specialization, it stores a useless inline header.
//
// We do have many AutoTArray<E, 0> objects in memory: about 2,000 per tab as
// of May 2014. These are typically not explicitly AutoTArray<E, 0> but rather
// AutoTArray<E, N> for some value N depending on template parameters, in
// generic code.
//
// For that reason, we optimize this case with the below partial specialization,
// which ensures that AutoTArray<E, 0> is just like nsTArray<E>, without any
// inline header overhead.
//
template <class E>
class AutoTArray<E, 0> : public nsTArray<E> {
  using nsTArray<E>::nsTArray;
};

template <class E, size_t N>
struct nsTArray_RelocationStrategy<AutoTArray<E, N>> {
  using Type = nsTArray_RelocateUsingMoveConstructor<AutoTArray<E, N>>;
};

template <class E, size_t N>
class CopyableAutoTArray : public AutoTArray<E, N> {
 public:
  typedef CopyableAutoTArray<E, N> self_type;
  using AutoTArray<E, N>::AutoTArray;

  CopyableAutoTArray(const CopyableAutoTArray& aOther) : AutoTArray<E, N>() {
    this->Assign(aOther);
  }
  CopyableAutoTArray& operator=(const CopyableAutoTArray& aOther) {
    if (this != &aOther) {
      this->Assign(aOther);
    }
    return *this;
  }
  template <typename Allocator>
  MOZ_IMPLICIT CopyableAutoTArray(const nsTArray_Impl<E, Allocator>& aOther) {
    this->Assign(aOther);
  }
  template <typename Allocator>
  CopyableAutoTArray& operator=(const nsTArray_Impl<E, Allocator>& aOther) {
    if constexpr (std::is_same_v<Allocator, nsTArrayInfallibleAllocator>) {
      if (this == &aOther) {
        return *this;
      }
    }
    this->Assign(aOther);
    return *this;
  }
  template <typename Allocator>
  MOZ_IMPLICIT CopyableAutoTArray(nsTArray_Impl<E, Allocator>&& aOther)
      : AutoTArray<E, N>{std::move(aOther)} {}
  template <typename Allocator>
  CopyableAutoTArray& operator=(nsTArray_Impl<E, Allocator>&& aOther) {
    static_cast<AutoTArray<E, N>&>(*this) = std::move(aOther);
    return *this;
  }

  // CopyableTArray exists for cases where an explicit Clone is not possible.
  // These uses should not be mixed, so we delete Clone() here.
  self_type Clone() const = delete;

  CopyableAutoTArray(CopyableAutoTArray&&) = default;
  CopyableAutoTArray& operator=(CopyableAutoTArray&&) = default;
};

// NOTE: We don't use MOZ_COUNT_CTOR/MOZ_COUNT_DTOR to perform leak checking of
// nsTArray_base objects intentionally for the following reasons:
// * The leak logging isn't as useful as other types of logging, as
//   nsTArray_base is frequently relocated without invoking a constructor, such
//   as when stored within another nsTArray. This means that
//   XPCOM_MEM_LOG_CLASSES cannot be used to identify specific leaks of nsTArray
//   objects.
// * The nsTArray type is layout compatible with the ThinVec crate with the
//   correct flags, and ThinVec does not currently perform leak logging.
//   This means that if a large number of arrays are transferred between Rust
//   and C++ code using ThinVec, for example within another ThinVec, they
//   will not be logged correctly and might appear as e.g. negative leaks.
// * Leaks which have been found thanks to the leak logging added by this
//   type have often not been significant, and/or have needed to be
//   circumvented using some other mechanism. Most leaks found with this type
//   in them also include other types which will continue to be tracked.

template <typename RelocationStrategy>
nsTArray_base<RelocationStrategy>::~nsTArray_base() {
  if (!HasEmptyHeader() && !UsesAutoArrayBuffer()) {
    nsTArrayInfallibleAllocator::Free(mHdr);
  }
}

// defined in nsTArray.cpp
bool IsTwiceTheRequiredBytesRepresentableAsUint32(size_t aCapacity,
                                                  size_t aElemSize);

template <typename RelocationStrategy>
template <typename Alloc>
typename Alloc::ResultTypeProxy
nsTArray_base<RelocationStrategy>::ExtendCapacity(size_type aLength,
                                                  size_type aCount,
                                                  size_type aElemSize) {
  mozilla::CheckedInt<size_type> newLength = aLength;
  newLength += aCount;

  if (!newLength.isValid()) {
    return Alloc::FailureResult();
  }

  return this->EnsureCapacity<Alloc>(newLength.value(), aElemSize);
}

template <class RelocationStrategy>
template <typename Alloc>
typename Alloc::ResultTypeProxy
nsTArray_base<RelocationStrategy>::EnsureCapacityImpl(size_type aCapacity,
                                                      size_type aElemSize) {
  MOZ_ASSERT(aCapacity > mHdr->mCapacity,
             "Should have been checked by caller (EnsureCapacity)");

  // If the requested memory allocation exceeds size_type(-1)/2, then
  // our doubling algorithm may not be able to allocate it.
  // Additionally, if it exceeds uint32_t(-1) then we couldn't fit in the
  // Header::mCapacity member. Just bail out in cases like that.  We don't want
  // to be allocating 2 GB+ arrays anyway.
  if (!IsTwiceTheRequiredBytesRepresentableAsUint32(aCapacity, aElemSize)) {
    Alloc::SizeTooBig((size_t)aCapacity * aElemSize);
    return Alloc::FailureResult();
  }

  size_t reqSize = sizeof(Header) + aCapacity * aElemSize;

  if (HasEmptyHeader()) {
    // Malloc() new data
    Header* header = static_cast<Header*>(Alloc::Malloc(reqSize));
    if (!header) {
      return Alloc::FailureResult();
    }
    header->mLength = 0;
    header->mCapacity = aCapacity;
    header->mIsAutoArray = false;
    mHdr = header;

    return Alloc::SuccessResult();
  }

  // We increase our capacity so that the allocated buffer grows exponentially,
  // which gives us amortized O(1) appending. Below the threshold, we use
  // powers-of-two. Above the threshold, we grow by at least 1.125, rounding up
  // to the nearest MiB.
  const size_t slowGrowthThreshold = 8 * 1024 * 1024;

  size_t bytesToAlloc;
  if (reqSize >= slowGrowthThreshold) {
    size_t currSize = sizeof(Header) + Capacity() * aElemSize;
    size_t minNewSize = currSize + (currSize >> 3);  // multiply by 1.125
    bytesToAlloc = reqSize > minNewSize ? reqSize : minNewSize;

    // Round up to the next multiple of MiB.
    const size_t MiB = 1 << 20;
    bytesToAlloc = MiB * ((bytesToAlloc + MiB - 1) / MiB);
  } else {
    // Round up to the next power of two.
    bytesToAlloc = mozilla::RoundUpPow2(reqSize);
  }

  Header* header;
  if (UsesAutoArrayBuffer() || !RelocationStrategy::allowRealloc) {
    // Malloc() and copy
    header = static_cast<Header*>(Alloc::Malloc(bytesToAlloc));
    if (!header) {
      return Alloc::FailureResult();
    }

    RelocationStrategy::RelocateNonOverlappingRegionWithHeader(
        header, mHdr, Length(), aElemSize);

    if (!UsesAutoArrayBuffer()) {
      Alloc::Free(mHdr);
    }
  } else {
    // Realloc() existing data
    header = static_cast<Header*>(Alloc::Realloc(mHdr, bytesToAlloc));
    if (!header) {
      return Alloc::FailureResult();
    }
  }

  // How many elements can we fit in bytesToAlloc?
  size_t newCapacity = (bytesToAlloc - sizeof(Header)) / aElemSize;
  MOZ_ASSERT(newCapacity >= aCapacity, "Didn't enlarge the array enough!");
  header->mCapacity = newCapacity;

  mHdr = header;

  return Alloc::SuccessResult();
}

// We don't need use Alloc template parameter specified here because failure to
// shrink the capacity will leave the array unchanged.
template <typename RelocationStrategy>
void nsTArray_base<RelocationStrategy>::ShrinkCapacity(size_type aElemSize) {
  if (HasEmptyHeader()) {
    return;
  }

  size_type length = Length();
  // Try to switch to our auto-buffer if possible.
  if (auto* autoHdr = GetAutoArrayHeader()) {
    if (mHdr == autoHdr) {
      return;
    }
    if (autoHdr->mCapacity >= length) {
      RelocationStrategy::RelocateNonOverlappingRegion(autoHdr + 1, mHdr + 1,
                                                       length, aElemSize);
      autoHdr->mLength = length;
      nsTArrayFallibleAllocator::Free(mHdr);
      mHdr = autoHdr;
      return;
    }
  }

  if (length == 0) {
    MOZ_ASSERT(!mHdr->mIsAutoArray, "Should've been dealt with above.");
    nsTArrayFallibleAllocator::Free(mHdr);
    mHdr = EmptyHdr();
    return;
  }

  if (length >= mHdr->mCapacity) {  // should never be greater than...
    return;
  }

  size_type newSize = sizeof(Header) + length * aElemSize;

  Header* newHeader;
  if (!RelocationStrategy::allowRealloc) {
    // Malloc() and copy.
    newHeader =
        static_cast<Header*>(nsTArrayFallibleAllocator::Malloc(newSize));
    if (!newHeader) {
      return;
    }

    RelocationStrategy::RelocateNonOverlappingRegionWithHeader(
        newHeader, mHdr, Length(), aElemSize);

    nsTArrayFallibleAllocator::Free(mHdr);
  } else {
    // Realloc() existing data.
    newHeader =
        static_cast<Header*>(nsTArrayFallibleAllocator::Realloc(mHdr, newSize));
    if (!newHeader) {
      return;
    }
  }

  mHdr = newHeader;
  mHdr->mCapacity = length;
}

template <typename RelocationStrategy>
void nsTArray_base<RelocationStrategy>::ShrinkCapacityToZero() {
  MOZ_ASSERT(mHdr->mLength == 0);

  if (HasEmptyHeader()) {
    return;
  }

  Header* newHdr = EmptyHdr();
  if (auto* autoBuf = GetAutoArrayHeader()) {
    if (mHdr == autoBuf) {
      return;
    }
    newHdr = autoBuf;
    newHdr->mLength = 0;
  }

  nsTArrayFallibleAllocator::Free(mHdr);
  mHdr = newHdr;
}

template <typename RelocationStrategy>
template <typename Alloc>
void nsTArray_base<RelocationStrategy>::ShiftData(index_type aStart,
                                                  size_type aOldLen,
                                                  size_type aNewLen,
                                                  size_type aElemSize) {
  if (aOldLen == aNewLen) {
    return;
  }

  // Determine how many elements need to be shifted
  size_type num = mHdr->mLength - (aStart + aOldLen);

  // Compute the resulting length of the array
  mHdr->mLength += aNewLen - aOldLen;
  if (mHdr->mLength == 0) {
    ShrinkCapacityToZero();
    return;
  }
  // Maybe nothing needs to be shifted
  if (num == 0) {
    return;
  }
  // Perform shift (change units to bytes first)
  aStart *= aElemSize;
  aNewLen *= aElemSize;
  aOldLen *= aElemSize;
  char* baseAddr = reinterpret_cast<char*>(mHdr + 1) + aStart;
  RelocationStrategy::RelocateOverlappingRegion(
      baseAddr + aNewLen, baseAddr + aOldLen, num, aElemSize);
}

template <typename RelocationStrategy>
template <typename Alloc>
void nsTArray_base<RelocationStrategy>::SwapFromEnd(index_type aStart,
                                                    size_type aCount,
                                                    size_type aElemSize) {
  // This method is part of the implementation of
  // nsTArray::SwapRemoveElement{s,}At. For more information, read the
  // documentation on that method.
  if (aCount == 0) {
    return;
  }

  // We are going to be removing aCount elements. Update our length to point to
  // the new end of the array.
  size_type oldLength = mHdr->mLength;
  mHdr->mLength -= aCount;

  if (mHdr->mLength == 0) {
    // If we have no elements remaining in the array, we can free our buffer.
    ShrinkCapacityToZero();
    return;
  }

  // Determine how many elements we need to move from the end of the array into
  // the now-removed section. This will either be the number of elements which
  // were removed (if there are more elements in the tail of the array), or the
  // entire tail of the array, whichever is smaller.
  size_type relocCount = std::min(aCount, mHdr->mLength - aStart);
  if (relocCount == 0) {
    return;
  }

  // Move the elements which are now stranded after the end of the array back
  // into the now-vacated memory.
  index_type sourceBytes = (oldLength - relocCount) * aElemSize;
  index_type destBytes = aStart * aElemSize;

  // Perform the final copy. This is guaranteed to be a non-overlapping copy
  // as our source contains only still-valid entries, and the destination
  // contains only invalid entries which need to be overwritten.
  MOZ_ASSERT(sourceBytes >= destBytes,
             "The source should be after the destination.");
  MOZ_ASSERT(sourceBytes - destBytes >= relocCount * aElemSize,
             "The range should be nonoverlapping");

  char* baseAddr = reinterpret_cast<char*>(mHdr + 1);
  RelocationStrategy::RelocateNonOverlappingRegion(
      baseAddr + destBytes, baseAddr + sourceBytes, relocCount, aElemSize);
}

template <typename RelocationStrategy>
template <typename Alloc>
typename Alloc::ResultTypeProxy
nsTArray_base<RelocationStrategy>::InsertSlotsAt(index_type aIndex,
                                                 size_type aCount,
                                                 size_type aElemSize) {
  if (MOZ_UNLIKELY(aIndex > Length())) {
    mozilla::detail::InvalidArrayIndex_CRASH(aIndex, Length());
  }

  if (!Alloc::Successful(
          this->ExtendCapacity<Alloc>(Length(), aCount, aElemSize))) {
    return Alloc::FailureResult();
  }

  // Move the existing elements as needed.  Note that this will
  // change our mLength, so no need to call IncrementLength.
  ShiftData<Alloc>(aIndex, 0, aCount, aElemSize);

  return Alloc::SuccessResult();
}

template <class RelocationStrategy>
template <typename Alloc>
typename Alloc::ResultTypeProxy
nsTArray_base<RelocationStrategy>::SwapArrayElements(
    nsTArray_base<RelocationStrategy>& aOther, size_type aElemSize) {
  // If neither array uses an auto buffer which is big enough to store the
  // other array's elements, then ensure that both arrays use malloc'ed storage
  // and swap their mHdr pointers.
  if ((!UsesAutoArrayBuffer() || Capacity() < aOther.Length()) &&
      (!aOther.UsesAutoArrayBuffer() || aOther.Capacity() < Length())) {
    auto* thisHdr = TakeHeaderForMove<Alloc>(aElemSize);
    if (MOZ_UNLIKELY(!thisHdr)) {
      return Alloc::FailureResult();
    }
    auto* otherHdr = aOther.template TakeHeaderForMove<Alloc>(aElemSize);
    if (MOZ_UNLIKELY(!otherHdr)) {
      // Ensure thisHdr and the elements inside it are safely
      // cleaned up in this error case, by returning it to
      // being owned by this.
      MOZ_ASSERT(UsesAutoArrayBuffer() || HasEmptyHeader());
      thisHdr->mIsAutoArray = mHdr->mIsAutoArray;
      mHdr = thisHdr;
      return Alloc::FailureResult();
    }
    // Avoid replacing the potentially auto-buffer with the empty header if
    // we're empty.
    if (otherHdr != EmptyHdr()) {
      otherHdr->mIsAutoArray = mHdr->mIsAutoArray;
      mHdr = otherHdr;
    }
    if (thisHdr != EmptyHdr()) {
      thisHdr->mIsAutoArray = aOther.mHdr->mIsAutoArray;
      aOther.mHdr = thisHdr;
    }
    return Alloc::SuccessResult();
  }

  // Swap the two arrays by copying, since at least one is using an auto
  // buffer which is large enough to hold all of the aOther's elements.  We'll
  // copy the shorter array into temporary storage.
  //
  // (We could do better than this in some circumstances.  Suppose we're
  // swapping arrays X and Y.  X has space for 2 elements in its auto buffer,
  // but currently has length 4, so it's using malloc'ed storage.  Y has length
  // 2.  When we swap X and Y, we don't need to use a temporary buffer; we can
  // write Y straight into X's auto buffer, write X's malloc'ed buffer on top
  // of Y, and then switch X to using its auto buffer.)

  if (!Alloc::Successful(EnsureCapacity<Alloc>(aOther.Length(), aElemSize)) ||
      !Alloc::Successful(
          aOther.template EnsureCapacity<Alloc>(Length(), aElemSize))) {
    return Alloc::FailureResult();
  }

  // The EnsureCapacity calls above shouldn't have caused *both* arrays to
  // switch from their auto buffers to malloc'ed space.
  MOZ_ASSERT(UsesAutoArrayBuffer() || aOther.UsesAutoArrayBuffer(),
             "One of the arrays should be using its auto buffer.");

  size_type smallerLength = XPCOM_MIN(Length(), aOther.Length());
  size_type largerLength = XPCOM_MAX(Length(), aOther.Length());
  void* smallerElements;
  void* largerElements;
  if (Length() <= aOther.Length()) {
    smallerElements = Hdr() + 1;
    largerElements = aOther.Hdr() + 1;
  } else {
    smallerElements = aOther.Hdr() + 1;
    largerElements = Hdr() + 1;
  }

  // Allocate temporary storage for the smaller of the two arrays.  We want to
  // allocate this space on the stack, if it's not too large.  Sounds like a
  // job for AutoTArray!  (One of the two arrays we're swapping is using an
  // auto buffer, so we're likely not allocating a lot of space here.  But one
  // could, in theory, allocate a huge AutoTArray on the heap.)
  AutoTArray<uint8_t, 64 * sizeof(void*)> temp;
  if (!Alloc::Successful(temp.template EnsureCapacity<Alloc>(
          smallerLength * aElemSize, sizeof(uint8_t)))) {
    return Alloc::FailureResult();
  }

  RelocationStrategy::RelocateNonOverlappingRegion(
      temp.Elements(), smallerElements, smallerLength, aElemSize);
  RelocationStrategy::RelocateNonOverlappingRegion(
      smallerElements, largerElements, largerLength, aElemSize);
  RelocationStrategy::RelocateNonOverlappingRegion(
      largerElements, temp.Elements(), smallerLength, aElemSize);

  // Swap the arrays' lengths.
  MOZ_ASSERT((aOther.Length() == 0 || !HasEmptyHeader()) &&
                 (Length() == 0 || !aOther.HasEmptyHeader()),
             "Don't set sEmptyTArrayHeader's length.");
  size_type tempLength = Length();

  // Avoid writing to EmptyHdr, since it can trigger false
  // positives with TSan.
  if (!HasEmptyHeader()) {
    mHdr->mLength = aOther.Length();
  }
  if (!aOther.HasEmptyHeader()) {
    aOther.mHdr->mLength = tempLength;
  }

  return Alloc::SuccessResult();
}

template <class RelocationStrategy>
void nsTArray_base<RelocationStrategy>::MoveInit(
    nsTArray_base<RelocationStrategy>& aOther, size_type aElemSize) {
  // This method is similar to SwapArrayElements, but specialized for the case
  // where the target array is empty with no allocated heap storage. It is
  // provided and used to simplify template instantiation and enable better code
  // generation.

  MOZ_ASSERT(Length() == 0);
  MOZ_ASSERT(Capacity() == 0 || UsesAutoArrayBuffer());

  const auto newLength = aOther.Length();
  if (aOther.HasEmptyHeader()) {
    return;
  }

  // If this array doesn't use an auto buffer which is big enough to store the
  // other array's elements, and the other array is using malloc'ed storage,
  // take their mHdr pointer.
  if (!aOther.UsesAutoArrayBuffer() &&
      (!mHdr->mIsAutoArray || Capacity() < newLength)) {
    const bool thisIsAuto = mHdr->mIsAutoArray;
    Header* otherAutoHeader = aOther.GetAutoArrayHeader();
    mHdr = aOther.mHdr;
    mHdr->mIsAutoArray = thisIsAuto;
    if (otherAutoHeader) {
      aOther.mHdr = otherAutoHeader;
      otherAutoHeader->mLength = 0;
    } else {
      aOther.mHdr = EmptyHdr();
    }
    return;
  }

  if (newLength) {
    // Move the data by copying, since at least one has an auto
    // buffer which is large enough to hold all of the aOther's elements.
    EnsureCapacity<nsTArrayInfallibleAllocator>(newLength, aElemSize);

    // The EnsureCapacity calls above shouldn't have caused *both* arrays to
    // switch from their auto buffers to malloc'ed space.
    MOZ_ASSERT(UsesAutoArrayBuffer() || aOther.UsesAutoArrayBuffer(),
               "One of the arrays should be using its auto buffer.");

    RelocationStrategy::RelocateNonOverlappingRegion(
        Hdr() + 1, aOther.Hdr() + 1, newLength, aElemSize);

    // Swap the arrays' lengths.
    MOZ_ASSERT(!HasEmptyHeader() && !aOther.HasEmptyHeader(),
               "Both arrays should have capacity");

    // Update our buffer's length, and reduce the other buffer's length.
    mHdr->mLength = newLength;
    aOther.mHdr->mLength = 0;
  }
  aOther.ShrinkCapacityToZero();
}

template <typename RelocationStrategy>
void nsTArray_base<RelocationStrategy>::MoveConstructNonAutoArray(
    nsTArray_base<RelocationStrategy>& aOther, size_type aElemSize) {
  // We know that we are not an (Copyable)AutoTArray and we know that we are
  // empty, so don't use SwapArrayElements which doesn't know either of these
  // facts and is very complex. Use nsTArrayInfallibleAllocator regardless of
  // Alloc because this is called from a move constructor, which cannot report
  // an error to the caller.
  mHdr =
      aOther.template TakeHeaderForMove<nsTArrayInfallibleAllocator>(aElemSize);
  MOZ_ASSERT(!mHdr->mIsAutoArray);
}

template <class RelocationStrategy>
template <typename Alloc>
auto nsTArray_base<RelocationStrategy>::TakeHeaderForMove(size_type aElemSize)
    -> Header* {
  auto* autoHdr = GetAutoArrayHeader();
  if (!autoHdr) {
    return std::exchange(mHdr, EmptyHdr());
  }

  if (mHdr != autoHdr) {
    MOZ_ASSERT(mHdr->mIsAutoArray);
    MOZ_ASSERT(autoHdr->mIsAutoArray);
    autoHdr->mLength = 0;
    mHdr->mIsAutoArray = false;
    return std::exchange(mHdr, autoHdr);
  }

  const auto length = Length();
  if (!length) {
    return EmptyHdr();
  }

  size_type size = sizeof(Header) + length * aElemSize;
  Header* header = static_cast<Header*>(Alloc::Malloc(size));
  if (!header) {
    return nullptr;
  }

  RelocationStrategy::RelocateNonOverlappingRegionWithHeader(header, mHdr,
                                                             length, aElemSize);
  header->mCapacity = length;
  // This will be set by our caller if needed.
  header->mIsAutoArray = false;

  mHdr->mLength = 0;
  MOZ_ASSERT(UsesAutoArrayBuffer());
  MOZ_ASSERT(IsEmpty());
  return header;
}

namespace mozilla {
template <typename E, typename ArrayT>
class nsTArrayBackInserter {
  ArrayT* mArray;

  class Proxy {
    ArrayT& mArray;

   public:
    explicit Proxy(ArrayT& aArray) : mArray{aArray} {}

    template <typename E2>
    void operator=(E2&& aValue) {
      mArray.AppendElement(std::forward<E2>(aValue));
    }
  };

 public:
  using iterator_category = std::output_iterator_tag;
  using value_type = void;
  using difference_type = void;
  using pointer = void;
  using reference = void;
  explicit nsTArrayBackInserter(ArrayT& aArray) : mArray{&aArray} {}

  // Return a proxy so that nsTArrayBackInserter has the default special member
  // functions, and the operator= template is defined in Proxy rather than this
  // class (which otherwise breaks with recent MS STL versions).
  // See also Bug 1331137, comment 11.
  Proxy operator*() { return Proxy(*mArray); }

  nsTArrayBackInserter& operator++() { return *this; }
  nsTArrayBackInserter& operator++(int) { return *this; }
};
}  // namespace mozilla

template <typename E>
auto MakeBackInserter(nsTArray<E>& aArray) {
  return mozilla::nsTArrayBackInserter<E, nsTArray<E>>{aArray};
}

// Span integration
namespace mozilla {
template <typename E, class Alloc>
Span(nsTArray_Impl<E, Alloc>&) -> Span<E>;

template <typename E, class Alloc>
Span(const nsTArray_Impl<E, Alloc>&) -> Span<const E>;

// Provides a view on a nsTArray through which the existing array elements can
// be accessed in a non-const way, but the array itself cannot be modified, so
// that references to elements are guaranteed to be stable.
template <typename E>
class nsTArrayView {
 public:
  using element_type = E;
  using pointer = element_type*;
  using reference = element_type&;
  using index_type = typename Span<element_type>::index_type;
  using size_type = typename Span<element_type>::index_type;

  explicit nsTArrayView(nsTArray<element_type> aArray)
      : mArray(std::move(aArray)), mSpan(mArray) {}

  element_type& operator[](index_type aIndex) { return mSpan[aIndex]; }

  const element_type& operator[](index_type aIndex) const {
    return mSpan[aIndex];
  }

  size_type Length() const { return mSpan.Length(); }

  auto begin() { return mSpan.begin(); }
  auto end() { return mSpan.end(); }
  auto begin() const { return mSpan.begin(); }
  auto end() const { return mSpan.end(); }
  auto cbegin() const { return mSpan.cbegin(); }
  auto cend() const { return mSpan.cend(); }

  Span<element_type> AsSpan() { return mSpan; }
  Span<const element_type> AsSpan() const { return mSpan; }

 private:
  nsTArray<element_type> mArray;
  const Span<element_type> mSpan;
};

// NOTE(emilio): If changing the name of this or so, make sure to change
// specializations too.
template <typename Range,
          typename = std::enable_if_t<std::is_same_v<
              typename std::iterator_traits<typename std::remove_reference_t<
                  Range>::iterator>::iterator_category,
              std::random_access_iterator_tag>>>
size_t RangeSizeEstimate(const Range& aRange) {
  // See https://en.cppreference.com/w/cpp/iterator/begin, section 'User-defined
  // overloads'.
  using std::begin;
  using std::end;

  return std::distance(begin(aRange), end(aRange));
}

/**
 * Materialize a range as a nsTArray (or a compatible variant, like AutoTArray)
 * of an explicitly specified type. The array value type must be implicitly
 * convertible from the range's value type.
 */
template <typename Array, typename Range>
auto ToTArray(Range&& aRange) {
  using std::begin;
  using std::end;

  Array res;
  if (auto estimate = RangeSizeEstimate(aRange)) {
    res.SetCapacity(estimate);
  }
  std::copy(begin(aRange), end(aRange), MakeBackInserter(res));
  return res;
}

/**
 * Materialize a range as a nsTArray of its (decayed) value type.
 */
template <typename Range>
auto ToArray(Range&& aRange) {
  return ToTArray<nsTArray<std::decay_t<typename std::iterator_traits<
      typename std::remove_reference_t<Range>::iterator>::value_type>>>(
      std::forward<Range>(aRange));
}

/**
 * Appends all elements from a range to an array.
 */
template <typename Array, typename Range>
void AppendToArray(Array& aArray, Range&& aRange) {
  using std::begin;
  using std::end;
  if (auto estimate = RangeSizeEstimate(aRange)) {
    aArray.SetCapacity(aArray.Length() + estimate);
  }
  std::copy(begin(aRange), end(aRange), MakeBackInserter(aArray));
}

}  // namespace mozilla

// MOZ_DBG support

template <class E, class Alloc>
std::ostream& operator<<(std::ostream& aOut,
                         const nsTArray_Impl<E, Alloc>& aTArray) {
  return aOut << mozilla::Span(aTArray);
}

#endif  // nsTArray_h_
