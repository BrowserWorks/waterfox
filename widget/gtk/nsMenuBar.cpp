/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/Assertions.h"
#include "mozilla/DebugOnly.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/Event.h"
#include "mozilla/dom/KeyboardEvent.h"
#include "mozilla/dom/KeyboardEventBinding.h"
#include "mozilla/Preferences.h"
#include "nsContentUtils.h"
#include "nsIDOMEventListener.h"
#include "nsIRunnable.h"
#include "nsIWidget.h"
#include "nsTArray.h"
#include "nsUnicharUtils.h"

#include "nsMenu.h"
#include "nsNativeMenuService.h"

#include <gdk/gdk.h>
#include <gdk/gdkx.h>
#include <glib.h>
#include <glib-object.h>

#include "nsMenuBar.h"

using namespace mozilla;

static bool
ShouldHandleKeyEvent(dom::KeyboardEvent *aEvent)
{
    return !aEvent->DefaultPrevented() && aEvent->IsTrusted();
}

class nsMenuBarContentInsertedEvent : public Runnable
{
public:
    nsMenuBarContentInsertedEvent(nsMenuBar *aMenuBar,
                                  nsIContent *aChild,
                                  nsIContent *aPrevSibling) :
        Runnable("nsMenuBarContentInsertedEvent"),
        mWeakMenuBar(aMenuBar),
        mChild(aChild),
        mPrevSibling(aPrevSibling) { }

    NS_IMETHODIMP Run()
    {
        if (!mWeakMenuBar) {
            return NS_OK;
        }

        static_cast<nsMenuBar *>(mWeakMenuBar.get())->HandleContentInserted(mChild,
                                                                            mPrevSibling);
        return NS_OK;
    }

private:
    nsWeakMenuObject mWeakMenuBar;

    nsCOMPtr<nsIContent> mChild;
    nsCOMPtr<nsIContent> mPrevSibling;
};

class nsMenuBarContentRemovedEvent : public Runnable
{
public:
    nsMenuBarContentRemovedEvent(nsMenuBar *aMenuBar,
                                 nsIContent *aChild) :
        Runnable("nsMenuBarContentRemovedEvent"),
        mWeakMenuBar(aMenuBar),
        mChild(aChild) { }

    NS_IMETHODIMP Run()
    {
        if (!mWeakMenuBar) {
            return NS_OK;
        }

        static_cast<nsMenuBar *>(mWeakMenuBar.get())->HandleContentRemoved(mChild);
        return NS_OK;
    }

private:
    nsWeakMenuObject mWeakMenuBar;

    nsCOMPtr<nsIContent> mChild;
};

class nsMenuBar::DocEventListener final : public nsIDOMEventListener
{
public:
    NS_DECL_ISUPPORTS
    NS_DECL_NSIDOMEVENTLISTENER

    DocEventListener(nsMenuBar *aOwner) : mOwner(aOwner) { };

private:
    ~DocEventListener() { };

    nsMenuBar *mOwner;
};

NS_IMPL_ISUPPORTS(nsMenuBar::DocEventListener, nsIDOMEventListener)

NS_IMETHODIMP
nsMenuBar::DocEventListener::HandleEvent(dom::Event *aEvent)
{
    nsAutoString type;
    aEvent->GetType(type);

    if (type.Equals(u"focus"_ns)) {
        mOwner->Focus();
    } else if (type.Equals(u"blur"_ns)) {
        mOwner->Blur();
    }

    RefPtr<dom::KeyboardEvent> keyEvent = aEvent->AsKeyboardEvent();
    if (!keyEvent) {
        return NS_OK;
    }

    if (type.Equals(u"keypress"_ns)) {
        return mOwner->Keypress(keyEvent);
    } else if (type.Equals(u"keydown"_ns)) {
        return mOwner->KeyDown(keyEvent);
    } else if (type.Equals(u"keyup"_ns)) {
        return mOwner->KeyUp(keyEvent);
    }

    return NS_OK;
}

nsMenuBar::nsMenuBar(nsIContent *aMenuBarNode) :
    nsMenuContainer(new nsNativeMenuDocListener(aMenuBarNode), aMenuBarNode),
    mTopLevel(nullptr),
    mServer(nullptr),
    mIsActive(false)
{
    MOZ_COUNT_CTOR(nsMenuBar);
}

nsresult
nsMenuBar::Init(nsIWidget *aParent)
{
    MOZ_ASSERT(aParent);

    GdkWindow *gdkWin = static_cast<GdkWindow *>(
        aParent->GetNativeData(NS_NATIVE_WINDOW));
    if (!gdkWin) {
        return NS_ERROR_FAILURE;
    }

    gpointer user_data = nullptr;
    gdk_window_get_user_data(gdkWin, &user_data);
    if (!user_data || !GTK_IS_CONTAINER(user_data)) {
        return NS_ERROR_FAILURE;
    }

    mTopLevel = gtk_widget_get_toplevel(GTK_WIDGET(user_data));
    if (!mTopLevel) {
        return NS_ERROR_FAILURE;
    }

    g_object_ref(mTopLevel);

    nsAutoCString path;
    path.Append("/com/canonical/menu/"_ns);
    char xid[10];
    sprintf(xid, "%X", static_cast<uint32_t>(
        GDK_WINDOW_XID(gtk_widget_get_window(mTopLevel))));
    path.Append(xid);

    mServer = dbusmenu_server_new(path.get());
    if (!mServer) {
        return NS_ERROR_FAILURE;
    }

    CreateNativeData();
    if (!GetNativeData()) {
        return NS_ERROR_FAILURE;
    }

    dbusmenu_server_set_root(mServer, GetNativeData());

    mEventListener = new DocEventListener(this);

    mDocument = ContentNode()->OwnerDoc();

    mAccessKey = Preferences::GetInt("ui.key.menuAccessKey");
    if (mAccessKey == dom::KeyboardEvent_Binding::DOM_VK_SHIFT) {
        mAccessKeyMask = eModifierShift;
    } else if (mAccessKey == dom::KeyboardEvent_Binding::DOM_VK_CONTROL) {
        mAccessKeyMask = eModifierCtrl;
    } else if (mAccessKey == dom::KeyboardEvent_Binding::DOM_VK_ALT) {
        mAccessKeyMask = eModifierAlt;
    } else if (mAccessKey == dom::KeyboardEvent_Binding::DOM_VK_META) {
        mAccessKeyMask = eModifierMeta;
    } else {
        mAccessKeyMask = eModifierAlt;
    }

    return NS_OK;
}

void
nsMenuBar::Build()
{
    uint32_t count = ContentNode()->GetChildCount();
    for (uint32_t i = 0; i < count; ++i) {
        nsIContent *childContent = ContentNode()->GetChildAt_Deprecated(i);

        UniquePtr<nsMenuObject> child = CreateChild(childContent);

        if (!child) {
            continue;
        }

        AppendChild(std::move(child));
    }
}

void
nsMenuBar::DisconnectDocumentEventListeners()
{
    mDocument->RemoveEventListener(u"focus"_ns,
                                   mEventListener,
                                   true);
    mDocument->RemoveEventListener(u"blur"_ns,
                                   mEventListener,
                                   true);
    mDocument->RemoveEventListener(u"keypress"_ns,
                                   mEventListener,
                                   false);
    mDocument->RemoveEventListener(u"keydown"_ns,
                                   mEventListener,
                                   false);
    mDocument->RemoveEventListener(u"keyup"_ns,
                                   mEventListener,
                                   false);
}

void
nsMenuBar::SetShellShowingMenuBar(bool aShowing)
{
    ContentNode()->OwnerDoc()->GetRootElement()->SetAttr(
        kNameSpaceID_None, nsGkAtoms::shellshowingmenubar,
        aShowing ? u"true"_ns : u"false"_ns,
        true);
}

void
nsMenuBar::Focus()
{
    ContentNode()->AsElement()->SetAttr(kNameSpaceID_None,
                                        nsGkAtoms::openedwithkey,
                                        u"false"_ns, true);
}

void
nsMenuBar::Blur()
{
    // We do this here in case we lose focus before getting the
    // keyup event, which leaves the menubar state looking like
    // the alt key is stuck down
    dbusmenu_server_set_status(mServer, DBUSMENU_STATUS_NORMAL);
}

nsMenuBar::ModifierFlags
nsMenuBar::GetModifiersFromEvent(dom::KeyboardEvent *aEvent)
{
    ModifierFlags modifiers = static_cast<ModifierFlags>(0);

    if (aEvent->AltKey()) {
        modifiers = static_cast<ModifierFlags>(modifiers | eModifierAlt);
    }

    if (aEvent->ShiftKey()) {
        modifiers = static_cast<ModifierFlags>(modifiers | eModifierShift);
    }

    if (aEvent->CtrlKey()) {
        modifiers = static_cast<ModifierFlags>(modifiers | eModifierCtrl);
    }

    if (aEvent->MetaKey()) {
        modifiers = static_cast<ModifierFlags>(modifiers | eModifierMeta);
    }

    return modifiers;
}

nsresult
nsMenuBar::Keypress(dom::KeyboardEvent *aEvent)
{
    if (!ShouldHandleKeyEvent(aEvent)) {
        return NS_OK;
    }

    ModifierFlags modifiers = GetModifiersFromEvent(aEvent);
    if (((modifiers & mAccessKeyMask) == 0) ||
        ((modifiers & ~mAccessKeyMask) != 0)) {
        return NS_OK;
    }

    uint32_t charCode = aEvent->CharCode();
    if (charCode == 0) {
        return NS_OK;
    }

    char16_t ch = char16_t(charCode);
    char16_t chl = ToLowerCase(ch);
    char16_t chu = ToUpperCase(ch);

    nsMenuObject *found = nullptr;
    uint32_t count = ChildCount();
    for (uint32_t i = 0; i < count; ++i) {
        nsAutoString accesskey;
        ChildAt(i)->ContentNode()->AsElement()->GetAttr(kNameSpaceID_None,
                                                        nsGkAtoms::accesskey,
                                                        accesskey);
        const nsAutoString::char_type *key = accesskey.BeginReading();
        if (*key == chu || *key == chl) {
            found = ChildAt(i);
            break;
        }
    }

    if (!found || found->Type() != nsMenuObject::eType_Menu) {
        return NS_OK;
    }

    ContentNode()->AsElement()->SetAttr(kNameSpaceID_None,
                                        nsGkAtoms::openedwithkey,
                                        u"true"_ns, true);
    static_cast<nsMenu *>(found)->OpenMenu();

    aEvent->StopPropagation();
    aEvent->PreventDefault();

    return NS_OK;
}

nsresult
nsMenuBar::KeyDown(dom::KeyboardEvent *aEvent)
{
    if (!ShouldHandleKeyEvent(aEvent)) {
        return NS_OK;
    }

    uint32_t keyCode = aEvent->KeyCode();
    ModifierFlags modifiers = GetModifiersFromEvent(aEvent);
    if ((keyCode != mAccessKey) || ((modifiers & ~mAccessKeyMask) != 0)) {
        return NS_OK;
    }

    dbusmenu_server_set_status(mServer, DBUSMENU_STATUS_NOTICE);

    return NS_OK;
}

nsresult
nsMenuBar::KeyUp(dom::KeyboardEvent *aEvent)
{
    if (!ShouldHandleKeyEvent(aEvent)) {
        return NS_OK;
    }

    uint32_t keyCode = aEvent->KeyCode();
    if (keyCode == mAccessKey) {
        dbusmenu_server_set_status(mServer, DBUSMENU_STATUS_NORMAL);
    }

    return NS_OK;
}

void
nsMenuBar::HandleContentInserted(nsIContent *aChild, nsIContent *aPrevSibling)
{
    UniquePtr<nsMenuObject> child = CreateChild(aChild);

    if (!child) {
        return;
    }

    InsertChildAfter(std::move(child), aPrevSibling);
}

void
nsMenuBar::HandleContentRemoved(nsIContent *aChild)
{
    RemoveChild(aChild);
}

void
nsMenuBar::OnContentInserted(nsIContent *aContainer, nsIContent *aChild,
                             nsIContent *aPrevSibling)
{
    MOZ_ASSERT(aContainer == ContentNode(),
               "Received an event that wasn't meant for us");

    nsContentUtils::AddScriptRunner(
        new nsMenuBarContentInsertedEvent(this, aChild, aPrevSibling));
}

void
nsMenuBar::OnContentRemoved(nsIContent *aContainer, nsIContent *aChild)
{
    MOZ_ASSERT(aContainer == ContentNode(),
               "Received an event that wasn't meant for us");

    nsContentUtils::AddScriptRunner(
        new nsMenuBarContentRemovedEvent(this, aChild));
}

nsMenuBar::~nsMenuBar()
{
    nsNativeMenuService *service = nsNativeMenuService::GetSingleton();
    if (service) {
        service->NotifyNativeMenuBarDestroyed(this);
    }

    if (ContentNode()) {
        SetShellShowingMenuBar(false);
    }

    // We want to destroy all children before dropping our reference
    // to the doc listener
    while (ChildCount() > 0) {
        RemoveChildAt(0);
    }

    if (mTopLevel) {
        g_object_unref(mTopLevel);
    }

    if (DocListener()) {
        DocListener()->Stop();
    }

    if (mDocument) {
        DisconnectDocumentEventListeners();
    }

    if (mServer) {
        g_object_unref(mServer);
    }

    MOZ_COUNT_DTOR(nsMenuBar);
}

/* static */ UniquePtr<nsMenuBar>
nsMenuBar::Create(nsIWidget *aParent, nsIContent *aMenuBarNode)
{
    UniquePtr<nsMenuBar> menubar(new nsMenuBar(aMenuBarNode));
    if (NS_FAILED(menubar->Init(aParent))) {
        return nullptr;
    }

    return menubar;
}

nsMenuObject::EType
nsMenuBar::Type() const
{
    return eType_MenuBar;
}

bool
nsMenuBar::IsBeingDisplayed() const
{
    return true;
}

uint32_t
nsMenuBar::WindowId() const
{
    return static_cast<uint32_t>(GDK_WINDOW_XID(gtk_widget_get_window(mTopLevel)));
}

nsCString
nsMenuBar::ObjectPath() const
{
    gchar *tmp;
    g_object_get(mServer, DBUSMENU_SERVER_PROP_DBUS_OBJECT, &tmp, NULL);

    nsCString result;
    result.Adopt(tmp);

    return result;
}

void
nsMenuBar::Activate()
{
    if (mIsActive) {
        return;
    }

    mIsActive = true;

    mDocument->AddEventListener(u"focus"_ns,
                                mEventListener,
                                true);
    mDocument->AddEventListener(u"blur"_ns,
                                mEventListener,
                                true);
    mDocument->AddEventListener(u"keypress"_ns,
                                mEventListener,
                                false);
    mDocument->AddEventListener(u"keydown"_ns,
                                mEventListener,
                                false);
    mDocument->AddEventListener(u"keyup"_ns,
                                mEventListener,
                                false);

    // Clear this. Not sure if we really need to though
    ContentNode()->AsElement()->SetAttr(kNameSpaceID_None,
                                        nsGkAtoms::openedwithkey,
                                        u"false"_ns, true);

    DocListener()->Start();
    Build();
    SetShellShowingMenuBar(true);
}

void
nsMenuBar::Deactivate()
{
    if (!mIsActive) {
        return;
    }

    mIsActive = false;

    SetShellShowingMenuBar(false);
    while (ChildCount() > 0) {
        RemoveChildAt(0);
    }
    DocListener()->Stop();
    DisconnectDocumentEventListeners();
}
