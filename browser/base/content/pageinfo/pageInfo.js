/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/* import-globals-from /toolkit/content/globalOverlay.js */
/* import-globals-from /toolkit/content/contentAreaUtils.js */
/* import-globals-from /toolkit/content/treeUtils.js */
/* import-globals-from ../utilityOverlay.js */
/* import-globals-from permissions.js */
/* import-globals-from security.js */

ChromeUtils.defineESModuleGetters(this, {
  E10SUtils: "resource://gre/modules/E10SUtils.sys.mjs",
});

// define a js object to implement nsITreeView
function pageInfoTreeView(treeid, copycol) {
  // copycol is the index number for the column that we want to add to
  // the copy-n-paste buffer when the user hits accel-c
  this.treeid = treeid;
  this.copycol = copycol;
  this.rows = 0;
  this.tree = null;
  this.data = [];
  this.selection = null;
  this.sortcol = -1;
  this.sortdir = false;
}

pageInfoTreeView.prototype = {
  set rowCount(c) {
    throw new Error("rowCount is a readonly property");
  },
  get rowCount() {
    return this.rows;
  },

  setTree(tree) {
    this.tree = tree;
  },

  getCellText(row, column) {
    // row can be null, but js arrays are 0-indexed.
    // colidx cannot be null, but can be larger than the number
    // of columns in the array. In this case it's the fault of
    // whoever typoed while calling this function.
    return this.data[row][column.index] || "";
  },

  setCellValue() {},

  setCellText(row, column, value) {
    this.data[row][column.index] = value;
  },

  addRow(row) {
    this.rows = this.data.push(row);
    this.rowCountChanged(this.rows - 1, 1);
    if (this.selection.count == 0 && this.rowCount && !gImageElement) {
      this.selection.select(0);
    }
  },

  addRows(rows) {
    for (let row of rows) {
      this.addRow(row);
    }
  },

  rowCountChanged(index, count) {
    this.tree.rowCountChanged(index, count);
  },

  invalidate() {
    this.tree.invalidate();
  },

  clear() {
    if (this.tree) {
      this.tree.rowCountChanged(0, -this.rows);
    }
    this.rows = 0;
    this.data = [];
  },

  onPageMediaSort(columnname) {
    var tree = document.getElementById(this.treeid);
    var treecol = tree.columns.getNamedColumn(columnname);

    this.sortdir = gTreeUtils.sort(
      tree,
      this,
      this.data,
      treecol.index,
      function textComparator(a, b) {
        return (a || "").toLowerCase().localeCompare((b || "").toLowerCase());
      },
      this.sortcol,
      this.sortdir
    );

    for (let col of tree.columns) {
      col.element.removeAttribute("sortActive");
      col.element.removeAttribute("sortDirection");
    }
    treecol.element.setAttribute("sortActive", "true");
    treecol.element.setAttribute(
      "sortDirection",
      this.sortdir ? "ascending" : "descending"
    );

    this.sortcol = treecol.index;
  },

  getRowProperties() {
    return "";
  },
  getCellProperties() {
    return "";
  },
  getColumnProperties() {
    return "";
  },
  isContainer() {
    return false;
  },
  isContainerOpen() {
    return false;
  },
  isSeparator() {
    return false;
  },
  isSorted() {
    return this.sortcol > -1;
  },
  canDrop() {
    return false;
  },
  drop() {
    return false;
  },
  getParentIndex() {
    return 0;
  },
  hasNextSibling() {
    return false;
  },
  getLevel() {
    return 0;
  },
  getImageSrc() {},
  getCellValue(row, column) {
    let col = column != null ? column : this.copycol;
    return row < 0 || col < 0 ? "" : this.data[row][col] || "";
  },
  toggleOpenState() {},
  cycleHeader() {},
  selectionChanged() {},
  cycleCell() {},
  isEditable() {
    return false;
  },
};

// mmm, yummy. global variables.
var gDocInfo = null;
var gImageElement = null;

// column number to help using the data array
const COL_IMAGE_ADDRESS = 0;
const COL_IMAGE_TYPE = 1;
const COL_IMAGE_SIZE = 2;
const COL_IMAGE_ALT = 3;
const COL_IMAGE_COUNT = 4;
const COL_IMAGE_NODE = 5;
const COL_IMAGE_BG = 6;
const COL_IMAGE_RAWSIZE = 7;

// column number to copy from, second argument to pageInfoTreeView's constructor
const COPYCOL_NONE = -1;
const COPYCOL_META_CONTENT = 1;
const COPYCOL_IMAGE = COL_IMAGE_ADDRESS;

// one nsITreeView for each tree in the window
var gMetaView = new pageInfoTreeView("metatree", COPYCOL_META_CONTENT);
var gImageView = new pageInfoTreeView("imagetree", COPYCOL_IMAGE);

gImageView.getCellProperties = function (row, col) {
  var data = gImageView.data[row];
  var item = gImageView.data[row][COL_IMAGE_NODE];
  var props = "";
  if (
    !checkProtocol(data) ||
    HTMLEmbedElement.isInstance(item) ||
    (HTMLObjectElement.isInstance(item) && !item.type.startsWith("image/"))
  ) {
    props += "broken";
  }

  if (col.element.id == "image-address") {
    props += " ltr";
  }

  return props;
};

gImageView.onPageMediaSort = function (columnname) {
  var tree = document.getElementById(this.treeid);
  var treecol = tree.columns.getNamedColumn(columnname);

  var comparator;
  var index = treecol.index;
  if (index == COL_IMAGE_SIZE || index == COL_IMAGE_COUNT) {
    comparator = function numComparator(a, b) {
      return a - b;
    };

    // COL_IMAGE_SIZE contains the localized string, compare raw numbers.
    if (index == COL_IMAGE_SIZE) {
      index = COL_IMAGE_RAWSIZE;
    }
  } else {
    comparator = function textComparator(a, b) {
      return (a || "").toLowerCase().localeCompare((b || "").toLowerCase());
    };
  }

  this.sortdir = gTreeUtils.sort(
    tree,
    this,
    this.data,
    index,
    comparator,
    this.sortcol,
    this.sortdir
  );

  for (let col of tree.columns) {
    col.element.removeAttribute("sortActive");
    col.element.removeAttribute("sortDirection");
  }
  treecol.element.setAttribute("sortActive", "true");
  treecol.element.setAttribute(
    "sortDirection",
    this.sortdir ? "ascending" : "descending"
  );

  this.sortcol = index;
};

var gImageHash = {};

// localized strings (will be filled in when the document is loaded)
const MEDIA_STRINGS = {};
let SIZE_UNKNOWN = "";
let ALT_NOT_SET = "";

// a number of services I'll need later
// the cache services
const nsICacheStorageService = Ci.nsICacheStorageService;
const nsICacheStorage = Ci.nsICacheStorage;
const cacheService = Cc[
  "@mozilla.org/netwerk/cache-storage-service;1"
].getService(nsICacheStorageService);

var diskStorage = null;

const nsICookiePermission = Ci.nsICookiePermission;

const nsICertificateDialogs = Ci.nsICertificateDialogs;
const CERTIFICATEDIALOGS_CONTRACTID = "@mozilla.org/nsCertificateDialogs;1";

// clipboard helper
function getClipboardHelper() {
  try {
    return Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
  } catch (e) {
    // do nothing, later code will handle the error
    return null;
  }
}
const gClipboardHelper = getClipboardHelper();

/* Called when PageInfo window is loaded.  Arguments are:
 *  window.arguments[0] - (optional) an object consisting of
 *                         - doc: (optional) document to use for source. if not provided,
 *                                the calling window's document will be used
 *                         - initialTab: (optional) id of the initial tab to display
 */
window.addEventListener(
  "load",
  async function onLoadPageInfo() {
    [
      SIZE_UNKNOWN,
      ALT_NOT_SET,
      MEDIA_STRINGS.img,
      MEDIA_STRINGS["bg-img"],
      MEDIA_STRINGS["border-img"],
      MEDIA_STRINGS["list-img"],
      MEDIA_STRINGS.cursor,
      MEDIA_STRINGS.object,
      MEDIA_STRINGS.embed,
      MEDIA_STRINGS.link,
      MEDIA_STRINGS.input,
      MEDIA_STRINGS.video,
      MEDIA_STRINGS.audio,
    ] = await document.l10n.formatValues([
      "image-size-unknown",
      "not-set-alternative-text",
      "media-img",
      "media-bg-img",
      "media-border-img",
      "media-list-img",
      "media-cursor",
      "media-object",
      "media-embed",
      "media-link",
      "media-input",
      "media-video",
      "media-audio",
    ]);

    const args =
      "arguments" in window &&
      window.arguments.length >= 1 &&
      window.arguments[0];

    // Init media view
    let imageTree = document.getElementById("imagetree");
    imageTree.view = gImageView;

    imageTree.controllers.appendController(treeController);

    document
      .getElementById("metatree")
      .controllers.appendController(treeController);

    document
      .querySelector("#metatree > treecols")
      .addEventListener("click", event => {
        let id = event.target.id;
        switch (id) {
          case "meta-name":
          case "meta-content":
            gMetaView.onPageMediaSort(id);
            break;
        }
      });

    document
      .querySelector("#imagetree > treecols")
      .addEventListener("click", event => {
        let id = event.target.id;
        switch (id) {
          case "image-address":
          case "image-type":
          case "image-size":
          case "image-alt":
          case "image-count":
            gImageView.onPageMediaSort(id);
            break;
        }
      });

    let imagetree = document.getElementById("imagetree");
    imagetree.addEventListener("select", onImageSelect);
    imagetree.addEventListener("dragstart", event =>
      onBeginLinkDrag(event, "image-address", "image-alt")
    );

    document.addEventListener("command", event => {
      switch (event.target.id) {
        // == pageInfoCommandSet ==
        case "cmd_close":
          window.close();
          break;
        case "cmd_help":
          doHelpButton();
          break;
        // == topBar ==
        case "generalTab":
        case "mediaTab":
        case "permTab":
        case "securityTab":
          showTab(event.target.id.slice(0, -3));
          break;
        // == imageSaveBox ==
        case "selectallbutton":
          doSelectAllMedia();
          break;
        case "imagesaveasbutton":
        case "mediasaveasbutton":
          saveMedia();
          break;
        // == securityPanel ==
        case "security-view-cert":
          security.viewCert();
          break;
        case "security-view-qwac":
          security.viewQWAC();
          break;
        case "security-clear-sitedata":
          security.clearSiteData();
          break;
        case "security-view-password":
          security.viewPasswords();
          break;
      }
    });

    // Select the requested tab, if the name is specified
    await loadTab(args);

    // Emit init event for tests
    window.dispatchEvent(new Event("page-info-init"));
  },
  { once: true }
);

async function loadPageInfo(browsingContext, imageElement, browser) {
  browser = browser || window.opener.gBrowser.selectedBrowser;
  browsingContext = browsingContext || browser.browsingContext;

  let actor = browsingContext.currentWindowGlobal.getActor("PageInfo");

  let result = await actor.sendQuery("PageInfo:getData");
  await onNonMediaPageInfoLoad(browsingContext, result, imageElement);

  // Here, we are walking the frame tree via BrowsingContexts to collect all of the
  // media information for each frame
  let contextsToVisit = [browsingContext];
  while (contextsToVisit.length) {
    let currContext = contextsToVisit.pop();
    let global = currContext.currentWindowGlobal;

    if (!global) {
      continue;
    }

    let subframeActor = global.getActor("PageInfo");
    let mediaResult = await subframeActor.sendQuery("PageInfo:getMediaData");
    for (let item of mediaResult.mediaItems) {
      addImage(item);
    }
    selectImage();
    contextsToVisit.push(...currContext.children);
  }
}

// Setup the <browser> used for media previews
function createPreviewBrowserElement(browser, docInfo) {
  const previewBrowser = document.createXULElement("browser");
  previewBrowser.setAttribute("id", "mediaBrowser");
  previewBrowser.setAttribute("type", "content");
  previewBrowser.setAttribute("remote", "true");
  previewBrowser.setAttribute("remoteType", browser.remoteType);
  previewBrowser.setAttribute("maychangeremoteness", "true");
  previewBrowser.setAttribute("disableglobalhistory", "true");
  previewBrowser.setAttribute("nodefaultsrc", "true");
  previewBrowser.setAttribute("disablecontextmenu", "true");
  previewBrowser.setAttribute(
    "initialBrowsingContextGroupId",
    browser.browsingContext.group.id
  );

  let { userContextId } = docInfo.principal.originAttributes;
  if (userContextId) {
    previewBrowser.setAttribute("usercontextid", userContextId);
  }

  document.getElementById("mediaBrowser").replaceWith(previewBrowser);
}

/**
 * onNonMediaPageInfoLoad is responsible for populating the page info
 * UI other than the media tab. This includes general, permissions, and security.
 */
async function onNonMediaPageInfoLoad(
  browsingContext,
  pageInfoData,
  imageInfo
) {
  let browser = browsingContext.top.embedderElement;
  const { docInfo, windowInfo } = pageInfoData;
  let uri = Services.io.newURI(docInfo.documentURIObject.spec);
  let principal = docInfo.principal;
  gDocInfo = docInfo;

  gImageElement = imageInfo;
  var titleFormat = windowInfo.isTopWindow
    ? "page-info-page"
    : "page-info-frame";
  document.l10n.setAttributes(document.documentElement, titleFormat, {
    website: docInfo.location,
  });

  document
    .getElementById("main-window")
    .setAttribute("relatedUrl", docInfo.location);

  createPreviewBrowserElement(browser, docInfo);

  await makeGeneralTab(pageInfoData.metaViewRows, docInfo);
  if (
    uri.spec.startsWith("about:neterror") ||
    uri.spec.startsWith("about:certerror") ||
    uri.spec.startsWith("about:httpsonlyerror")
  ) {
    uri = browser.currentURI;
    principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      browser.contentPrincipal.originAttributes
    );
  }
  onLoadPermission(uri, principal);
  securityOnLoad(uri, windowInfo, browsingContext);
}

function resetPageInfo(args) {
  /* Reset Meta tags part */
  gMetaView.clear();

  /* Reset Media tab */
  var mediaTab = document.getElementById("mediaTab");
  if (!mediaTab.hidden) {
    mediaTab.hidden = true;
  }
  gImageView.clear();
  gImageHash = {};

  /* Rebuild the data */
  loadTab(args);
}

function doHelpButton() {
  const helpTopics = {
    generalPanel: "pageinfo_general",
    mediaPanel: "pageinfo_media",
    permPanel: "pageinfo_permissions",
    securityPanel: "pageinfo_security",
  };

  var deck = document.getElementById("mainDeck");
  var helpdoc = helpTopics[deck.selectedPanel.id] || "pageinfo_general";
  openHelpLink(helpdoc);
}

function showTab(id) {
  var deck = document.getElementById("mainDeck");
  var pagel = document.getElementById(id + "Panel");
  deck.selectedPanel = pagel;
}

async function loadTab(args) {
  // If the "View Image Info" context menu item was used, the related image
  // element is provided as an argument. This can't be a background image.
  let imageElement = args?.imageElement;
  let browsingContext = args?.browsingContext;
  let browser = args?.browser;

  // Check if diskStorage has not be created yet if it has not been, get
  // partitionKey from content process and create diskStorage with said partitionKey
  if (!diskStorage) {
    let oaWithPartitionKey = await getOaWithPartitionKey(
      browsingContext,
      browser
    );
    let loadContextInfo = Services.loadContextInfo.custom(
      false,
      oaWithPartitionKey
    );
    diskStorage = cacheService.diskCacheStorage(loadContextInfo);
  }

  /* Load the page info */
  await loadPageInfo(browsingContext, imageElement, browser);

  var initialTab = args?.initialTab || "generalTab";
  var radioGroup = document.getElementById("viewGroup");
  initialTab =
    document.getElementById(initialTab) ||
    document.getElementById("generalTab");
  radioGroup.selectedItem = initialTab;
  radioGroup.selectedItem.doCommand();
  radioGroup.focus({ focusVisible: false });
}

function openCacheEntry(key, cb) {
  var checkCacheListener = {
    onCacheEntryCheck() {
      return Ci.nsICacheEntryOpenCallback.ENTRY_WANTED;
    },
    onCacheEntryAvailable(entry) {
      cb(entry);
    },
  };
  diskStorage.asyncOpenURI(
    Services.io.newURI(key),
    "",
    nsICacheStorage.OPEN_READONLY,
    checkCacheListener
  );
}

async function makeGeneralTab(metaViewRows, docInfo) {
  // Sets Title in the General Tab, set to "Untitled Page" if no title found
  if (docInfo.title) {
    document.getElementById("titletext").value = docInfo.title;
  } else {
    document.l10n.setAttributes(
      document.getElementById("titletext"),
      "no-page-title"
    );
  }

  var url = docInfo.location;
  setItemValue("urltext", url);

  var referrer = "referrer" in docInfo && docInfo.referrer;
  setItemValue("refertext", referrer);

  var mode =
    "compatMode" in docInfo && docInfo.compatMode == "BackCompat"
      ? "general-quirks-mode"
      : "general-strict-mode";
  document.l10n.setAttributes(document.getElementById("modetext"), mode);

  // find out the mime type
  setItemValue("typetext", docInfo.contentType);

  // get the document characterset
  var encoding = docInfo.characterSet;
  document.getElementById("encodingtext").value = encoding;

  let length = metaViewRows.length;

  var metaGroup = document.getElementById("metaTags");
  if (!length) {
    metaGroup.style.visibility = "hidden";
  } else {
    document.l10n.setAttributes(
      document.getElementById("metaTagsCaption"),
      "general-meta-tags",
      { tags: length }
    );

    document.getElementById("metatree").view = gMetaView;

    // Add the metaViewRows onto the general tab's meta info tree.
    gMetaView.addRows(metaViewRows);

    metaGroup.style.removeProperty("visibility");
  }

  var modifiedText = formatDate(
    docInfo.lastModified,
    await document.l10n.formatValue("not-set-date")
  );
  document.getElementById("modifiedtext").value = modifiedText;

  // get cache info
  var cacheKey = url.replace(/#.*$/, "");
  openCacheEntry(cacheKey, function (cacheEntry) {
    if (cacheEntry) {
      var pageSize = cacheEntry.dataSize;
      var kbSize = formatNumber(Math.round((pageSize / 1024) * 100) / 100);
      document.l10n.setAttributes(
        document.getElementById("sizetext"),
        "properties-general-size",
        { kb: kbSize, bytes: formatNumber(pageSize) }
      );
    } else {
      setItemValue("sizetext", null);
    }
  });
}

async function addImage({ url, type, alt, altNotProvided, element, isBg }) {
  if (!url) {
    return;
  }

  if (altNotProvided) {
    alt = ALT_NOT_SET;
  }

  if (!gImageHash.hasOwnProperty(url)) {
    gImageHash[url] = {};
  }
  if (!gImageHash[url].hasOwnProperty(type)) {
    gImageHash[url][type] = {};
  }
  if (!gImageHash[url][type].hasOwnProperty(alt)) {
    gImageHash[url][type][alt] = gImageView.data.length;
    var row = [
      url,
      MEDIA_STRINGS[type],
      SIZE_UNKNOWN,
      alt,
      1,
      element,
      isBg,
      -1,
    ];
    gImageView.addRow(row);

    // Fill in cache data asynchronously
    openCacheEntry(url, function (cacheEntry) {
      if (cacheEntry) {
        let value = cacheEntry.dataSize;
        // If value is not -1 then replace with actual value, else keep as "unknown"
        if (value != -1) {
          row[COL_IMAGE_RAWSIZE] = value;
          let kbSize = Number(Math.round((value / 1024) * 100) / 100);
          document.l10n
            .formatValue("media-file-size", { size: kbSize })
            .then(function (response) {
              row[COL_IMAGE_SIZE] = response;
              // Invalidate the row to trigger a repaint.
              gImageView.tree.invalidateRow(gImageView.data.indexOf(row));
            });
        }
      }
    });

    if (gImageView.data.length == 1) {
      document.getElementById("mediaTab").hidden = false;
    }
  } else {
    var i = gImageHash[url][type][alt];
    gImageView.data[i][COL_IMAGE_COUNT]++;
    // The same image can occur several times on the page at different sizes.
    // If the "View Image Info" context menu item was used, ensure we select
    // the correct element.
    if (
      !gImageView.data[i][COL_IMAGE_BG] &&
      gImageElement &&
      url == gImageElement.currentSrc &&
      gImageElement.width == element.width &&
      gImageElement.height == element.height &&
      gImageElement.imageText == element.imageText
    ) {
      gImageView.data[i][COL_IMAGE_NODE] = element;
    }
  }
}

// Link Stuff
function onBeginLinkDrag(event, urlField, descField) {
  if (event.originalTarget.localName != "treechildren") {
    return;
  }

  var tree = event.target;
  if (tree.localName != "tree") {
    tree = tree.parentNode;
  }

  var row = tree.getRowAt(event.clientX, event.clientY);
  if (row == -1) {
    return;
  }

  // Adding URL flavor
  var col = tree.columns[urlField];
  var url = tree.view.getCellText(row, col);
  col = tree.columns[descField];
  var desc = tree.view.getCellText(row, col);

  var dt = event.dataTransfer;
  dt.setData("text/x-moz-url", url + "\n" + desc);
  dt.setData("text/url-list", url);
  dt.setData("text/plain", url);
}

// Image Stuff
function getSelectedRows(tree) {
  var start = {};
  var end = {};
  var numRanges = tree.view.selection.getRangeCount();

  var rowArray = [];
  for (var t = 0; t < numRanges; t++) {
    tree.view.selection.getRangeAt(t, start, end);
    for (var v = start.value; v <= end.value; v++) {
      rowArray.push(v);
    }
  }

  return rowArray;
}

function getSelectedRow(tree) {
  var rows = getSelectedRows(tree);
  return rows.length == 1 ? rows[0] : -1;
}

async function selectSaveFolder(aCallback) {
  const { nsIFile, nsIFilePicker } = Ci;
  let titleText = await document.l10n.formatValue("media-select-folder");
  let fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
  let fpCallback = function fpCallback_done(aResult) {
    if (aResult == nsIFilePicker.returnOK) {
      aCallback(fp.file.QueryInterface(nsIFile));
    } else {
      aCallback(null);
    }
  };

  fp.init(window.browsingContext, titleText, nsIFilePicker.modeGetFolder);
  fp.appendFilters(nsIFilePicker.filterAll);
  try {
    let initialDir = Services.prefs.getComplexValue(
      "browser.download.dir",
      nsIFile
    );
    if (initialDir) {
      fp.displayDirectory = initialDir;
    }
  } catch (ex) {}
  fp.open(fpCallback);
}

function saveMedia() {
  var tree = document.getElementById("imagetree");
  var rowArray = getSelectedRows(tree);
  let ReferrerInfo = Components.Constructor(
    "@mozilla.org/referrer-info;1",
    "nsIReferrerInfo",
    "init"
  );

  if (rowArray.length == 1) {
    let row = rowArray[0];
    let item = gImageView.data[row][COL_IMAGE_NODE];
    let url = gImageView.data[row][COL_IMAGE_ADDRESS];

    if (url) {
      var titleKey = "SaveImageTitle";

      if (HTMLVideoElement.isInstance(item)) {
        titleKey = "SaveVideoTitle";
      } else if (HTMLAudioElement.isInstance(item)) {
        titleKey = "SaveAudioTitle";
      }

      // Bug 1565216 to evaluate passing referrer as item.baseURL
      let referrerInfo = new ReferrerInfo(
        Ci.nsIReferrerInfo.EMPTY,
        true,
        Services.io.newURI(item.baseURI)
      );
      let cookieJarSettings = E10SUtils.deserializeCookieJarSettings(
        gDocInfo.cookieJarSettings
      );
      internalSave(
        url,
        null,
        null,
        null,
        null,
        item.mimeType,
        false,
        titleKey,
        null,
        referrerInfo,
        cookieJarSettings,
        null,
        false,
        null,
        gDocInfo.isContentWindowPrivate,
        gDocInfo.principal
      );
    }
  } else {
    selectSaveFolder(function (aDirectory) {
      if (aDirectory) {
        var saveAnImage = function (aURIString, aChosenData, aBaseURI) {
          uniqueFile(aChosenData.file);

          let referrerInfo = new ReferrerInfo(
            Ci.nsIReferrerInfo.EMPTY,
            true,
            aBaseURI
          );
          let cookieJarSettings = E10SUtils.deserializeCookieJarSettings(
            gDocInfo.cookieJarSettings
          );
          internalSave(
            aURIString,
            null,
            null,
            null,
            null,
            null,
            false,
            "SaveImageTitle",
            aChosenData,
            referrerInfo,
            cookieJarSettings,
            null,
            false,
            null,
            gDocInfo.isContentWindowPrivate,
            gDocInfo.principal
          );
        };

        for (var i = 0; i < rowArray.length; i++) {
          let v = rowArray[i];
          let dir = aDirectory.clone();
          let item = gImageView.data[v][COL_IMAGE_NODE];
          let uriString = gImageView.data[v][COL_IMAGE_ADDRESS];
          let uri = Services.io.newURI(uriString);

          try {
            uri.QueryInterface(Ci.nsIURL);
            dir.append(decodeURIComponent(uri.fileName));
          } catch (ex) {
            // data:/blob: uris
            // Supply a dummy filename, otherwise Download Manager
            // will try to delete the base directory on failure.
            dir.append(gImageView.data[v][COL_IMAGE_TYPE]);
          }

          if (i == 0) {
            saveAnImage(
              uriString,
              new AutoChosen(dir, uri),
              Services.io.newURI(item.baseURI)
            );
          } else {
            // This delay is a hack which prevents the download manager
            // from opening many times. See bug 377339.
            setTimeout(
              saveAnImage,
              200,
              uriString,
              new AutoChosen(dir, uri),
              Services.io.newURI(item.baseURI)
            );
          }
        }
      }
    });
  }
}

function onImageSelect() {
  var previewBox = document.getElementById("mediaPreviewBox");
  var mediaSaveBox = document.getElementById("mediaSaveBox");
  var splitter = document.getElementById("mediaSplitter");
  var tree = document.getElementById("imagetree");
  var count = tree.view.selection.count;
  if (count == 0) {
    previewBox.collapsed = true;
    mediaSaveBox.collapsed = true;
    splitter.collapsed = true;
    tree.setAttribute("flex", "1");
  } else if (count > 1) {
    splitter.collapsed = true;
    previewBox.collapsed = true;
    mediaSaveBox.collapsed = false;
    tree.setAttribute("flex", "1");
  } else {
    mediaSaveBox.collapsed = true;
    splitter.collapsed = false;
    previewBox.collapsed = false;
    tree.setAttribute("flex", "0");
    makePreview(getSelectedRows(tree)[0]);
  }
}

// Makes the media preview (image, video, etc) for the selected row on the media tab.
function makePreview(row) {
  var item = gImageView.data[row][COL_IMAGE_NODE];
  var url = gImageView.data[row][COL_IMAGE_ADDRESS];
  var isBG = gImageView.data[row][COL_IMAGE_BG];

  setItemValue("imageurltext", url);
  setItemValue("imagetext", item.imageText);
  setItemValue("imagelongdesctext", item.longDesc);

  // get cache info
  var cacheKey = url.replace(/#.*$/, "");
  openCacheEntry(cacheKey, async function (cacheEntry) {
    // find out the file size
    if (cacheEntry) {
      let imageSize = cacheEntry.dataSize;
      var kbSize = Math.round((imageSize / 1024) * 100) / 100;
      document.l10n.setAttributes(
        document.getElementById("imagesizetext"),
        "properties-general-size",
        { kb: formatNumber(kbSize), bytes: formatNumber(imageSize) }
      );
    } else {
      document.l10n.setAttributes(
        document.getElementById("imagesizetext"),
        "media-unknown-not-cached"
      );
    }

    var mimeType = item.mimeType || this.getContentTypeFromHeaders(cacheEntry);
    var numFrames = item.numFrames;

    let element = document.getElementById("imagetypetext");
    var imageType;
    if (mimeType) {
      // We found the type, try to display it nicely
      let imageMimeType = /^image\/(.*)/i.exec(mimeType);
      if (imageMimeType) {
        imageType = imageMimeType[1].toUpperCase();
        if (numFrames > 1) {
          document.l10n.setAttributes(element, "media-animated-image-type", {
            type: imageType,
            frames: numFrames,
          });
        } else {
          document.l10n.setAttributes(element, "media-image-type", {
            type: imageType,
          });
        }
      } else {
        // the MIME type doesn't begin with image/, display the raw type
        element.setAttribute("value", mimeType);
        element.removeAttribute("data-l10n-id");
      }
    } else {
      // We couldn't find the type, fall back to the value in the treeview
      element.setAttribute("value", gImageView.data[row][COL_IMAGE_TYPE]);
      element.removeAttribute("data-l10n-id");
    }

    let forceMediaDocument = null;
    let message = {
      width: undefined,
      height: undefined,
    };

    let isAllowed = checkProtocol(gImageView.data[row]);
    if (isAllowed) {
      try {
        Services.scriptSecurityManager.checkLoadURIWithPrincipal(
          gDocInfo.principal,
          Services.io.newURI(url),
          0
        );
      } catch {
        isAllowed = false;
      }
    }

    if (
      (item.HTMLLinkElement ||
        item.HTMLInputElement ||
        item.HTMLImageElement ||
        item.SVGImageElement ||
        (item.HTMLObjectElement && mimeType && mimeType.startsWith("image/")) ||
        isBG) &&
      isAllowed
    ) {
      forceMediaDocument = "image";

      if (item.SVGImageElement) {
        message.width = item.SVGImageElementWidth;
        message.height = item.SVGImageElementHeight;
      } else if (!isBG) {
        if ("width" in item && item.width) {
          message.width = item.width;
        }
        if ("height" in item && item.height) {
          message.height = item.height;
        }
      }

      document.getElementById("theimagecontainer").collapsed = false;
      document.getElementById("brokenimagecontainer").collapsed = true;
    } else if (item.HTMLVideoElement && isAllowed) {
      forceMediaDocument = "video";

      document.getElementById("theimagecontainer").collapsed = false;
      document.getElementById("brokenimagecontainer").collapsed = true;

      document.l10n.setAttributes(
        document.getElementById("imagedimensiontext"),
        "media-dimensions",
        {
          dimx: formatNumber(item.videoWidth),
          dimy: formatNumber(item.videoHeight),
        }
      );
    } else if (item.HTMLAudioElement && isAllowed) {
      forceMediaDocument = "video"; // Audio also uses a VideoDocument.

      document.getElementById("theimagecontainer").collapsed = false;
      document.getElementById("brokenimagecontainer").collapsed = true;
    } else {
      // fallback image for protocols not allowed (e.g., javascript:)
      // or elements not [yet] handled (e.g., object, embed).
      document.getElementById("brokenimagecontainer").collapsed = false;
      document.getElementById("theimagecontainer").collapsed = true;
      return;
    }

    const mediaBrowser = document.getElementById("mediaBrowser");

    const options = {
      triggeringPrincipal: gDocInfo.principal,
      forceMediaDocument,
    };
    mediaBrowser.loadURI(Services.io.newURI(url), options);

    await new Promise(resolve => {
      let webProgressListener = {
        onStateChange(webProgress, request, aStateFlags) {
          if (aStateFlags & Ci.nsIWebProgressListener.STATE_STOP) {
            mediaBrowser.webProgress?.removeProgressListener(
              webProgressListener
            );
            resolve();
          }
        },

        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener2",
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
      };
      mediaBrowser.addProgressListener(
        webProgressListener,
        Ci.nsIWebProgress.NOTIFY_STATE_WINDOW
      );
    });

    try {
      const actor =
        mediaBrowser.browsingContext.currentWindowGlobal.getActor(
          "PageInfoPreview"
        );

      let data = await actor.sendQuery("PageInfoPreview:resize", message);
      if (!data) {
        return;
      }

      let tree = document.getElementById("imagetree");
      let activeRow = getSelectedRows(tree)[0];

      // Make sure we only update the dimensions if the
      // image is still selected.
      if (url !== gImageView.data[activeRow][COL_IMAGE_ADDRESS]) {
        return;
      }

      if (
        data.width != data.naturalWidth ||
        data.height != data.naturalHeight
      ) {
        document.l10n.setAttributes(
          document.getElementById("imagedimensiontext"),
          "media-dimensions-scaled",
          {
            dimx: formatNumber(data.naturalWidth),
            dimy: formatNumber(data.naturalHeight),
            scaledx: formatNumber(data.width),
            scaledy: formatNumber(data.height),
          }
        );
      } else {
        document.l10n.setAttributes(
          document.getElementById("imagedimensiontext"),
          "media-dimensions",
          {
            dimx: formatNumber(data.width),
            dimy: formatNumber(data.height),
          }
        );
      }
    } catch (e) {
      console.error(e);
    } finally {
      // Event for tests.
      window.dispatchEvent(new Event("page-info-mediapreview-load"));
    }
  });
}

function getContentTypeFromHeaders(cacheEntryDescriptor) {
  if (!cacheEntryDescriptor) {
    return null;
  }

  let headers = cacheEntryDescriptor.getMetaDataElement("response-head");
  let type = /^Content-Type:\s*(.*?)\s*(?:\;|$)/im.exec(headers);
  return type && type[1];
}

function setItemValue(id, value) {
  var item = document.getElementById(id);
  item.closest("tr").hidden = !value;
  if (value) {
    item.value = value;
  }
}

function formatNumber(number) {
  return (+number).toLocaleString(); // coerce number to a numeric value before calling toLocaleString()
}

function formatDate(datestr, unknown) {
  var date = new Date(datestr);
  if (!date.valueOf()) {
    return unknown;
  }

  const dateTimeFormatter = new Services.intl.DateTimeFormat(undefined, {
    dateStyle: "long",
    timeStyle: "long",
  });
  return dateTimeFormatter.format(date);
}

let treeController = {
  supportsCommand(command) {
    return command == "cmd_copy" || command == "cmd_selectAll";
  },

  isCommandEnabled() {
    return true; // not worth checking for this
  },

  doCommand(command) {
    switch (command) {
      case "cmd_copy":
        doCopy();
        break;
      case "cmd_selectAll":
        document.activeElement.view.selection.selectAll();
        break;
    }
  },
};

function doCopy() {
  if (!gClipboardHelper) {
    return;
  }

  var elem = document.commandDispatcher.focusedElement;

  if (elem && elem.localName == "tree") {
    var view = elem.view;
    var selection = view.selection;
    var text = [],
      tmp = "";
    var min = {},
      max = {};

    var count = selection.getRangeCount();

    for (var i = 0; i < count; i++) {
      selection.getRangeAt(i, min, max);

      for (var row = min.value; row <= max.value; row++) {
        tmp = view.getCellValue(row, null);
        if (tmp) {
          text.push(tmp);
        }
      }
    }
    gClipboardHelper.copyString(text.join("\n"));
  }
}

function doSelectAllMedia() {
  var tree = document.getElementById("imagetree");

  if (tree) {
    tree.view.selection.selectAll();
  }
}

function selectImage() {
  if (!gImageElement) {
    return;
  }

  var tree = document.getElementById("imagetree");
  for (var i = 0; i < tree.view.rowCount; i++) {
    // If the image row element is the image selected from the "View Image Info" context menu item.
    let image = gImageView.data[i][COL_IMAGE_NODE];
    if (
      !gImageView.data[i][COL_IMAGE_BG] &&
      gImageElement.currentSrc == gImageView.data[i][COL_IMAGE_ADDRESS] &&
      gImageElement.width == image.width &&
      gImageElement.height == image.height &&
      gImageElement.imageText == image.imageText
    ) {
      tree.view.selection.select(i);
      tree.ensureRowIsVisible(i);
      tree.focus();
      return;
    }
  }
}

function checkProtocol(img) {
  var url = img[COL_IMAGE_ADDRESS];
  return (
    /^data:image\//i.test(url) ||
    /^(https?|file|about|chrome|resource):/.test(url)
  );
}

async function getOaWithPartitionKey(browsingContext, browser) {
  browser = browser || window.opener.gBrowser.selectedBrowser;
  browsingContext = browsingContext || browser.browsingContext;

  let actor = browsingContext.currentWindowGlobal.getActor("PageInfo");
  let partitionKeyFromChild = await actor.sendQuery("PageInfo:getPartitionKey");

  let oa = browser.contentPrincipal.originAttributes;
  oa.partitionKey = partitionKeyFromChild.partitionKey;

  return oa;
}
