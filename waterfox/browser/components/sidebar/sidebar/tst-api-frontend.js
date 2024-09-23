/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import { DOMUpdater } from '/extlib/dom-updater.js';

import {
  configs,
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as Size from './size.js';

import {
  kTAB_ELEMENT_NAME,
} from './components/TabElement.js';

function log(...args) {
  internalLogger('sidebar/tst-api-frontend', ...args);
}

// Above/below extra contents need to be inserted here, because missing those
// contents will shrink height of the tab and may triggers "underflow" of the
// tab bar unexpectedly.
const AUTO_REINSERT_PLACES = new Set([
  'tab-above',
  'tab-below',
]);

let mTargetWindow;

Sidebar.onInit.addListener(() => {
  mTargetWindow = TabsStore.getCurrentWindowId();
});

SidebarTabs.onReuseTabElement.addListener(tabElement => {
  setExtraTabContentsToElement(tabElement, '*', { place: 'tab-indent' });
  setExtraTabContentsToElement(tabElement, '*', { place: 'tab-front' });
  setExtraTabContentsToElement(tabElement, '*', { place: 'tab-behind' });
  setExtraTabContentsToElement(tabElement, '*', { place: 'tab-above' });
  setExtraTabContentsToElement(tabElement, '*', { place: 'tab-below' });
});

const mAddonsWithExtraContents = new Set();

const mNewTabButtonExtraItemsContainerRoots = Array.from(
  document.querySelectorAll(`.${Constants.kNEWTAB_BUTTON} .${Constants.kEXTRA_ITEMS_CONTAINER}`),
  container => {
    const root = container.attachShadow({ mode: 'open' });
    root.itemById = new Map();
    return root;
  }
);

const mTabbarTopExtraItemsContainerRoot = (() => {
  const container = document.querySelector(`#tabbar-top > .${Constants.kEXTRA_ITEMS_CONTAINER}`);
  const root = container.attachShadow({ mode: 'open' });
  root.itemById = new Map();
  return root;
})();

const mTabbarBottomExtraItemsContainerRoot = (() => {
  const container = document.querySelector(`#tabbar-bottom > .${Constants.kEXTRA_ITEMS_CONTAINER}`);
  const root = container.attachShadow({ mode: 'open' });
  root.itemById = new Map();
  return root;
})();

const mDummyTab = document.getElementById('dummy-tab');

TSTAPI.onRegistered.addListener(addon => {
  // Install stylesheet always, even if the addon is not allowed to access
  // private windows, because the client addon can be alloed on private
  // windows by Firefox itself and extra context menu commands may be called
  // via Firefox's native context menu (or shortcuts).
  if (addon.style)
    installStyle(addon.id, addon.style);
});

TSTAPI.onUnregistered.addListener(addon => {
  clearAllExtraTabContents(addon.id);
  uninstallStyle(addon.id)
});

TSTAPI.onMessageExternal.addListener((message, sender) => {
  if ((!configs.incognitoAllowedExternalAddons.includes(sender.id) &&
       document.documentElement.classList.contains('incognito')))
    return;

  if (!message.windowId)
    message.windowId = message.window || mTargetWindow;

  if (message.windowId != mTargetWindow)
    return;

  switch (message.type) {
    case TSTAPI.kCLEAR_ALL_EXTRA_TAB_CONTENTS: // for backward compatibility
      clearAllExtraTabContents(sender.id);
      return;

    case TSTAPI.kSET_EXTRA_NEW_TAB_BUTTON_CONTENTS: // for backward compatibility
      setExtraNewTabButtonContents(sender.id, message);
      return;

    case TSTAPI.kCLEAR_EXTRA_NEW_TAB_BUTTON_CONTENTS: // for backward compatibility
      clearExtraNewTabButtonContents(sender.id);
      return;

    case TSTAPI.kSET_EXTRA_CONTENTS:
      log('setting contents: ', message, sender.id);
      switch (String(message.place).toLowerCase()) {
        case 'newtabbutton':
        case 'new-tab-button':
        case 'newtab-button':
          setExtraNewTabButtonContents(sender.id, message);
          return;

        case 'tabbar-top':
          setExtraTabbarTopContents(sender.id, message);
          return;

        case 'tabbar-bottom':
          setExtraTabbarBottomContents(sender.id, message);
          return;

        default: // tabs
          TSTAPI.getTargetTabs(message, sender).then(tabs => {
            log(' => setting contents in tabs: ', tabs, message);
            for (const tab of tabs) {
              setExtraContentsTo(tab, sender.id, message);
            }
          });
          return;
      }
      return;

    case TSTAPI.kCLEAR_EXTRA_CONTENTS:
      log('clearing contents: ', message, sender.id);
      switch (String(message.place).toLowerCase()) {
        case 'newtabbutton':
        case 'new-tab-button':
        case 'newtab-button':
          clearExtraNewTabButtonContents(sender.id);
          return;

        case 'tabbar-top':
          clearExtraTabbarTopContents(sender.id);
          return;

        case 'tabbar-bottom':
          clearExtraTabbarBottomContents(sender.id);
          return;

        default: // tabs
          TSTAPI.getTargetTabs(message, sender).then(tabs => {
            log(' => clearing contents in tabs: ', tabs, message);
            for (const tab of tabs) {
              clearExtraTabContentsIn(tab, sender.id);
            }
          });
          return;
      }
      return;

    case TSTAPI.kCLEAR_ALL_EXTRA_CONTENTS:
      log('clearing all contents: ', sender.id);
      clearAllExtraTabContents(sender.id);
      return;

    case TSTAPI.kSET_EXTRA_CONTENTS_PROPERTIES:
      log('setting properties for contents: ', message, sender.id);
      TSTAPI.getTargetTabs(message, sender).then(tabs => {
        log(' => setting properties for contents in tabs: ', tabs, message);
        setExtraContentsProperties({
          id:    sender.id,
          tabs,
          place: message.place || null,
          part:  message.part,
          properties: message.properties || {},
        });
      });
      return;

    case TSTAPI.kFOCUS_TO_EXTRA_CONTENTS:
      log('focus to contents: ', message, sender.id);
      TSTAPI.getTargetTabs(message, sender).then(tabs => {
        log(' => focus to contents in tabs: ', tabs, message);
        focusToExtraContents({
          id:    sender.id,
          tabs,
          place: message.place || null,
          part:  message.part,
        });
      });
      return;

    default:
      Tab.waitUntilTracked(message.id).then(() => {
        const tabElement = document.querySelector(`#tab-${message.id}`);
        if (!tabElement)
          return;

        switch (message.type) {
          case TSTAPI.kSET_EXTRA_TAB_CONTENTS: // for backward compatibility
            setExtraTabContentsToElement(tabElement, sender.id, message);
            break;

          case TSTAPI.kCLEAR_EXTRA_TAB_CONTENTS: // for backward compatibility
            clearExtraTabContentsInElement(tabElement, sender.id);
            break;
        }
      });
      return;
  }
});

// https://developer.mozilla.org/docs/Web/HTML/Element
const SAFE_CONTENTS = `
a
abbr
acronym
address
//applet
area
article
aside
b
//base
//basefont
bdi
bdo
//bgsound
big
blink
blockquote
//body
br
button
canvas
caption
center
cite
code
col
colgroup
command
//content
data
datalist
dd
del
details
dfn
dialog
dir
div
dl
dt
//element
em
//embed
fieldset
figcaption
figure
font
footer
//form
//frame
//frameset
h1
//head
header
hgroup
hr
//html
i
//iframe
image
img
input
ins
isindex
kbd
keygen
label
legend
li
//link
listing
main
map
mark
marquee
menu
menuitem
//meta
//meter
multicol
nav
nextid
nobr
//noembed
//noframes
//noscript
object
ol
optgroup
option
output
p
param
picture
plaintext
pre
progress
q
rb
rp
rt
rtc
duby
s
samp
//script
section
select
//shadow
slot
small
source
spacer
span
strike
strong
//style
sub
summary
sup
table
tbody
td
template
textarea
tfoot
th
thead
time
//title
tr
track
tt
u
ul
var
//video
wbr
xmp
`.trim().split('\n').filter(selector => !selector.startsWith('//'));
const DANGEROUS_CONTENTS_SELECTOR = SAFE_CONTENTS.map(selector => `:not(${selector})`).join('');

export function setExtraContentsTo(tab, id, params = {}) {
  if (!tab || !tab.$TST.element)
    return;
  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  setExtraTabContentsToElement(tab.$TST.element, id, params);
}

function setExtraContentsToContainer(container, id, params = {}) {
  if (id == '*') {
    for (const id of container.itemById.keys()) {
      setExtraContentsToContainer(container, id, params = {});
    }
    return;
  }

  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }

  let cacheHolder, cacheKey;
  const place = String(params.place).toLowerCase();
  if (AUTO_REINSERT_PLACES.has(place)) {
    const cacheHolderElement = container?.host?.closest(kTAB_ELEMENT_NAME) || container;
    cacheHolder = cacheHolderElement.$TST || cacheHolderElement;
    cacheKey = `$$lastContentsSourceFor_${id}`;
    params = {
      ...params,
      contents: (
        params.contents ||
        (!('contents' in params) && cacheHolder[cacheKey]) ||
        null
      ),
    };
    switch (place) {
      case 'tab-above':
        onExtraContentsAboveChanged(id, params);
        break;

      case 'tab-below':
        onExtraContentsBelowChanged(id, params);
        break;
    }
  }

  let item = container.itemById.get(id);
  if (!params.style &&
      item &&
      item.styleElement &&
      item.styleElement.parentNode) {
    container.removeChild(item.styleElement);
    item.styleElement = null;
  }
  if (!params.contents) {
    if (item) {
      if (item.styleElement)
        container.removeChild(item.styleElement);
      container.removeChild(item);
      container.itemById.delete(id);
    }
    if (cacheHolder)
      cacheHolder[cacheKey] = null;
    return;
  }

  const extraContentsPartName = getExtraContentsPartName(id);

  if (!item) {
    item = document.createElement('span');
    item.setAttribute('part', `${extraContentsPartName} container`);
    item.classList.add('extra-item');
    item.classList.add(extraContentsPartName);
    item.dataset.owner = id;
    container.itemById.set(id, item);
  }
  if ('style' in params && !item.styleElement) {
    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    item.styleElement = style;
  }

  const contentsSource = String(params.contents || '').trim();
  if (cacheHolder)
    cacheHolder[cacheKey] = contentsSource;

  const range = document.createRange();
  range.selectNodeContents(item);
  const contents = range.createContextualFragment(contentsSource);
  range.detach();

  const dangerousContents = contents.querySelectorAll(DANGEROUS_CONTENTS_SELECTOR);
  for (const node of dangerousContents) {
    node.parentNode.removeChild(node);
  }
  if (dangerousContents.length > 0)
    console.log(`Could not include some elements as extra contents. provider=${id}, container:`, container, dangerousContents);

  // Sanitize remote resources
  for (const node of contents.querySelectorAll('*[href], *[src], *[srcset], *[part]')) {
    for (const attribute of node.attributes) {
      if (attribute.name == 'part')
        attribute.value += ` ${extraContentsPartName}`;
      if (/^(href|src|srcset)$/.test(attribute.name) &&
          attribute.value &&
          !/^(data|resource|chrome|about|moz-extension):/.test(attribute.value)) {
        attribute.value = '#';
        node.setAttribute('part', `${node.getAttribute('part') || ''} sanitized`);
      }
    }
  }
  // We don't need to handle inline event handlers because
  // they are blocked by the CSP mechanism.

  if ('style' in params)
    item.styleElement.textContent = (params.style || '')
      .replace(/%EXTRA_CONTENTS_PART%/gi, `${extraContentsPartName}`);

  DOMUpdater.update(item, contents);

  if (item.styleElement &&
      !item.styleElement.parentNode)
    container.appendChild(item.styleElement);
  if (!item.parentNode)
    container.appendChild(item);

  mAddonsWithExtraContents.add(id);
}

function getExtraContentsPartName(id) {
  if (!id) // the addon id is optional
    id = browser.runtime.id;
  return `extra-contents-by-${id.replace(/[^-a-z0-9_]/gi, '_')}`;
}


function setExtraTabContentsToElement(tabElement, id, params = {}) {
  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  let container;
  switch (String(params.place).toLowerCase()) {
    case 'indent': // for backward compatibility
    case 'tab-indent':
      container = tabElement.extraItemsContainerIndentRoot;
      break;

    case 'behind': // for backward compatibility
    case 'tab-behind':
      container = tabElement.extraItemsContainerBehindRoot;
      break;

    case 'front': // for backward compatibility
    case 'tab-front':
    default:
      container = tabElement.extraItemsContainerFrontRoot;
      break;

    case 'tab-above':
      container = tabElement.extraItemsContainerAboveRoot;
      break;

    case 'tab-above':
      container = tabElement.extraItemsContainerBelowRoot;
      break;
  }

  if (container)
    return setExtraContentsToContainer(container, id, params);
}

function onExtraContentsAboveChanged(id, params) {
  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  if (onExtraContentsAboveChanged.invoked)
    return;
  onExtraContentsAboveChanged.invoked = true;
  window.requestAnimationFrame(() => {
    onExtraContentsAboveChanged.invoked = false;
    if (params.container != mDummyTab.extraItemsContainerAboveRoot) {
      setExtraContentsToContainer(mDummyTab.extraItemsContainerAboveRoot, id, {
        ...params,
        container: mDummyTab.extraItemsContainerAboveRoot,
      });
    }
    throttledUpdateSize();
  });
}

function onExtraContentsBelowChanged(id, params) {
  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  if (onExtraContentsBelowChanged.invoked)
    return;
  onExtraContentsBelowChanged.invoked = true;
  window.requestAnimationFrame(() => {
    onExtraContentsBelowChanged.invoked = false;
    if (params.container != mDummyTab.extraItemsContainerBelowRoot) {
      setExtraContentsToContainer(mDummyTab.extraItemsContainerBelowRoot, id, {
        ...params,
        container: mDummyTab.extraItemsContainerBelowRoot,
      });
    }
    throttledUpdateSize();
  });
}

function throttledUpdateSize() {
  if (throttledUpdateSize.invoked)
    return;
  throttledUpdateSize.invoked = true;
  window.requestAnimationFrame(() => {
    throttledUpdateSize.invoked = false;
    Size.updateTabs();
    Size.updateContainers();
  });
}

export function clearExtraTabContentsIn(tab, id) {
  if (!tab || !tab.$TST.element)
    return;
  if (!id) // the addon id is optional
    id = browser.runtime.id;
  clearExtraTabContentsInElement(tab.$TST.element, id);
}

function clearExtraTabContentsInElement(tabElement, id) {
  if (!id) // the addon id is optional
    id = browser.runtime.id;
  setExtraTabContentsToElement(tabElement, id, { place: 'tab-indent' });
  setExtraTabContentsToElement(tabElement, id, { place: 'tab-front' });
  setExtraTabContentsToElement(tabElement, id, { place: 'tab-behind' });
  setExtraTabContentsToElement(tabElement, id, { place: 'tab-above' });
  setExtraTabContentsToElement(tabElement, id, { place: 'tab-below' });
  onExtraContentsAboveChanged(id);
  onExtraContentsBelowChanged(id);
}

export function clearAllExtraTabContents(id) {
  if (!id) // the addon id is optional
    id = browser.runtime.id;

  if (!mAddonsWithExtraContents.has(id))
    return;

  for (const tabElement of document.querySelectorAll(kTAB_ELEMENT_NAME)) {
    clearExtraTabContentsInElement(tabElement, id);
  }
  setExtraNewTabButtonContents(id);
  clearExtraTabbarTopContents(id);
  clearExtraTabbarBottomContents(id);
  onExtraContentsAboveChanged(id);
  onExtraContentsBelowChanged(id);
  mAddonsWithExtraContents.delete(id);
}


export function setExtraNewTabButtonContents(id, params = {}) {
  if (typeof id != 'string') { // addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  for (const container of mNewTabButtonExtraItemsContainerRoots) {
    setExtraContentsToContainer(container, id, params);
  }
  Sidebar.reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_RESIZE,
    timeout: 100,
  });
}

export function clearExtraNewTabButtonContents(id) {
  if (!id)
    setExtraNewTabButtonContents({});
  setExtraNewTabButtonContents(id, {});
}


export function setExtraTabbarTopContents(id, params = {}) {
  if (typeof id != 'string') { // the addon id is optional
    params = id;
    id = browser.runtime.id;
  }
  setExtraContentsToContainer(mTabbarTopExtraItemsContainerRoot, id, params);
  Sidebar.reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_RESIZE,
    timeout: 100,
  });
}

export function clearExtraTabbarTopContents(id) {
  if (!id) // the addon id is optional
    id = browser.runtime.id;
  setExtraTabbarTopContents(id, {});
}


export function setExtraTabbarBottomContents(id, params = {}) {
  if (typeof id != 'string') {
    params = id;
    id = browser.runtime.id;
  }
  setExtraContentsToContainer(mTabbarBottomExtraItemsContainerRoot, id, params);
  Sidebar.reserveToUpdateTabbarLayout({
    reason:  Constants.kTABBAR_UPDATE_REASON_RESIZE,
    timeout: 100,
  });
}

export function clearExtraTabbarBottomContents(id) {
  if (!id) // the addon id is optional
    id = browser.runtime.id;
  setExtraTabbarBottomContents(id, {});
}

function collectExtraContentsRoots({ tabs, place }) {
  switch (String(place).toLowerCase()) {
    case 'indent': // for backward compatibility
    case 'tab-indent':
      return (tabs || Tab.getAllTabs(mTargetWindow)).map(tab => tab.$TST.element.extraItemsContainerIndentRoot);

    case 'behind': // for backward compatibility
    case 'tab-behind':
      return (tabs || Tab.getAllTabs(mTargetWindow)).map(tab => tab.$TST.element.extraItemsContainerBehindRoot);

    case 'front': // for backward compatibility
    case 'tab-front':
      return (tabs || Tab.getAllTabs(mTargetWindow)).map(tab => tab.$TST.element.extraItemsContainerFrontRoot);

    case 'tab-above':
      return [
        ...(tabs || Tab.getAllTabs(mTargetWindow)).map(tab => tab.$TST.element.extraItemsContainerAboveRoot),
        mDummyTab.extraItemsContainerAboveRoot,
      ];

    case 'tab-below':
      return [
        ...(tabs || Tab.getAllTabs(mTargetWindow)).map(tab => tab.$TST.element.extraItemsContainerBelowRoot),
        mDummyTab.extraItemsContainerBelowRoot,
      ];

    case 'newtabbutton':
    case 'new-tab-button':
    case 'newtab-button':
      return mNewTabButtonExtraItemsContainerRoots;

    case 'tabbar-top':
      return [mTabbarTopExtraItemsContainerRoot];

    case 'tabbar-bottom':
      return [mTabbarBottomExtraItemsContainerRoot];

    default:
      return [];
  }
}

function setExtraContentsProperties({ id, tabs, place, part, properties }) {
  if (!id || !part || !properties)
    return;

  const roots = collectExtraContentsRoots({ id, tabs, place });
  for (const root of roots) {
    const node = root.querySelector(`[part~="${getExtraContentsPartName(id)}"][part~="${part}"]`);
    if (!node)
      continue;
    for (const [property, value] of Object.entries(properties)) {
      node[property] = value;
    }
  }
}

function focusToExtraContents({ id, tabs, place, part }) {
  if (!id || !part)
    return;

  const roots = collectExtraContentsRoots({ id, tabs, place });
  for (const root of roots) {
    const node = root.querySelector(`[part~="${getExtraContentsPartName(id)}"][part~="${part}"]`);
    if (!node || typeof node.focus != 'function')
      continue;
    node.focus();
  }
}


const mAddonStyles = new Map();

function installStyle(id, style) {
  let styleElement = mAddonStyles.get(id);
  if (!styleElement) {
    styleElement = document.createElement('style');
    styleElement.setAttribute('type', 'text/css');
    document.head.insertBefore(styleElement, document.querySelector('#addons-style-rules'));
    mAddonStyles.set(id, styleElement);
  }
  styleElement.textContent = (style || '').replace(/%EXTRA_CONTENTS_PART%/gi, getExtraContentsPartName(id));
}

function uninstallStyle(id) {
  const styleElement = mAddonStyles.get(id);
  if (!styleElement)
    return;
  document.head.removeChild(styleElement);
  mAddonStyles.delete(id);
}


// we should not handle dblclick on #tabbar here - it is handled by mouse-event-listener.js
for (const container of document.querySelectorAll('#tabbar-top, #tabbar-bottom')) {
  container.addEventListener('dblclick', onExtraContentsDblClick, { capture: true });
}
document.addEventListener('keydown',  onExtraContentsKeyEvent, { capture: true });
document.addEventListener('keyup',    onExtraContentsKeyEvent, { capture: true });
document.addEventListener('input',    onExtraContentsInput,    { capture: true });
document.addEventListener('change',   onExtraContentsChange,   { capture: true });
document.addEventListener('compositionstart',  onExtraContentsCompositionEvent, { capture: true });
document.addEventListener('compositionupdate', onExtraContentsCompositionEvent, { capture: true });
document.addEventListener('compositionend',    onExtraContentsCompositionEvent, { capture: true });
document.addEventListener('focus',    onExtraContentsFocusEvent, { capture: true });
document.addEventListener('blur',     onExtraContentsFocusEvent, { capture: true });

async function onExtraContentsDblClick(event) {
  const detail            = EventUtils.getMouseEventDetail(event, null);
  const extraContentsInfo = getOriginalExtraContentsTarget(event);
  const allowed = await tryMouseOperationAllowedWithExtraContents(
    TSTAPI.kNOTIFY_EXTRA_CONTENTS_DBLCLICKED,
    null,
    { detail },
    extraContentsInfo
  );
  if (allowed)
    return;
}

async function notifyExtraContentsEvent(event, eventType, details = {}) {
  const extraContentsInfo = getOriginalExtraContentsTarget(event);
  if (!extraContentsInfo ||
      !extraContentsInfo.owners ||
      extraContentsInfo.owners.size == 0)
    return;

  const target = EventUtils.getElementOriginalTarget(event);
  if (target &&
      target.closest('tab-item, button, *[role="button"], input[type="submit"]')) {
    event.stopPropagation();
    event.stopImmediatePropagation();
    event.preventDefault();
  }

  const livingTab = EventUtils.getTabFromEvent(event);
  const eventInfo = {
    ...EventUtils.getTabEventDetail(event, livingTab),
    ...extraContentsInfo.fieldValues,
    originalTarget:     extraContentsInfo.target,
    originalTargetPart: extraContentsInfo.targetPart,
    $extraContentsInfo: null,
    ...details,
  };
  const options = {
    targets: extraContentsInfo.owners,
  };
  if (livingTab) {
    eventInfo.tab = livingTab;
    options.tabProperties = ['tab'];
    options.cache = {};
  }

  await TSTAPI.tryOperationAllowed(
    eventType,
    eventInfo,
    options
  );
  if (eventInfo.tab)
    eventInfo.tab.clearCache();
}

async function onExtraContentsKeyEvent(event) {
  await notifyExtraContentsEvent(
    event,
    event.type == 'keydown' ?
      TSTAPI.kNOTIFY_EXTRA_CONTENTS_KEYDOWN :
      TSTAPI.kNOTIFY_EXTRA_CONTENTS_KEYUP,
    {
      key:         event.key,
      isComposing: event.isComposing,
      locale:      event.locale,
      location:    event.location,
      repeat:      event.repeat,
    }
  );
}

async function onExtraContentsInput(event) {
  await notifyExtraContentsEvent(
    event,
    TSTAPI.kNOTIFY_EXTRA_CONTENTS_INPUT,
    {
      data:        event.data,
      inputType:   event.inputType,
      isComposing: event.isComposing,
    }
  );
}

async function onExtraContentsChange(event) {
  await notifyExtraContentsEvent(
    event,
    TSTAPI.kNOTIFY_EXTRA_CONTENTS_CHANGE
  );
}

async function onExtraContentsCompositionEvent(event) {
  await notifyExtraContentsEvent(
    event,
    event.type == 'compositionstart' ?
      TSTAPI.kNOTIFY_EXTRA_CONTENTS_COMPOSITIONSTART : 
      event.type == 'compositionupdate' ?
        TSTAPI.kNOTIFY_EXTRA_CONTENTS_COMPOSITIONUPDATE :
        TSTAPI.kNOTIFY_EXTRA_CONTENTS_COMPOSITIONEND,
    {
      data:   event.data,
      locale: event.locale,
    }
  );
}

async function onExtraContentsFocusEvent(event) {
  const target = EventUtils.getElementOriginalTarget(event);
  if (!target)
    return {};

  const extraContents = target.closest(`.extra-item`);

  let relatedTarget = null;
  const relatedTargetNode    = event.relatedTarget && EventUtils.getElementTarget(event.relatedTarget);
  const relatedExtraContents = relatedTargetNode && relatedTargetNode.closest(`.extra-item`)
  if (relatedExtraContents &&
      extraContents.dataset.owner == relatedExtraContents.dataset.owner)
    relatedTarget = relatedTargetNode.outerHTML;

  await notifyExtraContentsEvent(
    event,
    event.type == 'focus' ?
      TSTAPI.kNOTIFY_EXTRA_CONTENTS_FOCUS : 
      TSTAPI.kNOTIFY_EXTRA_CONTENTS_BLUR,
    { relatedTarget }
  );
}

function getFieldValues(event) {
  const target = EventUtils.getElementOriginalTarget(event);
  if (!target)
    return {};

  const fieldNode = target.closest('input, select, textarea');
  if (!fieldNode)
    return {};

  return {
    fieldValue:   'value' in fieldNode ? fieldNode.value : null,
    fieldChecked: 'checked' in fieldNode ? fieldNode.checked : null,
  };
}

export function getOriginalExtraContentsTarget(event) {
  try {
    const target        = EventUtils.getElementOriginalTarget(event);
    const extraContents = target && target.closest(`.extra-item`);
    if (extraContents) {
      const targetPart = target.closest(`[part]`)
      return {
        owners: new Set([extraContents.dataset.owner]),
        target: cleanupExtraContentsPartName(target.outerHTML),
        targetPart: cleanupExtraContentsPartName(targetPart.getAttribute('part')).trim(),
        fieldValues: getFieldValues(event),
      };
    }
  }
  catch(_error) {
    // this may happen by mousedown on scrollbar
  }

  return {
    owners: new Set(),
    target: null,
    targetPart: null,
    fieldValues: {},
  };
}

function cleanupExtraContentsPartName(string) {
  return string
    .replace(/ extra-contents-by-[-a-z0-9_]+\b/gi, '');
}

export async function tryMouseOperationAllowedWithExtraContents(eventType, rawEventType, mousedown, extraContentsInfo) {
  const cache = {};

  if (extraContentsInfo &&
      extraContentsInfo.owners &&
      extraContentsInfo.owners.size > 0) {
    const eventInfo = {
      ...mousedown.detail,
      originalTarget:     extraContentsInfo.target,
      originalTargetPart: extraContentsInfo.targetPart,
      ...extraContentsInfo.fieldValues,
      $extraContentsInfo: null,
    };
    const options = {
      targets: extraContentsInfo.owners,
    };
    if (mousedown.tab) {
      eventInfo.tab = mousedown.tab;
      options.tabProperties = ['tab'];
      options.cache = cache;
    }
    const allowed = (await TSTAPI.tryOperationAllowed(
      eventType,
      eventInfo,
      options
    )) && (!rawEventType || await TSTAPI.tryOperationAllowed(
      rawEventType, // for backward compatibility
      eventInfo,
      options
    ));
    if (!allowed)
      return false;
  }

  if (rawEventType) {
    const eventInfo = {
      ...mousedown.detail,
      $extraContentsInfo: null,
    };
    const options = {
      except: extraContentsInfo && extraContentsInfo.owners,
    };
    if (mousedown.tab) {
      eventInfo.tab = mousedown.tab;
      options.tabProperties = ['tab'];
      options.cache = cache;
    }
    const allowed = await TSTAPI.tryOperationAllowed(
      rawEventType,
      eventInfo,
      options
    );
    if (!allowed)
      return false;
  }

  return true;
}
