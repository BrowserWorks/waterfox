/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
#ifndef mozilla_dom_HTMLSelectElement_h
#define mozilla_dom_HTMLSelectElement_h

#include "mozilla/Attributes.h"
#include "mozilla/EnumSet.h"
#include "mozilla/dom/BindingDeclarations.h"
#include "mozilla/dom/ConstraintValidation.h"
#include "mozilla/dom/HTMLFormElement.h"
#include "mozilla/dom/HTMLOptionsCollection.h"
#include "nsContentUtils.h"
#include "nsError.h"
#include "nsGenericHTMLElement.h"
#include "nsStubMutationObserver.h"

class nsIDOMHTMLOptionElement;
class nsListControlFrame;

namespace mozilla {

class ErrorResult;
class EventChainPostVisitor;
class EventChainPreVisitor;
class SelectContentData;
class PresState;

namespace dom {

class ContentList;
class FormData;
class HTMLButtonElement;
class HTMLCollection;
class HTMLElementOrLong;
class HTMLOptionElementOrHTMLOptGroupElement;
class HTMLSelectElement;
class HTMLSelectedContentElement;

/**
 * Implementation of &lt;select&gt;
 */
class HTMLSelectElement final : public nsGenericHTMLFormControlElementWithState,
                                public nsStubMutationObserver,
                                public ConstraintValidation {
 public:
  /**
   *  IsSelected        whether to set the option(s) to true or false
   *
   *  ClearAll          whether to clear all other options (for example, if you
   *                     are normal-clicking on the current option)
   *
   *  SetDisabled       whether it is permissible to set disabled options
   *                     (for JavaScript)
   *
   *  Notify             whether to notify frames and such
   *
   *  NoReselect        no need to select something after an option is
   * deselected (for reset)
   *
   *  InsertingOptions  if an option has just been inserted some bailouts can't
   * be taken
   */
  enum class OptionFlag : uint8_t {
    IsSelected,
    ClearAll,
    SetDisabled,
    Notify,
    NoReselect,
    InsertingOptions
  };
  using OptionFlags = EnumSet<OptionFlag>;

  using ConstraintValidation::GetValidationMessage;

  explicit HTMLSelectElement(already_AddRefed<mozilla::dom::NodeInfo> aNodeInfo,
                             FromParser aFromParser = NOT_FROM_PARSER);

  NS_IMPL_FROMNODE_HTML_WITH_TAG(HTMLSelectElement, select)

  // nsISupports
  NS_DECL_ISUPPORTS_INHERITED

  // For comboboxes, we need to keep the list up to date when options change.
  NS_DECL_NSIMUTATIONOBSERVER_ATTRIBUTECHANGED
  NS_DECL_NSIMUTATIONOBSERVER_CHARACTERDATACHANGED
  NS_DECL_NSIMUTATIONOBSERVER_CONTENTREMOVED
  NS_DECL_NSIMUTATIONOBSERVER_CONTENTAPPENDED
  NS_DECL_NSIMUTATIONOBSERVER_CONTENTINSERTED

  int32_t TabIndexDefault() override;

  // Element
  bool IsInteractiveHTMLContent() const override { return true; }

  // WebIdl HTMLSelectElement
  void GetAutocomplete(DOMString& aValue);
  void SetAutocomplete(const nsAString& aValue, ErrorResult& aRv) {
    SetHTMLAttr(nsGkAtoms::autocomplete, aValue, aRv);
  }

  void GetAutocompleteInfo(AutocompleteInfo& aInfo);

  // Sets the user interacted flag and fires input/change events if needed.
  MOZ_CAN_RUN_SCRIPT void UserFinishedInteracting(bool aChanged);

  bool Disabled() const { return GetBoolAttr(nsGkAtoms::disabled); }
  void SetDisabled(bool aVal, ErrorResult& aRv) {
    SetHTMLBoolAttr(nsGkAtoms::disabled, aVal, aRv);
  }
  bool Multiple() const { return GetBoolAttr(nsGkAtoms::multiple); }
  void SetMultiple(bool aVal, ErrorResult& aRv) {
    SetHTMLBoolAttr(nsGkAtoms::multiple, aVal, aRv);
  }

  void GetName(DOMString& aValue) { GetHTMLAttr(nsGkAtoms::name, aValue); }
  void SetName(const nsAString& aName, ErrorResult& aRv) {
    SetHTMLAttr(nsGkAtoms::name, aName, aRv);
  }
  bool Required() const { return State().HasState(ElementState::REQUIRED); }
  void SetRequired(bool aVal, ErrorResult& aRv) {
    SetHTMLBoolAttr(nsGkAtoms::required, aVal, aRv);
  }
  uint32_t Size() const { return GetUnsignedIntAttr(nsGkAtoms::size, 0); }
  void SetSize(uint32_t aSize, ErrorResult& aRv) {
    SetUnsignedIntAttr(nsGkAtoms::size, aSize, 0, aRv);
  }

  void GetType(nsAString& aValue);

  HTMLOptionsCollection* Options() const { return mOptions; }
  uint32_t Length() const { return mOptions->Length(); }
  void SetLength(uint32_t aLength, ErrorResult& aRv);
  Element* IndexedGetter(uint32_t aIdx, bool& aFound) const {
    return mOptions->IndexedGetter(aIdx, aFound);
  }
  HTMLOptionElement* Item(uint32_t aIdx) const {
    return mOptions->ItemAsOption(aIdx);
  }
  HTMLOptionElement* NamedItem(const nsAString& aName) const {
    return static_cast<HTMLOptionElement*>(
        mOptions->NamedItem(aName, /* aDoFlush = */ true));
  }
  void Add(const HTMLOptionElementOrHTMLOptGroupElement& aElement,
           const Nullable<HTMLElementOrLong>& aBefore, ErrorResult& aRv);
  void Remove(int32_t aIndex) const;
  void IndexedSetter(uint32_t aIndex, HTMLOptionElement* aOption,
                     ErrorResult& aRv) {
    mOptions->IndexedSetter(aIndex, aOption, aRv);
  }

  static bool MatchSelectedOptions(Element* aElement, int32_t, nsAtom*, void*);

  HTMLCollection* SelectedOptions();

  int32_t SelectedIndex() const;
  // During removal handling we might need to ignore some options that are
  // getting removed.
  using IgnoredOptionList = Span<RefPtr<HTMLOptionElement>>;
  HTMLOptionElement* GetSelectedOption(IgnoredOptionList = {}) const;
  void SetSelectedIndex(int32_t aIdx);
  void GetValue(nsAString& aValue) const;
  void SetValue(const nsAString& aValue);

  // Override SetCustomValidity so we update our state properly when it's called
  // via bindings.
  void SetCustomValidity(const nsAString& aError);

  void ShowPicker(ErrorResult& aRv);

  using nsINode::Remove;

  // nsINode
  JSObject* WrapNode(JSContext*, JS::Handle<JSObject*> aGivenProto) override;

  // nsIContent
  void GetEventTargetParent(EventChainPreVisitor& aVisitor) override;
  MOZ_CAN_RUN_SCRIPT_BOUNDARY
  nsresult PostHandleEvent(EventChainPostVisitor& aVisitor) override;

  HTMLOptionElement* GetCurrentOption() const;

  bool IsHTMLFocusable(IsFocusableFlags, bool* aIsFocusable,
                       int32_t* aTabIndex) override;

  // nsGenericHTMLElement
  bool IsDisabledForEvents(WidgetEvent* aEvent) override;

  // nsGenericHTMLFormElement
  void SaveState() override;
  bool RestoreState(PresState* aState) override;

  // Overridden nsIFormControl methods
  MOZ_CAN_RUN_SCRIPT NS_IMETHOD Reset() override;
  NS_IMETHOD SubmitNamesValues(FormData* aFormData) override;

  void FieldSetDisabledChanged(bool aNotify) override;

  /**
   * Checks whether an option is disabled (even if it's part of an optgroup)
   *
   * @param aIndex the index of the option to check
   * @return whether the option is disabled
   */
  NS_IMETHOD IsOptionDisabled(int32_t aIndex, bool* aIsDisabled);
  bool IsOptionDisabled(HTMLOptionElement* aOption) const;

  /**
   * Sets multiple options (or just sets startIndex if select is single)
   * and handles notifications and cleanup and everything under the sun.
   * When this method exits, the select will be in a consistent state.  i.e.
   * if you set the last option to false, it will select an option anyway.
   *
   * @param aStartIndex the first index to set
   * @param aEndIndex the last index to set (set same as first index for one
   *        option)
   * @param aOptionsMask determines whether to set, clear all or disable
   *        options and whether frames are to be notified of such.
   * @return whether any options were actually changed
   */
  bool SetOptionsSelectedByIndex(int32_t aStartIndex, int32_t aEndIndex,
                                 OptionFlags aOptionsMask);

  /**
   * Called when an attribute is about to be changed
   */
  nsresult BindToTree(BindContext&, nsINode& aParent) override;
  void UnbindFromTree(UnbindContext&) override;
  void BeforeSetAttr(int32_t aNameSpaceID, nsAtom* aName,
                     const nsAttrValue* aValue, bool aNotify) override;
  void AfterSetAttr(int32_t aNameSpaceID, nsAtom* aName,
                    const nsAttrValue* aValue, const nsAttrValue* aOldValue,
                    nsIPrincipal* aSubjectPrincipal, bool aNotify) override;

  void DoneAddingChildren(bool aHaveNotified) override;
  bool IsDoneAddingChildren() const { return mIsDoneAddingChildren; }

  bool ParseAttribute(int32_t aNamespaceID, nsAtom* aAttribute,
                      const nsAString& aValue,
                      nsIPrincipal* aMaybeScriptedPrincipal,
                      nsAttrValue& aResult) override;
  nsMapRuleToAttributesFunc GetAttributeMappingFunction() const override;
  nsChangeHint GetAttributeChangeHint(const nsAtom* aAttribute,
                                      AttrModType aModType) const override;
  NS_IMETHOD_(bool) IsAttributeMapped(const nsAtom* aAttribute) const override;

  nsresult Clone(dom::NodeInfo*, nsINode** aResult) const override;

  NS_DECL_CYCLE_COLLECTION_CLASS_INHERITED(
      HTMLSelectElement, nsGenericHTMLFormControlElementWithState)

  HTMLOptionsCollection* GetOptions() { return mOptions; }

  // ConstraintValidation
  nsresult GetValidationMessage(nsAString& aValidationMessage,
                                ValidityStateType aType) override;

  void UpdateValueMissingValidityState(IgnoredOptionList = {});
  void UpdateValidityElementStates(bool aNotify);
  /**
   * Insert aElement before the node given by aBefore
   */
  void Add(nsGenericHTMLElement& aElement, nsGenericHTMLElement* aBefore,
           ErrorResult& aError);
  void Add(nsGenericHTMLElement& aElement, int32_t aIndex,
           ErrorResult& aError) {
    // If item index is out of range, insert to last.
    // (since beforeElement becomes null, it is inserted to last)
    Element* beforeContent = mOptions->Item(aIndex);
    return Add(aElement, nsGenericHTMLElement::FromNodeOrNull(beforeContent),
               aError);
  }

  /** Is this a combobox? */
  bool IsCombobox() const { return !Multiple() && Size() <= 1; }

  bool OpenInParentProcess() const { return mIsOpenInParentProcess; }
  void SetOpenInParentProcess(bool aVal) {
    mIsOpenInParentProcess = aVal;
    SetStates(ElementState::OPEN, aVal);
  }

  void GetPreviewValue(nsAString& aValue) { aValue = mPreviewValue; }
  void SetPreviewValue(const nsAString& aValue);

  void SetAutofillState(const nsAString& aState) {
    SetFormAutofillState(aState);
  }
  void GetAutofillState(nsAString& aState) { GetFormAutofillState(aState); }

  HTMLButtonElement* GetFirstButton() const;

  void SetupShadowTree();
  void GetSlotNameFor(const ShadowRoot&, const nsIContent&,
                      nsAString&) const override;
  void OnChildBeforeSlotted(ShadowRoot&, nsIContent&) override;
  void OnChildUnslotted(ShadowRoot&, nsIContent&) override;

  // Returns the text node that has the selected <option>'s text.
  // Note that it might return null for printing.
  Text* GetSelectedContentText() const;
  void SelectedContentTextMightHaveChanged(bool aNotify = true,
                                           IgnoredOptionList = {});

  // https://html.spec.whatwg.org/#selectedness-setting-algorithm
  // NOTE: PR https://github.com/whatwg/html/pull/12263 rewrites this algorithm
  // aIgnored: options to skip (for pre-removal handling where options are still
  // in the list but about to be unbound).
  void RunSelectednessSettingAlgorithm(bool aNotify = true,
                                       bool aInsertionOrRemovalSteps = false,
                                       IgnoredOptionList aIgnored = {});

  // Queues a microtask to update all descendant selectedcontent elements.
  // Multiple calls coalesce into a single update.
  void ScheduleSelectedContentUpdate();
  // Like ScheduleSelectedContentUpdate but uses AddScriptRunner instead of a
  // microtask, so it fires in FIFO order with post-connection script runners.
  // aForceUpdate: skips IsInComposedDoc and mSelectedContentUpdatePending
  // guards. Used by spec algorithms (select.value, select.selectedIndex) that
  // must update selectedcontent even on disconnected selects and must not be
  // coalesced with deferred mutation-driven updates. Safe from re-entrance
  // because JS setters cannot be called during UpdateDescendantSelectedContent.
  void ScheduleSelectedContentUpdateScriptRunner(bool aForceUpdate = false);

  // https://html.spec.whatwg.org/#update-a-select's-descendant-selectedcontent-elements
  MOZ_CAN_RUN_SCRIPT void UpdateDescendantSelectedContentElements();
  // https://html.spec.whatwg.org/#update-a-selectedcontent
  MOZ_CAN_RUN_SCRIPT void UpdateSelectedContentElement(
      HTMLSelectedContentElement* aSelectedContent);
  // https://html.spec.whatwg.org/#clone-an-option-into-a-selectedcontent
  MOZ_CAN_RUN_SCRIPT void CloneOptionIntoSelectedContent(
      HTMLOptionElement* aOption, HTMLSelectedContentElement* aSelectedContent);

 protected:
  virtual ~HTMLSelectElement();

  // Helper Methods
  /**
   * Check whether the option specified by the index is selected
   * @param aIndex the index
   * @return whether the option at the index is selected
   */
  bool IsOptionSelectedByIndex(int32_t aIndex) const;
  /**
   * Starting with (and including) aStartIndex, find the first selected index
   * and set mSelectedIndex to it.
   * @param aStartIndex the index to start with
   */
  void FindSelectedIndex(int32_t aStartIndex, bool aNotify);
  /**
   * Called to trigger notifications of frames and fixing selected index
   *
   * @param aIndex the index that was selected or deselected
   * @param aSelected whether the index was selected or deselected
   * @param aChangeOptionState if false, don't do anything to the
   *                           HTMLOptionElement at aIndex.  If true, change
   *                           its selected state to aSelected.
   * @param aNotify whether to notify the style system and such
   */
  void OnOptionSelected(int32_t aIndex, bool aSelected, bool aChangeOptionState,
                        bool aNotify);
  /**
   * Restore state to a particular state string (representing the options)
   * @param aNewSelected the state string to restore to
   */
  void RestoreStateTo(const SelectContentData& aNewSelected);

  // nsIConstraintValidation
  void UpdateBarredFromConstraintValidation();
  bool IsValueMissing(IgnoredOptionList = {}) const;

  /**
   * Get the index of the first option at, under or following the content in
   * the select, or length of options[] if none are found
   * @param aOptions the content
   * @return the index of the first option
   */
  int32_t GetOptionIndexAt(nsIContent* aOptions);
  /**
   * Get the next option following the content in question (not at or under)
   * (this could include siblings of the current content or siblings of the
   * parent or children of siblings of the parent).
   * @param aOptions the content
   * @return the index of the next option after the content
   */
  int32_t GetOptionIndexAfter(nsIContent* aOptions);
  /**
   * Get the first option index at or under the content in question.
   * @param aOptions the content
   * @return the index of the first option at or under the content
   */
  int32_t GetFirstOptionIndex(nsIContent* aOptions);
  /**
   * Get the first option index under the content in question, within the
   * range specified.
   * @param aOptions the content
   * @param aStartIndex the first child to look at
   * @param aEndIndex the child *after* the last child to look at
   * @return the index of the first option at or under the content
   */
  int32_t GetFirstChildOptionIndex(nsIContent* aOptions, int32_t aStartIndex,
                                   int32_t aEndIndex);

  /** Get the frame as an nsListControlFrame (MAY RETURN nullptr) */
  nsListControlFrame* GetListBoxFrame();

  /**
   * Helper method for dispatching ContentReset notifications to list box
   * frames.
   */
  void DispatchContentReset();

  void SetSelectedIndexInternal(int32_t aIndex, bool aNotify);

  void OnSelectionChanged();

  /**
   * Marks the selectedOptions list as dirty, so that it'll populate itself
   * again.
   */
  void UpdateSelectedOptions();

  void SetUserInteracted(bool) final;

  MOZ_CAN_RUN_SCRIPT nsresult HandleKeyDown(EventChainPostVisitor&);
  MOZ_CAN_RUN_SCRIPT nsresult HandleKeyPress(EventChainPostVisitor&);
  MOZ_CAN_RUN_SCRIPT nsresult HandleMouseDown(EventChainPostVisitor&);
  MOZ_CAN_RUN_SCRIPT nsresult HandleMouseUp(EventChainPostVisitor&);
  MOZ_CAN_RUN_SCRIPT nsresult HandleMouseMove(EventChainPostVisitor&);

  void AdjustIndexForDisabledOpt(int32_t aStartIndex, int32_t& aNewIndex,
                                 int32_t aNumOptions, int32_t aDoAdjustInc,
                                 int32_t aDoAdjustIncNext);
  bool IsOptionInteractivelySelectable(uint32_t aIndex) const;
  int32_t GetEndSelectionIndex() const;
  int32_t ItemsPerPage() const;

  MOZ_CAN_RUN_SCRIPT
  void PostHandleKeyEvent(int32_t aNewIndex, uint32_t aCharCode, bool aIsShift,
                          bool aIsControlOrMeta);

  HTMLOptionElement* GetNonDisabledOptionFrom(
      int32_t aFromIndex, int32_t* aFoundIndex = nullptr) const;

  MOZ_CAN_RUN_SCRIPT void FireDropDownEvent(bool aShow,
                                            bool aIsSourceTouchEvent);

  void ContentAppendedOrInserted(nsIContent* aFirstNewContent, bool aIsAppend);

  /** The options[] array */
  RefPtr<HTMLOptionsCollection> mOptions;
  nsContentUtils::AutocompleteAttrState mAutocompleteAttrState;
  nsContentUtils::AutocompleteAttrState mAutocompleteInfoState;
  /** false if the parser is in the middle of adding children. */
  bool mIsDoneAddingChildren : 1;
  /** true if our disabled state has changed from the default **/
  bool mDisabledChanged : 1 = false;
  /** True if DoneAddingChildren will get called but shouldn't restore state. */
  bool mInhibitStateRestoration : 1;
  /** https://html.spec.whatwg.org/#user-interacted */
  bool mUserInteracted : 1 = false;
  /** True if the default selected option has been set. */
  bool mDefaultSelectionSet : 1 = false;
  /** True if we're open in the parent process */
  bool mIsOpenInParentProcess : 1 = false;
  bool mButtonDown : 1 = false;
  bool mControlSelectMode : 1 = false;
  /**
   * True once a selectedcontent update has been scheduled (as a microtask or a
   * script runner) but has not run yet. Used to coalesce multiple mutations
   * into a single update.
   */
  bool mSelectedContentUpdatePending : 1 = false;
  /**
   * True while we are cloning the selected option into our descendant
   * selectedcontent elements. Used to ignore the mutation observer
   * notifications caused by that cloning, which would otherwise schedule a
   * redundant update.
   */
  bool mIsUpdatingSelectedContent : 1 = false;
  /**
   * The temporary restore state in case we try to restore before parser is
   * done adding options
   */
  UniquePtr<SelectContentData> mRestoreState;

  /**
   * The live list of selected options.
   */
  RefPtr<ContentList> mSelectedOptions;

  /**
   * The current displayed preview text.
   */
  nsString mPreviewValue;

 private:
  static void MapAttributesIntoRule(MappedDeclarationsBuilder&);
};

}  // namespace dom
}  // namespace mozilla

#endif  // mozilla_dom_HTMLSelectElement_h
