/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenuItem_h__
#define __nsMenuItem_h__

#include "mozilla/Attributes.h"
#include "nsCOMPtr.h"

#include "nsDbusmenu.h"
#include "nsMenuObject.h"

#include <glib.h>

class nsAtom;
class nsIContent;
class nsMenuBar;
class nsMenuContainer;

/*
 * This class represents 3 main classes of menuitems: labels, checkboxes and
 * radio buttons (with/without an icon)
 */
class nsMenuItem final : public nsMenuObject
{
public:
    nsMenuItem(nsMenuContainer *aParent, nsIContent *aContent);
    ~nsMenuItem() override;

    nsMenuObject::EType Type() const override;

private:
    friend class nsMenuItemUncheckSiblingsRunnable;

    enum {
        eMenuItemFlag_ToggleState = (1 << 0)
    };

    enum EMenuItemType {
        eMenuItemType_Normal,
        eMenuItemType_Radio,
        eMenuItemType_CheckBox
    };

    bool IsCheckboxOrRadioItem() const;

    static void item_activated_cb(DbusmenuMenuitem *menuitem,
                                  guint timestamp,
                                  gpointer user_data);
    void Activate(uint32_t aTimestamp);

    void CopyAttrFromNodeIfExists(nsIContent *aContent, nsAtom *aAtom);
    void UpdateState();
    void UpdateTypeAndState();
    void UpdateAccel();
    nsMenuBar* MenuBar();
    void UncheckSiblings();

    void InitializeNativeData() override;
    void UpdateContentAttributes() override;
    void Update(const mozilla::ComputedStyle *aComputedStyle) override;
    bool IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const override;
    nsMenuObject::PropertyFlags SupportedProperties() const override;

    void OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute) override;

    EMenuItemType mType;

    bool mIsChecked;

    bool mNeedsUpdate;

    nsCOMPtr<nsIContent> mKeyContent;
};

#endif /* __nsMenuItem_h__ */
