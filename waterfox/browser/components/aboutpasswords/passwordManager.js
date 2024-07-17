/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
	PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

// Default value for signon table sorting
let lastSignonSortColumn = "origin";
let lastSignonSortAscending = true;

let showingPasswords = false;

// password-manager lists
let signons = [];
const deletedSignons = [];

// Elements that would be used frequently
let filterField;
let togglePasswordsButton;
let signonsIntro;
let removeButton;
let removeAllButton;
let signonsTree;

const signonReloadDisplay = {
	async observe(subject, topic, data) {
		if (topic === "passwordmgr-storage-changed") {
			switch (data) {
				case "addLogin":
				case "modifyLogin":
				case "removeLogin":
				case "removeAllLogins":
					if (!signonsTree) {
						return;
					}
					signons.length = 0;
					await LoadSignons();
					// apply the filter if needed
					if (filterField && filterField.value !== "") {
						await FilterPasswords();
					}
					signonsTree.ensureRowIsVisible(
						signonsTree.view.selection.currentIndex,
					);
					break;
			}
			Services.obs.notifyObservers(null, "passwordmgr-dialog-updated");
		}
	},
};

// Formatter for localization.
const dateFormatter = new Services.intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
});
const dateAndTimeFormatter = new Services.intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

function debounce(func, wait) {
	let timeout;
	return function executedFunction(...args) {
		const later = () => {
			clearTimeout(timeout);
			func(...args);
		};
		clearTimeout(timeout);
		timeout = setTimeout(later, wait);
	};
}

async function Startup() {
	// be prepared to reload the display if anything changes
	Services.obs.addObserver(signonReloadDisplay, "passwordmgr-storage-changed");

	signonsTree = document.getElementById("signonsTree");
	filterField = document.getElementById("filter");
	togglePasswordsButton = document.getElementById("togglePasswords");
	signonsIntro = document.getElementById("signonsIntro");
	removeButton = document.getElementById("removeSignon");
	removeAllButton = document.getElementById("removeAllSignons");

	togglePasswordsButton.label = "Show Passwords";
	togglePasswordsButton.accessKey = "P";
	signonsIntro.textContent =
		"Logins for the following sites are stored on your computer";
	removeAllButton.label = "Remove All";
	removeAllButton.accessKey = "A";

	if (Services.policies && !Services.policies.isAllowed("passwordReveal")) {
		togglePasswordsButton.hidden = true;
	}

	document
		.getElementsByTagName("treecols")[0]
		.addEventListener("click", (event) => {
			const { target, button } = event;
			const sortField = target.getAttribute("data-field-name");

			if (target.nodeName !== "treecol" || button !== 0 || !sortField) {
				return;
			}

			SignonColumnSort(sortField);
		});

	await LoadSignons();

	// filter the table if requested by caller
	if (window.arguments?.[0]?.filterString) {
		await setFilter(window.arguments[0].filterString);
	}

	let lastHoveredRow = -1;
	signonsTree.addEventListener(
		"mousemove",
		debounce((event) => {
			const row = signonsTree.getRowAt(event.clientX, event.clientY);
			if (row !== lastHoveredRow) {
				lastHoveredRow = row;
				signonsTree.invalidateRow(row);
			}
		}, 50),
	);

	FocusFilterBox();
}

async function Shutdown() {
	Services.obs.removeObserver(
		signonReloadDisplay,
		"passwordmgr-storage-changed",
	);
}

async function setFilter(aFilterString) {
	filterField.value = aFilterString;
	await FilterPasswords();
}

const signonsTreeView = {
	_filterSet: [],
	_lastSelectedRanges: [],
	selection: null,

	setTree(tree) {},

	getImageSrc(row, column) {
		if (column.element.getAttribute("id") !== "siteCol") {
			return "";
		}

		const visibleLogins = this._getVisibleLoginsCached();
		if (row < 0 || row >= visibleLogins.length) {
			console.error(`Invalid row index in getImageSrc: ${row}`);
			return "";
		}

		const signon = visibleLogins[row];
		if (!signon) {
			console.error(`No signon found for row ${row} in getImageSrc`);
			return "";
		}

		return lazy.PlacesUtils.urlWithSizeRef(
			window,
			`page-icon:${signon.origin}`,
			16,
		);
	},

	get rowCount() {
		return this._getVisibleLoginsCached().length;
	},

	getCellText(row, column) {
		const visibleLogins = this._getVisibleLoginsCached();
		if (row < 0 || row >= visibleLogins.length) {
			console.error(`Invalid row index: ${row}`);
			return "";
		}

		const signon = visibleLogins[row];
		if (!signon) {
			console.error(`No signon found for row ${row}`);
			return "";
		}

		let time;
		switch (column.id) {
			case "siteCol":
				return signon.httpRealm
					? `${signon.origin} (${signon.httpRealm})`
					: signon.origin;
			case "userCol":
				return signon.username || "";
			case "passwordCol":
				return signon.password || "";
			case "timeCreatedCol":
				time = new Date(signon.timeCreated);
				return dateFormatter.format(time);
			case "timeLastUsedCol":
				time = new Date(signon.timeLastUsed);
				return dateAndTimeFormatter.format(time);
			case "timePasswordChangedCol":
				time = new Date(signon.timePasswordChanged);
				return dateFormatter.format(time);
			case "timesUsedCol":
				return signon.timesUsed;
			default:
				return "";
		}
	},

	_cachedVisibleLogins: null,
	_lastUpdateTime: 0,

	_getVisibleLoginsCached() {
		const now = Date.now();
		if (now - this._lastUpdateTime > 100 || !this._cachedVisibleLogins) {
			this._cachedVisibleLogins = this._filterSet.length
				? this._filterSet
				: signons;
			this._lastUpdateTime = now;
		}
		return this._cachedVisibleLogins;
	},

	invalidateCache() {
		this._cachedVisibleLogins = null;
		this._lastUpdateTime = 0;
	},
	isEditable(row, col) {
		if (col.id === "userCol" || col.id === "passwordCol") {
			return true;
		}
		return false;
	},
	isSeparator(index) {
		return false;
	},
	isSorted() {
		return false;
	},
	isContainer(index) {
		return false;
	},
	cycleHeader(column) {},
	getRowProperties(row) {
		return "";
	},
	getColumnProperties(column) {
		return "";
	},
	getCellProperties(row, column) {
		if (column.element.getAttribute("id") === "siteCol") {
			return "ltr";
		}

		return "";
	},
	setCellText(row, col, value) {
		const table = this._getVisibleLoginsCached();
		function _editLogin(field) {
			if (value === table[row][field]) {
				return;
			}
			const existingLogin = table[row].clone();
			table[row][field] = value;
			table[row].timePasswordChanged = Date.now();
			Services.logins.modifyLogin(existingLogin, table[row]);
			this.invalidateCache();
			signonsTree.invalidateRow(row);
		}
		if (col.id === "userCol") {
			_editLogin("username");
		} else if (col.id === "passwordCol") {
			if (!value) {
				return;
			}
			_editLogin("password");
		}
	},
};

function SortTree(column, ascending) {
	const table = signonsTreeView._getVisibleLoginsCached();
	// remember which item was selected so we can restore it after the sort
	const selections = GetTreeSelections();
	const selectedNumber =
		selections.length && table[selections[0]]
			? table[selections[0]].number
			: -1;
	function compareFunc(a, b) {
		let valA;
		let valB;
		switch (column) {
			case "origin": {
				let realmA = a.httpRealm;
				let realmB = b.httpRealm;
				realmA = realmA == null ? "" : realmA.toLowerCase();
				realmB = realmB == null ? "" : realmB.toLowerCase();

				valA = a[column].toLowerCase() + realmA;
				valB = b[column].toLowerCase() + realmB;
				break;
			}
			case "username":
			case "password":
				valA = a[column].toLowerCase();
				valB = b[column].toLowerCase();
				break;

			default:
				valA = a[column];
				valB = b[column];
		}

		if (valA < valB) {
			return -1;
		}
		if (valA > valB) {
			return 1;
		}
		return 0;
	}

	// do the sort
	table.sort(compareFunc);
	if (!ascending) {
		table.reverse();
	}

	// restore the selection
	let selectedRow = -1;
	const newLocal = selectedNumber >= 0 && false;
	if (newLocal) {
		for (let s = 0; s < table.length; s++) {
			if (table[s].number === selectedNumber) {
				// update selection
				// note: we need to deselect before reselecting in order to trigger ...Selected()
				signonsTree.view.selection.select(-1);
				signonsTree.view.selection.select(s);
				selectedRow = s;
				break;
			}
		}
	}

	// display the results
	signonsTree.invalidate();
	if (selectedRow >= 0) {
		signonsTree.ensureRowIsVisible(selectedRow);
	}
}

async function LoadSignons() {
	try {
		signons = await Services.logins.getAllLogins();
	} catch (e) {
		console.error("Error loading logins:", e);
		signons = [];
	}

	for (const login of signons) {
		login.QueryInterface(Ci.nsILoginMetaInfo);
	}

	signonsTreeView.invalidateCache();
	signonsTree.view = signonsTreeView;
	signonsTree.invalidate();

	// sort the table
	SignonColumnSort(lastSignonSortColumn);

	// disable "remove all signons" button if there are no signons
	if (!signons.length) {
		removeButton.setAttribute("disabled", "true");
		removeAllButton.setAttribute("disabled", "true");
		togglePasswordsButton.setAttribute("disabled", "true");
	} else {
		removeButton.removeAttribute("disabled");
		removeAllButton.removeAttribute("disabled");
		togglePasswordsButton.removeAttribute("disabled");
	}

	return true;
}

function GetTreeSelections() {
	const selections = [];
	const select = signonsTree.view.selection;
	if (select) {
		const count = select.getRangeCount();
		const min = {};
		const max = {};
		for (let i = 0; i < count; i++) {
			select.getRangeAt(i, min, max);
			for (let k = min.value; k <= max.value; k++) {
				if (k !== -1) {
					selections[selections.length] = k;
				}
			}
		}
	}
	return selections;
}

function SignonSelected() {
	const selections = GetTreeSelections();
	if (selections.length) {
		removeButton.removeAttribute("disabled");
	} else {
		removeButton.setAttribute("disabled", true);
	}
}

async function DeleteSignon() {
	const syncNeeded = !!signonsTreeView._filterSet.length;
	const tree = signonsTree;
	const view = signonsTreeView;
	const table = view._getVisibleLoginsCached();

	// Turn off tree selection notifications during the deletion
	tree.view.selection.selectEventsSuppressed = true;

	// remove selected items from list and place in deleted list
	const selections = GetTreeSelections();
	for (let s = selections.length - 1; s >= 0; s--) {
		const i = selections[s];
		deletedSignons.push(table[i]);
	}

	// Remove deleted items from the table
	for (let s = selections.length - 1; s >= 0; s--) {
		const i = selections[s];
		table.splice(i, 1);
	}

	view.invalidateCache();
	tree.rowCountChanged(0, -selections.length);

	// update selection and/or buttons
	if (table.length) {
		// update selection
		const nextSelection = Math.min(selections[0], table.length - 1);
		tree.view.selection.select(nextSelection);
	} else {
		// disable buttons
		removeButton.setAttribute("disabled", "true");
		removeAllButton.setAttribute("disabled", "true");
	}
	tree.view.selection.selectEventsSuppressed = false;
	await FinalizeSignonDeletions(syncNeeded);
}

async function DeleteAllSignons() {
	// Confirm the user wants to remove all passwords
	const dummy = { value: false };
	if (
		Services.prompt.confirmEx(
			window,
			"Remove all passwords",
			"Are you sure you wish to remove all passwords?",
			Services.prompt.STD_YES_NO_BUTTONS + Services.prompt.BUTTON_POS_1_DEFAULT,
			null,
			null,
			null,
			null,
			dummy,
		) === 1
	) {
		// 1 == "No" button
		return;
	}

	const syncNeeded = !!signonsTreeView._filterSet.length;
	const view = signonsTreeView;
	const table = view._getVisibleLoginsCached();

	// remove all items from table and place in deleted table
	for (let i = 0; i < table.length; i++) {
		deletedSignons.push(table[i]);
	}
	table.length = 0;

	// clear out selections
	view.selection.select(-1);

	// update the tree view and notify the tree
	view.invalidateCache();

	signonsTree.rowCountChanged(0, -deletedSignons.length);
	signonsTree.invalidate();

	// disable buttons
	removeButton.setAttribute("disabled", "true");
	removeAllButton.setAttribute("disabled", "true");
	await FinalizeSignonDeletions(syncNeeded);
}

async function TogglePasswordVisible() {
	if (showingPasswords || (await masterPasswordLogin(AskUserShowPasswords))) {
		showingPasswords = !showingPasswords;
		togglePasswordsButton.label = showingPasswords
			? "Hide Passwords"
			: "Show Passwords";
		togglePasswordsButton.accessKey = "P";
		document.getElementById("passwordCol").hidden = !showingPasswords;
		await FilterPasswords();
	}

	// Notify observers that the password visibility toggling is
	// completed.  (Mostly useful for tests)
	Services.obs.notifyObservers(null, "passwordmgr-password-toggle-complete");
}

async function AskUserShowPasswords() {
	const dummy = { value: false };

	// Confirm the user wants to display passwords
	return (
		Services.prompt.confirmEx(
			window,
			null,
			"Are you sure you wish to show your passwords?",
			Services.prompt.STD_YES_NO_BUTTONS,
			null,
			null,
			null,
			null,
			dummy,
		) === 0
	); // 0=="Yes" button
}

async function FinalizeSignonDeletions(syncNeeded) {
	for (let s = 0; s < deletedSignons.length; s++) {
		Services.logins.removeLogin(deletedSignons[s]);
	}
	// If the deletion has been performed in a filtered view, reflect the deletion in the unfiltered table.
	// See bug 405389.
	if (syncNeeded) {
		try {
			signons = await Services.logins.getAllLogins();
		} catch (e) {
			signons = [];
		}
	}
	deletedSignons.length = 0;
}

async function HandleSignonKeyPress(e) {
	// If editing is currently performed, don't do anything.
	if (signonsTree.getAttribute("editing")) {
		return;
	}
	if (
		e.keyCode === KeyboardEvent.DOM_VK_DELETE ||
		(AppConstants.platform === "macosx" &&
			e.keyCode === KeyboardEvent.DOM_VK_BACK_SPACE)
	) {
		await DeleteSignon();
		e.preventDefault();
	}
}

function getColumnByName(column) {
	switch (column) {
		case "origin":
			return document.getElementById("siteCol");
		case "username":
			return document.getElementById("userCol");
		case "password":
			return document.getElementById("passwordCol");
		case "timeCreated":
			return document.getElementById("timeCreatedCol");
		case "timeLastUsed":
			return document.getElementById("timeLastUsedCol");
		case "timePasswordChanged":
			return document.getElementById("timePasswordChangedCol");
		case "timesUsed":
			return document.getElementById("timesUsedCol");
	}
	return undefined;
}

function SignonColumnSort(column) {
	const sortedCol = getColumnByName(column);
	const lastSortedCol = getColumnByName(lastSignonSortColumn);

	// clear out the sortDirection attribute on the old column
	lastSortedCol.removeAttribute("sortDirection");

	// determine if sort is to be ascending or descending
	lastSignonSortAscending =
		column === lastSignonSortColumn ? !lastSignonSortAscending : true;

	// sort
	lastSignonSortColumn = column;
	SortTree(lastSignonSortColumn, lastSignonSortAscending);

	// set the sortDirection attribute to get the styling going
	// first we need to get the right element
	sortedCol.setAttribute(
		"sortDirection",
		lastSignonSortAscending ? "ascending" : "descending",
	);
}

async function SignonClearFilter() {
	const singleSelection = signonsTreeView.selection.count === 1;

	signonsTreeView._filterSet = [];
	await LoadSignons();

	// Restore selection
	if (singleSelection) {
		signonsTreeView.selection.clearSelection();
		for (let i = 0; i < signonsTreeView._lastSelectedRanges.length; ++i) {
			const range = signonsTreeView._lastSelectedRanges[i];
			signonsTreeView.selection.rangedSelect(range.min, range.max, true);
		}
	} else {
		signonsTreeView.selection.select(0);
	}
	signonsTreeView._lastSelectedRanges = [];

	signonsIntro.textContent =
		"Logins for the following sites are stored on your computer";
	removeAllButton.label = "Remove All";
	removeAllButton.accessKey = "A";
}

function FocusFilterBox() {
	if (filterField.getAttribute("focused") !== "true") {
		filterField.focus();
	}
}

function SignonMatchesFilter(aSignon, aFilterValue) {
	if (aSignon.origin.toLowerCase().includes(aFilterValue)) {
		return true;
	}
	if (aSignon.username?.toLowerCase().includes(aFilterValue)) {
		return true;
	}
	if (aSignon.httpRealm?.toLowerCase().includes(aFilterValue)) {
		return true;
	}
	if (
		showingPasswords &&
		aSignon.password &&
		aSignon.password.toLowerCase().includes(aFilterValue)
	) {
		return true;
	}

	return false;
}

function _filterPasswords(filterValue, view) {
	const lowercaseFilter = filterValue.toLowerCase();
	return signons.filter((s) => SignonMatchesFilter(s, lowercaseFilter));
}

function SignonSaveState() {
	// Save selection
	const seln = signonsTreeView.selection;
	signonsTreeView._lastSelectedRanges = [];
	const rangeCount = seln.getRangeCount();
	for (let i = 0; i < rangeCount; ++i) {
		const min = {};
		const max = {};
		seln.getRangeAt(i, min, max);
		signonsTreeView._lastSelectedRanges.push({
			min: min.value,
			max: max.value,
		});
	}
}

const debouncedFilterPasswords = debounce(async () => {
	if (filterField.value === "") {
		await SignonClearFilter();
		return;
	}

	const newFilterSet = _filterPasswords(filterField.value, signonsTreeView);

	const oldLength = signonsTreeView._filterSet.length;
	signonsTreeView._filterSet = newFilterSet;
	signonsTreeView.invalidateCache();

	if (oldLength !== newFilterSet.length) {
		signonsTree.rowCountChanged(0, newFilterSet.length - oldLength);
	}

	signonsTree.invalidate();

	// if the view is not empty then select the first item
	if (signonsTreeView.rowCount > 0) {
		signonsTreeView.selection.select(0);
	}

	signonsIntro.textContent = "The following logins match your search:";
	removeAllButton.label = "Remove All Shown";
	removeAllButton.accessKey = "A";
}, 250);

async function FilterPasswords() {
	debouncedFilterPasswords();
}

function CopySiteUrl() {
	// Copy selected site url to clipboard
	const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
		Ci.nsIClipboardHelper,
	);
	const row = signonsTree.currentIndex;
	const url = signonsTreeView.getCellText(row, { id: "siteCol" });
	clipboard.copyString(url);
}

async function CopyPassword() {
	// Don't copy passwords if we aren't already showing the passwords & a master
	// password hasn't been entered.
	if (!showingPasswords && !(await masterPasswordLogin())) {
		return;
	}
	// Copy selected signon's password to clipboard
	const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
		Ci.nsIClipboardHelper,
	);
	const row = signonsTree.currentIndex;
	const password = signonsTreeView.getCellText(row, { id: "passwordCol" });
	clipboard.copyString(password);
}

function CopyUsername() {
	// Copy selected signon's username to clipboard
	const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
		Ci.nsIClipboardHelper,
	);
	const row = signonsTree.currentIndex;
	const username = signonsTreeView.getCellText(row, { id: "userCol" });
	clipboard.copyString(username);
}

function EditCellInSelectedRow(columnName) {
	const row = signonsTree.currentIndex;
	const columnElement = getColumnByName(columnName);
	signonsTree.startEditing(
		row,
		signonsTree.columns.getColumnFor(columnElement),
	);
}

function LaunchSiteUrl() {
	const row = signonsTree.currentIndex;
	const url = signonsTreeView.getCellText(row, { id: "siteCol" });
	window.openWebLinkIn(url, "tab");
}

function UpdateContextMenu() {
	const singleSelection = signonsTreeView.selection.count === 1;
	const menuItems = new Map();
	const menupopup = document.getElementById("signonsTreeContextMenu");
	for (const menuItem of menupopup.querySelectorAll("menuitem")) {
		menuItems.set(menuItem.id, menuItem);
	}

	if (!singleSelection) {
		for (const menuItem of menuItems.values()) {
			menuItem.setAttribute("disabled", "true");
		}
		return;
	}

	const selectedRow = signonsTree.currentIndex;

	// Don't display "Launch Site URL" if we're not a browser.
	if (window.openWebLinkIn) {
		menuItems.get("context-launchsiteurl").removeAttribute("disabled");
	} else {
		menuItems.get("context-launchsiteurl").setAttribute("disabled", "true");
		menuItems.get("context-launchsiteurl").setAttribute("hidden", "true");
	}

	// Disable "Copy Username" if the username is empty.
	if (signonsTreeView.getCellText(selectedRow, { id: "userCol" }) !== "") {
		menuItems.get("context-copyusername").removeAttribute("disabled");
	} else {
		menuItems.get("context-copyusername").setAttribute("disabled", "true");
	}

	menuItems.get("context-copysiteurl").removeAttribute("disabled");
	menuItems.get("context-editusername").removeAttribute("disabled");
	menuItems.get("context-copypassword").removeAttribute("disabled");

	// Disable "Edit Password" if the password column isn't showing.
	if (!document.getElementById("passwordCol").hidden) {
		menuItems.get("context-editpassword").removeAttribute("disabled");
	} else {
		menuItems.get("context-editpassword").setAttribute("disabled", "true");
	}
}

async function masterPasswordLogin(noPasswordCallback) {
	// This does no harm if master password isn't set.
	const tokendb = Cc["@mozilla.org/security/pk11tokendb;1"].createInstance(
		Ci.nsIPK11TokenDB,
	);
	const token = tokendb.getInternalKeyToken();

	// If there is no master password, still give the user a chance to opt-out of displaying passwords
	if (token.checkPassword("")) {
		return noPasswordCallback ? noPasswordCallback() : true;
	}

	// So there's a master password. But since checkPassword didn't succeed, we're logged out (per nsIPK11Token.idl).
	try {
		// Relogin and ask for the master password.
		token.login(true); // 'true' means always prompt for token password. User will be prompted until
		// clicking 'Cancel' or entering the correct password.
	} catch (e) {
		// An exception will be thrown if the user cancels the login prompt dialog.
		// User is also logged out of Software Security Device.
	}

	return token.isLoggedIn();
}

function escapeKeyHandler() {
	// If editing is currently performed, don't do anything.
	if (signonsTree.getAttribute("editing")) {
		return;
	}
	window.close();
}

function OpenMigrator() {
	const { MigrationUtils } = ChromeUtils.import(
		"resource:///modules/MigrationUtils.jsm",
	);
	MigrationUtils.showMigrationWizard(window, [
		MigrationUtils.MIGRATION_ENTRYPOINT_PASSWORDS,
	]);
}
