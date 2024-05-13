/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Original: https://github.com/mozilla-extensions/webcompat-addon/blob/main/src/experiment-apis/aboutConfigPrefs.js */
'use strict';

// Range.createContextualFragment() unexpectedly drops XUL elements.
// Moreover, the security mechanism of the browser rejects adoptation of elements
// created by DOMParser(). Thus we need to create elements manually...
function element(document, NS, localName, attributes, children) {
  if (Array.isArray(attributes)) {
    children   = attributes;
    attributes = {};
  }
  const element = document.createElementNS(NS, localName);
  if (attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child == 'string')
        element.appendChild(document.createTextNode(child));
      else
        element.appendChild(child);
    }
  }
  return element;
}

function initSidebarCategory(document, { locale, BASE_URL, BASE_PREF }) {
  const HTML = 'http://www.w3.org/1999/xhtml';
  const XUL  = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

  if (document.querySelector('#category-tabsSidebar'))
    return true;

  const generalItem = document.querySelector('#category-general');
  if (!generalItem)
    return false;

  try {
    const range = document.createRange();

    range.selectNode(document.head);
    range.collapse(false);
    range.insertNode(element(document, HTML, 'style', {
      id: 'category-tabsSidebar-style',
    }, [`
      #category-tabsSidebar > .category-icon {
        list-style-image: url("${BASE_URL}resources/24x24.svg#default-context");
      }
      [data-category="paneTabsSidebar"] .sub {
        margin-left: 1em;
      }
    `.trim()]));

    range.selectNode(generalItem);
    range.collapse(false);
    range.insertNode(element(document, XUL, 'richlistitem', {
      id:          'category-tabsSidebar',
      'class':     'category',
      value:       'paneTabsSidebar',
      align:       'center',
      tooltiptext: locale.get('preferencesCategoryTooltipText'),
    }, [
      element(document, XUL, 'image', {
        'class': 'category-icon',
      }),
      element(document, XUL, 'label', {
        'class': 'category-name',
        flex:    1,
      }, [locale.get('preferencesCategoryName')]),
    ]));

    const preferenceItems = document.createDocumentFragment();
    preferenceItems.appendChild(element(document, HTML, 'template', {
      id: 'template-paneTabsSidebar',
    }));
    // We need to insert elements directly to the page because XUL elements are missing
    // on <html:template>.content and the browser just uses the `.content`.
    preferenceItems.appendChild(element(document, XUL, 'hbox', {
      id:              'tabsSidebarCategory',
      'class':         'subcategory',
      'data-category': 'paneTabsSidebar',
    }, [
      element(document, HTML, 'h1', [locale.get('preferencesCategoryName')]),
    ]));

    preferenceItems.appendChild(element(document, XUL, 'groupbox', {
      id:              'tabsSidebar_appearanceGroup',
      'data-category': 'paneTabsSidebar',
    }, [
      element(document, XUL, 'label', [
        element(document, HTML, 'h2', [locale.get('preferences_appearanceGroup_caption')]),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_hideHorizontalTabsWhileActiveBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_hideHorizontalTabsWhileActive',
          preference: `${BASE_PREF}hideHorizontalTabsWhileActive`,
          label:      locale.get('preferences_hideHorizontalTabsWhileActive_label'),
          accesskey:  locale.get('preferences_hideHorizontalTabsWhileActive_accesskey'),
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_faviconizePinnedTabsBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_faviconizePinnedTabs',
          preference: `${BASE_PREF}faviconizePinnedTabs`,
          label:      locale.get('config_faviconizePinnedTabs_label'),
          accesskey:  locale.get('preferences_faviconizePinnedTabs_accesskey'),
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_showTabPreviewBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_showTabPreview',
          preference: `${BASE_PREF}showTabPreview`,
          label:      locale.get('preferences_showTabPreview_label'),
          accesskey:  locale.get('preferences_showTabPreview_accesskey'),
        }),
      ]),
    ]));

    preferenceItems.appendChild(element(document, XUL, 'groupbox', {
      id:              'tabsSidebar_autoStickyTabsBox',
      'data-category': 'paneTabsSidebar',
    }, [
      element(document, XUL, 'label', { id: 'tabsSidebar_stickyActiveTabBox_caption' }, [
        element(document, HTML, 'h2', [locale.get('config_autoStickyTab_caption')]),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_stickyActiveTabBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_stickyActiveTab',
          preference: `${BASE_PREF}stickyActiveTab`,
          label:      locale.get('config_stickyActiveTab_label'),
          accesskey:  locale.get('preferences_stickyActiveTab_accesskey'),
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_stickySoundPlayingTabBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_stickySoundPlayingTab',
          preference: `${BASE_PREF}stickySoundPlayingTab`,
          label:      locale.get('config_stickySoundPlayingTab_label'),
          accesskey:  locale.get('preferences_stickySoundPlayingTab_accesskey'),
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_stickySharingTabBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_stickySharingTab',
          preference: `${BASE_PREF}stickySharingTab`,
          label:      locale.get('config_stickySharingTab_label'),
          accesskey:  locale.get('preferences_stickySharingTab_accesskey'),
        }),
      ]),
    ]));

    preferenceItems.appendChild(element(document, XUL, 'groupbox', {
      id:              'tabsSidebar_treeBehaviorGroup',
      'data-category': 'paneTabsSidebar',
    }, [
      element(document, XUL, 'label', [
        element(document, HTML, 'h2', [locale.get('preferences_treeBehaviorGroup_caption')]),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_useTreeBox' }, [
        element(document, XUL, 'checkbox', {
          id:        'tabsSidebar_useTree',
          label:     locale.get('preferences_useTree'),
          accesskey: locale.get('preferences_useTree_accesskey'),
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_autoCollapseExpandSubtreeOnAttachBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_autoCollapseExpandSubtreeOnAttach',
          preference: `${BASE_PREF}autoCollapseExpandSubtreeOnAttach`,
          label:      locale.get('config_autoCollapseExpandSubtreeOnAttach_label'),
          accesskey:  locale.get('preferences_autoCollapseExpandSubtreeOnAttach_accesskey'),
          class:      'tree-option',
        }),
      ]),
      element(document, XUL, 'vbox', { id: 'tabsSidebar_autoCollapseExpandSubtreeOnSelectBox' }, [
        element(document, XUL, 'checkbox', {
          id:         'tabsSidebar_autoCollapseExpandSubtreeOnSelect',
          preference: `${BASE_PREF}autoCollapseExpandSubtreeOnSelect`,
          label:      locale.get('config_autoCollapseExpandSubtreeOnSelect_label'),
          accesskey:  locale.get('preferences_autoCollapseExpandSubtreeOnSelect_accesskey'),
          class:      'tree-option',
        }),
      ]),
      element(document, XUL, 'hbox', {
        id:    'tabsSidebar_treeDoubleClickBehaviorBox',
        align: 'center',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_treeDoubleClickBehavior_caption',
          control:   'tabsSidebar_treeDoubleClickBehavior',
          accesskey: locale.get('preferences_treeDoubleClickBehavior_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_treeDoubleClickBehavior_caption')]),
        element(document, XUL, 'menulist', {
          id:         'tabsSidebar_treeDoubleClickBehavior',
          preference: `${BASE_PREF}treeDoubleClickBehavior`,
          class:      'tree-option',
        }, [
          element(document, XUL, 'menupopup', {
            class: 'in-menulist',
          }, [
            element(document, XUL, 'menuitem', {
              value: '1',
              label: locale.get('config_treeDoubleClickBehavior_toggleCollapsed'),
            }),
            element(document, XUL, 'menuitem', {
              value: '4',
              label: locale.get('config_treeDoubleClickBehavior_toggleSticky'),
            }),
            element(document, XUL, 'menuitem', {
              value: '3',
              label: locale.get('config_treeDoubleClickBehavior_close'),
            }),
            element(document, XUL, 'menuitem', {
              value: '0',
              label: locale.get('config_treeDoubleClickBehavior_none'),
            }),
          ]),
        ]),
      ]),
      element(document, XUL, 'hbox', {
        id:    'tabsSidebar_successorTabControlLevelBox',
        align: 'center',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_successorTabControlLevel_caption',
          control:   'tabsSidebar_successorTabControlLevel',
          accesskey: locale.get('preferences_successorTabControlLevel_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_successorTabControlLevel_caption')]),
        element(document, XUL, 'menulist', {
          id:         'tabsSidebar_successorTabControlLevel',
          preference: `${BASE_PREF}successorTabControlLevel`,
          class:     'tree-option',
        }, [
          element(document, XUL, 'menupopup', {
            class: 'in-menulist',
          }, [
            element(document, XUL, 'menuitem', {
              value: '2',
              label: locale.get('config_successorTabControlLevel_inTree'),
            }),
            element(document, XUL, 'menuitem', {
              value: '1',
              label: locale.get('config_successorTabControlLevel_simulateDefault'),
            }),
            element(document, XUL, 'menuitem', {
              value: '0',
              label: locale.get('config_successorTabControlLevel_never'),
            }),
          ]),
        ]),
      ]),
      element(document, XUL, 'hbox', {
        id:    'tabsSidebar_dropLinksOnTabBehaviorBox',
        align: 'center',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_dropLinksOnTabBehavior_caption',
          control:   'tabsSidebar_dropLinksOnTabBehavior',
          accesskey: locale.get('preferences_dropLinksOnTabBehavior_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_dropLinksOnTabBehavior_caption')]),
        element(document, XUL, 'menulist', {
          id:         'tabsSidebar_dropLinksOnTabBehavior',
          preference: `${BASE_PREF}dropLinksOnTabBehavior`,
          class:      'tree-option',
        }, [
          element(document, XUL, 'menupopup', {
            class: 'in-menulist',
          }, [
            element(document, XUL, 'menuitem', {
              value: '0',
              label: locale.get('config_dropLinksOnTabBehavior_ask'),
            }),
            element(document, XUL, 'menuitem', {
              value: '1',
              label: locale.get('config_dropLinksOnTabBehavior_load'),
            }),
            element(document, XUL, 'menuitem', {
              value: '2',
              label: locale.get('config_dropLinksOnTabBehavior_newtab'),
            }),
          ]),
        ]),
      ]),
    ]));

    preferenceItems.appendChild(element(document, XUL, 'groupbox', {
      id:              'tabsSidebar_autoAttachGroup',
      'data-category': 'paneTabsSidebar',
    }, [
      element(document, XUL, 'label', [
        element(document, HTML, 'h2', [locale.get('preferences_autoAttachGroup_caption')]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachOnOpenedWithOwnerBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachOnOpenedWithOwner_before',
          control:   'tabsSidebar_autoAttachOnOpenedWithOwner',
          accesskey: locale.get('preferences_autoAttachOnOpenedWithOwner_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_autoAttachOnOpenedWithOwner_before')]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachOnOpenedWithOwnerMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachOnOpenedWithOwner',
            preference: `${BASE_PREF}autoAttachOnOpenedWithOwner`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachOnOpenedWithOwner_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachOnOpenedWithOwner_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachOnOpenedWithOwner_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachOnOpenedWithOwner_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '5',
                label: locale.get('config_autoAttachOnOpenedWithOwner_childNextToLastRelatedTab'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachOnOpenedWithOwner_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachOnOpenedWithOwner_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachOnOpenedWithOwner_after',
            control: 'tabsSidebar_autoAttachOnOpenedWithOwner',
            class:   'tree-option',
          }, [locale.get('config_autoAttachOnOpenedWithOwner_after')]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_insertNewTabFromPinnedTabAtBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_insertNewTabFromPinnedTabAt_before',
          control:   'tabsSidebar_insertNewTabFromPinnedTabAt',
          accesskey: locale.get('preferences_insertNewTabFromPinnedTabAt_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_insertNewTabFromPinnedTabAt_caption')]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_insertNewTabFromPinnedTabAtMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_insertNewTabFromPinnedTabAt',
            preference: `${BASE_PREF}insertNewTabFromPinnedTabAt`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_insertNewTabFromPinnedTabAt_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_insertNewTabFromPinnedTabAt_nextToLastRelatedTab'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_insertNewTabFromPinnedTabAt_top'),
              }),
              element(document, XUL, 'menuitem', {
                value: '1',
                label: locale.get('config_insertNewTabFromPinnedTabAt_end'),
              }),
            ]),
          ]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachOnNewTabCommandBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachOnNewTabCommand_before',
          control:   'tabsSidebar_autoAttachOnNewTabCommand',
          accesskey: locale.get('preferences_autoAttachOnNewTabCommand_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_autoAttachOnNewTabCommand_before')]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachOnNewTabCommandMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachOnNewTabCommand',
            preference: `${BASE_PREF}autoAttachOnNewTabCommand`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachOnNewTabCommand_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachOnNewTabCommand_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachOnNewTabCommand_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachOnNewTabCommand_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachOnNewTabCommand_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachOnNewTabCommand_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachOnNewTabCommand_after',
            control: 'tabsSidebar_autoAttachOnNewTabCommand',
            class:   'tree-option',
          }, [locale.get('config_autoAttachOnNewTabCommand_after')]),
        ]),
        element(document, XUL, 'vbox', {
          id: 'tabsSidebar_autoAttachOnNewTabButtonMiddleClickBox',
          class: 'sub',
        }, [
          element(document, XUL, 'label', {
            id:        'tabsSidebar_autoAttachOnNewTabButtonMiddleClick_before',
            control:   'tabsSidebar_autoAttachOnNewTabButtonMiddleClick',
            accesskey: locale.get('preferences_autoAttachOnNewTabButtonMiddleClick_accesskey'),
            class:     'tree-option',
          }, [locale.get('config_autoAttachOnNewTabButtonMiddleClick_before')]),
          element(document, XUL, 'hbox', {
            id:    'tabsSidebar_autoAttachOnNewTabButtonMiddleClickMenulistBox',
            align: 'center',
            class: 'sub',
          }, [
            element(document, XUL, 'menulist', {
              id:         'tabsSidebar_autoAttachOnNewTabButtonMiddleClick',
              preference: `${BASE_PREF}autoAttachOnNewTabButtonMiddleClick`,
              class:      'tree-option',
            }, [
              element(document, XUL, 'menupopup', {
                class: 'in-menulist',
              }, [
                element(document, XUL, 'menuitem', {
                  value: '-1',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_noControl'),
                }),
                element(document, XUL, 'menuitem', {
                  value: '0',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_independent'),
                }),
                element(document, XUL, 'menuitem', {
                  value: '6',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_childTop'),
                }),
                element(document, XUL, 'menuitem', {
                  value: '7',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_childEnd'),
                }),
                element(document, XUL, 'menuitem', {
                  value: '2',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_sibling'),
                }),
                element(document, XUL, 'menuitem', {
                  value: '3',
                  label: locale.get('config_autoAttachOnNewTabButtonMiddleClick_nextSibling'),
                }),
              ]),
            ]),
            element(document, XUL, 'label', {
              id:      'tabsSidebar_autoAttachOnNewTabButtonMiddleClick_after',
              control: 'tabsSidebar_autoAttachOnNewTabButtonMiddleClick',
              class:   'tree-option',
            }, [locale.get('config_autoAttachOnNewTabButtonMiddleClick_after')]),
          ]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachOnDuplicatedBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachOnDuplicated_before',
          control:   'tabsSidebar_autoAttachOnDuplicated',
          accesskey: locale.get('preferences_autoAttachOnDuplicated_accesskey'),
          class:     'tree-option',
        }, [locale.get('config_autoAttachOnDuplicated_before')]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachOnDuplicatedMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachOnDuplicated',
            preference: `${BASE_PREF}autoAttachOnDuplicated`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachOnDuplicated_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachOnDuplicated_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachOnDuplicated_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachOnDuplicated_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachOnDuplicated_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachOnDuplicated_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachOnDuplicated_after',
            control: 'tabsSidebar_autoAttachOnDuplicated',
            class:   'tree-option',
          }, [locale.get('config_autoAttachOnDuplicated_after')]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachSameSiteOrphanBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachSameSiteOrphan_before',
          control:   'tabsSidebar_autoAttachSameSiteOrphan',
          accesskey: locale.get('preferences_autoAttachSameSiteOrphan_accesskey'),
          class:     'tree-option',
        }, [`${locale.get('config_sameSiteOrphan_caption')}: ${locale.get('config_autoAttachSameSiteOrphan_before')}`,]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachSameSiteOrphanMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachSameSiteOrphan',
            preference: `${BASE_PREF}autoAttachSameSiteOrphan`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachSameSiteOrphan_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachSameSiteOrphan_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachSameSiteOrphan_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachSameSiteOrphan_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachSameSiteOrphan_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachSameSiteOrphan_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachSameSiteOrphan_after',
            control: 'tabsSidebar_autoAttachSameSiteOrphan',
            class:   'tree-option',
          }, [locale.get('config_autoAttachSameSiteOrphan_after')]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachOnOpenedFromExternalBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachOnOpenedFromExternal_before',
          control:   'tabsSidebar_autoAttachOnOpenedFromExternal',
          accesskey: locale.get('preferences_autoAttachOnOpenedFromExternal_accesskey'),
          class:     'tree-option',
        }, [`${locale.get('config_fromExternal_caption')}: ${locale.get('config_autoAttachOnOpenedFromExternal_before')}`]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachOnOpenedFromExternalMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachOnOpenedFromExternal',
            preference: `${BASE_PREF}autoAttachOnOpenedFromExternal`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachOnOpenedFromExternal_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachOnOpenedFromExternal_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachOnOpenedFromExternal_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachOnOpenedFromExternal_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachOnOpenedFromExternal_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachOnOpenedFromExternal_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachOnOpenedFromExternal_after',
            control: 'tabsSidebar_autoAttachOnOpenedFromExternal',
            class:   'tree-option',
          }, [locale.get('config_autoAttachOnOpenedFromExternal_after')]),
        ]),
      ]),
      element(document, XUL, 'vbox', {
        id: 'tabsSidebar_autoAttachOnAnyOtherTriggerBox',
      }, [
        element(document, XUL, 'label', {
          id:        'tabsSidebar_autoAttachOnAnyOtherTrigger_before',
          control:   'tabsSidebar_autoAttachOnAnyOtherTrigger',
          accesskey: locale.get('preferences_autoAttachOnAnyOtherTrigger_accesskey'),
          class:     'tree-option',
        }, [`${locale.get('config_anyOtherTrigger_caption')}: ${locale.get('config_autoAttachOnAnyOtherTrigger_before')}`]),
        element(document, XUL, 'hbox', {
          id:    'tabsSidebar_autoAttachOnAnyOtherTriggerMenulistBox',
          align: 'center',
          class: 'sub',
        }, [
          element(document, XUL, 'menulist', {
            id:         'tabsSidebar_autoAttachOnAnyOtherTrigger',
            preference: `${BASE_PREF}autoAttachOnAnyOtherTrigger`,
            class:      'tree-option',
          }, [
            element(document, XUL, 'menupopup', {
              class: 'in-menulist',
            }, [
              element(document, XUL, 'menuitem', {
                value: '-1',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_noControl'),
              }),
              element(document, XUL, 'menuitem', {
                value: '0',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_independent'),
              }),
              element(document, XUL, 'menuitem', {
                value: '6',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_childTop'),
              }),
              element(document, XUL, 'menuitem', {
                value: '7',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_childEnd'),
              }),
              element(document, XUL, 'menuitem', {
                value: '2',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_sibling'),
              }),
              element(document, XUL, 'menuitem', {
                value: '3',
                label: locale.get('config_autoAttachOnAnyOtherTrigger_nextSibling'),
              }),
            ]),
          ]),
          element(document, XUL, 'label', {
            id:      'tabsSidebar_autoAttachOnAnyOtherTrigger_after',
            control: 'tabsSidebar_autoAttachOnAnyOtherTrigger',
            class:   'tree-option',
          }, [locale.get('config_autoAttachOnAnyOtherTrigger_after')]),
        ]),
      ]),
    ]));

    range.selectNodeContents(document.querySelector('#mainPrefPane'));
    range.collapse(false);
    range.insertNode(preferenceItems);

    range.detach();

    // We cannot remove entries added by Preferences.add() so we need to avoid re-adding of entries.
    for (const prefInfo of [
      { id: `${BASE_PREF}hideHorizontalTabsWhileActive`, type: 'bool' },
      { id: `${BASE_PREF}faviconizePinnedTabs`, type: 'bool' },
      { id: `${BASE_PREF}showTabPreview`, type: 'bool' },
      { id: `${BASE_PREF}stickyActiveTab`, type: 'bool' },
      { id: `${BASE_PREF}stickySoundPlayingTab`, type: 'bool' },
      { id: `${BASE_PREF}stickySharingTab`, type: 'bool' },
      { id: `${BASE_PREF}autoCollapseExpandSubtreeOnAttach`, type: 'bool' },
      { id: `${BASE_PREF}autoCollapseExpandSubtreeOnSelect`, type: 'bool' },
      { id: `${BASE_PREF}treeDoubleClickBehavior`, type: 'unichar' },
      { id: `${BASE_PREF}successorTabControlLevel`, type: 'unichar' },
      { id: `${BASE_PREF}dropLinksOnTabBehavior`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnOpenedWithOwner`, type: 'unichar' },
      { id: `${BASE_PREF}insertNewTabFromPinnedTabAt`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnNewTabCommand`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnNewTabButtonMiddleClick`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnDuplicated`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachSameSiteOrphan`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnOpenedFromExternal`, type: 'unichar' },
      { id: `${BASE_PREF}autoAttachOnAnyOtherTrigger`, type: 'unichar' },
    ]) {
      if (!document.defaultView.Preferences.get(prefInfo.id))
        document.defaultView.Preferences.add(prefInfo);
    }
    document.defaultView.gSidebarPage = {
      init() {
        document.querySelector('#tabsSidebar_useTree').checked = (
          Services.prefs.getBoolPref(`${BASE_PREF}autoAttach`) &&
          Services.prefs.getBoolPref(`${BASE_PREF}syncParentTabAndOpenerTab`) &&
          Services.prefs.getStringPref(`${BASE_PREF}maxTreeLevel`) != '0'
        );
        this.updateTreeOptions();

        this.onCommand = this.onCommand.bind(this);
        this.onButtonClick = this.onButtonClick.bind(this);
        this.onButtonKeyDown = this.onButtonKeyDown.bind(this);

        document.addEventListener('command', this.onCommand);
        document.addEventListener('click', this.onButtonClick);
        document.addEventListener('keydown', this.onButtonKeyDown);
      },

      uninit() {
        document.removeEventListener('command', this.onCommand);
        document.removeEventListener('click', this.onButtonClick);
        document.removeEventListener('keydown', this.onButtonKeyDown);
      },

      updateTreeOptions() {
        const active = document.querySelector('#tabsSidebar_useTree').checked;
        for (const node of document.querySelectorAll('[data-category="paneTabsSidebar"] .tree-option')) {
          node.disabled = !active;
        }
      },

      openAdvancedOptions() {
        const url = `${BASE_URL}options/options.html#!`;

        const windows = Services.wm.getEnumerator('navigator:browser');
        while (windows.hasMoreElements()) {
          const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
          if (!win.gBrowser)
            continue;
          for (const tab of win.gBrowser.tabs) {
            if (tab.linkedBrowser.currentURI.spec != url)
              continue;
            win.gBrowser.selectedTab = tab;
            return;
          }
        }

        Services.wm.getMostRecentBrowserWindow()
          .openLinkIn(url, 'tab', {
            allowThirdPartyFixup: false,
            triggeringPrincipal:  Services.scriptSecurityManager.getSystemPrincipal(),
            inBackground:         false,
          });
      },

      onCommand(event) {
        switch (event.target.id) {
          case 'tabsSidebar_useTree':
            if (event.target.checked) {
              Services.prefs.setBoolPref(`${BASE_PREF}autoAttach`, true);
              Services.prefs.setBoolPref(`${BASE_PREF}syncParentTabAndOpenerTab`, true);
              Services.prefs.setStringPref(`${BASE_PREF}maxTreeLevel`, '-1');
            }
            else {
              Services.prefs.setBoolPref(`${BASE_PREF}autoAttach`, false);
              Services.prefs.setBoolPref(`${BASE_PREF}syncParentTabAndOpenerTab`, false);
              Services.prefs.setStringPref(`${BASE_PREF}maxTreeLevel`, '0');
            }
            this.updateTreeOptions();
            break;
        }
      },

      onButtonClick(event) {
        if (event.button != 0)
          return;

        switch (event.target.id) {
          default:
            break;
        }
      },

      onButtonKeyDown(event) {
        if (event.key != 'Enter')
          return;

        switch (event.target.id) {
          default:
            break;
        }
      },
    };
    document.defaultView.register_module('paneTabsSidebar', document.defaultView.gSidebarPage);

    if (document.URL.endsWith('#tabsSidebar')) {
      document.querySelector('#categories').selectItem(document.querySelector('#category-tabsSidebar'));
      document.defaultView.gotoPref('paneTabsSidebar');
      document.defaultView.gCategoryInits.get('paneTabsSidebar').init();
    }
  }
  catch (error) {
    console.error(error);
  }

  return true;
}

function uninitSidebarCategory(document) {
  for (const node of document.querySelectorAll(`
    #category-tabsSidebar-style,
    #category-tabsSidebar,
    #template-paneTabsSidebar,
    [data-category="paneTabsSidebar"]
  `)) {
    node.parentNode.removeChild(node);
  }

  document.removeEventListener('command', document.defaultView.gSidebarPage.onCommand);
  document.removeEventListener('click', document.defaultView.gSidebarPage.onButtonClick);
  document.removeEventListener('keydown', document.defaultView.gSidebarPage.onButtonKeyDown);

  // We cannot remove entries added by Preferences.add()...

  document.defaultView.gCategoryModules.delete('paneTabsSidebar');
  document.defaultView.gCategoryInits.delete('paneTabsSidebar');
  document.defaultView.gSidebarPage.uninit();
  document.defaultView.gSidebarPage = null;
}


const AboutPreferencesWatcher = {
  WATCHING_URLS: [
    'about:preferences',
  ],
  BASE_URL: null, // this need to be replaced with "moz-extension://..../"
  BASE_PREF: 'browser.sidebar.', // null,
  locale:   null, // this need to be replaced with a map

  handleWindow(win) {
    if (!win ||
        !win.location)
      return false;

    const document = win.document;
    if (!document)
      return false;

    if (win.location.href.startsWith('about:preferences'))
      return initSidebarCategory(document, {
        locale:   this.locale,
        BASE_URL: this.BASE_URL,
        BASE_PREF: this.BASE_PREF,
      });

    return true;
  },

  unhandleWindow(win) {
    if (!win ||
        !win.location)
      return;

    const document = win.document;
    if (!document)
      return;

    if (win.location.href.startsWith('about:preferences'))
      return uninitSidebarCategory(document);
  },

  onPrefChanged(name) {
    switch (name) {
      case 'browser.tabs.selectOwnerOnClose':
        Services.prefs.setBoolPref(`${this.BASE_PREF}simulateSelectOwnerOnClose`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.loadInBackground':
        Services.prefs.setBoolPref(`${this.BASE_PREF}simulateTabsLoadInBackgroundInverted`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.warnOnClose':
        Services.prefs.setBoolPref(`${this.BASE_PREF}warnOnCloseTabs`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.searchclipboardfor.middleclick':
        Services.prefs.setBoolPref(`${this.BASE_PREF}middleClickPasteURLOnNewTabButton`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.insertAfterCurrent':
      case 'browser.tabs.insertRelatedAfterCurrent': {
        const insertAfterCurrent        = Services.prefs.getBoolPref('browser.tabs.insertAfterCurrent');
        const insertRelatedAfterCurrent = Services.prefs.getBoolPref('browser.tabs.insertRelatedAfterCurrent');
        const useTree = (
          Services.prefs.getBoolPref(`${this.BASE_PREF}autoAttach`, false) &&
          Services.prefs.getBoolPref(`${this.BASE_PREF}syncParentTabAndOpenerTab`, false)
        );
        Services.prefs.setStringPref(`${this.BASE_PREF}autoAttachOnOpenedWithOwner`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 5 :
              insertAfterCurrent ? 6 :
                0);
        Services.prefs.setStringPref(`${this.BASE_PREF}insertNewTabFromPinnedTabAt`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 3 :
              insertAfterCurrent ? 0 :
                1);
        Services.prefs.setStringPref(`${this.BASE_PREF}insertNewTabFromFirefoxViewAt`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 3 :
              insertAfterCurrent ? 0 :
                1);
      }; break;
    }
  },

  // as an XPCOM component...
  classDescription: 'Waterfox Chrome Window Watcher for about:preferences',
  contractID:       '@waterfox.net/chrome-window-watche-about-preferences;1',
  classID:          Components.ID('{c8a990cf-b9a3-4b4c-829c-a1dfc5753527}'),
  QueryInterface:   ChromeUtils.generateQI([
    'nsIContentPolicy',
    'nsIObserver',
    'nsISupportsWeakReference',
  ]),

  // nsIContentPolicy
  shouldLoad(contentLocation, loadInfo, mimeTypeGuess) {
    if (this.WATCHING_URLS.some(url => contentLocation.spec.startsWith(url))) {
      const startAt = Date.now();
      const topWin  = loadInfo.browsingContext.topChromeWindow;
      const timer   = topWin.setInterval(() => {
        if (Date.now() - startAt > 1000) {
          // timeout
          topWin.clearInterval(timer);
          return;
        }
        const win = loadInfo.browsingContext.window;
        if (!win)
          return;
        try {
          if (this.handleWindow(win))
            topWin.clearInterval(timer);
        }
        catch(_error) {
        }
      }, 250);
    }
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  shouldProcess(contentLocation, loadInfo, mimeTypeGuess) {
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  // nsIObserver
  observe(subject, topic, data) {
    switch (topic) {
      case 'domwindowopened':
        subject
          //.QueryInterface(Components.interfaces.nsIDOMWindow)
          .addEventListener('DOMContentLoaded', () => {
            this.handleWindow(subject);
          }, { once: true });
        break;

      case 'nsPref:changed':
        this.onPrefChanged(data);
        break;
    }
  },

  createInstance(iid) {
    return this.QueryInterface(iid);
  },
};

this.prefs = class extends ExtensionAPI {
  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;
    const extensionIDBase = context.extension.id.split('@')[0];
    //const extensionPrefNameBase = `extensions.${extensionIDBase}.`;

    AboutPreferencesWatcher.BASE_URL = context.extension.baseURL;
    //AboutPreferencesWatcher.BASE_PREF = extensionPrefNameBase;
    AboutPreferencesWatcher.locale   = {
      get(key) {
        key = key.toLowerCase();
        if (this.selected.has(key))
          return this.selected.get(key);
        return this.default.get(key) || key;
      },
      default:  context.extension.localeData.messages.get(context.extension.localeData.defaultLocale),
      selected: context.extension.localeData.messages.get(context.extension.localeData.selectedLocale),
    };

    //const resourceURI = Services.io.newURI('resources', null, context.extension.rootURI);
    //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
    //handler.setSubstitution('waterfox-bridge', resourceURI);

    // watch loading of about:preferences in subframes
    const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    registrar.registerFactory(
      AboutPreferencesWatcher.classID,
      AboutPreferencesWatcher.classDescription,
      AboutPreferencesWatcher.contractID,
      AboutPreferencesWatcher
    );
    Services.catMan.addCategoryEntry(
      'content-policy',
      AboutPreferencesWatcher.contractID,
      AboutPreferencesWatcher.contractID,
      false,
      true
    );

    // handle loading of about:preferences as a top level window
    Services.ww.registerNotification(AboutPreferencesWatcher);

    // handle already opened about:preferences pages
    const windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
      AboutPreferencesWatcher.handleWindow(win);

      if (win.gBrowser) { // handle about:preferences in browser tabs
        for (const tab of win.gBrowser.tabs) {
          if (AboutPreferencesWatcher.WATCHING_URLS.some(url => tab.linkedBrowser.currentURI.spec.startsWith(url)))
            AboutPreferencesWatcher.handleWindow(tab.linkedBrowser.contentWindow);
        }
      }
    }

    // Synchronize simulation configs with the browser's preferences
    for (const [source, dest] of Object.entries({
      'browser.tabs.selectOwnerOnClose': `${AboutPreferencesWatcher.BASE_PREF}simulateSelectOwnerOnClose`,
      'browser.tabs.loadInBackground':   `${AboutPreferencesWatcher.BASE_PREF}simulateTabsLoadInBackgroundInverted`,
      'browser.tabs.warnOnClose':        `${AboutPreferencesWatcher.BASE_PREF}warnOnCloseTabs`,
      'browser.tabs.searchclipboardfor.middleclick': `${AboutPreferencesWatcher.BASE_PREF}middleClickPasteURLOnNewTabButton`,
    })) {
      Services.prefs.setBoolPref(dest, Services.prefs.getBoolPref(source));
    }
    Services.prefs.addObserver('browser.tabs.', AboutPreferencesWatcher);
    AboutPreferencesWatcher.onPrefChanged('browser.tabs.insertAfterCurrent');

    return {
      prefs: {
        onChanged: new EventManager({
          context,
          name: 'prefs.onChanged',
          register: (fire) => {
            const observe = (_subject, _topic, data) => {
              fire.async(data.replace(AboutPreferencesWatcher.BASE_PREF, '')).catch(() => {}); // ignore Message Manager disconnects
            };
            Services.prefs.addObserver(AboutPreferencesWatcher.BASE_PREF, observe);
            return () => {
              Services.prefs.removeObserver(AboutPreferencesWatcher.BASE_PREF, observe);
            };
          },
        }).api(),
        async getBoolValue(name, defaultValue = false) {
          try {
            return Services.prefs.getBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setBoolValue(name, value) {
          Services.prefs.setBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultBoolValue(name, value) {
          Services.prefs.getDefaultBranch(null).setBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async getStringValue(name, defaultValue = '') {
          try {
            return Services.prefs.getStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setStringValue(name, value) {
          Services.prefs.setStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultStringValue(name, value) {
          Services.prefs.getDefaultBranch(null).setStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async getIntValue(name, defaultValue = 0) {
          try {
            return Services.prefs.getIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setIntValue(name, value) {
          Services.prefs.setIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultIntValue(name, value) {
          Services.prefs.getDefaultBranch(null).setIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown)
      return;

    const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    registrar.unregisterFactory(
      AboutPreferencesWatcher.classID,
      AboutPreferencesWatcher
    );
    Services.catMan.deleteCategoryEntry(
      'content-policy',
      AboutPreferencesWatcher.contractID,
      false
    );

    Services.ww.unregisterNotification(AboutPreferencesWatcher);

    const windows = Services.wm.getEnumerator(null);
    while (windows.hasMoreElements()) {
      const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
      AboutPreferencesWatcher.unhandleWindow(win);
      if (!win.gBrowser)
        continue;
      for (const tab of win.gBrowser.tabs) {
        if (AboutPreferencesWatcher.WATCHING_URLS.some(url => tab.linkedBrowser.currentURI.spec.startsWith(url)))
          AboutPreferencesWatcher.unhandleWindow(tab.linkedBrowser.contentWindow);
      }
    }

    //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
    //handler.setSubstitution('waterfox-bridge', null);

    Services.prefs.removeObserver('browser.tabs.', AboutPreferencesWatcher);
  }
};
