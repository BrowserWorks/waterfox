/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/Assertions.h"
#include "nsCRT.h"
#include "nsGkAtoms.h"

#include "nsDbusmenu.h"

#include "nsMenuContainer.h"
#include "nsMenuSeparator.h"

using namespace mozilla;

void
nsMenuSeparator::InitializeNativeData()
{
    dbusmenu_menuitem_property_set(GetNativeData(),
                                   DBUSMENU_MENUITEM_PROP_TYPE,
                                   "separator");
}

void
nsMenuSeparator::Update(const ComputedStyle *aComputedStyle)
{
    UpdateVisibility(aComputedStyle);
}

bool
nsMenuSeparator::IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const
{
    return nsCRT::strcmp(dbusmenu_menuitem_property_get(aNativeData,
                                                        DBUSMENU_MENUITEM_PROP_TYPE),
                         "separator") == 0;
}

nsMenuObject::PropertyFlags
nsMenuSeparator::SupportedProperties() const
{
    return static_cast<nsMenuObject::PropertyFlags>(
        nsMenuObject::ePropVisible |
        nsMenuObject::ePropType
    );
}

void
nsMenuSeparator::OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute)
{
    MOZ_ASSERT(aContent == ContentNode(), "Received an event that wasn't meant for us!");

    if (!Parent()->IsBeingDisplayed()) {
        return;
    }

    if (aAttribute == nsGkAtoms::hidden ||
        aAttribute == nsGkAtoms::collapsed) {
        RefPtr<const ComputedStyle> style = GetComputedStyle();
        UpdateVisibility(style);
    }
}

nsMenuSeparator::nsMenuSeparator(nsMenuContainer *aParent,
                                 nsIContent *aContent) :
    nsMenuObject(aParent, aContent)
{
    MOZ_COUNT_CTOR(nsMenuSeparator);
}

nsMenuSeparator::~nsMenuSeparator()
{
    MOZ_COUNT_DTOR(nsMenuSeparator);
}

nsMenuObject::EType
nsMenuSeparator::Type() const
{
    return eType_MenuItem;
}
