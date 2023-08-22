/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "mozilla/dom/Element.h"
#include "mozilla/Assertions.h"
#include "mozilla/Preferences.h"
#include "mozilla/UniquePtr.h"
#include "nsCOMPtr.h"
#include "nsCRT.h"
#include "nsGtkUtils.h"
#include "nsIContent.h"
#include "nsIWidget.h"
#include "nsServiceManagerUtils.h"
#include "nsWindow.h"
#include "prlink.h"

#include "nsDbusmenu.h"
#include "nsMenuBar.h"
#include "nsNativeMenuDocListener.h"

#include <glib-object.h>
#include <pango/pango.h>
#include <stdlib.h>

#include "nsNativeMenuService.h"

using namespace mozilla;

nsNativeMenuService* nsNativeMenuService::sService = nullptr;

extern PangoLayout* gPangoLayout;
extern nsNativeMenuDocListenerTArray* gPendingListeners;

#undef g_dbus_proxy_new_for_bus
#undef g_dbus_proxy_new_for_bus_finish
#undef g_dbus_proxy_call
#undef g_dbus_proxy_call_finish
#undef g_dbus_proxy_get_name_owner

typedef void (*_g_dbus_proxy_new_for_bus_fn)(GBusType, GDBusProxyFlags,
                                             GDBusInterfaceInfo*,
                                             const gchar*, const gchar*,
                                             const gchar*, GCancellable*,
                                             GAsyncReadyCallback, gpointer);

typedef GDBusProxy* (*_g_dbus_proxy_new_for_bus_finish_fn)(GAsyncResult*,
                                                           GError**);
typedef void (*_g_dbus_proxy_call_fn)(GDBusProxy*, const gchar*, GVariant*,
                                      GDBusCallFlags, gint, GCancellable*,
                                      GAsyncReadyCallback, gpointer);
typedef GVariant* (*_g_dbus_proxy_call_finish_fn)(GDBusProxy*, GAsyncResult*,
                                                  GError**);
typedef gchar* (*_g_dbus_proxy_get_name_owner_fn)(GDBusProxy*);

static _g_dbus_proxy_new_for_bus_fn _g_dbus_proxy_new_for_bus;
static _g_dbus_proxy_new_for_bus_finish_fn _g_dbus_proxy_new_for_bus_finish;
static _g_dbus_proxy_call_fn _g_dbus_proxy_call;
static _g_dbus_proxy_call_finish_fn _g_dbus_proxy_call_finish;
static _g_dbus_proxy_get_name_owner_fn _g_dbus_proxy_get_name_owner;

#define g_dbus_proxy_new_for_bus _g_dbus_proxy_new_for_bus
#define g_dbus_proxy_new_for_bus_finish _g_dbus_proxy_new_for_bus_finish
#define g_dbus_proxy_call _g_dbus_proxy_call
#define g_dbus_proxy_call_finish _g_dbus_proxy_call_finish
#define g_dbus_proxy_get_name_owner _g_dbus_proxy_get_name_owner

static PRLibrary *gGIOLib = nullptr;

static nsresult
GDBusInit()
{
    gGIOLib = PR_LoadLibrary("libgio-2.0.so.0");
    if (!gGIOLib) {
        return NS_ERROR_FAILURE;
    }

    g_dbus_proxy_new_for_bus = (_g_dbus_proxy_new_for_bus_fn)PR_FindFunctionSymbol(gGIOLib, "g_dbus_proxy_new_for_bus");
    g_dbus_proxy_new_for_bus_finish = (_g_dbus_proxy_new_for_bus_finish_fn)PR_FindFunctionSymbol(gGIOLib, "g_dbus_proxy_new_for_bus_finish");
    g_dbus_proxy_call = (_g_dbus_proxy_call_fn)PR_FindFunctionSymbol(gGIOLib, "g_dbus_proxy_call");
    g_dbus_proxy_call_finish = (_g_dbus_proxy_call_finish_fn)PR_FindFunctionSymbol(gGIOLib, "g_dbus_proxy_call_finish");
    g_dbus_proxy_get_name_owner = (_g_dbus_proxy_get_name_owner_fn)PR_FindFunctionSymbol(gGIOLib, "g_dbus_proxy_get_name_owner");

    if (!g_dbus_proxy_new_for_bus ||
        !g_dbus_proxy_new_for_bus_finish ||
        !g_dbus_proxy_call ||
        !g_dbus_proxy_call_finish ||
        !g_dbus_proxy_get_name_owner) {
        return NS_ERROR_FAILURE;
    }

    return NS_OK;
}

NS_IMPL_ISUPPORTS(nsNativeMenuService, nsINativeMenuService)

nsNativeMenuService::nsNativeMenuService() :
    mCreateProxyCancellable(nullptr), mDbusProxy(nullptr), mOnline(false)
{
}

nsNativeMenuService::~nsNativeMenuService()
{
    SetOnline(false);

    if (mCreateProxyCancellable) {
        g_cancellable_cancel(mCreateProxyCancellable);
        g_object_unref(mCreateProxyCancellable);
        mCreateProxyCancellable = nullptr;
    }

    // Make sure we disconnect map-event handlers
    while (mMenuBars.Length() > 0) {
        NotifyNativeMenuBarDestroyed(mMenuBars[0]);
    }

    Preferences::UnregisterCallback(PrefChangedCallback,
                                    "ui.use_unity_menubar");

    if (mDbusProxy) {
        g_signal_handlers_disconnect_by_func(mDbusProxy,
                                             FuncToGpointer(name_owner_changed_cb),
                                             NULL);
        g_object_unref(mDbusProxy);
    }

    if (gPendingListeners) {
        delete gPendingListeners;
        gPendingListeners = nullptr;
    }
    if (gPangoLayout) {
        g_object_unref(gPangoLayout);
        gPangoLayout = nullptr;
    }

    MOZ_ASSERT(sService == this);
    sService = nullptr;
}

nsresult
nsNativeMenuService::Init()
{
    nsresult rv = nsDbusmenuFunctions::Init();
    if (NS_FAILED(rv)) {
        return rv;
    }

    rv = GDBusInit();
    if (NS_FAILED(rv)) {
        return rv;
    }

    Preferences::RegisterCallback(PrefChangedCallback,
                                  "ui.use_unity_menubar");

    mCreateProxyCancellable = g_cancellable_new();

    g_dbus_proxy_new_for_bus(G_BUS_TYPE_SESSION,
                             static_cast<GDBusProxyFlags>(
                                 G_DBUS_PROXY_FLAGS_DO_NOT_LOAD_PROPERTIES |
                                 G_DBUS_PROXY_FLAGS_DO_NOT_CONNECT_SIGNALS |
                                 G_DBUS_PROXY_FLAGS_DO_NOT_AUTO_START),
                             nullptr,
                             "com.canonical.AppMenu.Registrar",
                             "/com/canonical/AppMenu/Registrar",
                             "com.canonical.AppMenu.Registrar",
                             mCreateProxyCancellable, proxy_created_cb,
                             nullptr);

    /* We don't technically know that the shell will draw the menubar until
     * we know whether anybody owns the name of the menubar service on the
     * session bus. However, discovering this happens asynchronously so
     * we optimize for the common case here by assuming that the shell will
     * draw window menubars if we are running inside Unity. This should
     * mean that we avoid temporarily displaying the window menubar ourselves
     */
    const char *desktop = getenv("XDG_CURRENT_DESKTOP");
    if (nsCRT::strcmp(desktop, "Unity") == 0) {
        SetOnline(true);
    }

    return NS_OK;
}

/* static */ void
nsNativeMenuService::EnsureInitialized()
{
    if (sService) {
        return;
    }
    nsCOMPtr<nsINativeMenuService> service =
        do_GetService("@mozilla.org/widget/nativemenuservice;1");
}

void
nsNativeMenuService::SetOnline(bool aOnline)
{
    if (!Preferences::GetBool("ui.use_unity_menubar", true)) {
        aOnline = false;
    }

    mOnline = aOnline;
    if (aOnline) {
        for (uint32_t i = 0; i < mMenuBars.Length(); ++i) {
            RegisterNativeMenuBar(mMenuBars[i]);
        }
    } else {
        for (uint32_t i = 0; i < mMenuBars.Length(); ++i) {
            mMenuBars[i]->Deactivate();
        }
    }
}

void
nsNativeMenuService::RegisterNativeMenuBar(nsMenuBar *aMenuBar)
{
    if (!mOnline) {
        return;
    }

    // This will effectively create the native menubar for
    // exporting over the session bus, and hide the XUL menubar
    aMenuBar->Activate();

    if (!mDbusProxy ||
        !gtk_widget_get_mapped(aMenuBar->TopLevelWindow()) ||
        mMenuBarRegistrationCancellables.Get(aMenuBar, nullptr)) {
        // Don't go further if we don't have a proxy for the shell menu
        // service, the window isn't mapped or there is a request in progress.
        return;
    }

    uint32_t xid = aMenuBar->WindowId();
    nsCString path = aMenuBar->ObjectPath();
    if (xid == 0 || path.IsEmpty()) {
        NS_WARNING("Menubar has invalid XID or object path");
        return;
    }

    GCancellable *cancellable = g_cancellable_new();
    mMenuBarRegistrationCancellables.InsertOrUpdate(aMenuBar, cancellable);

    // We keep a weak ref because we can't assume that GDBus cancellation
    // is reliable (see https://launchpad.net/bugs/953562)

    g_dbus_proxy_call(mDbusProxy, "RegisterWindow",
                      g_variant_new("(uo)", xid, path.get()),
                      G_DBUS_CALL_FLAGS_NONE, -1,
                      cancellable,
                      register_native_menubar_cb, aMenuBar);
}

/* static */ void
nsNativeMenuService::name_owner_changed_cb(GObject *gobject,
                                           GParamSpec *pspec,
                                           gpointer user_data)
{
    nsNativeMenuService::GetSingleton()->OnNameOwnerChanged();
}

/* static */ void
nsNativeMenuService::proxy_created_cb(GObject *source_object,
                                      GAsyncResult *res,
                                      gpointer user_data)
{
    GError *error = nullptr;
    GDBusProxy *proxy = g_dbus_proxy_new_for_bus_finish(res, &error);
    if (error && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        g_error_free(error);
        return;
    }

    if (error) {
        g_error_free(error);
    }

    // We need this check because we can't assume that GDBus cancellation
    // is reliable (see https://launchpad.net/bugs/953562)
    nsNativeMenuService *self = nsNativeMenuService::GetSingleton();
    if (!self) {
        if (proxy) {
            g_object_unref(proxy);
        }
        return;
    }

    self->OnProxyCreated(proxy);
}

/* static */ void
nsNativeMenuService::register_native_menubar_cb(GObject *source_object,
                                                GAsyncResult *res,
                                                gpointer user_data)
{
    nsMenuBar *menuBar = static_cast<nsMenuBar *>(user_data);

    GError *error = nullptr;
    GVariant *results = g_dbus_proxy_call_finish(G_DBUS_PROXY(source_object),
                                                 res, &error);
    if (results) {
        // There's nothing useful in the response
        g_variant_unref(results);
    }

    bool success = error ? false : true;
    if (error && g_error_matches(error, G_IO_ERROR, G_IO_ERROR_CANCELLED)) {
        g_error_free(error);
        return;
    }

    if (error) {
        g_error_free(error);
    }

    nsNativeMenuService *self = nsNativeMenuService::GetSingleton();
    if (!self) {
        return;
    }

    self->OnNativeMenuBarRegistered(menuBar, success);
}

/* static */ gboolean
nsNativeMenuService::map_event_cb(GtkWidget *widget,
                                  GdkEvent *event,
                                  gpointer user_data)
{
    nsMenuBar *menubar = static_cast<nsMenuBar *>(user_data);
    nsNativeMenuService::GetSingleton()->RegisterNativeMenuBar(menubar);

    return FALSE;
}

void
nsNativeMenuService::OnNameOwnerChanged()
{
    char *owner = g_dbus_proxy_get_name_owner(mDbusProxy);
    SetOnline(owner ? true : false);
    g_free(owner);
}

void
nsNativeMenuService::OnProxyCreated(GDBusProxy *aProxy)
{
    mDbusProxy = aProxy;

    g_object_unref(mCreateProxyCancellable);
    mCreateProxyCancellable = nullptr;

    if (!mDbusProxy) {
        SetOnline(false);
        return;
    }

    g_signal_connect(mDbusProxy, "notify::g-name-owner",
                     G_CALLBACK(name_owner_changed_cb), nullptr);

    OnNameOwnerChanged();
}

void
nsNativeMenuService::OnNativeMenuBarRegistered(nsMenuBar *aMenuBar,
                                               bool aSuccess)
{
    // Don't assume that GDBus cancellation is reliable (ie, |aMenuBar| might
    // have already been deleted (see https://launchpad.net/bugs/953562)
    GCancellable *cancellable = nullptr;
    if (!mMenuBarRegistrationCancellables.Get(aMenuBar, &cancellable)) {
        return;
    }

    g_object_unref(cancellable);
    mMenuBarRegistrationCancellables.Remove(aMenuBar);

    if (!aSuccess) {
        aMenuBar->Deactivate();
    }
}

/* static */ void
nsNativeMenuService::PrefChangedCallback(const char *aPref,
                                         void *aClosure)
{
    nsNativeMenuService::GetSingleton()->PrefChanged();
}

void
nsNativeMenuService::PrefChanged()
{
    if (!mDbusProxy) {
        SetOnline(false);
        return;
    }

    OnNameOwnerChanged();
}

NS_IMETHODIMP
nsNativeMenuService::CreateNativeMenuBar(nsIWidget *aParent,
                                         mozilla::dom::Element *aMenuBarNode)
{
    NS_ENSURE_ARG(aParent);
    NS_ENSURE_ARG(aMenuBarNode);

    if (aMenuBarNode->AttrValueIs(kNameSpaceID_None,
                                  nsGkAtoms::_moz_menubarkeeplocal,
                                  nsGkAtoms::_true,
                                  eCaseMatters)) {
        return NS_OK;
    }

    UniquePtr<nsMenuBar> menubar(nsMenuBar::Create(aParent, aMenuBarNode));
    if (!menubar) {
        NS_WARNING("Failed to create menubar");
        return NS_ERROR_FAILURE;
    }

    // Unity forgets our window if it is unmapped by the application, which
    // happens with some extensions that add "minimize to tray" type
    // functionality. We hook on to the MapNotify event to re-register our menu
    // with Unity
    g_signal_connect(G_OBJECT(menubar->TopLevelWindow()),
                     "map-event", G_CALLBACK(map_event_cb),
                     menubar.get());

    mMenuBars.AppendElement(menubar.get());
    RegisterNativeMenuBar(menubar.get());

    static_cast<nsWindow *>(aParent)->SetMenuBar(std::move(menubar));

    return NS_OK;
}

/* static */ already_AddRefed<nsNativeMenuService>
nsNativeMenuService::GetInstanceForServiceManager()
{
    RefPtr<nsNativeMenuService> service(sService);

    if (service) {
        return service.forget();
    }

    service = new nsNativeMenuService();

    if (NS_FAILED(service->Init())) {
        return nullptr;
    }

    sService = service.get();
    return service.forget();
}

/* static */ nsNativeMenuService*
nsNativeMenuService::GetSingleton()
{
    EnsureInitialized();
    return sService;
}

void
nsNativeMenuService::NotifyNativeMenuBarDestroyed(nsMenuBar *aMenuBar)
{
    g_signal_handlers_disconnect_by_func(aMenuBar->TopLevelWindow(),
                                         FuncToGpointer(map_event_cb),
                                         aMenuBar);

    mMenuBars.RemoveElement(aMenuBar);

    GCancellable *cancellable = nullptr;
    if (mMenuBarRegistrationCancellables.Get(aMenuBar, &cancellable)) {
        mMenuBarRegistrationCancellables.Remove(aMenuBar);
        g_cancellable_cancel(cancellable);
        g_object_unref(cancellable);
    }
}
