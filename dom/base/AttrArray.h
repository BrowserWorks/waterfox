/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Storage of the attributes of a DOM node.
 */

#ifndef AttrArray_h_
#define AttrArray_h_

#include "mozilla/BindgenUniquePtr.h"
#include "mozilla/MemoryReporting.h"
#include "mozilla/Span.h"
#include "mozilla/dom/BorrowedAttrInfo.h"
#include "nsAttrName.h"
#include "nsAttrValue.h"
#include "nsCaseTreatment.h"
#include "nscore.h"

namespace mozilla {
class AttributeStyles;
struct StyleLockedDeclarationBlock;

namespace dom {
class Element;
class ElementInternals;
}  // namespace dom
}  // namespace mozilla

class AttrArray {
  using BorrowedAttrInfo = mozilla::dom::BorrowedAttrInfo;

  // Declare as friend to grant access to call SetAndSwapAttr.
  friend class mozilla::dom::Element;
  friend class mozilla::dom::ElementInternals;

 public:
  AttrArray() {
    // Initialize bloom filter.
    SetTaggedBloom(0x1ULL);
  }
  ~AttrArray() {
    // If mImpl contains a tagged bloom filter (bit 0 = 1), we must clear it
    // before the BindgenUniquePtr destructor tries to free it as a pointer.
    if (HasTaggedBloom()) {
      mImpl.release();
    }
  }

  bool HasAttrs() const { return !!AttrCount(); }

  uint32_t AttrCount() const { return HasImpl() ? GetImpl()->mAttrCount : 0; }

  const nsAttrValue* GetAttr(const nsAtom* aLocalName) const;

  const nsAttrValue* GetAttr(const nsAtom* aLocalName,
                             int32_t aNamespaceID) const;
  // As above but using a string attr name and always using
  // kNameSpaceID_None.  This is always case-sensitive.
  const nsAttrValue* GetAttr(const nsAString& aName) const;
  // Get an nsAttrValue by qualified name.  Can optionally do
  // ASCII-case-insensitive name matching.
  const nsAttrValue* GetAttr(const nsAString& aName,
                             nsCaseTreatment aCaseSensitive) const;
  const nsAttrValue* AttrAt(uint32_t aPos) const;

  // This stores the argument and clears the pending mapped attribute evaluation
  // bit, so after calling this IsPendingMappedAttributeEvaluation() is
  // guaranteed to return false.
  void SetMappedDeclarationBlock(
      already_AddRefed<mozilla::StyleLockedDeclarationBlock>);

  bool IsPendingMappedAttributeEvaluation() const {
    return HasImpl() && GetImpl()->mMappedAttributeBits & 1;
  }

  mozilla::StyleLockedDeclarationBlock* GetMappedDeclarationBlock() const {
    return HasImpl() ? GetImpl()->GetMappedDeclarationBlock() : nullptr;
  }

  // Remove the attr at position aPos.  The value of the attr is placed in
  // aValue; any value that was already in aValue is destroyed.
  nsresult RemoveAttrAt(uint32_t aPos, nsAttrValue& aValue);

  // Returns attribute name at given position, *not* out-of-bounds safe
  const nsAttrName* AttrNameAt(uint32_t aPos) const;

  // Returns the attribute info at a given position, *not* out-of-bounds safe
  BorrowedAttrInfo AttrInfoAt(uint32_t aPos) const;

  // If aPos is in bounds, set aResult to the attribute at the given position
  // without AddRefing it and return true. Otherwise, return false.
  [[nodiscard]] bool GetSafeAttrNameAt(uint32_t aPos,
                                       const nsAttrName** aResult) const;

  // If aPos is in bounds, return the attribute at the given position.
  // Otherwise, crash.
  const nsAttrName* GetSafeAttrNameAt(uint32_t aPos) const;

  const nsAttrName* GetExistingAttrNameFromQName(const nsAString& aName) const;
  int32_t IndexOfAttr(const nsAtom* aLocalName) const;
  int32_t IndexOfAttr(const nsAtom* aLocalName, int32_t aNamespaceID) const;

  void Compact();

  size_t SizeOfExcludingThis(mozilla::MallocSizeOf aMallocSizeOf) const;

  // Mark the element as pending mapped attribute evaluation. This should be
  // called when a mapped attribute is changed (regardless of connectedness).
  bool MarkAsPendingPresAttributeEvaluation() {
    // It'd be great to be able to assert that HasImpl() is true or we're the
    // <body> or <svg> elements.
    if (MOZ_UNLIKELY(!HasImpl()) && !GrowBy(1)) {
      return false;
    }
    InfallibleMarkAsPendingPresAttributeEvaluation();
    return true;
  }

  // See above.
  void InfallibleMarkAsPendingPresAttributeEvaluation() {
    MOZ_ASSERT(HasImpl());
    GetImpl()->mMappedAttributeBits |= 1;
  }

  // Clear the servo declaration block on the mapped attributes, if any
  // Will assert off main thread
  void ClearMappedServoStyle();

  // Increases capacity (if necessary) to have enough space to accommodate the
  // unmapped attributes of |aOther|.
  nsresult EnsureCapacityToClone(const AttrArray& aOther);

  enum AttrValuesState { ATTR_MISSING = -1, ATTR_VALUE_NO_MATCH = -2 };
  using AttrValuesArray = nsStaticAtom* const;
  int32_t FindAttrValueIn(int32_t aNameSpaceID, const nsAtom* aName,
                          AttrValuesArray* aValues,
                          nsCaseTreatment aCaseSensitive) const;

  inline bool GetAttr(int32_t aNameSpaceID, const nsAtom* aName,
                      nsAString& aResult) const {
    MOZ_ASSERT(aResult.IsEmpty(), "Should have empty string coming in");
    const nsAttrValue* val = GetAttr(aName, aNameSpaceID);
    if (!val) {
      return false;
    }
    val->ToString(aResult);
    return true;
  }

  inline bool GetAttr(const nsAtom* aName, nsAString& aResult) const {
    MOZ_ASSERT(aResult.IsEmpty(), "Should have empty string coming in");
    const nsAttrValue* val = GetAttr(aName);
    if (!val) {
      return false;
    }
    val->ToString(aResult);
    return true;
  }

  inline bool HasAttr(const nsAtom* aName) const { return !!GetAttr(aName); }

  inline bool HasAttr(int32_t aNameSpaceID, const nsAtom* aName) const {
    return !!GetAttr(aName, aNameSpaceID);
  }

  inline bool AttrValueIs(int32_t aNameSpaceID, const nsAtom* aName,
                          const nsAString& aValue,
                          nsCaseTreatment aCaseSensitive) const {
    NS_ASSERTION(aName, "Must have attr name");
    NS_ASSERTION(aNameSpaceID != kNameSpaceID_Unknown, "Must have namespace");
    const nsAttrValue* val = GetAttr(aName, aNameSpaceID);
    return val && val->Equals(aValue, aCaseSensitive);
  }

  inline bool AttrValueIs(int32_t aNameSpaceID, const nsAtom* aName,
                          const nsAtom* aValue,
                          nsCaseTreatment aCaseSensitive) const {
    NS_ASSERTION(aName, "Must have attr name");
    NS_ASSERTION(aNameSpaceID != kNameSpaceID_Unknown, "Must have namespace");
    NS_ASSERTION(aValue, "Null value atom");

    const nsAttrValue* val = GetAttr(aName, aNameSpaceID);
    return val && val->Equals(aValue, aCaseSensitive);
  }

  struct InternalAttr {
    nsAttrName mName;
    nsAttrValue mValue;
  };

  AttrArray(const AttrArray& aOther) = delete;
  AttrArray& operator=(const AttrArray& aOther) = delete;

  bool GrowBy(uint32_t aGrowSize);
  bool GrowTo(uint32_t aCapacity);

  void Clear() {
    // If mImpl contains a tagged bloom filter, release it first to prevent
    // unique_ptr from trying to delete it as a pointer
    if (HasTaggedBloom()) {
      mImpl.release();
    } else {
      mImpl.reset();
    }
    // Reinitialize to default tagged bloom filter
    SetTaggedBloom(0x1ULL);
  }

  // For the HTML parser to call only after ensuring capacity.
  // Moves out of the arguments and returns a pointer to the
  // value once it is in place.
  const nsAttrValue* AddNewAttributeAssumeAvailableSlot(RefPtr<nsAtom>& aName,
                                                        nsAttrValue& aValue);

 private:
  // Tries to create an attribute, growing the buffer if needed, with the given
  // name and value.
  //
  // The value is moved from the argument.
  //
  // `Name` can be anything you construct a `nsAttrName` with (either an atom or
  // a NodeInfo pointer).
  template <typename Name>
  nsresult AddNewAttribute(Name*, nsAttrValue&);

  class Impl {
   public:
    constexpr static size_t AllocationSizeForAttributes(uint32_t aAttrCount) {
      return sizeof(Impl) + aAttrCount * sizeof(InternalAttr);
    }

    mozilla::StyleLockedDeclarationBlock* GetMappedDeclarationBlock() const {
      return reinterpret_cast<mozilla::StyleLockedDeclarationBlock*>(
          mMappedAttributeBits & ~uintptr_t(1));
    }

    auto Attrs() const {
      return mozilla::Span<const InternalAttr>{mBuffer, mAttrCount};
    }

    auto Attrs() { return mozilla::Span<InternalAttr>{mBuffer, mAttrCount}; }

    Impl(const Impl&) = delete;
    Impl(Impl&&) = delete;
    ~Impl();

    uint32_t mAttrCount;
    uint32_t mCapacity;  // In number of InternalAttrs

    // mMappedAttributeBits is a tagged pointer of a
    // StyleLockedDeclarationBlock, which holds the style information that our
    // attributes map to.
    //
    // If the lower bit is set, then our mapped attributes are dirty. This just
    // means that we might have mapped attributes (or used to and no longer
    // have), and are pending an update to recompute our declaration.
    uintptr_t mMappedAttributeBits = 0;

    // Combined bloom filter (63 bits) for both classes and attributes
    //   Bit 0: Always 1 to match tagged pointer implementation.
    //   Bits 1-63: Combined bloom filter (63 bits)
    uint64_t mSubtreeBloomFilter;

   public:
    Impl() : mSubtreeBloomFilter(0xFFFFFFFFFFFFFFFFULL) {}

    // Allocated in the same buffer as `Impl`.
    InternalAttr mBuffer[0];
  };

  mozilla::Span<InternalAttr> Attrs() {
    return HasImpl() ? GetImpl()->Attrs() : mozilla::Span<InternalAttr>();
  }

  mozilla::Span<const InternalAttr> Attrs() const {
    return HasImpl() ? GetImpl()->Attrs() : mozilla::Span<const InternalAttr>();
  }

  bool HasTaggedBloom() const {
    return (reinterpret_cast<uintptr_t>(mImpl.get()) & 1) != 0;
  }

  bool HasImpl() const {
    MOZ_ASSERT(mImpl.get() != nullptr);
    return !HasTaggedBloom();
  }

  Impl* GetImpl() {
    MOZ_ASSERT(HasImpl());
    return mImpl.get();
  }

  const Impl* GetImpl() const {
    MOZ_ASSERT(HasImpl());
    return mImpl.get();
  }

  uint64_t GetTaggedBloom() const {
    MOZ_ASSERT(HasTaggedBloom());
    return reinterpret_cast<uint64_t>(mImpl.get());
  }

  void SetTaggedBloom(uint64_t aBloom) {
    // If we already have a tagged bloom, release it first
    if (HasTaggedBloom()) {
      mImpl.release();
    }
    // Ensure bit 0 is set (tag bit) and upper bit is clear (valid pointer
    // range)
    MOZ_ASSERT((aBloom & 1) != 0);
    mImpl.reset(reinterpret_cast<Impl*>(static_cast<uintptr_t>(aBloom)));
  }

  void SetImpl(Impl* aImpl) {
    MOZ_ASSERT(aImpl != nullptr &&
               (reinterpret_cast<uintptr_t>(aImpl) & 1) == 0);
    // If we currently have a tagged bloom filter, release it first to prevent
    // unique_ptr from trying to delete it as a pointer
    if (HasTaggedBloom()) {
      mImpl.release();
    }
    mImpl.reset(aImpl);
  }

 public:
  // Set bloom filter directly from 64-bit value
  void SetSubtreeBloomFilter(uint64_t aBloom) {
    if (HasImpl()) {
      GetImpl()->mSubtreeBloomFilter = aBloom;
    } else {
      SetTaggedBloom(aBloom);
    }
  }

  // Get bloom filter, used for fast querySelector
  uint64_t GetSubtreeBloomFilter() const {
    if (HasImpl()) {
      return GetImpl()->mSubtreeBloomFilter;
    } else if (HasTaggedBloom()) {
      return GetTaggedBloom();
    }
    MOZ_ASSERT_UNREACHABLE("Bloom filter should never be nullptr");
    return 0xFFFFFFFFFFFFFFFFULL;
  }

  // Update bloom filter with new 64-bit hash
  void UpdateSubtreeBloomFilter(uint64_t aHash) {
    if (HasImpl()) {
      GetImpl()->mSubtreeBloomFilter |= aHash;
    } else {
      uint64_t current = GetSubtreeBloomFilter();
      SetTaggedBloom(current | aHash);
    }
  }

  // Check if bloom may contain the given hash
  bool BloomMayHave(uint64_t aHash) const {
    uint64_t bloom = GetSubtreeBloomFilter();
    return (bloom & aHash) == aHash;
  }

 private:
  // Internal method that swaps the current attribute value with aValue.
  // Does NOT update bloom filters - external code should always use
  // Element::SetAndSwapAttr instead, which calls this and updates bloom
  // filters. If the attribute was unset, an empty value will be swapped into
  // aValue and aHadValue will be set to false. Otherwise, aHadValue will be set
  // to true.
  nsresult SetAndSwapAttr(nsAtom* aLocalName, nsAttrValue& aValue,
                          bool* aHadValue);
  nsresult SetAndSwapAttr(mozilla::dom::NodeInfo* aName, nsAttrValue& aValue,
                          bool* aHadValue);

  // mImpl serves dual purposes using pointer tagging:
  //
  // 1. When the element has no attributes:
  //    - Stores a "tagged bloom filter" (bit 0 is 1). The remaining
  //      bits are used as a bloomfilter to identify the existence of
  //      attribute & class names in this subtree for querySelector.
  //
  // 2. When the element has attributes:
  //    - Points to an Impl struct (bit 0 is 0).
  //    - Contains actual attribute storage and the bloom filter
  //      is now copied as a member of Impl.
  //
  // Use HasTaggedBloom() vs HasImpl() to distinguish.
  mozilla::BindgenUniquePtr<Impl> mImpl;
};

#endif
