/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenu_h__
#define __nsMenu_h__

#include "mozilla/Attributes.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"

#include "nsDbusmenu.h"
#include "nsMenuContainer.h"
#include "nsMenuObject.h"

#include <glib.h>

class nsAtom;
class nsIContent;
class nsITimer;

#define NSMENU_NUMBER_OF_POPUPSTATE_BITS 2U
#define NSMENU_NUMBER_OF_FLAGS           4U

// This class represents a menu
class nsMenu final : public nsMenuContainer
{
public:
    nsMenu(nsMenuContainer *aParent, nsIContent *aContent);
    ~nsMenu();

    nsMenuObject::EType Type() const override;

    bool IsBeingDisplayed() const override;
    bool NeedsRebuild() const override;

    // Tell the desktop shell to display this menu
    void OpenMenu();

    // Normally called via the shell, but it's public so that child
    // menuitems can do the shells work. Sigh....
    void OnClose();

private:
    friend class nsMenuContentInsertedEvent;
    friend class nsMenuContentRemovedEvent;

    enum EPopupState {
        ePopupState_Closed,
        ePopupState_Showing,
        ePopupState_Open,
        ePopupState_Hiding
    };

    void SetPopupState(EPopupState aState);

    static void DoOpenCallback(nsITimer *aTimer, void *aClosure);
    static void menu_event_cb(DbusmenuMenuitem *menu,
                              const gchar *name,
                              GVariant *value,
                              guint timestamp,
                              gpointer user_data);

    // We add a placeholder item to empty menus so that Unity actually treats
    // us as a proper menu, rather than a menuitem without a submenu
    void MaybeAddPlaceholderItem();

    // Removes a placeholder item if it exists and asserts that this succeeds
    void EnsureNoPlaceholderItem();

    void OnOpen();
    void Build();
    void InitializePopup();
    void RemoveChildAt(size_t aIndex);
    void RemoveChild(nsIContent *aChild);
    void InsertChildAfter(mozilla::UniquePtr<nsMenuObject> aChild,
                          nsIContent *aPrevSibling);
    void AppendChild(mozilla::UniquePtr<nsMenuObject> aChild);
    bool IsInBatchedUpdate() const;
    void StructureMutated();
    bool CanOpen() const;

    void HandleContentInserted(nsIContent *aContainer,
                               nsIContent *aChild,
                               nsIContent *aPrevSibling);
    void HandleContentRemoved(nsIContent *aContainer,
                              nsIContent *aChild);

    void InitializeNativeData() override;
    void Update(const mozilla::ComputedStyle *aComputedStyle) override;
    nsMenuObject::PropertyFlags SupportedProperties() const override;

    void OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute) override;
    void OnContentInserted(nsIContent *aContainer, nsIContent *aChild,
                           nsIContent *aPrevSibling) override;
    void OnContentRemoved(nsIContent *aContainer, nsIContent *aChild) override;
    void OnBeginUpdates(nsIContent *aContent) override;
    void OnEndUpdates() override;

    bool mNeedsRebuild;
    bool mNeedsUpdate;

    DbusmenuMenuitem *mPlaceholderItem;

    EPopupState mPopupState;

    enum EBatchedUpdateState {
        eBatchedUpdateState_Inactive,
        eBatchedUpdateState_Active,
        eBatchedUpdateState_DidMutate
    };

    EBatchedUpdateState mBatchedUpdateState;

    nsCOMPtr<nsIContent> mPopupContent;

    nsCOMPtr<nsITimer> mOpenDelayTimer;
};

#endif /* __nsMenu_h__ */
