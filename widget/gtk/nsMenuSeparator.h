/* -*- Mode: C++; tab-width: 4; indent-tabs-mode: nil; c-basic-offset: 4 -*- */
/* vim:expandtab:shiftwidth=4:tabstop=4:
 */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef __nsMenuSeparator_h__
#define __nsMenuSeparator_h__

#include "mozilla/Attributes.h"

#include "nsMenuObject.h"

class nsIContent;
class nsAtom;
class nsMenuContainer;

// Menu separator class
class nsMenuSeparator final : public nsMenuObject
{
public:
    nsMenuSeparator(nsMenuContainer *aParent, nsIContent *aContent);
    ~nsMenuSeparator();

    nsMenuObject::EType Type() const override;

private:
    void InitializeNativeData() override;
    void Update(const mozilla::ComputedStyle *aComputedStyle) override;
    bool IsCompatibleWithNativeData(DbusmenuMenuitem *aNativeData) const override;
    nsMenuObject::PropertyFlags SupportedProperties() const override;

    void OnAttributeChanged(nsIContent *aContent, nsAtom *aAttribute) override;
};

#endif /* __nsMenuSeparator_h__ */
