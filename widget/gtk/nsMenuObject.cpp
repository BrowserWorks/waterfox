/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "ImageOps.h"
#include "imgIContainer.h"
#include "imgINotificationObserver.h"
#include "imgLoader.h"
#include "imgRequestProxy.h"
#include "mozilla/ArrayUtils.h"
#include "mozilla/Assertions.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/Preferences.h"
#include "mozilla/PresShell.h"
#include "mozilla/PresShellInlines.h"
#include "mozilla/GRefPtr.h"
#include "nsAttrValue.h"
#include "nsComputedDOMStyle.h"
#include "nsContentUtils.h"
#include "nsGkAtoms.h"
#include "nsIContent.h"
#include "nsIContentPolicy.h"
#include "nsILoadGroup.h"
#include "nsImageToPixbuf.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsPresContext.h"
#include "nsRect.h"
#include "nsServiceManagerUtils.h"
#include "nsString.h"
#include "nsStyleConsts.h"
#include "nsStyleStruct.h"
#include "nsUnicharUtils.h"

#include "nsMenuContainer.h"
#include "nsNativeMenuDocListener.h"

#include <gdk/gdk.h>
#include <glib-object.h>
#include <pango/pango.h>

#include "nsMenuObject.h"

// X11's None clashes with StyleDisplay::None
#include "X11UndefineNone.h"

#undef None

using namespace mozilla;
using mozilla::image::ImageOps;

#define MAX_WIDTH 350000

const char *gPropertyStrings[] = {
#define DBUSMENU_PROPERTY(e, s, b) s,
    DBUSMENU_PROPERTIES
#undef DBUSMENU_PROPERTY
    nullptr
};

nsWeakMenuObject* nsWeakMenuObject::sHead;
PangoLayout* gPangoLayout = nullptr;

class nsMenuObjectIconLoader final : public imgINotificationObserver
{
public:
    NS_DECL_ISUPPORTS
    NS_DECL_IMGINOTIFICATIONOBSERVER

    nsMenuObjectIconLoader(nsMenuObject *aOwner) : mOwner(aOwner) { };

    void LoadIcon(const ComputedStyle *aComputedStyle);
    void Destroy();

private:
    ~nsMenuObjectIconLoader() { };

    nsMenuObject *mOwner;
    RefPtr<imgRequestProxy> mImageRequest;
    nsCOMPtr<nsIURI> mURI;
};

NS_IMPL_ISUPPORTS(nsMenuObjectIconLoader, imgINotificationObserver)

void
nsMenuObjectIconLoader::Notify(imgIRequest *aProxy,
                               int32_t aType, const nsIntRect *aRect)
{
    if (!mOwner) {
        return;
    }

    if (aProxy != mImageRequest) {
        return;
    }

    if (aType == imgINotificationObserver::LOAD_COMPLETE) {
        uint32_t status = imgIRequest::STATUS_ERROR;
        if (NS_FAILED(mImageRequest->GetImageStatus(&status)) ||
            (status & imgIRequest::STATUS_ERROR)) {
            mImageRequest->Cancel(NS_BINDING_ABORTED);
            mImageRequest = nullptr;
            return;
        }

        nsCOMPtr<imgIContainer> image;
        mImageRequest->GetImage(getter_AddRefs(image));
        MOZ_ASSERT(image);

        // Ask the image to decode at its intrinsic size.
        int32_t width = 0, height = 0;
        image->GetWidth(&width);
        image->GetHeight(&height);
        image->RequestDecodeForSize(nsIntSize(width, height), imgIContainer::FLAG_NONE);
        return;
    }

    if (aType == imgINotificationObserver::DECODE_COMPLETE) {
        mImageRequest->Cancel(NS_BINDING_ABORTED);
        mImageRequest = nullptr;
        return;
    }

    if (aType != imgINotificationObserver::FRAME_COMPLETE) {
        return;
    }

    nsCOMPtr<imgIContainer> img;
    mImageRequest->GetImage(getter_AddRefs(img));
    if (!img) {
        return;
    }

    int32_t width, height;
    img->GetWidth(&width);
    img->GetHeight(&height);

    if (width <= 0 || height <= 0) {
        mOwner->ClearIcon();
        return;
    }

    if (width > 100 || height > 100) {
        // The icon data needs to go across DBus. Make sure the icon
        // data isn't too large, else our connection gets terminated and
        // GDbus helpfully aborts the application. Thank you :)
        NS_WARNING("Icon data too large");
        mOwner->ClearIcon();
        return;
    }

    RefPtr<GdkPixbuf> pixbuf = nsImageToPixbuf::ImageToPixbuf(img);
    if (pixbuf) {
        dbusmenu_menuitem_property_set_image(mOwner->GetNativeData(),
                                             DBUSMENU_MENUITEM_PROP_ICON_DATA,
                                             pixbuf);
    }

    return;
}

void
nsMenuObjectIconLoader::LoadIcon(const ComputedStyle *aComputedStyle)
{
    dom::Document *doc = mOwner->ContentNode()->OwnerDoc();

    nsCOMPtr<nsIURI> uri;
    imgRequestProxy *imageRequest = nullptr;

    nsAutoString uriString;
    if (mOwner->ContentNode()->AsElement()->GetAttr(kNameSpaceID_None,
                                                    nsGkAtoms::image,
                                                    uriString)) {
        NS_NewURI(getter_AddRefs(uri), uriString);
    } else {
        PresShell *shell = doc->GetPresShell();
        if (!shell) {
            return;
        }

        nsPresContext *pc = shell->GetPresContext();
        if (!pc || !aComputedStyle) {
            return;
        }

        const nsStyleList *list = aComputedStyle->StyleList();
        imageRequest = list->mListStyleImage.GetImageRequest();
        if (imageRequest) {
            imageRequest->GetURI(getter_AddRefs(uri));
        }
    }

    if (!uri) {
        mOwner->ClearIcon();
        mURI = nullptr;

        if (mImageRequest) {
            mImageRequest->Cancel(NS_BINDING_ABORTED);
            mImageRequest = nullptr;
        }

        return;
    }

    bool same;
    if (mURI && NS_SUCCEEDED(mURI->Equals(uri, &same)) && same &&
        !imageRequest) {
        return;
    }

    if (mImageRequest) {
        mImageRequest->Cancel(NS_BINDING_ABORTED);
        mImageRequest = nullptr;
    }

    mURI = uri;

    if (imageRequest) {
        imageRequest->Clone(this, nullptr, getter_AddRefs(mImageRequest));
    } else {
        nsCOMPtr<nsILoadGroup> loadGroup = doc->GetDocumentLoadGroup();
        RefPtr<imgLoader> loader =
            nsContentUtils::GetImgLoaderForDocument(doc);
        if (!loader || !loadGroup) {
            NS_WARNING("Failed to get loader or load group for image load");
            return;
        }

        loader->LoadImage(uri, nullptr, nullptr,
                          nullptr, 0, loadGroup, this, nullptr, nullptr,
                          nsIRequest::LOAD_NORMAL, nullptr,
                          nsIContentPolicy::TYPE_IMAGE, EmptyString(),
                          false, false, 0, dom::FetchPriority::Auto, getter_AddRefs(mImageRequest));
    }
}

void
nsMenuObjectIconLoader::Destroy()
{
    if (mImageRequest) {
        mImageRequest->CancelAndForgetObserver(NS_BINDING_ABORTED);
        mImageRequest = nullptr;
    }

    mOwner = nullptr;
}

static int
CalculateTextWidth(const nsAString& aText)
{
    if (!gPangoLayout) {
        PangoFontMap *fontmap = pango_cairo_font_map_get_default();
        PangoContext *ctx = pango_font_map_create_context(fontmap);
        gPangoLayout = pango_layout_new(ctx);
        g_object_unref(ctx);
    }

    pango_layout_set_text(gPangoLayout, NS_ConvertUTF16toUTF8(aText).get(), -1);

    int width, dummy;
    pango_layout_get_size(gPangoLayout, &width, &dummy);

    return width;
}

static const nsDependentString
GetEllipsis()
{
    static char16_t sBuf[4] = { 0, 0, 0, 0 };
    if (!sBuf[0]) {
        nsString ellipsis;
        Preferences::GetLocalizedString("intl.ellipsis", ellipsis);
        if (!ellipsis.IsEmpty()) {
            uint32_t l = ellipsis.Length();
            const nsString::char_type *c = ellipsis.BeginReading();
            uint32_t i = 0;
            while (i < 3 && i < l) {
                sBuf[i++] = *(c++);
            }
        } else {
            sBuf[0] = '.';
            sBuf[1] = '.';
            sBuf[2] = '.';
        }
    }

    return nsDependentString(sBuf);
}

static int
GetEllipsisWidth()
{
    static int sEllipsisWidth = -1;

    if (sEllipsisWidth == -1) {
        sEllipsisWidth = CalculateTextWidth(GetEllipsis());
    }

    return sEllipsisWidth;
}

nsMenuObject::nsMenuObject(nsMenuContainer *aParent, nsIContent *aContent) :
    mContent(aContent),
    mListener(aParent->DocListener()),
    mParent(aParent),
    mNativeData(nullptr)
{
    MOZ_ASSERT(mContent);
    MOZ_ASSERT(mListener);
    MOZ_ASSERT(mParent);
}

nsMenuObject::nsMenuObject(nsNativeMenuDocListener *aListener,
                           nsIContent *aContent) :
    mContent(aContent),
    mListener(aListener),
    mParent(nullptr),
    mNativeData(nullptr)
{
    MOZ_ASSERT(mContent);
    MOZ_ASSERT(mListener);
}

void
nsMenuObject::UpdateLabel()
{
    // Gecko stores the label and access key in separate attributes
    // so we need to convert label="Foo_Bar"/accesskey="F" in to
    // label="_Foo__Bar" for dbusmenu

    nsAutoString label;
    mContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::label, label);

    nsAutoString accesskey;
    mContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::accesskey,
                                   accesskey);

    const nsAutoString::char_type *akey = accesskey.BeginReading();
    char16_t keyLower = ToLowerCase(*akey);
    char16_t keyUpper = ToUpperCase(*akey);

    const nsAutoString::char_type *iter = label.BeginReading();
    const nsAutoString::char_type *end = label.EndReading();
    uint32_t length = label.Length();
    uint32_t pos = 0;
    bool foundAccessKey = false;

    while (iter != end) {
        if (*iter != char16_t('_')) {
            if ((*iter != keyLower && *iter != keyUpper) || foundAccessKey) {
                ++iter;
                ++pos;
                continue;
            }
            foundAccessKey = true;
        }

        label.SetLength(++length);

        iter = label.BeginReading() + pos;
        end = label.EndReading();
        nsAutoString::char_type *cur = label.BeginWriting() + pos;

        memmove(cur + 1, cur, (length - 1 - pos) * sizeof(nsAutoString::char_type));
        *cur = nsAutoString::char_type('_');

        iter += 2;
        pos += 2;
    }

    if (CalculateTextWidth(label) <= MAX_WIDTH) {
        dbusmenu_menuitem_property_set(mNativeData,
                                       DBUSMENU_MENUITEM_PROP_LABEL,
                                       NS_ConvertUTF16toUTF8(label).get());
        return;
    }

    // This sucks.
    // This should be done at the point where the menu is drawn (hello Unity),
    // but unfortunately it doesn't do that and will happily fill your entire
    // screen width with a menu if you have a bookmark with a really long title.
    // This leaves us with no other option but to ellipsize here, with no proper
    // knowledge of Unity's render path, font size etc. This is better than nothing
    nsAutoString truncated;
    int target = MAX_WIDTH - GetEllipsisWidth();
    length = label.Length();

    static mozilla::dom::Element::AttrValuesArray strings[] = {
        nsGkAtoms::left, nsGkAtoms::start,
        nsGkAtoms::center, nsGkAtoms::right,
        nsGkAtoms::end, nullptr
    };

    int32_t type = mContent->AsElement()->FindAttrValueIn(kNameSpaceID_None,
                                                          nsGkAtoms::crop,
                                                          strings, eCaseMatters);

    switch (type) {
        case 0:
        case 1:
            // FIXME: Implement left cropping
        case 2:
            // FIXME: Implement center cropping
        case 3:
        case 4:
        default:
            for (uint32_t i = 0; i < length; i++) {
                truncated.Append(label.CharAt(i));
                if (CalculateTextWidth(truncated) > target) {
                    break;
                }
            }

            truncated.Append(GetEllipsis());
    }

    dbusmenu_menuitem_property_set(mNativeData,
                                   DBUSMENU_MENUITEM_PROP_LABEL,
                                   NS_ConvertUTF16toUTF8(truncated).get());
}

void
nsMenuObject::UpdateVisibility(const ComputedStyle *aComputedStyle)
{
    bool vis = true;

    if (aComputedStyle &&
        (aComputedStyle->StyleDisplay()->mDisplay == StyleDisplay::None ||
         aComputedStyle->StyleVisibility()->mVisible ==
            StyleVisibility::Collapse)) {
        vis = false;
    }

    dbusmenu_menuitem_property_set_bool(mNativeData,
                                        DBUSMENU_MENUITEM_PROP_VISIBLE,
                                        vis);
}

void
nsMenuObject::UpdateSensitivity()
{
    bool disabled = mContent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                       nsGkAtoms::disabled,
                                                       nsGkAtoms::_true,
                                                       eCaseMatters);

    dbusmenu_menuitem_property_set_bool(mNativeData,
                                        DBUSMENU_MENUITEM_PROP_ENABLED,
                                        !disabled);

}

void
nsMenuObject::UpdateIcon(const ComputedStyle *aComputedStyle)
{
    if (ShouldShowIcon()) {
        if (!mIconLoader) {
            mIconLoader = new nsMenuObjectIconLoader(this);
        }

        mIconLoader->LoadIcon(aComputedStyle);
    } else {
        if (mIconLoader) {
            mIconLoader->Destroy();
            mIconLoader = nullptr;
        }

        ClearIcon();
    }
}

already_AddRefed<const ComputedStyle>
nsMenuObject::GetComputedStyle()
{
    RefPtr<const ComputedStyle> style =
        nsComputedDOMStyle::GetComputedStyleNoFlush(
            mContent->AsElement());

    return style.forget();
}

void
nsMenuObject::InitializeNativeData()
{
}

nsMenuObject::PropertyFlags
nsMenuObject::SupportedProperties() const
{
    return static_cast<nsMenuObject::PropertyFlags>(0);
}

bool
nsMenuObject::IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const
{
    return true;
}

void
nsMenuObject::UpdateContentAttributes()
{
}

void
nsMenuObject::Update(const ComputedStyle *aComputedStyle)
{
}

bool
nsMenuObject::ShouldShowIcon() const
{
    // Ideally we want to know the visibility of the anonymous XUL image in
    // our menuitem, but this isn't created because we don't have a frame.
    // The following works by default (because xul.css hides images in menuitems
    // that don't have the "menuitem-with-favicon" class). It's possible a third
    // party theme could override this, but, oh well...
    const nsAttrValue *classes = mContent->AsElement()->GetClasses();
    if (!classes) {
        return false;
    }

    for (uint32_t i = 0; i < classes->GetAtomCount(); ++i) {
        if (classes->AtomAt(i) == nsGkAtoms::menuitem_with_favicon) {
            return true;
        }
    }

    return false;
}

void
nsMenuObject::ClearIcon()
{
    dbusmenu_menuitem_property_remove(mNativeData,
                                      DBUSMENU_MENUITEM_PROP_ICON_DATA);
}

nsMenuObject::~nsMenuObject()
{
    nsWeakMenuObject::NotifyDestroyed(this);

    if (mIconLoader) {
        mIconLoader->Destroy();
    }

    if (mListener) {
        mListener->UnregisterForContentChanges(mContent);
    }

    if (mNativeData) {
        g_object_unref(mNativeData);
        mNativeData = nullptr;
    }
}

void
nsMenuObject::CreateNativeData()
{
    MOZ_ASSERT(mNativeData == nullptr, "This node already has a DbusmenuMenuitem. The old one will be leaked");

    mNativeData = dbusmenu_menuitem_new();
    InitializeNativeData();
    if (mParent && mParent->IsBeingDisplayed()) {
        ContainerIsOpening();
    }

    mListener->RegisterForContentChanges(mContent, this);
}

nsresult
nsMenuObject::AdoptNativeData(DbusmenuMenuitem *aNativeData)
{
    MOZ_ASSERT(mNativeData == nullptr, "This node already has a DbusmenuMenuitem. The old one will be leaked");

    if (!IsCompatibleWithNativeData(aNativeData)) {
        return NS_ERROR_FAILURE;
    }

    mNativeData = aNativeData;
    g_object_ref(mNativeData);

    PropertyFlags supported = SupportedProperties();
    PropertyFlags mask = static_cast<PropertyFlags>(1);

    for (uint32_t i = 0; gPropertyStrings[i]; ++i) {
        if (!(mask & supported)) {
            dbusmenu_menuitem_property_remove(mNativeData, gPropertyStrings[i]);
        }
        mask = static_cast<PropertyFlags>(mask << 1);
    }

    InitializeNativeData();
    if (mParent && mParent->IsBeingDisplayed()) {
        ContainerIsOpening();
    }

    mListener->RegisterForContentChanges(mContent, this);

    return NS_OK;
}

void
nsMenuObject::ContainerIsOpening()
{
    MOZ_ASSERT(nsContentUtils::IsSafeToRunScript());

    UpdateContentAttributes();

    RefPtr<const ComputedStyle> style = GetComputedStyle();
    Update(style);
}

/* static */ void
nsWeakMenuObject::AddWeakReference(nsWeakMenuObject *aWeak)
{
    aWeak->mPrev = sHead;
    sHead = aWeak;
}

/* static */ void
nsWeakMenuObject::RemoveWeakReference(nsWeakMenuObject *aWeak)
{
    if (aWeak == sHead) {
        sHead = aWeak->mPrev;
        return;
    }

    nsWeakMenuObject *weak = sHead;
    while (weak && weak->mPrev != aWeak) {
        weak = weak->mPrev;
    }

    if (weak) {
        weak->mPrev = aWeak->mPrev;
    }
}

/* static */ void
nsWeakMenuObject::NotifyDestroyed(nsMenuObject *aMenuObject)
{
    nsWeakMenuObject *weak = sHead;
    while (weak) {
        if (weak->mMenuObject == aMenuObject) {
            weak->mMenuObject = nullptr;
        }

        weak = weak->mPrev;
    }
}
