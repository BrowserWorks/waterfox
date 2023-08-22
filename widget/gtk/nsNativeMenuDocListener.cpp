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
#include "nsContentUtils.h"
#include "nsAtom.h"
#include "nsIContent.h"

#include "nsMenuContainer.h"

#include "nsNativeMenuDocListener.h"

using namespace mozilla;

uint32_t nsNativeMenuDocListener::sUpdateBlockersCount = 0;

nsNativeMenuDocListenerTArray *gPendingListeners;

/*
 * Small helper which caches a single listener, so that consecutive
 * events which go to the same node avoid multiple hash table lookups
 */
class MOZ_STACK_CLASS DispatchHelper
{
public:
    DispatchHelper(nsNativeMenuDocListener *aListener,
                   nsIContent *aContent) :
                   mObserver(nullptr)
    {
        if (aContent == aListener->mLastSource) {
            mObserver = aListener->mLastTarget;
        } else {
            mObserver = aListener->mContentToObserverTable.Get(aContent);
            if (mObserver) {
                aListener->mLastSource = aContent;
                aListener->mLastTarget = mObserver;
            }
        }
    }

    ~DispatchHelper() { };

    nsNativeMenuChangeObserver* Observer() const { return mObserver; }

    bool HasObserver() const { return !!mObserver; }

private:
    nsNativeMenuChangeObserver *mObserver;
};

NS_IMPL_ISUPPORTS(nsNativeMenuDocListener, nsIMutationObserver)

nsNativeMenuDocListener::~nsNativeMenuDocListener()
{
    MOZ_ASSERT(mContentToObserverTable.Count() == 0,
               "Some nodes forgot to unregister listeners. This is bad! (and we're lucky we made it this far)");
    MOZ_COUNT_DTOR(nsNativeMenuDocListener);
}

void
nsNativeMenuDocListener::AttributeChanged(mozilla::dom::Element *aElement,
                                          int32_t aNameSpaceID,
                                          nsAtom *aAttribute,
                                          int32_t aModType,
                                          const nsAttrValue* aOldValue)
{
    if (sUpdateBlockersCount == 0) {
        DoAttributeChanged(aElement, aAttribute);
        return;
    }

    MutationRecord *m = mPendingMutations.AppendElement(MakeUnique<MutationRecord>())->get();
    m->mType = MutationRecord::eAttributeChanged;
    m->mTarget = aElement;
    m->mAttribute = aAttribute;

    ScheduleFlush(this);
}

void
nsNativeMenuDocListener::ContentAppended(nsIContent *aFirstNewContent)
{
    for (nsIContent *c = aFirstNewContent; c; c = c->GetNextSibling()) {
        ContentInserted(c);
    }
}

void
nsNativeMenuDocListener::ContentInserted(nsIContent *aChild)
{
    nsIContent* container = aChild->GetParent();
    if (!container) {
      return;
    }

    nsIContent *prevSibling = nsMenuContainer::GetPreviousSupportedSibling(aChild);

    if (sUpdateBlockersCount == 0) {
        DoContentInserted(container, aChild, prevSibling);
        return;
    }

    MutationRecord *m = mPendingMutations.AppendElement(MakeUnique<MutationRecord>())->get();
    m->mType = MutationRecord::eContentInserted;
    m->mTarget = container;
    m->mChild = aChild;
    m->mPrevSibling = prevSibling;

    ScheduleFlush(this);
}

void
nsNativeMenuDocListener::ContentRemoved(nsIContent *aChild,
                                        nsIContent *aPreviousSibling)
{
    nsIContent* container = aChild->GetParent();
    if (!container) {
      return;
    }

    if (sUpdateBlockersCount == 0) {
        DoContentRemoved(container, aChild);
        return;
    }

    MutationRecord *m = mPendingMutations.AppendElement(MakeUnique<MutationRecord>())->get();
    m->mType = MutationRecord::eContentRemoved;
    m->mTarget = container;
    m->mChild = aChild;

    ScheduleFlush(this);
}

void
nsNativeMenuDocListener::NodeWillBeDestroyed(nsINode *aNode)
{
    mDocument = nullptr;
}

void
nsNativeMenuDocListener::DoAttributeChanged(nsIContent *aContent,
                                            nsAtom *aAttribute)
{
    DispatchHelper h(this, aContent);
    if (h.HasObserver()) {
        h.Observer()->OnAttributeChanged(aContent, aAttribute);
    }
}

void
nsNativeMenuDocListener::DoContentInserted(nsIContent *aContainer,
                                           nsIContent *aChild,
                                           nsIContent *aPrevSibling)
{
    DispatchHelper h(this, aContainer);
    if (h.HasObserver()) {
        h.Observer()->OnContentInserted(aContainer, aChild, aPrevSibling);
    }
}

void
nsNativeMenuDocListener::DoContentRemoved(nsIContent *aContainer,
                                          nsIContent *aChild)
{
    DispatchHelper h(this, aContainer);
    if (h.HasObserver()) {
        h.Observer()->OnContentRemoved(aContainer, aChild);
    }
}

void
nsNativeMenuDocListener::DoBeginUpdates(nsIContent *aTarget)
{
    DispatchHelper h(this, aTarget);
    if (h.HasObserver()) {
        h.Observer()->OnBeginUpdates(aTarget);
    }
}

void
nsNativeMenuDocListener::DoEndUpdates(nsIContent *aTarget)
{
    DispatchHelper h(this, aTarget);
    if (h.HasObserver()) {
        h.Observer()->OnEndUpdates();
    }
}

void
nsNativeMenuDocListener::FlushPendingMutations()
{
    nsIContent *currentTarget = nullptr;
    bool inUpdateSequence = false;

    while (mPendingMutations.Length() > 0) {
        MutationRecord *m = mPendingMutations[0].get();

        if (m->mTarget != currentTarget) {
            if (inUpdateSequence) {
                DoEndUpdates(currentTarget);
                inUpdateSequence = false;
            }

            currentTarget = m->mTarget;

            if (mPendingMutations.Length() > 1 &&
                mPendingMutations[1]->mTarget == currentTarget) {
                DoBeginUpdates(currentTarget);
                inUpdateSequence = true;
            }
        }

        switch (m->mType) {
            case MutationRecord::eAttributeChanged:
                DoAttributeChanged(m->mTarget, m->mAttribute);
                break;
            case MutationRecord::eContentInserted:
                DoContentInserted(m->mTarget, m->mChild, m->mPrevSibling);
                break;
            case MutationRecord::eContentRemoved:
                DoContentRemoved(m->mTarget, m->mChild);
                break;
            default:
                MOZ_ASSERT_UNREACHABLE("Invalid type");
        }

        mPendingMutations.RemoveElementAt(0);
    }

    if (inUpdateSequence) {
        DoEndUpdates(currentTarget);
    }
}

/* static */ void
nsNativeMenuDocListener::ScheduleFlush(nsNativeMenuDocListener *aListener)
{
    MOZ_ASSERT(sUpdateBlockersCount > 0, "Shouldn't be doing this now");

    if (!gPendingListeners) {
        gPendingListeners = new nsNativeMenuDocListenerTArray;
    }

    if (gPendingListeners->IndexOf(aListener) ==
        nsNativeMenuDocListenerTArray::NoIndex) {
        gPendingListeners->AppendElement(aListener);
    }
}

/* static */ void
nsNativeMenuDocListener::CancelFlush(nsNativeMenuDocListener *aListener)
{
    if (!gPendingListeners) {
        return;
    }

    gPendingListeners->RemoveElement(aListener);
}

/* static */ void
nsNativeMenuDocListener::RemoveUpdateBlocker()
{
    if (sUpdateBlockersCount == 1 && gPendingListeners) {
        while (gPendingListeners->Length() > 0) {
            (*gPendingListeners)[0]->FlushPendingMutations();
            gPendingListeners->RemoveElementAt(0);
        }
    }

    MOZ_ASSERT(sUpdateBlockersCount > 0, "Negative update blockers count!");
    sUpdateBlockersCount--;
}

nsNativeMenuDocListener::nsNativeMenuDocListener(nsIContent *aRootNode) :
    mRootNode(aRootNode),
    mDocument(nullptr),
    mLastSource(nullptr),
    mLastTarget(nullptr)
{
    MOZ_COUNT_CTOR(nsNativeMenuDocListener);
}

void
nsNativeMenuDocListener::RegisterForContentChanges(nsIContent *aContent,
                                                   nsNativeMenuChangeObserver *aObserver)
{
    MOZ_ASSERT(aContent, "Need content parameter");
    MOZ_ASSERT(aObserver, "Need observer parameter");
    if (!aContent || !aObserver) {
        return;
    }

    DebugOnly<nsNativeMenuChangeObserver *> old;
    MOZ_ASSERT(!mContentToObserverTable.Get(aContent, &old) || old == aObserver,
               "Multiple observers for the same content node are not supported");

    mContentToObserverTable.InsertOrUpdate(aContent, aObserver);
}

void
nsNativeMenuDocListener::UnregisterForContentChanges(nsIContent *aContent)
{
    MOZ_ASSERT(aContent, "Need content parameter");
    if (!aContent) {
        return;
    }

    mContentToObserverTable.Remove(aContent);
    if (aContent == mLastSource) {
        mLastSource = nullptr;
        mLastTarget = nullptr;
    }
}

void
nsNativeMenuDocListener::Start()
{
    if (mDocument) {
        return;
    }

    mDocument = mRootNode->OwnerDoc();
    if (!mDocument) {
        return;
    }

    mDocument->AddMutationObserver(this);
}

void
nsNativeMenuDocListener::Stop()
{
    if (mDocument) {
        mDocument->RemoveMutationObserver(this);
        mDocument = nullptr;
    }

    CancelFlush(this);
    mPendingMutations.Clear();
}
