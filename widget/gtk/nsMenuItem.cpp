/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/ArrayUtils.h"
#include "mozilla/Assertions.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "mozilla/dom/KeyboardEventBinding.h"
#include "mozilla/dom/XULCommandEvent.h"
#include "mozilla/Preferences.h"
#include "mozilla/TextEvents.h"
#include "nsContentUtils.h"
#include "nsCRT.h"
#include "nsGkAtoms.h"
#include "nsGlobalWindowInner.h"
#include "nsGtkUtils.h"
#include "nsIContent.h"
#include "nsIRunnable.h"
#include "nsQueryObject.h"
#include "nsReadableUtils.h"
#include "nsString.h"
#include "nsThreadUtils.h"

#include "nsMenu.h"
#include "nsMenuBar.h"
#include "nsMenuContainer.h"
#include "nsNativeMenuDocListener.h"

#include <gdk/gdk.h>
#include <gdk/gdkkeysyms.h>
#include <gdk/gdkkeysyms-compat.h>
#include <gdk/gdkx.h>
#include <gtk/gtk.h>

#include "nsMenuItem.h"

using namespace mozilla;

struct KeyCodeData {
    const char* str;
    size_t strlength;
    uint32_t keycode;
};

static struct KeyCodeData gKeyCodes[] = {
#define NS_DEFINE_VK(aDOMKeyName, aDOMKeyCode) \
  { #aDOMKeyName, sizeof(#aDOMKeyName) - 1, aDOMKeyCode },
#include "mozilla/VirtualKeyCodeList.h"
#undef NS_DEFINE_VK
  { nullptr, 0, 0 }
};

struct KeyPair {
    uint32_t DOMKeyCode;
    guint GDKKeyval;
};

//
// Netscape keycodes are defined in widget/public/nsGUIEvent.h
// GTK keycodes are defined in <gdk/gdkkeysyms.h>
//
static const KeyPair gKeyPairs[] = {
    { NS_VK_CANCEL,     GDK_Cancel },
    { NS_VK_BACK,       GDK_BackSpace },
    { NS_VK_TAB,        GDK_Tab },
    { NS_VK_TAB,        GDK_ISO_Left_Tab },
    { NS_VK_CLEAR,      GDK_Clear },
    { NS_VK_RETURN,     GDK_Return },
    { NS_VK_SHIFT,      GDK_Shift_L },
    { NS_VK_SHIFT,      GDK_Shift_R },
    { NS_VK_SHIFT,      GDK_Shift_Lock },
    { NS_VK_CONTROL,    GDK_Control_L },
    { NS_VK_CONTROL,    GDK_Control_R },
    { NS_VK_ALT,        GDK_Alt_L },
    { NS_VK_ALT,        GDK_Alt_R },
    { NS_VK_META,       GDK_Meta_L },
    { NS_VK_META,       GDK_Meta_R },

    // Assume that Super or Hyper is always mapped to physical Win key.
    { NS_VK_WIN,        GDK_Super_L },
    { NS_VK_WIN,        GDK_Super_R },
    { NS_VK_WIN,        GDK_Hyper_L },
    { NS_VK_WIN,        GDK_Hyper_R },

    // GTK's AltGraph key is similar to Mac's Option (Alt) key.  However,
    // unfortunately, browsers on Mac are using NS_VK_ALT for it even though
    // it's really different from Alt key on Windows.
    // On the other hand, GTK's AltGrapsh keys are really different from
    // Alt key.  However, there is no AltGrapsh key on Windows.  On Windows,
    // both Ctrl and Alt keys are pressed internally when AltGr key is pressed.
    // For some languages' users, AltGraph key is important, so, web
    // applications on such locale may want to know AltGraph key press.
    // Therefore, we should map AltGr keycode for them only on GTK.
    { NS_VK_ALTGR,      GDK_ISO_Level3_Shift },
    { NS_VK_ALTGR,      GDK_ISO_Level5_Shift },
    // We assume that Mode_switch is always used for level3 shift.
    { NS_VK_ALTGR,      GDK_Mode_switch },

    { NS_VK_PAUSE,      GDK_Pause },
    { NS_VK_CAPS_LOCK,  GDK_Caps_Lock },
    { NS_VK_KANA,       GDK_Kana_Lock },
    { NS_VK_KANA,       GDK_Kana_Shift },
    { NS_VK_HANGUL,     GDK_Hangul },
    // { NS_VK_JUNJA,      GDK_XXX },
    // { NS_VK_FINAL,      GDK_XXX },
    { NS_VK_HANJA,      GDK_Hangul_Hanja },
    { NS_VK_KANJI,      GDK_Kanji },
    { NS_VK_ESCAPE,     GDK_Escape },
    { NS_VK_CONVERT,    GDK_Henkan },
    { NS_VK_NONCONVERT, GDK_Muhenkan },
    // { NS_VK_ACCEPT,     GDK_XXX },
    // { NS_VK_MODECHANGE, GDK_XXX },
    { NS_VK_SPACE,      GDK_space },
    { NS_VK_PAGE_UP,    GDK_Page_Up },
    { NS_VK_PAGE_DOWN,  GDK_Page_Down },
    { NS_VK_END,        GDK_End },
    { NS_VK_HOME,       GDK_Home },
    { NS_VK_LEFT,       GDK_Left },
    { NS_VK_UP,         GDK_Up },
    { NS_VK_RIGHT,      GDK_Right },
    { NS_VK_DOWN,       GDK_Down },
    { NS_VK_SELECT,     GDK_Select },
    { NS_VK_PRINT,      GDK_Print },
    { NS_VK_EXECUTE,    GDK_Execute },
    { NS_VK_PRINTSCREEN, GDK_Print },
    { NS_VK_INSERT,     GDK_Insert },
    { NS_VK_DELETE,     GDK_Delete },
    { NS_VK_HELP,       GDK_Help },

    // keypad keys
    { NS_VK_LEFT,       GDK_KP_Left },
    { NS_VK_RIGHT,      GDK_KP_Right },
    { NS_VK_UP,         GDK_KP_Up },
    { NS_VK_DOWN,       GDK_KP_Down },
    { NS_VK_PAGE_UP,    GDK_KP_Page_Up },
    // Not sure what these are
    //{ NS_VK_,       GDK_KP_Prior },
    //{ NS_VK_,        GDK_KP_Next },
    { NS_VK_CLEAR,      GDK_KP_Begin }, // Num-unlocked 5
    { NS_VK_PAGE_DOWN,  GDK_KP_Page_Down },
    { NS_VK_HOME,       GDK_KP_Home },
    { NS_VK_END,        GDK_KP_End },
    { NS_VK_INSERT,     GDK_KP_Insert },
    { NS_VK_DELETE,     GDK_KP_Delete },
    { NS_VK_RETURN,     GDK_KP_Enter },

    { NS_VK_NUM_LOCK,   GDK_Num_Lock },
    { NS_VK_SCROLL_LOCK,GDK_Scroll_Lock },

    // Function keys
    { NS_VK_F1,         GDK_F1 },
    { NS_VK_F2,         GDK_F2 },
    { NS_VK_F3,         GDK_F3 },
    { NS_VK_F4,         GDK_F4 },
    { NS_VK_F5,         GDK_F5 },
    { NS_VK_F6,         GDK_F6 },
    { NS_VK_F7,         GDK_F7 },
    { NS_VK_F8,         GDK_F8 },
    { NS_VK_F9,         GDK_F9 },
    { NS_VK_F10,        GDK_F10 },
    { NS_VK_F11,        GDK_F11 },
    { NS_VK_F12,        GDK_F12 },
    { NS_VK_F13,        GDK_F13 },
    { NS_VK_F14,        GDK_F14 },
    { NS_VK_F15,        GDK_F15 },
    { NS_VK_F16,        GDK_F16 },
    { NS_VK_F17,        GDK_F17 },
    { NS_VK_F18,        GDK_F18 },
    { NS_VK_F19,        GDK_F19 },
    { NS_VK_F20,        GDK_F20 },
    { NS_VK_F21,        GDK_F21 },
    { NS_VK_F22,        GDK_F22 },
    { NS_VK_F23,        GDK_F23 },
    { NS_VK_F24,        GDK_F24 },

    // context menu key, keysym 0xff67, typically keycode 117 on 105-key (Microsoft)
    // x86 keyboards, located between right 'Windows' key and right Ctrl key
    { NS_VK_CONTEXT_MENU, GDK_Menu },
    { NS_VK_SLEEP,      GDK_Sleep },

    { NS_VK_ATTN,       GDK_3270_Attn },
    { NS_VK_CRSEL,      GDK_3270_CursorSelect },
    { NS_VK_EXSEL,      GDK_3270_ExSelect },
    { NS_VK_EREOF,      GDK_3270_EraseEOF },
    { NS_VK_PLAY,       GDK_3270_Play },
    //{ NS_VK_ZOOM,       GDK_XXX },
    { NS_VK_PA1,        GDK_3270_PA1 },
};

static guint
ConvertGeckoKeyNameToGDKKeyval(nsAString& aKeyName)
{
    NS_ConvertUTF16toUTF8 keyName(aKeyName);
    ToUpperCase(keyName); // We want case-insensitive comparison with data
                          // stored as uppercase.

    uint32_t keyCode = 0;

    uint32_t keyNameLength = keyName.Length();
    const char* keyNameStr = keyName.get();
    for (uint16_t i = 0; i < ArrayLength(gKeyCodes); ++i) {
        if (keyNameLength == gKeyCodes[i].strlength &&
            !nsCRT::strcmp(gKeyCodes[i].str, keyNameStr)) {
            keyCode = gKeyCodes[i].keycode;
            break;
        }
    }

    // First, try to handle alphanumeric input, not listed in nsKeycodes:
    // most likely, more letters will be getting typed in than things in
    // the key list, so we will look through these first.

    if (keyCode >= NS_VK_A && keyCode <= NS_VK_Z) {
        // gdk and DOM both use the ASCII codes for these keys.
        return keyCode;
    }

    // numbers
    if (keyCode >= NS_VK_0 && keyCode <= NS_VK_9) {
        // gdk and DOM both use the ASCII codes for these keys.
        return keyCode - NS_VK_0 + GDK_0;
    }

    switch (keyCode) {
        // keys in numpad
        case NS_VK_MULTIPLY:  return GDK_KP_Multiply;
        case NS_VK_ADD:       return GDK_KP_Add;
        case NS_VK_SEPARATOR: return GDK_KP_Separator;
        case NS_VK_SUBTRACT:  return GDK_KP_Subtract;
        case NS_VK_DECIMAL:   return GDK_KP_Decimal;
        case NS_VK_DIVIDE:    return GDK_KP_Divide;
        case NS_VK_NUMPAD0:   return GDK_KP_0;
        case NS_VK_NUMPAD1:   return GDK_KP_1;
        case NS_VK_NUMPAD2:   return GDK_KP_2;
        case NS_VK_NUMPAD3:   return GDK_KP_3;
        case NS_VK_NUMPAD4:   return GDK_KP_4;
        case NS_VK_NUMPAD5:   return GDK_KP_5;
        case NS_VK_NUMPAD6:   return GDK_KP_6;
        case NS_VK_NUMPAD7:   return GDK_KP_7;
        case NS_VK_NUMPAD8:   return GDK_KP_8;
        case NS_VK_NUMPAD9:   return GDK_KP_9;
        // other prinable keys
        case NS_VK_SPACE:               return GDK_space;
        case NS_VK_COLON:               return GDK_colon;
        case NS_VK_SEMICOLON:           return GDK_semicolon;
        case NS_VK_LESS_THAN:           return GDK_less;
        case NS_VK_EQUALS:              return GDK_equal;
        case NS_VK_GREATER_THAN:        return GDK_greater;
        case NS_VK_QUESTION_MARK:       return GDK_question;
        case NS_VK_AT:                  return GDK_at;
        case NS_VK_CIRCUMFLEX:          return GDK_asciicircum;
        case NS_VK_EXCLAMATION:         return GDK_exclam;
        case NS_VK_DOUBLE_QUOTE:        return GDK_quotedbl;
        case NS_VK_HASH:                return GDK_numbersign;
        case NS_VK_DOLLAR:              return GDK_dollar;
        case NS_VK_PERCENT:             return GDK_percent;
        case NS_VK_AMPERSAND:           return GDK_ampersand;
        case NS_VK_UNDERSCORE:          return GDK_underscore;
        case NS_VK_OPEN_PAREN:          return GDK_parenleft;
        case NS_VK_CLOSE_PAREN:         return GDK_parenright;
        case NS_VK_ASTERISK:            return GDK_asterisk;
        case NS_VK_PLUS:                return GDK_plus;
        case NS_VK_PIPE:                return GDK_bar;
        case NS_VK_HYPHEN_MINUS:        return GDK_minus;
        case NS_VK_OPEN_CURLY_BRACKET:  return GDK_braceleft;
        case NS_VK_CLOSE_CURLY_BRACKET: return GDK_braceright;
        case NS_VK_TILDE:               return GDK_asciitilde;
        case NS_VK_COMMA:               return GDK_comma;
        case NS_VK_PERIOD:              return GDK_period;
        case NS_VK_SLASH:               return GDK_slash;
        case NS_VK_BACK_QUOTE:          return GDK_grave;
        case NS_VK_OPEN_BRACKET:        return GDK_bracketleft;
        case NS_VK_BACK_SLASH:          return GDK_backslash;
        case NS_VK_CLOSE_BRACKET:       return GDK_bracketright;
        case NS_VK_QUOTE:               return GDK_apostrophe;
    }

    // misc other things
    for (uint32_t i = 0; i < ArrayLength(gKeyPairs); ++i) {
        if (gKeyPairs[i].DOMKeyCode == keyCode) {
            return gKeyPairs[i].GDKKeyval;
        }
    }

    return 0;
}

class nsMenuItemUncheckSiblingsRunnable final : public Runnable
{
public:
    NS_IMETHODIMP Run()
    {
        if (mMenuItem) {
            static_cast<nsMenuItem *>(mMenuItem.get())->UncheckSiblings();
        }
        return NS_OK;
    }

    nsMenuItemUncheckSiblingsRunnable(nsMenuItem *aMenuItem) :
        Runnable("nsMenuItemUncheckSiblingsRunnable"),
        mMenuItem(aMenuItem) { };

private:
    nsWeakMenuObject mMenuItem;
};

bool
nsMenuItem::IsCheckboxOrRadioItem() const
{
    return mType == eMenuItemType_Radio ||
           mType == eMenuItemType_CheckBox;
}

/* static */ void
nsMenuItem::item_activated_cb(DbusmenuMenuitem *menuitem,
                              guint timestamp,
                              gpointer user_data)
{
    nsMenuItem *item = static_cast<nsMenuItem *>(user_data);
    item->Activate(timestamp);
}

void
nsMenuItem::Activate(uint32_t aTimestamp)
{
    GdkWindow *window = gtk_widget_get_window(MenuBar()->TopLevelWindow());
    gdk_x11_window_set_user_time(
        window, std::min(aTimestamp, gdk_x11_get_server_time(window)));

    // We do this to avoid mutating our view of the menu until
    // after we have finished
    nsNativeMenuDocListener::BlockUpdatesScope updatesBlocker;

    if (!ContentNode()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                 nsGkAtoms::autocheck,
                                                 nsGkAtoms::_false,
                                                 eCaseMatters) &&
        (mType == eMenuItemType_CheckBox ||
         (mType == eMenuItemType_Radio && !mIsChecked))) {
        ContentNode()->AsElement()->SetAttr(kNameSpaceID_None,
                                            nsGkAtoms::checked,
                                            mIsChecked ?
                                                u"false"_ns
                                                : u"true"_ns,
                                            true);
    }

    dom::Document *doc = ContentNode()->OwnerDoc();
    ErrorResult rv;
    RefPtr<dom::Event> event =
        doc->CreateEvent(u"xulcommandevent"_ns,
                         dom::CallerType::System, rv);
    if (!rv.Failed()) {
        RefPtr<dom::XULCommandEvent> command = event->AsXULCommandEvent();
        if (command) {
            command->InitCommandEvent(u"command"_ns, true, true,
                                      nsGlobalWindowInner::Cast(doc->GetInnerWindow()),
                                      0, false, false, false, false, 0, nullptr, 0, rv);
            if (!rv.Failed()) {
                event->SetTrusted(true);
                ContentNode()->DispatchEvent(*event, rv);
                if (rv.Failed()) {
                    NS_WARNING("Failed to dispatch event");
                    rv.SuppressException();
                }
            } else {
                NS_WARNING("Failed to initialize command event");
                rv.SuppressException();
            }
        }
    } else {
        NS_WARNING("CreateEvent failed");
        rv.SuppressException();
    }

    // This kinda sucks, but Unity doesn't send a closed event
    // after activating a menuitem
    nsMenuObject *ancestor = Parent();
    while (ancestor && ancestor->Type() == eType_Menu) {
        static_cast<nsMenu *>(ancestor)->OnClose();
        ancestor = ancestor->Parent();
    }
}

void
nsMenuItem::CopyAttrFromNodeIfExists(nsIContent *aContent, nsAtom *aAttribute)
{
    nsAutoString value;
    if (aContent->AsElement()->GetAttr(kNameSpaceID_None, aAttribute, value)) {
        ContentNode()->AsElement()->SetAttr(kNameSpaceID_None, aAttribute,
                                            value, true);
    }
}

void
nsMenuItem::UpdateState()
{
    if (!IsCheckboxOrRadioItem()) {
        return;
    }

    mIsChecked = ContentNode()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                         nsGkAtoms::checked,
                                                         nsGkAtoms::_true,
                                                         eCaseMatters);
    dbusmenu_menuitem_property_set_int(GetNativeData(),
                                       DBUSMENU_MENUITEM_PROP_TOGGLE_STATE,
                                       mIsChecked ?
                                         DBUSMENU_MENUITEM_TOGGLE_STATE_CHECKED :
                                         DBUSMENU_MENUITEM_TOGGLE_STATE_UNCHECKED);
}

void
nsMenuItem::UpdateTypeAndState()
{
    static mozilla::dom::Element::AttrValuesArray attrs[] =
        { nsGkAtoms::checkbox, nsGkAtoms::radio, nullptr };
    int32_t type = ContentNode()->AsElement()->FindAttrValueIn(kNameSpaceID_None,
                                                               nsGkAtoms::type,
                                                               attrs, eCaseMatters);

    if (type >= 0 && type < 2) {
        if (type == 0) {
            dbusmenu_menuitem_property_set(GetNativeData(),
                                           DBUSMENU_MENUITEM_PROP_TOGGLE_TYPE,
                                           DBUSMENU_MENUITEM_TOGGLE_CHECK);
            mType = eMenuItemType_CheckBox;
        } else if (type == 1) {
            dbusmenu_menuitem_property_set(GetNativeData(),
                                           DBUSMENU_MENUITEM_PROP_TOGGLE_TYPE,
                                           DBUSMENU_MENUITEM_TOGGLE_RADIO);
            mType = eMenuItemType_Radio;
        }

        UpdateState();
    } else {
        dbusmenu_menuitem_property_remove(GetNativeData(),
                                          DBUSMENU_MENUITEM_PROP_TOGGLE_TYPE);
        dbusmenu_menuitem_property_remove(GetNativeData(),
                                          DBUSMENU_MENUITEM_PROP_TOGGLE_STATE);
        mType = eMenuItemType_Normal;
    }
}

void
nsMenuItem::UpdateAccel()
{
    dom::Document *doc = ContentNode()->GetUncomposedDoc();
    if (doc) {
        nsCOMPtr<nsIContent> oldKeyContent;
        oldKeyContent.swap(mKeyContent);

        nsAutoString key;
        ContentNode()->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::key,
                                            key);
        if (!key.IsEmpty()) {
            mKeyContent = doc->GetElementById(key);
        }

        if (mKeyContent != oldKeyContent) {
            if (oldKeyContent) {
                DocListener()->UnregisterForContentChanges(oldKeyContent);
            }
            if (mKeyContent) {
                DocListener()->RegisterForContentChanges(mKeyContent, this);
            }
        }
    }

    if (!mKeyContent) {
        dbusmenu_menuitem_property_remove(GetNativeData(),
                                          DBUSMENU_MENUITEM_PROP_SHORTCUT);
        return;
    }

    nsAutoString modifiers;
    mKeyContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::modifiers,
                                      modifiers);

    uint32_t modifier = 0;

    if (!modifiers.IsEmpty()) {
        char* str = ToNewUTF8String(modifiers);
        char *token = strtok(str, ", \t");
        while(token) {
            if (nsCRT::strcmp(token, "shift") == 0) {
                modifier |= GDK_SHIFT_MASK;
            } else if (nsCRT::strcmp(token, "alt") == 0) {
                modifier |= GDK_MOD1_MASK;
            } else if (nsCRT::strcmp(token, "meta") == 0) {
                modifier |= GDK_META_MASK;
            } else if (nsCRT::strcmp(token, "control") == 0) {
                modifier |= GDK_CONTROL_MASK;
            } else if (nsCRT::strcmp(token, "accel") == 0) {
                int32_t accel = Preferences::GetInt("ui.key.accelKey");
                if (accel == dom::KeyboardEvent_Binding::DOM_VK_META) {
                    modifier |= GDK_META_MASK;
                } else if (accel == dom::KeyboardEvent_Binding::DOM_VK_ALT) {
                    modifier |= GDK_MOD1_MASK;
                } else {
                    modifier |= GDK_CONTROL_MASK;
                }
            }

            token = strtok(nullptr, ", \t");
        }

        free(str);
    }

    nsAutoString keyStr;
    mKeyContent->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::key,
                                      keyStr);

    guint key = 0;
    if (!keyStr.IsEmpty()) {
        key = gdk_unicode_to_keyval(*keyStr.BeginReading());
    }

    if (key == 0) {
        mKeyContent->AsElement()->GetAttr(kNameSpaceID_None,
                                          nsGkAtoms::keycode, keyStr);
        if (!keyStr.IsEmpty()) {
            key = ConvertGeckoKeyNameToGDKKeyval(keyStr);
        }
    }

    if (key == 0) {
        key = GDK_VoidSymbol;
    }

    if (key != GDK_VoidSymbol) {
        dbusmenu_menuitem_property_set_shortcut(GetNativeData(), key,
                                                static_cast<GdkModifierType>(modifier));
    } else {
        dbusmenu_menuitem_property_remove(GetNativeData(),
                                          DBUSMENU_MENUITEM_PROP_SHORTCUT);
    }
}

nsMenuBar*
nsMenuItem::MenuBar()
{
    nsMenuObject *tmp = this;
    while (tmp->Parent()) {
        tmp = tmp->Parent();
    }

    MOZ_ASSERT(tmp->Type() == eType_MenuBar, "The top-level should be a menubar");

    return static_cast<nsMenuBar *>(tmp);
}

void
nsMenuItem::UncheckSiblings()
{
    if (!ContentNode()->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                 nsGkAtoms::type,
                                                 nsGkAtoms::radio,
                                                 eCaseMatters)) {
        // If we're not a radio button, we don't care
        return;
    }

    nsAutoString name;
    ContentNode()->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::name,
                                        name);

    nsIContent *parent = ContentNode()->GetParent();
    if (!parent) {
        return;
    }

    uint32_t count = parent->GetChildCount();
    for (uint32_t i = 0; i < count; ++i) {
        nsIContent *sibling = parent->GetChildAt_Deprecated(i);

        if (sibling->IsComment()) {
            continue;
        }

        nsAutoString otherName;
        sibling->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::name,
                                      otherName);

        if (sibling != ContentNode() && otherName == name &&
            sibling->AsElement()->AttrValueIs(kNameSpaceID_None,
                                              nsGkAtoms::type,
                                              nsGkAtoms::radio,
                                              eCaseMatters)) {
            sibling->AsElement()->UnsetAttr(kNameSpaceID_None,
                                            nsGkAtoms::checked, true);
        }
    }
}

void
nsMenuItem::InitializeNativeData()
{
    g_signal_connect(G_OBJECT(GetNativeData()),
                     DBUSMENU_MENUITEM_SIGNAL_ITEM_ACTIVATED,
                     G_CALLBACK(item_activated_cb), this);
    mNeedsUpdate = true;
}

void
nsMenuItem::UpdateContentAttributes()
{
    dom::Document *doc = ContentNode()->GetUncomposedDoc();
    if (!doc) {
        return;
    }

    nsAutoString command;
    ContentNode()->AsElement()->GetAttr(kNameSpaceID_None, nsGkAtoms::command,
                                        command);
    if (command.IsEmpty()) {
        return;
    }

    nsCOMPtr<nsIContent> commandContent = doc->GetElementById(command);
    if (!commandContent) {
        return;
    }

    if (commandContent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                                 nsGkAtoms::disabled,
                                                 nsGkAtoms::_true,
                                                 eCaseMatters)) {
        ContentNode()->AsElement()->SetAttr(kNameSpaceID_None,
                                            nsGkAtoms::disabled,
                                            u"true"_ns, true);
    } else {
        ContentNode()->AsElement()->UnsetAttr(kNameSpaceID_None,
                                              nsGkAtoms::disabled, true);
    }

    CopyAttrFromNodeIfExists(commandContent, nsGkAtoms::checked);
    CopyAttrFromNodeIfExists(commandContent, nsGkAtoms::accesskey);
    CopyAttrFromNodeIfExists(commandContent, nsGkAtoms::label);
    CopyAttrFromNodeIfExists(commandContent, nsGkAtoms::hidden);
}

void
nsMenuItem::Update(const ComputedStyle *aComputedStyle)
{
    if (mNeedsUpdate) {
        mNeedsUpdate = false;

        UpdateTypeAndState();
        UpdateAccel();
        UpdateLabel();
        UpdateSensitivity();
    }

    UpdateVisibility(aComputedStyle);
    UpdateIcon(aComputedStyle);
}

bool
nsMenuItem::IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const
{
    return nsCRT::strcmp(dbusmenu_menuitem_property_get(aNativeData,
                                                        DBUSMENU_MENUITEM_PROP_TYPE),
                         "separator") != 0;
}

nsMenuObject::PropertyFlags
nsMenuItem::SupportedProperties() const
{
    return static_cast<nsMenuObject::PropertyFlags>(
        nsMenuObject::ePropLabel |
        nsMenuObject::ePropEnabled |
        nsMenuObject::ePropVisible |
        nsMenuObject::ePropIconData |
        nsMenuObject::ePropShortcut |
        nsMenuObject::ePropToggleType |
        nsMenuObject::ePropToggleState
    );
}

void
nsMenuItem::OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute)
{
    MOZ_ASSERT(aContent == ContentNode() || aContent == mKeyContent,
               "Received an event that wasn't meant for us!");

    if (aContent == ContentNode() && aAttribute == nsGkAtoms::checked &&
        aContent->AsElement()->AttrValueIs(kNameSpaceID_None,
                                           nsGkAtoms::checked,
                                           nsGkAtoms::_true, eCaseMatters)) {
        nsContentUtils::AddScriptRunner(
            new nsMenuItemUncheckSiblingsRunnable(this));
    }

    if (mNeedsUpdate) {
        return;
    }

    if (!Parent()->IsBeingDisplayed()) {
        mNeedsUpdate = true;
        return;
    }

    if (aContent == ContentNode()) {
        if (aAttribute == nsGkAtoms::key) {
            UpdateAccel();
        } else if (aAttribute == nsGkAtoms::label ||
                   aAttribute == nsGkAtoms::accesskey ||
                   aAttribute == nsGkAtoms::crop) {
            UpdateLabel();
        } else if (aAttribute == nsGkAtoms::disabled) {
            UpdateSensitivity();
        } else if (aAttribute == nsGkAtoms::type) {
            UpdateTypeAndState();
        } else if (aAttribute == nsGkAtoms::checked) {
            UpdateState();
        } else if (aAttribute == nsGkAtoms::hidden ||
                   aAttribute == nsGkAtoms::collapsed) {
            RefPtr<const ComputedStyle> style = GetComputedStyle();
            UpdateVisibility(style);
        } else if (aAttribute == nsGkAtoms::image) {
            RefPtr<const ComputedStyle> style = GetComputedStyle();
            UpdateIcon(style);
        }
    } else if (aContent == mKeyContent &&
               (aAttribute == nsGkAtoms::key ||
                aAttribute == nsGkAtoms::keycode ||
                aAttribute == nsGkAtoms::modifiers)) {
        UpdateAccel();
    }
}

nsMenuItem::nsMenuItem(nsMenuContainer *aParent, nsIContent *aContent) :
    nsMenuObject(aParent, aContent),
    mType(eMenuItemType_Normal),
    mIsChecked(false),
    mNeedsUpdate(false)
{
    MOZ_COUNT_CTOR(nsMenuItem);
}

nsMenuItem::~nsMenuItem()
{
    if (DocListener() && mKeyContent) {
        DocListener()->UnregisterForContentChanges(mKeyContent);
    }

    if (GetNativeData()) {
        g_signal_handlers_disconnect_by_func(GetNativeData(),
                                             FuncToGpointer(item_activated_cb),
                                             this);
    }

    MOZ_COUNT_DTOR(nsMenuItem);
}

nsMenuObject::EType
nsMenuItem::Type() const
{
    return eType_MenuItem;
}
