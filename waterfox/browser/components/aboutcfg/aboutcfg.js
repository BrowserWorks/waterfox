/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const nsIPrefLocalizedString = Ci.nsIPrefLocalizedString;
const _nsISupportsString = Ci.nsISupportsString;
const nsIPrefBranch = Ci.nsIPrefBranch;
const nsIClipboardHelper = Ci.nsIClipboardHelper;

const nsClipboardHelper_CONTRACTID = "@mozilla.org/widget/clipboardhelper;1";

const gPrefBranch = Services.prefs;
const gClipboardHelper =
  Cc[nsClipboardHelper_CONTRACTID].getService(nsIClipboardHelper);

const gLockProps = ["default", "user", "locked"];
// we get these from a string bundle
const gLockStrs = [];
const gTypeStrs = [];

const PREF_IS_DEFAULT_VALUE = 0;
const PREF_IS_MODIFIED = 1;
const PREF_IS_LOCKED = 2;

const gPrefHash = {};
const gPrefArray = [];
let gPrefView = gPrefArray; // share the JS array
let gSortedColumn = "prefCol";
let gSortFunction = null;
let gSortDirection = 1; // 1 is ascending; -1 is descending
let gFilter = null;

const view = {
  get rowCount() {
    return gPrefView.length;
  },
  getCellText(index, col) {
    if (!(index in gPrefView)) {
      return "";
    }

    const value = gPrefView[index][col.id];

    switch (col.id) {
      case "lockCol":
        return gLockStrs[value];
      case "typeCol":
        return gTypeStrs[value];
      default:
        return value;
    }
  },
  getRowProperties(_index) {
    return "";
  },
  getCellProperties(index, _col) {
    if (index in gPrefView) {
      return gLockProps[gPrefView[index].lockCol];
    }

    return "";
  },
  getColumnProperties(_col) {
    return "";
  },
  treebox: null,
  selection: null,
  isContainer(_index) {
    return false;
  },
  isContainerOpen(_index) {
    return false;
  },
  isContainerEmpty(_index) {
    return false;
  },
  isSorted() {
    return true;
  },
  canDrop(_index, _orientation) {
    return false;
  },
  drop(_row, _orientation) {},
  setTree(out) {
    this.treebox = out;
  },
  getParentIndex(_rowIndex) {
    return -1;
  },
  hasNextSibling(_rowIndex, _afterIndex) {
    return false;
  },
  getLevel(_index) {
    return 1;
  },
  getImageSrc(_row, _col) {
    return "";
  },
  toggleOpenState(_index) {},
  cycleHeader(col) {
      let index = this.selection.currentIndex;
      if (col.id === gSortedColumn) {
        gSortDirection = -gSortDirection;
        gPrefArray.reverse();
        if (gPrefView !== gPrefArray) {
          gPrefView.reverse();
        }
        if (index >= 0) {
          index = gPrefView.length - index - 1;
        }
      } else {
        let pref = null;
        if (index >= 0) {
          pref = gPrefView[index];
        }

        const old = document.getElementById(gSortedColumn);
        old.removeAttribute("sortDirection");
        gSortFunction = gSortFunctions[col.id];
        gPrefArray.sort(gSortFunction);
        if (gPrefView !== gPrefArray) {
          gPrefView.sort(gSortFunction);
        }
        gSortedColumn = col.id;
        if (pref) {
          index = getViewIndexOfPref(pref);
        }
      }
      col.element.setAttribute(
        "sortDirection",
        gSortDirection > 0 ? "ascending" : "descending"
      );
      this.treebox.invalidate();
      if (index >= 0) {
        this.selection.select(index);
        this.treebox.ensureRowIsVisible(index);
      }
    },
  selectionChanged() {},
  cycleCell(_row, _col) {},
  isEditable(_row, _col) {
    return false;
  },
  setCellValue(_row, _col, _value) {},
  setCellText(_row, _col, _value) {},
  isSeparator(_index) {
    return false;
  },
};

// find the index in gPrefView of a pref object
// or -1 if it does not exist in the filtered view
function getViewIndexOfPref(pref) {
  let low = -1;
  let high = gPrefView.length;
  let index = (low + high) >> 1;
  while (index > low) {
    const mid = gPrefView[index];
    if (mid === pref) {
      return index;
    }
    if (gSortFunction(mid, pref) < 0) {
      low = index;
    } else {
      high = index;
    }
    index = (low + high) >> 1;
  }
  return -1;
}

// find the index in gPrefView where a pref object belongs
function getNearestViewIndexOfPref(pref) {
  let low = -1;
  let high = gPrefView.length;
  let index = (low + high) >> 1;
  while (index > low) {
    if (gSortFunction(gPrefView[index], pref) < 0) {
      low = index;
    } else {
      high = index;
    }
    index = (low + high) >> 1;
  }
  return high;
}

// find the index in gPrefArray of a pref object
function getIndexOfPref(pref) {
  let low = -1;
  let high = gPrefArray.length;
  let index = (low + high) >> 1;
  while (index > low) {
    const mid = gPrefArray[index];
    if (mid === pref) {
      return index;
    }
    if (gSortFunction(mid, pref) < 0) {
      low = index;
    } else {
      high = index;
    }
    index = (low + high) >> 1;
  }
  return index;
}

function getNearestIndexOfPref(pref) {
  let low = -1;
  let  high = gPrefArray.length;
  let index = (low + high) >> 1;
  while (index > low) {
    if (gSortFunction(gPrefArray[index], pref) < 0) {
      low = index;
    } else {
      high = index;
    }
    index = (low + high) >> 1;
  }
  return high;
}

const gPrefListener = {
  observe(_subject, topic, prefName) {
    if (topic !== "nsPref:changed") {
      return;
    }

    let arrayIndex = gPrefArray.length;
    let viewIndex = arrayIndex;
    let selectedIndex = view.selection.currentIndex;
    let pref;
    let updateView = false;
    let updateArray = false;
    let addedRow = false;
    if (prefName in gPrefHash) {
      pref = gPrefHash[prefName];
      viewIndex = getViewIndexOfPref(pref);
      arrayIndex = getIndexOfPref(pref);
      fetchPref(prefName, arrayIndex);
      // fetchPref replaces the existing pref object
      pref = gPrefHash[prefName];
      if (viewIndex >= 0) {
        // Might need to update the filtered view
        gPrefView[viewIndex] = gPrefHash[prefName];
        view.treebox.invalidateRow(viewIndex);
      }
      if (gSortedColumn === "lockCol" || gSortedColumn === "valueCol") {
        updateArray = true;
        gPrefArray.splice(arrayIndex, 1);
        if (gFilter?.test(`${pref.prefCol};${pref.valueCol}`)) {
          updateView = true;
          gPrefView.splice(viewIndex, 1);
        }
      }
    } else {
      fetchPref(prefName, arrayIndex);
      pref = gPrefArray.pop();
      updateArray = true;
      addedRow = true;
      if (gFilter?.test(`${pref.prefCol};${pref.valueCol}`)) {
        updateView = true;
      }
    }
    if (updateArray) {
      // Reinsert in the data array
      let newIndex = getNearestIndexOfPref(pref);
      gPrefArray.splice(newIndex, 0, pref);

      if (updateView) {
        // View is filtered, reinsert in the view separately
        newIndex = getNearestViewIndexOfPref(pref);
        gPrefView.splice(newIndex, 0, pref);
      } else if (gFilter) {
        // View is filtered, but nothing to update
        return;
      }

      if (addedRow) {
        view.treebox.rowCountChanged(newIndex, 1);
      }

      // Invalidate the changed range in the view
      const low = Math.min(viewIndex, newIndex);
      const high = Math.max(viewIndex, newIndex);
      view.treebox.invalidateRange(low, high);

      if (selectedIndex === viewIndex) {
        selectedIndex = newIndex;
      } else if (selectedIndex >= low && selectedIndex <= high) {
        selectedIndex += newIndex > viewIndex ? -1 : 1;
      }
      if (selectedIndex >= 0) {
        view.selection.select(selectedIndex);
        if (selectedIndex === newIndex) {
          view.treebox.ensureRowIsVisible(selectedIndex);
        }
      }
    }
  },
};

class prefObject {
  constructor(prefName, _prefIndex) {
    this.prefCol = prefName;
  }
}

prefObject.prototype = {
  lockCol: PREF_IS_DEFAULT_VALUE,
  typeCol: nsIPrefBranch.PREF_STRING,
  valueCol: "",
};

function fetchPref(prefName, prefIndex) {
  const pref = new prefObject(prefName);

  gPrefHash[prefName] = pref;
  gPrefArray[prefIndex] = pref;

  if (gPrefBranch.prefIsLocked(prefName)) {
    pref.lockCol = PREF_IS_LOCKED;
  } else if (gPrefBranch.prefHasUserValue(prefName)) {
    pref.lockCol = PREF_IS_MODIFIED;
  }

  try {
    switch (gPrefBranch.getPrefType(prefName)) {
      case gPrefBranch.PREF_BOOL:
        pref.typeCol = gPrefBranch.PREF_BOOL;
        // convert to a string
        pref.valueCol = gPrefBranch.getBoolPref(prefName).toString();
        break;
      case gPrefBranch.PREF_INT:
        pref.typeCol = gPrefBranch.PREF_INT;
        // convert to a string
        pref.valueCol = gPrefBranch.getIntPref(prefName).toString();
        break;
      default:
        pref.valueCol = gPrefBranch.getStringPref(prefName);
        // Try in case it's a localized string (will throw an exception if not)
        if (
          pref.lockCol === PREF_IS_DEFAULT_VALUE &&
          /^chrome:\/\/.+\/locale\/.+\.properties/.test(pref.valueCol)
        ) {
          pref.valueCol = gPrefBranch.getComplexValue(
            prefName,
            nsIPrefLocalizedString
          ).data;
        }
        break;
    }
  } catch (_e) {
    // Also catch obscure cases in which you can't tell in advance
    // that the pref exists but has no user or default value...
  }
}

async function onConfigLoad() {
  const configContext = document.getElementById("configContext");
  configContext.addEventListener("popupshowing", function (event) {
    if (event.target === this) {
      updateContextMenu();
    }
  });

  const commandListeners = {
    toggleSelected: ModifySelected,
    modifySelected: ModifySelected,
    copyPref,
    copyName,
    copyValue,
    resetSelected: ResetSelected,
  };

  configContext.addEventListener("command", (e) => {
    if (e.target.id in commandListeners) {
      commandListeners[e.target.id]();
    }
  });

  const configString = document.getElementById("configString");
  configString.addEventListener("command", () => {
    NewPref(nsIPrefBranch.PREF_STRING);
  });

  const configInt = document.getElementById("configInt");
  configInt.addEventListener("command", () => {
    NewPref(nsIPrefBranch.PREF_INT);
  });

  const configBool = document.getElementById("configBool");
  configBool.addEventListener("command", () => {
    NewPref(nsIPrefBranch.PREF_BOOL);
  });

  const keyVKReturn = document.getElementById("keyVKReturn");
  keyVKReturn.addEventListener("command", ModifySelected);

  const textBox = document.getElementById("textbox");
  textBox.addEventListener("command", FilterPrefs);

  const configFocuSearch = document.getElementById("configFocuSearch");
  configFocuSearch.addEventListener("command", () => {
    textBox.focus();
  });

  const configFocuSearch2 = document.getElementById("configFocuSearch2");
  configFocuSearch2.addEventListener("command", () => {
    textBox.focus();
  });

  const warningButton = document.getElementById("warningButton");
  warningButton.addEventListener("command", ShowPrefs);

  const configTree = document.getElementById("configTree");
  configTree.addEventListener("select", () => {
    window.updateCommands("select");
  });

  const configTreeBody = document.getElementById("configTreeBody");
  configTreeBody.addEventListener("dblclick", (event) => {
    if (event.button === 0) {
      ModifySelected();
    }
  });

  gLockStrs[PREF_IS_DEFAULT_VALUE] = "default";
  gLockStrs[PREF_IS_MODIFIED] = "modified";
  gLockStrs[PREF_IS_LOCKED] = "locked";
  gTypeStrs[nsIPrefBranch.PREF_STRING] = "string";
  gTypeStrs[nsIPrefBranch.PREF_INT] = "integer";
  gTypeStrs[nsIPrefBranch.PREF_BOOL] = "boolean";

  const showWarning = gPrefBranch.getBoolPref("general.warnOnAboutConfig");

  if (showWarning) {
    document.getElementById("warningButton").focus();
  } else {
    ShowPrefs();
  }
}

// Unhide the warning message
function ShowPrefs() {
  document.getElementById("configDeck").lastElementChild.style.visibility =
    "visible";
  gPrefBranch.getChildList("").forEach(fetchPref);

  const descending = document.getElementsByAttribute(
    "sortDirection",
    "descending"
  );
  if (descending.item(0)) {
    gSortedColumn = descending[0].id;
    gSortDirection = -1;
  } else {
    const ascending = document.getElementsByAttribute(
      "sortDirection",
      "ascending"
    );
    if (ascending.item(0)) {
      gSortedColumn = ascending[0].id;
    } else {
      document
        .getElementById(gSortedColumn)
        .setAttribute("sortDirection", "ascending");
    }
  }
  gSortFunction = gSortFunctions[gSortedColumn];
  gPrefArray.sort(gSortFunction);

  gPrefBranch.addObserver("", gPrefListener);

  const configTree = document.getElementById("configTree");
  configTree.view = view;
  configTree.controllers.insertControllerAt(0, configController);

  document.getElementById("configDeck").setAttribute("selectedIndex", 1);
  document.getElementById("configTreeKeyset").removeAttribute("disabled");
  if (!document.getElementById("showWarningNextTime").checked) {
    gPrefBranch.setBoolPref("general.warnOnAboutConfig", false);
  }

  // Process about:config?filter=<string>
  const textbox = document.getElementById("textbox");
  // About URIs don't support query params, so do this manually
  const loc = document.location.href;
  const matches = /[?&]filter=([^&]+)/i.exec(loc);
  if (matches) {
    textbox.value = decodeURIComponent(matches[1]);
  }

  // Even if we did not set the filter string via the URL query,
  // textbox might have been set via some other mechanism
  if (textbox.value) {
    FilterPrefs();
  }
  textbox.focus();
}

function onConfigUnload() {
  if (
    document.getElementById("configDeck").getAttribute("selectedIndex") === 1
  ) {
    gPrefBranch.removeObserver("", gPrefListener);
    const configTree = document.getElementById("configTree");
    configTree.view = null;
    configTree.controllers.removeController(configController);
  }
}

function FilterPrefs() {
  if (
    document.getElementById("configDeck").getAttribute("selectedIndex") !== 1
  ) {
    return;
  }

  const substring = document.getElementById("textbox").value;
  // Check for "/regex/[i]"
  if (substring.charAt(0) === "/") {
    const r = substring.match(/^\/(.*)\/(i?)$/);
    try {
      gFilter = RegExp(r[1], r[2]);
    } catch (_e) {
      return; // Do nothing on incomplete or bad RegExp
    }
  } else if (substring) {
    gFilter = RegExp(
      substring
        .replace(/([^* \w])/g, "\\$1")
        .replace(/^\*+/, "")
        .replace(/\*+/g, ".*"),
      "i"
    );
  } else {
    gFilter = null;
  }

  const prefCol =
    view.selection && view.selection.currentIndex < 0
      ? null
      : gPrefView[view.selection.currentIndex].prefCol;
  const oldlen = gPrefView.length;
  gPrefView = gPrefArray;
  if (gFilter) {
    gPrefView = [];
    for (let i = 0; i < gPrefArray.length; ++i) {
      if (gFilter.test(`${gPrefArray[i].prefCol};${gPrefArray[i].valueCol}`)) {
        gPrefView.push(gPrefArray[i]);
      }
    }
  }
  view.treebox.invalidate();
  view.treebox.rowCountChanged(oldlen, gPrefView.length - oldlen);
  gotoPref(prefCol);
}

function prefColSortFunction(x, y) {
  if (x.prefCol > y.prefCol) {
    return gSortDirection;
  }
  if (x.prefCol < y.prefCol) {
    return -gSortDirection;
  }
  return 0;
}

function lockColSortFunction(x, y) {
  if (x.lockCol !== y.lockCol) {
    return gSortDirection * (y.lockCol - x.lockCol);
  }
  return prefColSortFunction(x, y);
}

function typeColSortFunction(x, y) {
  if (x.typeCol !== y.typeCol) {
    return gSortDirection * (y.typeCol - x.typeCol);
  }
  return prefColSortFunction(x, y);
}

function valueColSortFunction(x, y) {
  if (x.valueCol > y.valueCol) {
    return gSortDirection;
  }
  if (x.valueCol < y.valueCol) {
    return -gSortDirection;
  }
  return prefColSortFunction(x, y);
}

const gSortFunctions = {
  prefCol: prefColSortFunction,
  lockCol: lockColSortFunction,
  typeCol: typeColSortFunction,
  valueCol: valueColSortFunction,
};

const _gCategoryLabelForSortColumn = {
  prefCol: "SortByName",
  lockCol: "SortByStatus",
  typeCol: "SortByType",
  valueCol: "SortByValue",
};

const configController = {
  supportsCommand: function supportsCommand(command) {
    return command === "cmd_copy";
  },
  isCommandEnabled: function isCommandEnabled(_command) {
    return view.selection && view.selection.currentIndex >= 0;
  },
  doCommand: function doCommand(_command) {
    copyPref();
  },
  onEvent: function onEvent(_event) {},
};

function updateContextMenu() {
  let lockCol = PREF_IS_LOCKED;
  let typeCol = nsIPrefBranch.PREF_STRING;
  let valueCol = "";
  let copyDisabled = true;
  const prefSelected = view.selection.currentIndex >= 0;

  if (prefSelected) {
    const prefRow = gPrefView[view.selection.currentIndex];
    lockCol = prefRow.lockCol;
    typeCol = prefRow.typeCol;
    valueCol = prefRow.valueCol;
    copyDisabled = false;
  }

  const copyPref = document.getElementById("copyPref");
  copyPref.setAttribute("disabled", copyDisabled);

  const copyName = document.getElementById("copyName");
  copyName.setAttribute("disabled", copyDisabled);

  const copyValue = document.getElementById("copyValue");
  copyValue.setAttribute("disabled", copyDisabled);

  const resetSelected = document.getElementById("resetSelected");
  resetSelected.setAttribute("disabled", lockCol !== PREF_IS_MODIFIED);

  const canToggle = typeCol === nsIPrefBranch.PREF_BOOL && valueCol !== "";
  // indicates that a pref is locked or no pref is selected at all
  const isLocked = lockCol === PREF_IS_LOCKED;

  const modifySelected = document.getElementById("modifySelected");
  modifySelected.setAttribute("disabled", isLocked);
  modifySelected.hidden = canToggle;

  const toggleSelected = document.getElementById("toggleSelected");
  toggleSelected.setAttribute("disabled", isLocked);
  toggleSelected.hidden = !canToggle;
}

function copyPref() {
  const pref = gPrefView[view.selection.currentIndex];
  gClipboardHelper.copyString(`${pref.prefCol};${pref.valueCol}`);
}

function copyName() {
  gClipboardHelper.copyString(gPrefView[view.selection.currentIndex].prefCol);
}

function copyValue() {
  gClipboardHelper.copyString(gPrefView[view.selection.currentIndex].valueCol);
}

function ModifySelected() {
  if (view.selection.currentIndex >= 0) {
    ModifyPref(gPrefView[view.selection.currentIndex]);
  }
}

function ResetSelected() {
  const entry = gPrefView[view.selection.currentIndex];
  gPrefBranch.clearUserPref(entry.prefCol);
}

async function NewPref(type) {
  const result = { value: "" };
  const dummy = { value: 0 };

  const [newTitle, newPrompt] = [
    `New ${gTypeStrs[type]} value`,
    "Enter the preference name",
  ];

  if (
    Services.prompt.prompt(window, newTitle, newPrompt, result, null, dummy)
  ) {
    result.value = result.value.trim();
    if (!result.value) {
      return;
    }

    let pref;
    if (result.value in gPrefHash) {
      pref = gPrefHash[result.value];
    } else {
      pref = {
        prefCol: result.value,
        lockCol: PREF_IS_DEFAULT_VALUE,
        typeCol: type,
        valueCol: "",
      };
    }
    if (ModifyPref(pref)) {
      setTimeout(gotoPref, 0, result.value);
    }
  }
}

function gotoPref(pref) {
  // make sure the pref exists and is displayed in the current view
  const index = pref in gPrefHash ? getViewIndexOfPref(gPrefHash[pref]) : -1;
  if (index >= 0) {
    view.selection.select(index);
    view.treebox.ensureRowIsVisible(index);
  } else {
    view.selection.clearSelection();
    view.selection.currentIndex = -1;
  }
}

async function ModifyPref(entry) {
  if (entry.lockCol === PREF_IS_LOCKED) {
    return false;
  }

  const [title] = [`Enter ${gTypeStrs[entry.typeCol]} value`];

  if (entry.typeCol === nsIPrefBranch.PREF_BOOL) {
    const check = { value: entry.valueCol === "false" };
    if (
      !entry.valueCol &&
      !Services.prompt.select(
        window,
        title,
        entry.prefCol,
        [false, true],
        check
      )
    ) {
      return false;
    }
    gPrefBranch.setBoolPref(entry.prefCol, check.value);
  } else {
    const result = window.prompt(entry.prefCol, entry.valueCol);
    if (result === null) {
      return false;
    }
    if (entry.typeCol === nsIPrefBranch.PREF_INT) {
      // | 0 converts to integer or 0; - 0 to float or NaN.
      // Thus, this check should catch all cases.
      const numResult = Number.parseInt(result);
      const val = numResult | 0;
      if (val !== numResult - 0) {
        const [err_title, err_text] = [
          "Invalid value",
          "The text you entered is not a number.",
        ];

        Services.prompt.alert(window, err_title, err_text);
        return false;
      }
      gPrefBranch.setIntPref(entry.prefCol, val);
    } else {
      gPrefBranch.setStringPref(entry.prefCol, result);
    }
  }

  Services.prefs.savePrefFile(null);
  return true;
}

window.onload = onConfigLoad;
window.addEventListener("unload", onConfigUnload);
