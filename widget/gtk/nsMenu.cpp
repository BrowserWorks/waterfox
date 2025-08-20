/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#define _IMPL_NS_LAYOUT

#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/Assertions.h"
#include "mozilla/ComputedStyleInlines.h"
#include "mozilla/EventDispatcher.h"
#include "mozilla/MouseEvents.h"
#include "mozilla/PresShell.h"
#include "mozilla/PresShellInlines.h"
#include "nsComponentManagerUtils.h"
#include "nsContentUtils.h"
#include "nsCSSValue.h"
#include "nsGkAtoms.h"
#include "nsGtkUtils.h"
#include "nsAtom.h"
#include "nsIContent.h"
#include "nsIRunnable.h"
#include "nsITimer.h"
#include "nsString.h"
#include "nsStyleStruct.h"
#include "nsThreadUtils.h"

#include "nsNativeMenuDocListener.h"

#include <glib-object.h>

#include "nsMenu.h"

using namespace mozilla;

class nsMenuContentInsertedEvent : public Runnable
{
public:
    nsMenuContentInsertedEvent(nsMenu *aMenu,
                               nsIContent *aContainer,
                               nsIContent *aChild,
                               nsIContent *aPrevSibling) :
        Runnable("nsMenuContentInsertedEvent"),
        mWeakMenu(aMenu),
        mContainer(aContainer),
        mChild(aChild),
        mPrevSibling(aPrevSibling) { }

    NS_IMETHODIMP Run()
    {
        if (!mWeakMenu) {
            return NS_OK;
        }

        static_cast<nsMenu *>(mWeakMenu.get())->HandleContentInserted(mContainer,
                                                                      mChild,
                                                                      mPrevSibling);
        return NS_OK;
    }

private:
    nsWeakMenuObject mWeakMenu;

    nsCOMPtr<nsIContent> mContainer;
    nsCOMPtr<nsIContent> mChild;
    nsCOMPtr<nsIContent> mPrevSibling;
};

class nsMenuContentRemovedEvent : public Runnable
{
public:
    nsMenuContentRemovedEvent(nsMenu *aMenu,
                              nsIContent *aContainer,
                              nsIContent *aChild) :
        Runnable("nsMenuContentRemovedEvent"),
        mWeakMenu(aMenu),
        mContainer(aContainer),
        mChild(aChild) { }

    NS_IMETHODIMP Run()
    {
        if (!mWeakMenu) {
            return NS_OK;
        }

        static_cast<nsMenu *>(mWeakMenu.get())->HandleContentRemoved(mContainer,
                                                                     mChild);
        return NS_OK;
    }

private:
    nsWeakMenuObject mWeakMenu;

    nsCOMPtr<nsIContent> mContainer;
    nsCOMPtr<nsIContent> mChild;
};

static void
DispatchMouseEvent(nsIContent *aTarget, mozilla::EventMessage aMsg)
{
    if (!aTarget) {
        return;
    }

    WidgetMouseEvent event(true, aMsg, nullptr, WidgetMouseEvent::eReal);
    EventDispatcher::Dispatch(aTarget, nullptr, &event);
}

void
nsMenu::SetPopupState(EPopupState aState)
{
    mPopupState = aState;

    if (!mPopupContent) {
        return;
    }

    nsAutoString state;
    switch (aState) {
        case ePopupState_Showing:
            state.Assign(u"showing"_ns);
            break;
        case ePopupState_Open:
            state.Assign(u"open"_ns);
            break;
        case ePopupState_Hiding:
            state.Assign(u"hiding"_ns);
            break;
        default:
            break;
    }

    if (state.IsEmpty()) {
        mPopupContent->AsElement()->UnsetAttr(
            kNameSpaceID_None, nsGkAtoms::_moz_nativemenupopupstate,
            false);
    } else {
        mPopupContent->AsElement()->SetAttr(
            kNameSpaceID_None, nsGkAtoms::_moz_nativemenupopupstate,
            state, false);
    }
}

/* static */ void
nsMenu::DoOpenCallback(nsITimer *aTimer, void *aClosure)
{
    nsMenu* self = static_cast<nsMenu *>(aClosure);

    dbusmenu_menuitem_show_to_user(self->GetNativeData(), 0);

    self->mOpenDelayTimer = nullptr;
}

/* static */ void
nsMenu::menu_event_cb(DbusmenuMenuitem *menu,
                      const gchar *name,
                      GVariant *value,
                      guint timestamp,
                      gpointer user_data)
{
    nsMenu *self = static_cast<nsMenu *>(user_data);

    nsAutoCString event(name);

    if (event.Equals("closed"_ns)) {
        self->OnClose();
        return;
    }

    if (event.Equals("opened"_ns)) {
        self->OnOpen();
        return;
    }
}

void
nsMenu::MaybeAddPlaceholderItem()
{
    MOZ_ASSERT(!IsInBatchedUpdate(),
               "Shouldn't be modifying the native menu structure now");

    GList *children = dbusmenu_menuitem_get_children(GetNativeData());
    if (!children) {
        MOZ_ASSERT(!mPlaceholderItem);

        mPlaceholderItem = dbusmenu_menuitem_new();
        if (!mPlaceholderItem) {
            return;
        }

        dbusmenu_menuitem_property_set_bool(mPlaceholderItem,
                                            DBUSMENU_MENUITEM_PROP_VISIBLE,
                                            false);

        MOZ_ALWAYS_TRUE(
            dbusmenu_menuitem_child_append(GetNativeData(), mPlaceholderItem));
    }
}

void
nsMenu::EnsureNoPlaceholderItem()
{
    MOZ_ASSERT(!IsInBatchedUpdate(),
               "Shouldn't be modifying the native menu structure now");

    if (!mPlaceholderItem) {
        return;
    }

    MOZ_ALWAYS_TRUE(
        dbusmenu_menuitem_child_delete(GetNativeData(), mPlaceholderItem));
    MOZ_ASSERT(!dbusmenu_menuitem_get_children(GetNativeData()));

    g_object_unref(mPlaceholderItem);
    mPlaceholderItem = nullptr;
}

void
nsMenu::OnOpen()
{
    if (mNeedsRebuild) {
        Build();
    }

    nsWeakMenuObject self(this);
    nsCOMPtr<nsIContent> origPopupContent(mPopupContent);
    {
        nsNativeMenuDocListener::BlockUpdatesScope updatesBlocker;

        SetPopupState(ePopupState_Showing);
        DispatchMouseEvent(mPopupContent, eXULPopupShowing);

        ContentNode()->AsElement()->SetAttr(kNameSpaceID_None, nsGkAtoms::open,
                                            u"true"_ns, true);
    }

    if (!self) {
        // We were deleted!
        return;
    }

    // I guess that the popup could have changed
    if (origPopupContent != mPopupContent) {
        return;
    }

    nsNativeMenuDocListener::BlockUpdatesScope updatesBlocker;

    size_t count = ChildCount();
    for (size_t i = 0; i < count; ++i) {
        ChildAt(i)->ContainerIsOpening();
    }

    SetPopupState(ePopupState_Open);
    DispatchMouseEvent(mPopupContent, eXULPopupShown);
}

void
nsMenu::Build()
{
    mNeedsRebuild = false;

    while (ChildCount() > 0) {
        RemoveChildAt(0);
    }

    InitializePopup();

    if (!mPopupContent) {
        return;
    }

    uint32_t count = mPopupContent->GetChildCount();
    for (uint32_t i = 0; i < count; ++i) {
        nsIContent *childContent = mPopupContent->GetChildAt_Deprecated(i);

        UniquePtr<nsMenuObject> child = CreateChild(childContent);

        if (!child) {
            continue;
        }

        AppendChild(std::move(child));
    }
}

void
nsMenu::InitializePopup()
{
    nsCOMPtr<nsIContent> oldPopupContent;
    oldPopupContent.swap(mPopupContent);

    for (uint32_t i = 0; i < ContentNode()->GetChildCount(); ++i) {
        nsIContent *child = ContentNode()->GetChildAt_Deprecated(i);

        if (child->NodeInfo()->NameAtom() == nsGkAtoms::menupopup) {
            mPopupContent = child;
            break;
        }
    }

    if (oldPopupContent == mPopupContent) {
        return;
    }

    // The popup has changed

    if (oldPopupContent) {
        DocListener()->UnregisterForContentChanges(oldPopupContent);
    }

    SetPopupState(ePopupState_Closed);

    if (!mPopupContent) {
        return;
    }

    DocListener()->RegisterForContentChanges(mPopupContent, this);
}

void
nsMenu::RemoveChildAt(size_t aIndex)
{
    MOZ_ASSERT(IsInBatchedUpdate() || !mPlaceholderItem,
               "Shouldn't have a placeholder menuitem");

    nsMenuContainer::RemoveChildAt(aIndex, !IsInBatchedUpdate());
    StructureMutated();

    if (!IsInBatchedUpdate()) {
        MaybeAddPlaceholderItem();
    }
}

void
nsMenu::RemoveChild(nsIContent *aChild)
{
    size_t index = IndexOf(aChild);
    if (index == NoIndex) {
        return;
    }

    RemoveChildAt(index);
}

void
nsMenu::InsertChildAfter(UniquePtr<nsMenuObject> aChild,
                         nsIContent *aPrevSibling)
{
    if (!IsInBatchedUpdate()) {
        EnsureNoPlaceholderItem();
    }

    nsMenuContainer::InsertChildAfter(std::move(aChild), aPrevSibling,
                                      !IsInBatchedUpdate());
    StructureMutated();
}

void
nsMenu::AppendChild(UniquePtr<nsMenuObject> aChild)
{
    if (!IsInBatchedUpdate()) {
        EnsureNoPlaceholderItem();
    }

    nsMenuContainer::AppendChild(std::move(aChild), !IsInBatchedUpdate());
    StructureMutated();
}

bool
nsMenu::IsInBatchedUpdate() const
{
    return mBatchedUpdateState != eBatchedUpdateState_Inactive;
}

void
nsMenu::StructureMutated()
{
    if (!IsInBatchedUpdate()) {
        return;
    }

    mBatchedUpdateState = eBatchedUpdateState_DidMutate;
}

bool
nsMenu::CanOpen() const
{
    bool isVisible = dbusmenu_menuitem_property_get_bool(GetNativeData(),
                                                         DBUSMENU_MENUITEM_PROP_VISIBLE);
    bool isDisabled = ContentNode()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                              nsGkAtoms::disabled,
                                                              nsGkAtoms::_true,
                                                              eCaseMatters);

    return (isVisible && !isDisabled);
}

void
nsMenu::HandleContentInserted(nsIContent *aContainer,
                              nsIContent *aChild,
                              nsIContent *aPrevSibling)
{
    if (aContainer == mPopupContent) {
        UniquePtr<nsMenuObject> child = CreateChild(aChild);

        if (child) {
            InsertChildAfter(std::move(child), aPrevSibling);
        }
    } else {
        Build();
    }
}

void
nsMenu::HandleContentRemoved(nsIContent *aContainer, nsIContent *aChild)
{
    if (aContainer == mPopupContent) {
        RemoveChild(aChild);
    } else {
        Build();
    }
}

void
nsMenu::InitializeNativeData()
{
    // Dbusmenu provides an "about-to-show" signal, and also "opened" and
    // "closed" events. However, Unity is the only thing that sends
    // both "about-to-show" and "opened" events. Unity 2D and the HUD only
    // send "opened" events, so we ignore "about-to-show" (I don't think
    // there's any real difference between them anyway).
    // To complicate things, there are certain conditions where we don't
    // get a "closed" event, so we need to be able to handle this :/
    g_signal_connect(G_OBJECT(GetNativeData()), "event",
                     G_CALLBACK(menu_event_cb), this);

    mNeedsRebuild = true;
    mNeedsUpdate = true;

    MaybeAddPlaceholderItem();
}

void
nsMenu::Update(const ComputedStyle *aComputedStyle)
{
    if (mNeedsUpdate) {
        mNeedsUpdate = false;

        UpdateLabel();
        UpdateSensitivity();
    }

    UpdateVisibility(aComputedStyle);
    UpdateIcon(aComputedStyle);
}

nsMenuObject::PropertyFlags
nsMenu::SupportedProperties() const
{
    return static_cast<nsMenuObject::PropertyFlags>(
        nsMenuObject::ePropLabel |
        nsMenuObject::ePropEnabled |
        nsMenuObject::ePropVisible |
        nsMenuObject::ePropIconData |
        nsMenuObject::ePropChildDisplay
    );
}

void
nsMenu::OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute)
{
    MOZ_ASSERT(aContent == ContentNode() || aContent == mPopupContent,
               "Received an event that wasn't meant for us!");

    if (mNeedsUpdate) {
        return;
    }

    if (aContent != ContentNode()) {
        return;
    }

    if (!Parent()->IsBeingDisplayed()) {
        mNeedsUpdate = true;
        return;
    }

    if (aAttribute == nsGkAtoms::disabled) {
        UpdateSensitivity();
    } else if (aAttribute == nsGkAtoms::label ||
               aAttribute == nsGkAtoms::accesskey ||
               aAttribute == nsGkAtoms::crop) {
        UpdateLabel();
    } else if (aAttribute == nsGkAtoms::hidden ||
        aAttribute == nsGkAtoms::collapsed) {
        RefPtr<const ComputedStyle> style = GetComputedStyle();
        UpdateVisibility(style);
    } else if (aAttribute == nsGkAtoms::image) {
        RefPtr<const ComputedStyle> style = GetComputedStyle();
        UpdateIcon(style);
    }
}

void
nsMenu::OnContentInserted(nsIContent *aContainer, nsIContent *aChild,
                          nsIContent *aPrevSibling)
{
    MOZ_ASSERT(aContainer == ContentNode() || aContainer == mPopupContent,
               "Received an event that wasn't meant for us!");

    if (mNeedsRebuild) {
        return;
    }

    if (mPopupState == ePopupState_Closed) {
        mNeedsRebuild = true;
        return;
    }

    nsContentUtils::AddScriptRunner(
        new nsMenuContentInsertedEvent(this, aContainer, aChild,
                                       aPrevSibling));
}

void
nsMenu::OnContentRemoved(nsIContent *aContainer, nsIContent *aChild)
{
    MOZ_ASSERT(aContainer == ContentNode() || aContainer == mPopupContent,
               "Received an event that wasn't meant for us!");

    if (mNeedsRebuild) {
        return;
    }

    if (mPopupState == ePopupState_Closed) {
        mNeedsRebuild = true;
        return;
    }

    nsContentUtils::AddScriptRunner(
        new nsMenuContentRemovedEvent(this, aContainer, aChild));
}

/*
 * Some menus (eg, the History menu in Firefox) refresh themselves on
 * opening by removing all children and then re-adding new ones. As this
 * happens whilst the menu is opening in Unity, it causes some flickering
 * as the menu popup is resized multiple times. To avoid this, we try to
 * reuse native menu items when the menu structure changes during a
 * batched update. If we can handle menu structure changes from Gecko
 * just by updating properties of native menu items (rather than destroying
 * and creating new ones), then we eliminate any flickering that occurs as
 * the menu is opened. To do this, we don't modify any native menu items
 * until the end of the update batch.
 */

void
nsMenu::OnBeginUpdates(nsIContent *aContent)
{
    MOZ_ASSERT(aContent == ContentNode() || aContent == mPopupContent,
               "Received an event that wasn't meant for us!");
    MOZ_ASSERT(!IsInBatchedUpdate(), "Already in an update batch!");

    if (aContent != mPopupContent) {
        return;
    }

    mBatchedUpdateState = eBatchedUpdateState_Active;
}

void
nsMenu::OnEndUpdates()
{
    if (!IsInBatchedUpdate()) {
        return;
    }

    bool didMutate = mBatchedUpdateState == eBatchedUpdateState_DidMutate;
    mBatchedUpdateState = eBatchedUpdateState_Inactive;

    /* Optimize for the case where we only had attribute changes */
    if (!didMutate) {
        return;
    }

    EnsureNoPlaceholderItem();

    GList *nextNativeChild = dbusmenu_menuitem_get_children(GetNativeData());
    DbusmenuMenuitem *nextOwnedNativeChild = nullptr;

    size_t count = ChildCount();

    // Find the first native menu item that is `owned` by a corresponding
    // Gecko menuitem
    for (size_t i = 0; i < count; ++i) {
        if (ChildAt(i)->GetNativeData()) {
            nextOwnedNativeChild = ChildAt(i)->GetNativeData();
            break;
        }
    }

    // Now iterate over all Gecko menuitems
    for (size_t i = 0; i < count; ++i) {
        nsMenuObject *child = ChildAt(i);

        if (child->GetNativeData()) {
            // This child already has a corresponding native menuitem.
            // Remove all preceding orphaned native items. At this point, we
            // modify the native menu structure.
            while (nextNativeChild &&
                   nextNativeChild->data != nextOwnedNativeChild) {

                DbusmenuMenuitem *data =
                    static_cast<DbusmenuMenuitem *>(nextNativeChild->data);
                nextNativeChild = nextNativeChild->next;

                MOZ_ALWAYS_TRUE(dbusmenu_menuitem_child_delete(GetNativeData(),
                                                               data));
            }

            if (nextNativeChild) {
                nextNativeChild = nextNativeChild->next;
            }

            // Now find the next native menu item that is `owned`
            nextOwnedNativeChild = nullptr;
            for (size_t j = i + 1; j < count; ++j) {
                if (ChildAt(j)->GetNativeData()) {
                    nextOwnedNativeChild = ChildAt(j)->GetNativeData();
                    break;
                }
            }
        } else {
            // This child is new, and doesn't have a native menu item. Find one!
            if (nextNativeChild &&
                nextNativeChild->data != nextOwnedNativeChild) {

                DbusmenuMenuitem *data =
                    static_cast<DbusmenuMenuitem *>(nextNativeChild->data);

                if (NS_SUCCEEDED(child->AdoptNativeData(data))) {
                    nextNativeChild = nextNativeChild->next;
                }
            }

            // There wasn't a suitable one available, so create a new one.
            // At this point, we modify the native menu structure.
            if (!child->GetNativeData()) {
                child->CreateNativeData();
                MOZ_ALWAYS_TRUE(
                    dbusmenu_menuitem_child_add_position(GetNativeData(),
                                                         child->GetNativeData(),
                                                         i));
            }
        }
    }

    while (nextNativeChild) {
        DbusmenuMenuitem *data =
            static_cast<DbusmenuMenuitem *>(nextNativeChild->data);
        nextNativeChild = nextNativeChild->next;

        MOZ_ALWAYS_TRUE(dbusmenu_menuitem_child_delete(GetNativeData(), data));
    }

    MaybeAddPlaceholderItem();
}

nsMenu::nsMenu(nsMenuContainer *aParent, nsIContent *aContent) :
    nsMenuContainer(aParent, aContent),
    mNeedsRebuild(false),
    mNeedsUpdate(false),
    mPlaceholderItem(nullptr),
    mPopupState(ePopupState_Closed),
    mBatchedUpdateState(eBatchedUpdateState_Inactive)
{
    MOZ_COUNT_CTOR(nsMenu);
}

nsMenu::~nsMenu()
{
    if (IsInBatchedUpdate()) {
        OnEndUpdates();
    }

    // Although nsTArray will take care of this in its destructor,
    // we have to manually ensure children are removed from our native menu
    // item, just in case our parent recycles us
    while (ChildCount() > 0) {
        RemoveChildAt(0);
    }

    EnsureNoPlaceholderItem();

    if (DocListener() && mPopupContent) {
        DocListener()->UnregisterForContentChanges(mPopupContent);
    }

    if (GetNativeData()) {
        g_signal_handlers_disconnect_by_func(GetNativeData(),
                                             FuncToGpointer(menu_event_cb),
                                             this);
    }

    MOZ_COUNT_DTOR(nsMenu);
}

nsMenuObject::EType
nsMenu::Type() const
{
    return eType_Menu;
}

bool
nsMenu::IsBeingDisplayed() const
{
    return mPopupState == ePopupState_Open;
}

bool
nsMenu::NeedsRebuild() const
{
    return mNeedsRebuild;
}

void
nsMenu::OpenMenu()
{
    if (!CanOpen()) {
        return;
    }

    if (mOpenDelayTimer) {
        return;
    }

    // Here, we synchronously fire popupshowing and popupshown events and then
    // open the menu after a short delay. This allows the menu to refresh before
    // it's shown, and avoids an issue where keyboard focus is not on the first
    // item of the history menu in Firefox when opening it with the keyboard,
    // because extra items to appear at the top of the menu

    OnOpen();

    mOpenDelayTimer = NS_NewTimer();
    if (!mOpenDelayTimer) {
        return;
    }

    if (NS_FAILED(mOpenDelayTimer->InitWithNamedFuncCallback(DoOpenCallback,
                                                             this,
                                                             100,
                                                             nsITimer::TYPE_ONE_SHOT,
                                                             "nsMenu::DoOpenCallback"))) {
        mOpenDelayTimer = nullptr;
    }
}

void
nsMenu::OnClose()
{
    if (mPopupState == ePopupState_Closed) {
        return;
    }

    MOZ_ASSERT(nsContentUtils::IsSafeToRunScript());

    // We do this to avoid mutating our view of the menu until
    // after we have finished
    nsNativeMenuDocListener::BlockUpdatesScope updatesBlocker;

    SetPopupState(ePopupState_Hiding);
    DispatchMouseEvent(mPopupContent, eXULPopupHiding);

    // Sigh, make sure all of our descendants are closed, as we don't
    // always get closed events for submenus when scrubbing quickly through
    // the menu
    size_t count = ChildCount();
    for (size_t i = 0; i < count; ++i) {
        if (ChildAt(i)->Type() == nsMenuObject::eType_Menu) {
            static_cast<nsMenu *>(ChildAt(i))->OnClose();
        }
    }

    SetPopupState(ePopupState_Closed);
    DispatchMouseEvent(mPopupContent, eXULPopupHidden);

    ContentNode()->AsElement()->UnsetAttr(kNameSpaceID_None, nsGkAtoms::open,
                                          true);
}

