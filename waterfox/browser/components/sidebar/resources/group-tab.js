/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

(async function prepare(retryCount = 0) {
  if (retryCount > 10)
    throw new Error('could not prepare group tab contents');

  if (!document.documentElement) {
    setTimeout(prepare, 100, retryCount + 1);
    return false;
  }

  if (window.prepared ||
      document.documentElement.classList.contains('initialized'))
    return false;

  window.prepared = true;

  let gTitle;
  let gTitleField;
  let gTemporaryCheck;
  let gTemporaryAggressiveCheck;
  let gBrowserThemeDefinition;
  let gUserStyleRules;

  // Firefox sometimes clears the document title set at here, so we need to re-set it later.
  document.title = getTitle();
  // Failsafe 1: This is effective on newly opened tabs,
  // but won't effective on already opened and reinitialized tabs.
  window.addEventListener('DOMContentLoaded', () => {
    document.title = getTitle();
  }, { once: true });

  function getTitle() {
    const url = new URL(location.href);
    let title = url.searchParams.get('title');
    if (!title) {
      const matched = location.search.match(/^\?([^&;]*)/);
      if (matched)
        title = decodeURIComponent(matched[1]);
    }
    return title || browser.i18n.getMessage('groupTab_label_default');
  }

  function setTitle(title) {
    if (!gTitle)
      init();
    document.title = gTitle.textContent = gTitleField.value = title;
    updateParameters({ title });
  }

  function isTemporary() {
    const url = new URL(location.href);
    return url.searchParams.get('temporary') == 'true';
  }

  function isTemporaryAggressive() {
    const url = new URL(location.href);
    return url.searchParams.get('temporaryAggressive') == 'true';
  }

  function getOpenerTabId() {
    const url = new URL(location.href);
    return url.searchParams.get('openerTabId');
  }

  function getAliasTabId() {
    const url = new URL(location.href);
    return url.searchParams.get('aliasTabId');
  }

  function enterTitleEdit() {
    if (!gTitle)
      init();
    gTitle.style.display = 'none';
    gTitleField.style.display = 'inline';
    gTitleField.select();
    gTitleField.focus();
  }

  function exitTitleEdit() {
    if (!gTitle)
      init();
    gTitle.style.display = '';
    gTitleField.style.display = '';
  }

  function hasModifier(event) {
    return event.altKey ||
           event.ctrlKey ||
           event.metaKey ||
           event.shiftKey;
  }

  function isAcceled(event) {
    return /^Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
  }

  function updateParameters({ title } = {}) {
    const url = new URL(location.href);
    url.searchParams.set('title', title || getTitle() || '');

    if (gTemporaryCheck.checked)
      url.searchParams.set('temporary', 'true');
    else
      url.searchParams.delete('temporary');

    if (gTemporaryAggressiveCheck.checked)
      url.searchParams.set('temporaryAggressive', 'true');
    else
      url.searchParams.delete('temporaryAggressive');

    const opener = getOpenerTabId();
    if (opener)
      url.searchParams.set('openerTabId', opener);
    else
      url.searchParams.delete('openerTabId');

    const aliasTabId = getAliasTabId();
    if (aliasTabId)
      url.searchParams.set('aliasTabId', aliasTabId);
    else
      url.searchParams.delete('aliasTabId');

    history.replaceState({}, document.title, url.href);
  }

  async function init(retryCount = 0) {
    if (gTitle &&
        gTitleField &&
        gTemporaryCheck &&
        gTemporaryAggressiveCheck &&
        gBrowserThemeDefinition &&
        gUserStyleRules)
      return;

    if (retryCount > 10)
      throw new Error('could not initialize group tab contents');

    gTitle                    = document.querySelector('#title');
    gTitleField               = document.querySelector('#title-field');
    gTemporaryCheck           = document.querySelector('#temporary');
    gTemporaryAggressiveCheck = document.querySelector('#temporaryAggressive');
    gBrowserThemeDefinition   = document.querySelector('#browser-theme-definition');
    gUserStyleRules           = document.querySelector('#user-style-rules');

    if (!gTitle ||
        !gTitleField ||
        !gTemporaryCheck ||
        !gTemporaryAggressiveCheck ||
        !gBrowserThemeDefinition ||
        !gUserStyleRules) {
      setTimeout(init, 100, retryCount + 1);
      return;
    }

    gTitle.addEventListener('click', event => {
      if (event.button == 0 &&
          !hasModifier(event)) {
        enterTitleEdit();
        event.stopPropagation();
      }
    });
    gTitleField.addEventListener('keydown', event => {
      // Event.isComposing for the Enter key to finish composition is always
      // "false" on keyup, so we need to handle this on keydown.
      if (hasModifier(event) ||
          event.isComposing)
        return;

      switch (event.key) {
        case 'Escape':
          gTitleField.value = gTitle.textContent;
          exitTitleEdit();
          break;

        case 'Enter':
          setTitle(gTitleField.value);
          exitTitleEdit();
          break;

        case 'F2':
          event.stopPropagation();
          break;
      }
    });
    window.addEventListener('mouseup', event => {
      const closebox = event.target.closest('li span.closebox');
      if (closebox) {
        const tabId = closebox.dataset.tabId;
        browser.runtime.sendMessage({
          type:             'ws:remove-tabs-internally',
          tabIds:           [parseInt(tabId)],
          byMouseOperation: true,
          keepDescendants:  true,
        });
        return;
      }

      const link  = event.target.closest('a, span.link');
      const tabId = link?.dataset?.tabId;
      if (tabId) {
        event.stopImmediatePropagation();
        event.preventDefault();
        if ((event.button == 0 && isAcceled(event)) ||
            (event.button == 1 && !hasModifier(event))) {
          browser.runtime.sendMessage({
            type:             'ws:remove-tabs-internally',
            tabIds:           [parseInt(tabId)],
            byMouseOperation: true,
            keepDescendants:  true,
          });
        }
        else {
          browser.runtime.sendMessage({
            type: 'ws:api:focus',
            tab:  parseInt(tabId),
          });
        }
        return false;
      }
      if (event.button != 0 ||
          hasModifier(event))
        return false;
      if (event.target != gTitleField) {
        setTitle(gTitleField.value);
        exitTitleEdit();
        event.stopPropagation();
      }
    }, { useCapture: true });
    window.addEventListener('keyup', event => {
      if (event.key == 'F2' &&
          !hasModifier(event))
        enterTitleEdit();
    });

    window.addEventListener('resize', reflow);

    gTitle.textContent = gTitleField.value = getTitle();

    gTemporaryCheck.checked = isTemporary();
    gTemporaryCheck.addEventListener('change', _event => {
      if (gTemporaryCheck.checked)
        gTemporaryAggressiveCheck.checked = false;
      updateParameters();
    });

    gTemporaryAggressiveCheck.checked = isTemporaryAggressive();
    gTemporaryAggressiveCheck.addEventListener('change', _event => {
      if (gTemporaryAggressiveCheck.checked)
        gTemporaryCheck.checked = false;
      updateParameters();
    });

    window.setTitle    = window.setTitle || setTitle;
    window.updateTree  = window.updateTree || updateTree;

    window.l10n.updateDocument();

    const [themeDeclarations, contextualIdentitiesColorInfo, configs, userStyleRules] = await Promise.all([
      browser.runtime.sendMessage({
        type: 'ws:get-theme-declarations'
      }),
      browser.runtime.sendMessage({
        type: 'ws:get-contextual-identities-color-info'
      }),
      browser.runtime.sendMessage({
        type: 'ws:get-config-value',
        keys: [
          'renderTreeInGroupTabs',
          'showAutoGroupOptionHint'
        ]
      }),
      browser.runtime.sendMessage({
        type: 'ws:get-user-style-rules'
      })
    ]);

    const contextualIdentitiesMarkerDeclarations = Object.keys(contextualIdentitiesColorInfo.colors).map(id =>
      `#tabs a[data-cookie-store-id="${id}"] .contextual-identity-marker {
         background-color: ${contextualIdentitiesColorInfo.colors[id]};
       }`).join('\n');
    gBrowserThemeDefinition.textContent = `
      ${themeDeclarations}
      ${contextualIdentitiesMarkerDeclarations}
      ${contextualIdentitiesColorInfo.colorDeclarations}
    `;
    gUserStyleRules.textContent = userStyleRules;

    updateTree.enabled = configs.renderTreeInGroupTabs;
    updateTree();

    let show = configs.showAutoGroupOptionHint;
    if (!isTemporary() && !isTemporaryAggressive())
      show = false;

    const hint = document.getElementById('optionHint');
    hint.style.display = show ? 'block' : 'none';

    if (show) {
      hint.firstChild.addEventListener('click', event => {
        if (event.button != 0)
          return;
        browser.runtime.sendMessage({
          type: 'ws:open-tab',
          uri:  `moz-extension://${location.host}/options/options.html#autoGroupNewTabsSection`
        });
      });
      hint.firstChild.addEventListener('keydown', event => {
        if (event.key != 'Enter' &&
            event.key != 'Space')
          return;
        browser.runtime.sendMessage({
          type: 'ws:open-tab',
          uri:  `moz-extension://${location.host}/options/options.html#autoGroupNewTabsSection`
        });
      });

      const closebox = document.getElementById('dismissOptionHint');
      closebox.addEventListener('click', event => {
        if (event.button != 0)
          return;
        hint.style.display = 'none';
        browser.runtime.sendMessage({
          type: 'ws:set-config-value',
          key:  'showAutoGroupOptionHint',
          value: false
        });
      });
      closebox.addEventListener('keydown', event => {
        if (event.key != 'Enter' &&
            event.key != 'Space')
          return;
        hint.style.display = 'none';
        browser.runtime.sendMessage({
          type: 'ws:set-config-value',
          key:  'showAutoGroupOptionHint',
          value: false
        });
      });
    }

    browser.runtime.onMessage.addListener((message, _sender) => {
      switch (message && message.type) {
        case 'ws:clear-temporary-state':
          gTemporaryCheck.checked = gTemporaryAggressiveCheck.checked = false;
          updateParameters();
          return Promise.resolve(true);

        case 'ws:replace-state-url':
          history.replaceState({}, document.title, message.url);
          return Promise.resolve(true);

        case 'ws:update-tree':
          updateTree();
          return Promise.resolve(true);

        case 'ws:update-title':
          setTitle(message.title);
          return Promise.resolve(true);
      }
    });

    // Failsafe 2: This is effective on any case, but too slow for newly opened tabs.
    document.title = getTitle();

    document.documentElement.classList.add('initialized');
  }
  //document.addEventListener('DOMContentLoaded', init, { once: true });


  const loadedIconUrls = new Set();
  const failedIconUrls = new Set();

  async function updateTree() {
    const runAt = updateTree.lastRun = Date.now();

    const container = document.getElementById('tabs');
    function clear() {
      const range = document.createRange();
      range.selectNodeContents(container.firstChild);
      range.deleteContents();
      range.detach();
    }

    const rootClassList = document.documentElement.classList;
    if (!updateTree.enabled) {
      rootClassList.remove('updating');
      clear();
      return;
    }

    rootClassList.add('updating');

    const baseRequest = {
      type: 'ws:api:get-tree',
      interval: 50,
    };
    const [thisTab, openerTab, aliasTab] = await Promise.all([
      // We need to request them separately because
      // get-tree always compact the returned array (null tab will be removved).
      browser.runtime.sendMessage({
        ...baseRequest,
        tab: 'senderTab',
      }),
      browser.runtime.sendMessage({
        ...baseRequest,
        tab: getOpenerTabId(),
      }),
      browser.runtime.sendMessage({
        ...baseRequest,
        tab: getAliasTabId(),
      }),
    ]);

    /*
    console.log('updateTree ', {
      ur: location.href,
      openerTabId: getOpenerTabId(),
      openerTab,
      aliasTabId: getAliasTabId(),
      aliasTab,
    });
    */

    // called again while waiting
    if (runAt != updateTree.lastRun)
      return;

    if (!thisTab) {
      console.error(new Error('Couldn\'t get tree of tabs unexpectedly.'));
      clear();
      rootClassList.remove('updating');
      return;
    }

    if (aliasTab)
      thisTab.children = aliasTab.children;

    let tree;
    if (!aliasTab && openerTab) {
      openerTab.children = thisTab.children;
      tree = buildChildren({
        children: [
          openerTab,
        ],
      });
    }
    else
      tree = buildChildren(thisTab);

    if (tree) {
      const { DOMUpdater } = await import('/extlib/dom-updater.js');
      tree.setAttribute('id', 'top-level-tree');
      const newContents = document.createDocumentFragment();
      newContents.appendChild(tree);
      DOMUpdater.update(container, newContents);
      for (const icon of container.querySelectorAll('li.favicon-loading img')) {
        const item = icon.closest('li');
        const url  = icon.dataset.faviconUrl;
        icon.onerror = () => {
          item.classList.remove('favicon-loading');
          item.classList.add('use-default-favicon');
          failedIconUrls.add(url);
        };
        icon.onload = () => {
          item.classList.remove('favicon-loading');
          loadedIconUrls.add(url);
        };
        icon.src = url;
      }
      reflow();
    }
    else {
      clear();
    }

    rootClassList.remove('updating');
    rootClassList.add('has-contents');
  }
  updateTree.enabled = true;

  function reflow() {
    const container = document.getElementById('tabs');
    columnizeTree(container.firstChild, {
      columnWidth: 'var(--column-width, 20em)',
      containerRect: container.getBoundingClientRect()
    });
  }

  function buildItem(tab) {
    const item = document.createElement('li');
    item.setAttribute('id', `tab-item-${tab.id}`);

    const link = item.appendChild(document.createElement('span'));
    link.setAttribute('id', `tab-link-${tab.id}`);
    link.setAttribute('class', 'link');
    link.setAttribute('title', tab.cookieStoreName ? `${tab.title} - ${tab.cookieStoreName}` : tab.title);
    link.dataset.tabId = tab.id;
    link.dataset.cookieStoreId = tab.cookieStoreId;

    const contextualIdentityMarker = link.appendChild(document.createElement('span'));
    contextualIdentityMarker.setAttribute('id', `tab-contextual-identity-marker-${tab.id}`);
    contextualIdentityMarker.classList.add('contextual-identity-marker');

    const defaultFavIcon = link.appendChild(document.createElement('span'));
    defaultFavIcon.setAttribute('id', `tab-default-favicon-${tab.id}`);
    defaultFavIcon.classList.add('default-favicon');

    const icon = link.appendChild(document.createElement('img'));
    icon.setAttribute('id', `tab-icon-${tab.id}`);
    const favIconUrl = tab.effectiveFavIconUrl || tab.favIconUrl;
    if (favIconUrl && !failedIconUrls.has(favIconUrl)) {
      if (loadedIconUrls.has(favIconUrl)) {
        icon.src = favIconUrl;
      }
      else {
        icon.dataset.faviconUrl = favIconUrl;
        item.classList.add('favicon-loading');
      }
    }
    else {
      item.classList.add('use-default-favicon');
    }

    if (Array.isArray(tab.states) &&
        tab.states.includes('group-tab'))
      item.classList.add('group-tab');

    const label = link.appendChild(document.createElement('span'));
    label.setAttribute('id', `tab-label-${tab.id}`);
    label.classList.add('label');
    label.textContent = tab.title;

    const closeBox = item.appendChild(document.createElement('span'));
    closeBox.setAttribute('id', `tab-closebox-${tab.id}`);
    closeBox.classList.add('closebox');
    closeBox.dataset.tabId = tab.id;

    const children = buildChildren(tab);
    if (!children)
      return item;

    children.setAttribute('id', `tab-${tab.id}-children`);
    const fragment = document.createDocumentFragment();
    fragment.appendChild(item);
    const childrenWrapped = document.createElement('li');
    childrenWrapped.setAttribute('id', `tabr-${tab.id}-children-wrappe`);
    childrenWrapped.appendChild(children);
    fragment.appendChild(childrenWrapped);
    return fragment;
  }

  function buildChildren(tab) {
    if (tab.children && tab.children.length > 0) {
      const list = document.createElement('ul');
      for (const child of tab.children) {
        list.appendChild(buildItem(child));
      }
      return list;
    }
    return null;
  }

  function columnizeTree(aTree, options) {
    options = options || {};
    options.columnWidth = options.columnWidth || 'var(--column-width, 20em)';

    const style = aTree.style;
    style.columnWidth = style.MozColumnWidth = `calc(${options.columnWidth})`;
    const computedStyle = window.getComputedStyle(aTree, null);
    aTree.columnWidth = Number((computedStyle.MozColumnWidth || computedStyle.columnWidth).replace(/px/, ''));
    style.columnGap   = style.MozColumnGap = '1em';
    style.columnFill  = style.MozColumnFill = 'auto';
    style.columnCount = style.MozColumnCount = 'auto';

    const containerRect = options.containerRect || aTree.parentNode.getBoundingClientRect();
    const maxWidth = containerRect.width;
    if (aTree.columnWidth * 2 <= maxWidth ||
        options.calculateCount) {
      const treeContentsRange = document.createRange();
      treeContentsRange.selectNodeContents(aTree);
      const overflow = treeContentsRange.getBoundingClientRect().width > window.innerWidth;
      treeContentsRange.detach();
      const blankSpace = overflow ? 2 : 1;
      style.height = style.maxHeight =
        `calc(${containerRect.height}px - ${blankSpace}em)`;

      if (getActualColumnCount(aTree) <= 1)
        style.columnWidth = style.MozColumnWidth = '';
    }
    else {
      style.height = style.maxHeight = '';
    }
  }

  function getActualColumnCount(aTree) {
    const range = document.createRange();
    range.selectNodeContents(aTree);
    const rect = range.getBoundingClientRect();
    range.detach();
    return Math.floor(rect.width / aTree.columnWidth);
  }

  init();
  return true;
})();
