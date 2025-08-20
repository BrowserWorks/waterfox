/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsNativeMenuDocListener_h__
#define __nsNativeMenuDocListener_h__

#include "mozilla/Attributes.h"
#include "mozilla/RefPtr.h"
#include "mozilla/UniquePtr.h"
#include "nsTHashMap.h"
#include "nsStubMutationObserver.h"
#include "nsTArray.h"

class nsAtom;
class nsIContent;
class nsNativeMenuChangeObserver;

namespace mozilla {
namespace dom {
class Document;
}
}

/*
 * This class keeps a mapping of content nodes to observers and forwards DOM
 * mutations to these. There is exactly one of these for every menubar.
 */
class nsNativeMenuDocListener final : nsStubMutationObserver
{
public:
    NS_DECL_ISUPPORTS

    nsNativeMenuDocListener(nsIContent *aRootNode);

    // Register an observer to receive mutation events for the specified
    // content node. The caller must keep the observer alive until
    // UnregisterForContentChanges is called.
    void RegisterForContentChanges(nsIContent *aContent,
                                   nsNativeMenuChangeObserver *aObserver);

    // Unregister the registered observer for the specified content node
    void UnregisterForContentChanges(nsIContent *aContent);

    // Start listening to the document and forwarding DOM mutations to
    // registered observers.
    void Start();

    // Stop listening to the document. No DOM mutations will be forwarded
    // to registered observers.
    void Stop();

    /*
     * This class is intended to be used inside GObject signal handlers.
     * It allows us to queue updates until we have finished delivering
     * events to Gecko, and then we can batch updates to our view of the
     * menu. This allows us to do menu updates without altering the structure
     * seen by the OS.
     */
    class MOZ_STACK_CLASS BlockUpdatesScope
    {
    public:
        BlockUpdatesScope()
        {
            nsNativeMenuDocListener::AddUpdateBlocker();
        }

        ~BlockUpdatesScope()
        {
            nsNativeMenuDocListener::RemoveUpdateBlocker();
        }
    };

private:
    friend class DispatchHelper;

    struct MutationRecord {
        enum RecordType {
            eAttributeChanged,
            eContentInserted,
            eContentRemoved
        } mType;

        nsCOMPtr<nsIContent> mTarget;
        nsCOMPtr<nsIContent> mChild;
        nsCOMPtr<nsIContent> mPrevSibling;
        RefPtr<nsAtom> mAttribute;
    };

    ~nsNativeMenuDocListener();

    NS_DECL_NSIMUTATIONOBSERVER_ATTRIBUTECHANGED
    NS_DECL_NSIMUTATIONOBSERVER_CONTENTAPPENDED
    NS_DECL_NSIMUTATIONOBSERVER_CONTENTINSERTED
    NS_DECL_NSIMUTATIONOBSERVER_CONTENTREMOVED
    NS_DECL_NSIMUTATIONOBSERVER_NODEWILLBEDESTROYED

    void DoAttributeChanged(nsIContent *aContent, nsAtom *aAttribute);
    void DoContentInserted(nsIContent *aContainer,
                           nsIContent *aChild,
                           nsIContent *aPrevSibling);
    void DoContentRemoved(nsIContent *aContainer, nsIContent *aChild);
    void DoBeginUpdates(nsIContent *aTarget);
    void DoEndUpdates(nsIContent *aTarget);

    void FlushPendingMutations();
    static void ScheduleFlush(nsNativeMenuDocListener *aListener);
    static void CancelFlush(nsNativeMenuDocListener *aListener);

    static void AddUpdateBlocker() { ++sUpdateBlockersCount; }
    static void RemoveUpdateBlocker();

    nsCOMPtr<nsIContent> mRootNode;
    mozilla::dom::Document *mDocument;
    nsIContent *mLastSource;
    nsNativeMenuChangeObserver *mLastTarget;
    nsTArray<mozilla::UniquePtr<MutationRecord> > mPendingMutations;
    nsTHashMap<nsPtrHashKey<nsIContent>, nsNativeMenuChangeObserver *> mContentToObserverTable;

    static uint32_t sUpdateBlockersCount;
};

typedef nsTArray<RefPtr<nsNativeMenuDocListener> > nsNativeMenuDocListenerTArray;

/*
 * Implemented by classes that want to listen to mutation events from content
 * nodes.
 */
class nsNativeMenuChangeObserver
{
public:
    virtual void OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute) {}

    virtual void OnContentInserted(nsIContent *aContainer,
                                   nsIContent *aChild,
                                   nsIContent *aPrevSibling) {}

    virtual void OnContentRemoved(nsIContent *aContainer, nsIContent *aChild) {}

    // Signals the start of a sequence of more than 1 event for the specified
    // node. This only happens when events are flushed as all BlockUpdatesScope
    // instances go out of scope
    virtual void OnBeginUpdates(nsIContent *aContent) {};

    // Signals the end of a sequence of events
    virtual void OnEndUpdates() {};
};

#endif /* __nsNativeMenuDocListener_h__ */
