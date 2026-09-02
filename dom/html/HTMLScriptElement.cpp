/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/HTMLScriptElement.h"

#include "mozilla/StaticPrefs_dom.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/FetchPriority.h"
#include "mozilla/dom/HTMLScriptElementBinding.h"
#include "mozilla/dom/TrustedTypeUtils.h"
#include "mozilla/dom/TrustedTypesConstants.h"
#include "nsAttrValue.h"
#include "nsAttrValueOrString.h"
#include "nsContentUtils.h"
#include "nsDOMJSUtils.h"
#include "nsDOMTokenList.h"
#include "nsError.h"
#include "nsGenericHTMLElement.h"
#include "nsGkAtoms.h"
#include "nsIScriptContext.h"
#include "nsIScriptError.h"
#include "nsIScriptGlobalObject.h"
#include "nsISupportsImpl.h"
#include "nsNetUtil.h"
#include "nsServiceManagerUtils.h"
#include "nsStyleConsts.h"
#include "nsTArray.h"
#include "nsUnicharUtils.h"  // for nsCaseInsensitiveStringComparator()

NS_IMPL_NS_NEW_HTML_ELEMENT_CHECK_PARSER(Script)

using JS::loader::ScriptKind;

namespace mozilla::dom {

JSObject* HTMLScriptElement::WrapNode(JSContext* aCx,
                                      JS::Handle<JSObject*> aGivenProto) {
  return HTMLScriptElement_Binding::Wrap(aCx, this, aGivenProto);
}

HTMLScriptElement::HTMLScriptElement(
    already_AddRefed<mozilla::dom::NodeInfo> aNodeInfo, FromParser aFromParser)
    : nsGenericHTMLElement(std::move(aNodeInfo)), ScriptElement(aFromParser) {
  AddMutationObserver(this);
}

HTMLScriptElement::~HTMLScriptElement() = default;

NS_IMPL_ISUPPORTS_CYCLE_COLLECTION_INHERITED(HTMLScriptElement,
                                             nsGenericHTMLElement,
                                             nsIScriptLoaderObserver,
                                             nsIScriptElement,
                                             nsIMutationObserver)

NS_IMPL_CYCLE_COLLECTION_INHERITED(HTMLScriptElement, nsGenericHTMLElement,
                                   mBlocking)

nsresult HTMLScriptElement::BindToTree(BindContext& aContext,
                                       nsINode& aParent) {
  nsresult rv = nsGenericHTMLElement::BindToTree(aContext, aParent);
  NS_ENSURE_SUCCESS(rv, rv);

  if (IsInComposedDoc()) {
    MaybeProcessScript(nullptr /* aParser */);
  }

  return NS_OK;
}

bool HTMLScriptElement::ParseAttribute(int32_t aNamespaceID, nsAtom* aAttribute,
                                       const nsAString& aValue,
                                       nsIPrincipal* aMaybeScriptedPrincipal,
                                       nsAttrValue& aResult) {
  if (aNamespaceID == kNameSpaceID_None) {
    if (aAttribute == nsGkAtoms::crossorigin) {
      ParseCORSValue(aValue, aResult);
      return true;
    }

    if (aAttribute == nsGkAtoms::integrity) {
      aResult.ParseStringOrAtom(aValue);
      return true;
    }

    if (aAttribute == nsGkAtoms::fetchpriority) {
      ParseFetchPriority(aValue, aResult);
      return true;
    }

    if (aAttribute == nsGkAtoms::blocking &&
        StaticPrefs::dom_element_blocking_enabled()) {
      aResult.ParseAtomArray(aValue);
      return true;
    }
  }

  return nsGenericHTMLElement::ParseAttribute(aNamespaceID, aAttribute, aValue,
                                              aMaybeScriptedPrincipal, aResult);
}

nsresult HTMLScriptElement::Clone(dom::NodeInfo* aNodeInfo,
                                  nsINode** aResult) const {
  *aResult = nullptr;

  HTMLScriptElement* it = new (aNodeInfo->NodeInfoManager())
      HTMLScriptElement(do_AddRef(aNodeInfo), NOT_FROM_PARSER);

  nsCOMPtr<nsINode> kungFuDeathGrip = it;
  nsresult rv = const_cast<HTMLScriptElement*>(this)->CopyInnerTo(it);
  NS_ENSURE_SUCCESS(rv, rv);

  // The clone should be marked evaluated if we are.
  it->mAlreadyStarted = mAlreadyStarted;
  it->mLineNumber = mLineNumber;
  it->mMalformed = mMalformed;

  kungFuDeathGrip.swap(*aResult);

  return NS_OK;
}

void HTMLScriptElement::AfterSetAttr(int32_t aNamespaceID, nsAtom* aName,
                                     const nsAttrValue* aValue,
                                     const nsAttrValue* aOldValue,
                                     nsIPrincipal* aMaybeScriptedPrincipal,
                                     bool aNotify) {
  if (nsGkAtoms::async == aName && kNameSpaceID_None == aNamespaceID) {
    mForceAsync = false;
  }
  if (nsGkAtoms::src == aName && kNameSpaceID_None == aNamespaceID) {
    mSrcTriggeringPrincipal = nsContentUtils::GetAttrTriggeringPrincipal(
        this, nsAttrValueOrString(aValue).String(), aMaybeScriptedPrincipal);
  }
  return nsGenericHTMLElement::AfterSetAttr(
      aNamespaceID, aName, aValue, aOldValue, aMaybeScriptedPrincipal, aNotify);
}

void HTMLScriptElement::GetInnerHTML(nsAString& aInnerHTML,
                                     OOMReporter& aError) {
  if (!nsContentUtils::GetNodeTextContent(this, false, aInnerHTML, fallible)) {
    aError.ReportOOM();
  }
}

void HTMLScriptElement::SetInnerHTMLTrusted(const nsAString& aInnerHTML,
                                            nsIPrincipal* aSubjectPrincipal,
                                            ErrorResult& aError) {
  // aInnerHTML is trusted HTML, but not trusted script so we must not preserve
  // trustworthiness.
  aError = nsContentUtils::SetNodeTextContent(this, aInnerHTML, true);
}

void HTMLScriptElement::GetText(nsAString& aValue, ErrorResult& aRv) const {
  if (!nsContentUtils::GetNodeTextContent(this, false, aValue, fallible)) {
    aRv.Throw(NS_ERROR_OUT_OF_MEMORY);
  }
}

void HTMLScriptElement::GetText(OwningTrustedScriptOrString& aValue,
                                ErrorResult& aRv) const {
  GetText(aValue.SetAsString(), aRv);
}

void HTMLScriptElement::SetText(const TrustedScriptOrString& aValue,
                                nsIPrincipal* aSubjectPrincipal,
                                ErrorResult& aRv) {
  constexpr nsLiteralString sink = u"HTMLScriptElement text"_ns;

  Maybe<nsAutoString> compliantStringHolder;
  const nsAString* compliantString =
      TrustedTypeUtils::GetTrustedTypesCompliantString(
          aValue, sink, kTrustedTypesOnlySinkGroup, *this, aSubjectPrincipal,
          compliantStringHolder, aRv);
  if (aRv.Failed()) {
    return;
  }
  aRv = nsContentUtils::SetNodeTextContent(
      this, *compliantString, true,
      MutationEffectOnScript::KeepTrustWorthiness);
}

void HTMLScriptElement::GetInnerText(
    OwningTrustedScriptOrNullIsEmptyString& aValue, ErrorResult& aError) {
  DOMString innerText;
  nsGenericHTMLElement::GetInnerText(innerText, aError);
  if (aError.Failed()) {
    return;
  }
  aValue.SetAsNullIsEmptyString() = std::move(innerText);
}

void HTMLScriptElement::SetInnerText(
    const TrustedScriptOrNullIsEmptyString& aValue,
    nsIPrincipal* aSubjectPrincipal, ErrorResult& aError) {
  constexpr nsLiteralString sink = u"HTMLScriptElement innerText"_ns;

  Maybe<nsAutoString> compliantStringHolder;
  const nsAString* compliantString =
      TrustedTypeUtils::GetTrustedTypesCompliantString(
          aValue, sink, kTrustedTypesOnlySinkGroup, *this, aSubjectPrincipal,
          compliantStringHolder, aError);
  if (aError.Failed()) {
    return;
  }
  nsGenericHTMLElement::SetInnerTextInternal(
      *compliantString, MutationEffectOnScript::KeepTrustWorthiness);
}

void HTMLScriptElement::GetTrustedScriptOrStringTextContent(
    Nullable<OwningTrustedScriptOrString>& aTextContent,
    mozilla::OOMReporter& aError) {
  FragmentOrElement::GetTextContentInternal(
      aTextContent.SetValue().SetAsString(), aError);
}

void HTMLScriptElement::SetTrustedScriptOrStringTextContent(
    const Nullable<TrustedScriptOrString>& aTextContent,
    nsIPrincipal* aSubjectPrincipal, mozilla::ErrorResult& aError) {
  constexpr nsLiteralString sink = u"HTMLScriptElement textContent"_ns;
  Maybe<nsAutoString> compliantStringHolder;
  if (aTextContent.IsNull()) {
    Nullable<TrustedScriptOrString> emptyString;
    emptyString.SetValue().SetStringLiteral(u"");
    SetTrustedScriptOrStringTextContent(emptyString, aSubjectPrincipal, aError);
    return;
  }
  const nsAString* compliantString =
      TrustedTypeUtils::GetTrustedTypesCompliantString(
          aTextContent.Value(), sink, kTrustedTypesOnlySinkGroup, *this,
          aSubjectPrincipal, compliantStringHolder, aError);
  if (aError.Failed()) {
    return;
  }
  SetTextContentInternal(*compliantString, aSubjectPrincipal, aError,
                         MutationEffectOnScript::KeepTrustWorthiness);
}

void HTMLScriptElement::GetSrc(OwningTrustedScriptURLOrUSVString& aSrc) {
  GetURIAttr(nsGkAtoms::src, nullptr, aSrc.SetAsUSVString());
}

void HTMLScriptElement::SetSrc(const TrustedScriptURLOrUSVString& aSrc,
                               nsIPrincipal* aSubjectPrincipal,
                               ErrorResult& aRv) {
  constexpr nsLiteralString sink = u"HTMLScriptElement src"_ns;

  Maybe<nsAutoString> compliantStringHolder;
  const nsAString* compliantString =
      TrustedTypeUtils::GetTrustedTypesCompliantString(
          aSrc, sink, kTrustedTypesOnlySinkGroup, *this, aSubjectPrincipal,
          compliantStringHolder, aRv);
  if (aRv.Failed()) {
    return;
  }

  SetHTMLAttr(nsGkAtoms::src, *compliantString, aSubjectPrincipal, aRv);
}

// variation of this code in SVGScriptElement - check if changes
// need to be transferred when modifying

void HTMLScriptElement::GetScriptText(nsAString& text) const {
  GetText(text, IgnoreErrors());
}

void HTMLScriptElement::GetScriptCharset(nsAString& charset) {
  GetCharset(charset);
}

void HTMLScriptElement::FreezeExecutionAttrs(const Document* aOwnerDoc) {
  if (mFrozen) {
    return;
  }

  // Determine whether this is a(n) classic/module/importmap script.
  DetermineKindFromType(aOwnerDoc);

  // variation of this code in SVGScriptElement - check if changes
  // need to be transferred when modifying.  Note that we don't use GetSrc here
  // because it will return the base URL when the attr value is "".
  nsAutoString src;
  if (GetAttr(nsGkAtoms::src, src)) {
    SourceLocation loc{OwnerDoc()->GetDocumentURI(), GetScriptLineNumber(),
                       GetScriptColumnNumber().oneOriginValue()};
    // Empty src should be treated as invalid URL.
    if (!src.IsEmpty()) {
      nsContentUtils::NewURIWithDocumentCharset(getter_AddRefs(mUri), src,
                                                OwnerDoc(), GetBaseURI());

      if (!mUri) {
        AutoTArray<nsString, 2> params = {u"src"_ns, std::move(src)};

        nsContentUtils::ReportToConsole(nsIScriptError::warningFlag, "HTML"_ns,
                                        OwnerDoc(),
                                        PropertiesFile::DOM_PROPERTIES,
                                        "ScriptSourceInvalidUri", params, loc);
      }
    } else {
      AutoTArray<nsString, 1> params = {u"src"_ns};
      nsContentUtils::ReportToConsole(
          nsIScriptError::warningFlag, "HTML"_ns, OwnerDoc(),
          PropertiesFile::DOM_PROPERTIES, "ScriptSourceEmpty", params, loc);
    }

    // At this point mUri will be null for invalid URLs.
    mExternal = true;
  }

  bool async = (mExternal || mKind == ScriptKind::eModule) && Async();
  bool defer = mExternal && Defer();

  mDefer = !async && defer;
  mAsync = async;

  mFrozen = true;
}

CORSMode HTMLScriptElement::GetCORSMode() const {
  return AttrValueToCORSMode(GetParsedAttr(nsGkAtoms::crossorigin));
}

FetchPriority HTMLScriptElement::GetFetchPriority() const {
  return Element::GetFetchPriority();
}

mozilla::dom::ReferrerPolicy HTMLScriptElement::GetReferrerPolicy() {
  return GetReferrerPolicyAsEnum();
}

bool HTMLScriptElement::HasExternalScriptContent() {
  return mFrozen ? mExternal : HasAttr(nsGkAtoms::src);
}

// https://html.spec.whatwg.org/multipage/scripting.html#dom-script-supports
/* static */
bool HTMLScriptElement::Supports(const GlobalObject& aGlobal,
                                 const nsAString& aType) {
  nsAutoString type(aType);
  return aType.EqualsLiteral("classic") || aType.EqualsLiteral("module") ||

         aType.EqualsLiteral("importmap");
}

nsDOMTokenList* HTMLScriptElement::Blocking() {
  if (!mBlocking) {
    mBlocking =
        new nsDOMTokenList(this, nsGkAtoms::blocking, sSupportedBlockingValues);
  }
  return mBlocking;
}

bool HTMLScriptElement::IsPotentiallyRenderBlocking() {
  return BlockingContainsRender();

  // TODO: handle implicitly potentially render blocking
  // https://html.spec.whatwg.org/#implicitly-potentially-render-blocking
  // A script element el is implicitly potentially render-blocking if el's type
  // is "classic", el is parser-inserted, and el does not have an async or defer
  // attribute.
}

}  // namespace mozilla::dom
