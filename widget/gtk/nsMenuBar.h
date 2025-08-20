/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenuBar_h__
#define __nsMenuBar_h__

#include "mozilla/Attributes.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsString.h"

#include "nsDbusmenu.h"
#include "nsMenuContainer.h"
#include "nsMenuObject.h"

#include <gtk/gtk.h>

class nsIContent;
class nsIWidget;
class nsMenuBarDocEventListener;

namespace mozilla {
namespace dom {
class Document;
class KeyboardEvent;
}
}

/*
 * The menubar class. There is one of these per window (and the window
 * owns its menubar). Each menubar has an object path, and the service is
 * responsible for telling the desktop shell which object path corresponds
 * to a particular window. A menubar and its hierarchy also own a
 * nsNativeMenuDocListener.
 */
class nsMenuBar final : public nsMenuContainer
{
public:
    ~nsMenuBar() override;

    static mozilla::UniquePtr<nsMenuBar> Create(nsIWidget *aParent,
                                                nsIContent *aMenuBarNode);

    nsMenuObject::EType Type() const override;

    bool IsBeingDisplayed() const override;

    // Get the native window ID for this menubar
    uint32_t WindowId() const;

    // Get the object path for this menubar
    nsCString ObjectPath() const;

    // Get the top-level GtkWindow handle
    GtkWidget* TopLevelWindow() { return mTopLevel; }

    // Called from the menuservice when the menubar is about to be registered.
    // Causes the native menubar to be created, and the XUL menubar to be hidden
    void Activate();

    // Called from the menuservice when the menubar is no longer registered
    // with the desktop shell. Will cause the XUL menubar to be shown again
    void Deactivate();

private:
    class DocEventListener;
    friend class nsMenuBarContentInsertedEvent;
    friend class nsMenuBarContentRemovedEvent;

    enum ModifierFlags {
        eModifierShift = (1 << 0),
        eModifierCtrl = (1 << 1),
        eModifierAlt = (1 << 2),
        eModifierMeta = (1 << 3)
    };

    nsMenuBar(nsIContent *aMenuBarNode);
    nsresult Init(nsIWidget *aParent);
    void Build();
    void DisconnectDocumentEventListeners();
    void SetShellShowingMenuBar(bool aShowing);
    void Focus();
    void Blur();
    ModifierFlags GetModifiersFromEvent(mozilla::dom::KeyboardEvent *aEvent);
    nsresult Keypress(mozilla::dom::KeyboardEvent *aEvent);
    nsresult KeyDown(mozilla::dom::KeyboardEvent *aEvent);
    nsresult KeyUp(mozilla::dom::KeyboardEvent *aEvent);

    void HandleContentInserted(nsIContent *aChild,
                               nsIContent *aPrevSibling);
    void HandleContentRemoved(nsIContent *aChild);

    void OnContentInserted(nsIContent *aContainer, nsIContent *aChild,
                           nsIContent *aPrevSibling) override;
    void OnContentRemoved(nsIContent *aContainer, nsIContent *aChild) override;

    GtkWidget *mTopLevel;
    DbusmenuServer *mServer;
    nsCOMPtr<mozilla::dom::Document> mDocument;
    RefPtr<DocEventListener> mEventListener;

    uint32_t mAccessKey;
    ModifierFlags mAccessKeyMask;
    bool mIsActive;
};

#endif /* __nsMenuBar_h__ */
