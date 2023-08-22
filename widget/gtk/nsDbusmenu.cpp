/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsDbusmenu.h"
#include "prlink.h"
#include "mozilla/ArrayUtils.h"

#define FUNC(name, type, params) \
nsDbusmenuFunctions::_##name##_fn nsDbusmenuFunctions::s_##name;
DBUSMENU_GLIB_FUNCTIONS
DBUSMENU_GTK_FUNCTIONS
#undef FUNC

static PRLibrary *gDbusmenuGlib = nullptr;
static PRLibrary *gDbusmenuGtk = nullptr;

typedef void (*nsDbusmenuFunc)();
struct nsDbusmenuDynamicFunction {
    const char *functionName;
    nsDbusmenuFunc *function;
};

/* static */ nsresult
nsDbusmenuFunctions::Init()
{
#define FUNC(name, type, params) \
    { #name, (nsDbusmenuFunc *)&nsDbusmenuFunctions::s_##name },
    static const nsDbusmenuDynamicFunction kDbusmenuGlibSymbols[] = {
        DBUSMENU_GLIB_FUNCTIONS
    };
    static const nsDbusmenuDynamicFunction kDbusmenuGtkSymbols[] = {
        DBUSMENU_GTK_FUNCTIONS
    };

#define LOAD_LIBRARY(symbol, name) \
    if (!g##symbol) { \
        g##symbol = PR_LoadLibrary(name); \
        if (!g##symbol) { \
            return NS_ERROR_FAILURE; \
        } \
    } \
    for (uint32_t i = 0; i < mozilla::ArrayLength(k##symbol##Symbols); ++i) { \
        *k##symbol##Symbols[i].function = \
            PR_FindFunctionSymbol(g##symbol, k##symbol##Symbols[i].functionName); \
        if (!*k##symbol##Symbols[i].function) { \
            return NS_ERROR_FAILURE; \
        } \
    }

    LOAD_LIBRARY(DbusmenuGlib, "libdbusmenu-glib.so.4")
#ifdef MOZ_WIDGET_GTK
    LOAD_LIBRARY(DbusmenuGtk, "libdbusmenu-gtk3.so.4")
#endif
#undef LOAD_LIBRARY

    return NS_OK;
}
