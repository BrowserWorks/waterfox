/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenuContainer_h__
#define __nsMenuContainer_h__

#include "mozilla/UniquePtr.h"
#include "nsTArray.h"

#include "nsMenuObject.h"

class nsIContent;
class nsNativeMenuDocListener;

// Base class for containers (menus and menubars)
class nsMenuContainer : public nsMenuObject
{
public:
    typedef nsTArray<mozilla::UniquePtr<nsMenuObject> > ChildTArray;

    // Determine if this container is being displayed on screen. Must be
    // implemented by subclasses. Must return true if the container is
    // in the fully open state, or false otherwise
    virtual bool IsBeingDisplayed() const = 0;

    // Determine if this container will be rebuilt the next time it opens.
    // Returns false by default but can be overridden by subclasses
    virtual bool NeedsRebuild() const;

    // Return the first previous sibling that is of a type supported by the
    // menu system
    static nsIContent* GetPreviousSupportedSibling(nsIContent *aContent);

    static const ChildTArray::index_type NoIndex;

protected:
    nsMenuContainer(nsMenuContainer *aParent, nsIContent *aContent);
    nsMenuContainer(nsNativeMenuDocListener *aListener, nsIContent *aContent);

    // Create a new child element for the specified content node
    mozilla::UniquePtr<nsMenuObject> CreateChild(nsIContent *aContent);

    // Return the index of the child for the specified content node
    size_t IndexOf(nsIContent *aChild) const;

    size_t ChildCount() const { return mChildren.Length(); }
    nsMenuObject* ChildAt(size_t aIndex) const { return mChildren[aIndex].get(); }

    void RemoveChildAt(size_t aIndex, bool aUpdateNative = true);

    // Remove the child that owns the specified content node
    void RemoveChild(nsIContent *aChild, bool aUpdateNative = true);

    // Insert a new child after the child that owns the specified content node
    void InsertChildAfter(mozilla::UniquePtr<nsMenuObject> aChild,
                          nsIContent *aPrevSibling,
                          bool aUpdateNative = true);

    void AppendChild(mozilla::UniquePtr<nsMenuObject> aChild,
                     bool aUpdateNative = true);

private:
    ChildTArray mChildren;
};

#endif /* __nsMenuContainer_h__ */
