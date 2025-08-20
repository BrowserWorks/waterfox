/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenuObject_h__
#define __nsMenuObject_h__

#include "mozilla/Attributes.h"
#include "mozilla/ComputedStyleInlines.h"
#include "nsCOMPtr.h"

#include "nsDbusmenu.h"
#include "nsNativeMenuDocListener.h"

class nsIContent;
class nsMenuContainer;
class nsMenuObjectIconLoader;

#define DBUSMENU_PROPERTIES \
    DBUSMENU_PROPERTY(Label, DBUSMENU_MENUITEM_PROP_LABEL, 0) \
    DBUSMENU_PROPERTY(Enabled, DBUSMENU_MENUITEM_PROP_ENABLED, 1) \
    DBUSMENU_PROPERTY(Visible, DBUSMENU_MENUITEM_PROP_VISIBLE, 2) \
    DBUSMENU_PROPERTY(IconData, DBUSMENU_MENUITEM_PROP_ICON_DATA, 3) \
    DBUSMENU_PROPERTY(Type, DBUSMENU_MENUITEM_PROP_TYPE, 4) \
    DBUSMENU_PROPERTY(Shortcut, DBUSMENU_MENUITEM_PROP_SHORTCUT, 5) \
    DBUSMENU_PROPERTY(ToggleType, DBUSMENU_MENUITEM_PROP_TOGGLE_TYPE, 6) \
    DBUSMENU_PROPERTY(ToggleState, DBUSMENU_MENUITEM_PROP_TOGGLE_STATE, 7) \
    DBUSMENU_PROPERTY(ChildDisplay, DBUSMENU_MENUITEM_PROP_CHILD_DISPLAY, 8)

/*
 * This is the base class for all menu nodes. Each instance represents
 * a single node in the menu hierarchy. It wraps the corresponding DOM node and
 * native menu node, keeps them in sync and transfers events between the two.
 * It is not reference counted - each node is owned by its parent (the top
 * level menubar is owned by the window) and keeps a weak pointer to its
 * parent (which is guaranteed to always be valid because a node will never
 * outlive its parent). It is not safe to keep a reference to nsMenuObject
 * externally.
 */
class nsMenuObject : public nsNativeMenuChangeObserver
{
public:
    enum EType {
        eType_MenuBar,
        eType_Menu,
        eType_MenuItem
    };

    virtual ~nsMenuObject();

    // Get the native menu item node
    DbusmenuMenuitem* GetNativeData() const { return mNativeData; }

    // Get the parent menu object
    nsMenuContainer* Parent() const { return mParent; }

    // Get the content node
    nsIContent* ContentNode() const { return mContent; }

    // Get the type of this node. Must be provided by subclasses
    virtual EType Type() const = 0;

    // Get the document listener
    nsNativeMenuDocListener* DocListener() const { return mListener; }

    // Create the native menu item node (called by containers)
    void CreateNativeData();

    // Adopt the specified native menu item node (called by containers)
    nsresult AdoptNativeData(DbusmenuMenuitem *aNativeData);

    // Called by the container to tell us that it's opening
    void ContainerIsOpening();

protected:
    nsMenuObject(nsMenuContainer *aParent, nsIContent *aContent);
    nsMenuObject(nsNativeMenuDocListener *aListener, nsIContent *aContent);

    enum PropertyFlags {
#define DBUSMENU_PROPERTY(e, s, b) eProp##e = (1 << b),
        DBUSMENU_PROPERTIES
#undef DBUSMENU_PROPERTY
    };

    void UpdateLabel();
    void UpdateVisibility(const mozilla::ComputedStyle *aComputedStyle);
    void UpdateSensitivity();
    void UpdateIcon(const mozilla::ComputedStyle *aComputedStyle);

    already_AddRefed<const mozilla::ComputedStyle> GetComputedStyle();

private:
    friend class nsMenuObjectIconLoader;

    // Set up initial properties on the native data, connect to signals etc.
    // This should be implemented by subclasses
    virtual void InitializeNativeData();

    // Return the properties that this menu object type supports
    // This should be implemented by subclasses
    virtual PropertyFlags SupportedProperties() const;

    // Determine whether this menu object could use the specified
    // native item. Returns true by default but can be overridden by subclasses
    virtual bool
    IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const;

    // Update attributes on this objects content node when the container opens.
    // This is called before style resolution, and should be implemented by
    // subclasses who want to modify attributes that might affect style.
    // This will not be called when there are script blockers
    virtual void UpdateContentAttributes();

    // Update properties that should be refreshed when the container opens.
    // This should be implemented by subclasses that have properties which
    // need refreshing
    virtual void Update(const mozilla::ComputedStyle *aComputedStyle);

    bool ShouldShowIcon() const;
    void ClearIcon();

    nsCOMPtr<nsIContent> mContent;
    // mListener is a strong ref for simplicity - someone in the tree needs to
    // own it, and this only really needs to be the top-level object (as no
    // children outlives their parent). However, we need to keep it alive until
    // after running the nsMenuObject destructor for the top-level menu object,
    // hence the strong ref
    RefPtr<nsNativeMenuDocListener> mListener;
    nsMenuContainer *mParent; // [weak]
    DbusmenuMenuitem *mNativeData; // [strong]
    RefPtr<nsMenuObjectIconLoader> mIconLoader;
};

// Keep a weak pointer to a menu object
class nsWeakMenuObject
{
public:
    nsWeakMenuObject() : mPrev(nullptr), mMenuObject(nullptr) {}

    nsWeakMenuObject(nsMenuObject *aMenuObject) :
        mPrev(nullptr), mMenuObject(aMenuObject)
    {
        AddWeakReference(this);
    }

    ~nsWeakMenuObject() { RemoveWeakReference(this); }

    nsMenuObject* get() const { return mMenuObject; }

    nsMenuObject* operator->() const { return mMenuObject; }

    explicit operator bool() const { return !!mMenuObject; }

    static void NotifyDestroyed(nsMenuObject *aMenuObject);

private:
    static void AddWeakReference(nsWeakMenuObject *aWeak);
    static void RemoveWeakReference(nsWeakMenuObject *aWeak);

    nsWeakMenuObject *mPrev;
    static nsWeakMenuObject *sHead;

    nsMenuObject *mMenuObject;
};

#endif /* __nsMenuObject_h__ */
