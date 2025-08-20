/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/DebugOnly.h"
#include "nsGkAtoms.h"
#include "nsIContent.h"

#include "nsDbusmenu.h"
#include "nsMenu.h"
#include "nsMenuItem.h"
#include "nsMenuSeparator.h"

#include "nsMenuContainer.h"

using namespace mozilla;

const nsMenuContainer::ChildTArray::index_type nsMenuContainer::NoIndex = nsMenuContainer::ChildTArray::NoIndex;

typedef UniquePtr<nsMenuObject> (*nsMenuObjectConstructor)(nsMenuContainer*,
                                                           nsIContent*);

template<class T>
static UniquePtr<nsMenuObject> CreateMenuObject(nsMenuContainer *aContainer,
                                                nsIContent *aContent)
{
    return UniquePtr<T>(new T(aContainer, aContent));
}

static nsMenuObjectConstructor
GetMenuObjectConstructor(nsIContent *aContent)
{
    if (aContent->IsXULElement(nsGkAtoms::menuitem)) {
        return CreateMenuObject<nsMenuItem>;
    } else if (aContent->IsXULElement(nsGkAtoms::menu)) {
        return CreateMenuObject<nsMenu>;
    } else if (aContent->IsXULElement(nsGkAtoms::menuseparator)) {
        return CreateMenuObject<nsMenuSeparator>;
    }

    return nullptr;
}

static bool
ContentIsSupported(nsIContent *aContent)
{
    return GetMenuObjectConstructor(aContent) ? true : false;
}

nsMenuContainer::nsMenuContainer(nsMenuContainer *aParent,
                                 nsIContent *aContent) :
    nsMenuObject(aParent, aContent)
{
}

nsMenuContainer::nsMenuContainer(nsNativeMenuDocListener *aListener,
                                 nsIContent *aContent) :
    nsMenuObject(aListener, aContent)
{
}

UniquePtr<nsMenuObject>
nsMenuContainer::CreateChild(nsIContent *aContent)
{
    nsMenuObjectConstructor ctor = GetMenuObjectConstructor(aContent);
    if (!ctor) {
        // There are plenty of node types we might stumble across that
        // aren't supported
        return nullptr;
    }

    UniquePtr<nsMenuObject> res = ctor(this, aContent);
    return res;
}

size_t
nsMenuContainer::IndexOf(nsIContent *aChild) const
{
    if (!aChild) {
        return NoIndex;
    }

    size_t count = ChildCount();
    for (size_t i = 0; i < count; ++i) {
        if (ChildAt(i)->ContentNode() == aChild) {
            return i;
        }
    }

    return NoIndex;
}

void
nsMenuContainer::RemoveChildAt(size_t aIndex, bool aUpdateNative)
{
    MOZ_ASSERT(aIndex < ChildCount());

    if (aUpdateNative) {
        MOZ_ALWAYS_TRUE(
            dbusmenu_menuitem_child_delete(GetNativeData(),
                                           ChildAt(aIndex)->GetNativeData()));
    }

    mChildren.RemoveElementAt(aIndex);
}

void
nsMenuContainer::RemoveChild(nsIContent *aChild, bool aUpdateNative)
{
    size_t index = IndexOf(aChild);
    if (index == NoIndex) {
        return;
    }

    RemoveChildAt(index, aUpdateNative);
}

void
nsMenuContainer::InsertChildAfter(UniquePtr<nsMenuObject> aChild,
                                  nsIContent *aPrevSibling,
                                  bool aUpdateNative)
{
    size_t index = IndexOf(aPrevSibling);
    MOZ_ASSERT(!aPrevSibling || index != NoIndex);

    ++index;

    if (aUpdateNative) {
        aChild->CreateNativeData();
        MOZ_ALWAYS_TRUE(
            dbusmenu_menuitem_child_add_position(GetNativeData(),
                                                 aChild->GetNativeData(),
                                                 index));
    }

    mChildren.InsertElementAt(index, std::move(aChild));
}

void
nsMenuContainer::AppendChild(UniquePtr<nsMenuObject> aChild,
                             bool aUpdateNative)
{
    if (aUpdateNative) {
        aChild->CreateNativeData();
        MOZ_ALWAYS_TRUE(
            dbusmenu_menuitem_child_append(GetNativeData(),
                                           aChild->GetNativeData()));
    }

    mChildren.AppendElement(std::move(aChild));
}

bool
nsMenuContainer::NeedsRebuild() const
{
    return false;
}

/* static */ nsIContent*
nsMenuContainer::GetPreviousSupportedSibling(nsIContent *aContent)
{
    do {
        aContent = aContent->GetPreviousSibling();
    } while (aContent && !ContentIsSupported(aContent));

    return aContent;
}
