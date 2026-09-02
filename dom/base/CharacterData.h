/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Base class for DOM Core's Comment, DocumentType, Text,
 * CDATASection, and ProcessingInstruction nodes.
 */

#ifndef mozilla_dom_CharacterData_h
#define mozilla_dom_CharacterData_h

#include "CharacterDataBuffer.h"
#include "nsCycleCollectionParticipant.h"
#include "nsError.h"
#include "nsIContent.h"
#include "nsIMutationObserver.h"

namespace mozilla::dom {
class Element;
class HTMLSlotElement;
}  // namespace mozilla::dom

#define CHARACTER_DATA_FLAG_BIT(n_) \
  NODE_FLAG_BIT(NODE_TYPE_SPECIFIC_BITS_OFFSET + (n_))

// Data node specific flags
enum {
  // This bit is set to indicate that if the text node changes to
  // non-whitespace, we may need to create a frame for it. This bit must
  // not be set on nodes that already have a frame.
  NS_CREATE_FRAME_IF_NON_WHITESPACE = CHARACTER_DATA_FLAG_BIT(0),

  // This bit is set to indicate that if the text node changes to
  // whitespace, we may need to reframe it (or its ancestors).
  NS_REFRAME_IF_WHITESPACE = CHARACTER_DATA_FLAG_BIT(1),

  // This bit is set to indicate that we have a cached
  // TextIsOnlyWhitespace value
  NS_CACHED_TEXT_IS_ONLY_WHITESPACE = CHARACTER_DATA_FLAG_BIT(2),

  // This bit is only meaningful if the NS_CACHED_TEXT_IS_ONLY_WHITESPACE
  // bit is set, and if so it indicates whether we're only whitespace or
  // not.
  NS_TEXT_IS_ONLY_WHITESPACE = CHARACTER_DATA_FLAG_BIT(3),

  // This bit is set if there is a NewlineProperty attached to the node
  // (used by nsTextFrame).
  NS_HAS_NEWLINE_PROPERTY = CHARACTER_DATA_FLAG_BIT(4),

  // This bit is set if there is a FlowLengthProperty attached to the node
  // (used by nsTextFrame).
  NS_HAS_FLOWLENGTH_PROPERTY = CHARACTER_DATA_FLAG_BIT(5),

  // This bit is set if the node may be modified frequently.  This is typically
  // specified if the instance is in <input> or <textarea>.
  NS_MAYBE_MODIFIED_FREQUENTLY = CHARACTER_DATA_FLAG_BIT(6),

  // This bit is set if the node may be masked because of being in a password
  // field.
  NS_MAYBE_MASKED = CHARACTER_DATA_FLAG_BIT(7),

  // Set if this text might be responsible for setting the directionality
  // of a dir="auto" ancestor.
  NS_MAY_SET_DIR_AUTO = CHARACTER_DATA_FLAG_BIT(8),
};

// Make sure we have enough space for those bits
ASSERT_NODE_FLAGS_SPACE(NODE_TYPE_SPECIFIC_BITS_OFFSET + 8);

#undef CHARACTER_DATA_FLAG_BIT

namespace mozilla::dom {

class CharacterData : public nsIContent {
 public:
  // We want to avoid the overhead of extra function calls for
  // refcounting when we're not doing refcount logging, so we can't
  // NS_DECL_ISUPPORTS_INHERITED.
  NS_IMETHOD QueryInterface(REFNSIID aIID, void** aInstancePtr) override;
  NS_INLINE_DECL_REFCOUNTING_INHERITED(CharacterData, nsIContent);

  NS_DECL_ADDSIZEOFEXCLUDINGTHIS

  explicit CharacterData(already_AddRefed<dom::NodeInfo> aNodeInfo);

  void MarkAsMaybeModifiedFrequently() {
    SetFlags(NS_MAYBE_MODIFIED_FREQUENTLY);
  }
  void MarkAsMaybeMasked() { SetFlags(NS_MAYBE_MASKED); }

  void SetMaySetDirAuto() { SetFlags(NS_MAY_SET_DIR_AUTO); }
  bool MaySetDirAuto() const { return HasFlag(NS_MAY_SET_DIR_AUTO); }
  void ClearMaySetDirAuto() { UnsetFlags(NS_MAY_SET_DIR_AUTO); }

  NS_IMPL_FROMNODE_HELPER(CharacterData, IsCharacterData())

  void GetNodeValueInternal(nsAString& aNodeValue) override;
  void SetNodeValueInternal(
      const nsAString& aNodeValue, ErrorResult& aError,
      MutationEffectOnScript aMutationEffectOnScript) override;

  void GetTextContentInternal(nsAString& aTextContent, OOMReporter&) final {
    GetNodeValue(aTextContent);
  }

  void SetTextContentInternal(
      const nsAString& aTextContent, nsIPrincipal* aSubjectPrincipal,
      ErrorResult& aError,
      MutationEffectOnScript aMutationEffectOnScript) final;

  // Implementation for nsIContent
  nsresult BindToTree(BindContext&, nsINode& aParent) override;

  void UnbindFromTree(UnbindContext&) override;

  const CharacterDataBuffer* GetCharacterDataBuffer() const override {
    return &mBuffer;
  }
  uint32_t TextLength() const final { return TextDataLength(); }

  const CharacterDataBuffer& DataBuffer() const { return mBuffer; }
  uint32_t TextDataLength() const { return mBuffer.GetLength(); }

  /**
   * Set the text to the given value. If aNotify is true then
   * the document is notified of the content change.
   */
  nsresult SetText(const char16_t* aBuffer, uint32_t aLength, bool aNotify);
  /**
   * Append the given value to the current text. If aNotify is true then
   * the document is notified of the content change.
   */
  nsresult SetText(const nsAString& aStr, bool aNotify) {
    return SetText(aStr.BeginReading(), aStr.Length(), aNotify);
  }

  /**
   * Append the given value to the current text. If aNotify is true then
   * the document is notified of the content change.
   */
  nsresult AppendText(const char16_t* aBuffer, uint32_t aLength, bool aNotify);

  bool TextIsOnlyWhitespace() final;
  bool ThreadSafeTextIsOnlyWhitespace() const final;

  /**
   * Check if all text before the given offset is whitespace.
   */
  bool TextStartsWithOnlyWhitespace(uint32_t aOffset) const;

  /**
   * Check if all text at or after the given offset is whitespace.
   */
  bool TextEndsWithOnlyWhitespace(uint32_t aOffset) const;

  /**
   * Append the text content to aResult.
   */
  void AppendTextTo(nsAString& aResult) const { mBuffer.AppendTo(aResult); }

  /**
   * Append the text content to aResult.
   */
  [[nodiscard]] bool AppendTextTo(nsAString& aResult,
                                  const fallible_t& aFallible) const {
    return mBuffer.AppendTo(aResult, aFallible);
  }

  void SaveSubtreeState() final {}

#ifdef MOZ_DOM_LIST
  void ToCString(nsAString& aBuf, int32_t aOffset, int32_t aLen) const;

  void List(FILE* out, int32_t aIndent) const override {}

  void DumpContent(FILE* out, int32_t aIndent, bool aDumpAll) const override {}
#endif

  nsresult Clone(dom::NodeInfo* aNodeInfo, nsINode** aResult) const override {
    RefPtr<CharacterData> result = CloneDataNode(aNodeInfo, true);
    result.forget(aResult);

    if (!*aResult) {
      return NS_ERROR_OUT_OF_MEMORY;
    }

    return NS_OK;
  }

  // WebIDL API
  void GetData(nsAString& aData) const;
  void SetData(const nsAString& aData, ErrorResult& rv) {
    SetDataInternal(aData, MutationEffectOnScript::DropTrustWorthiness, rv);
  }
  virtual void SetDataInternal(const nsAString& aData,
                               MutationEffectOnScript aMutationEffectOnScript,
                               ErrorResult& rv);
  // nsINode::Length() returns the right thing for our length attribute
  void SubstringData(uint32_t aStart, uint32_t aCount, nsAString& aReturn,
                     ErrorResult& rv);
  void AppendData(const nsAString& aData, ErrorResult& rv) {
    AppendDataInternal(aData, MutationEffectOnScript::DropTrustWorthiness, rv);
  }
  void AppendDataInternal(const nsAString& aData,
                          MutationEffectOnScript aMutationEffectOnScript,
                          ErrorResult& rv);
  void InsertData(uint32_t aOffset, const nsAString& aData, ErrorResult& rv) {
    InsertDataInternal(aOffset, aData,
                       MutationEffectOnScript::DropTrustWorthiness, rv);
  }
  void InsertDataInternal(uint32_t aOffset, const nsAString& aData,
                          MutationEffectOnScript aMutationEffectOnScript,
                          ErrorResult& rv);
  void DeleteData(uint32_t aOffset, uint32_t aCount, ErrorResult& rv) {
    DeleteDataInternal(aOffset, aCount,
                       MutationEffectOnScript::DropTrustWorthiness, rv);
  }
  void DeleteDataInternal(uint32_t aOffset, uint32_t aCount,
                          MutationEffectOnScript aMutationEffectOnScript,
                          ErrorResult& rv);
  void ReplaceData(uint32_t aOffset, uint32_t aCount, const nsAString& aData,
                   ErrorResult& rv) {
    ReplaceDataInternal(aOffset, aCount, aData,
                        MutationEffectOnScript::DropTrustWorthiness, rv);
  }
  void ReplaceDataInternal(uint32_t aOffset, uint32_t aCount,
                           const nsAString& aData,
                           MutationEffectOnScript aMutationEffectOnScript,
                           ErrorResult& rv);

  //----------------------------------------

  NS_DECL_CYCLE_COLLECTION_SKIPPABLE_WRAPPERCACHE_CLASS_INHERITED(CharacterData,
                                                                  nsIContent)

  /**
   * Compare two CharacterData nodes for text equality.
   */
  [[nodiscard]] bool TextEquals(const CharacterData* aOther) const {
    return mBuffer.BufferEquals(aOther->mBuffer);
  }

 protected:
  virtual ~CharacterData();

  Element* GetNameSpaceElement() final;

  nsresult SetTextInternal(
      uint32_t aOffset, uint32_t aCount, const char16_t* aBuffer,
      uint32_t aLength, bool aNotify,
      MutationEffectOnScript aMutationEffectOnScript =
          MutationEffectOnScript::DropTrustWorthiness,
      CharacterDataChangeInfo::Details* aDetails = nullptr);

  /**
   * Method to clone this node. This needs to be overridden by all derived
   * classes. If aCloneText is true the text content will be cloned too.
   *
   * @param aOwnerDocument the ownerDocument of the clone
   * @param aCloneText if true the text content will be cloned too
   * @return the clone
   */
  virtual already_AddRefed<CharacterData> CloneDataNode(
      dom::NodeInfo* aNodeInfo, bool aCloneText) const = 0;

  CharacterDataBuffer mBuffer;

 private:
  already_AddRefed<nsAtom> GetCurrentValueAtom();

  bool CheckTextIsOnlyWhitespace(uint32_t aStartOffset,
                                 uint32_t aEndOffset) const;
};

}  // namespace mozilla::dom

#endif /* mozilla_dom_CharacterData_h */
