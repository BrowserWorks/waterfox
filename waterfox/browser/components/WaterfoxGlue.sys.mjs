/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const WaterfoxGlue = {

  async init() {
    // Set pref observers
    this._setPrefObservers();

    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
    // Observe main-pane-loaded topic to detect about:preferences open
    Services.obs.addObserver(this, "main-pane-loaded");
    // Observe final-ui-startup to launch browser window dependant tasks
    Services.obs.addObserver(this, "final-ui-startup");
    // Observe browser shutdown
    Services.obs.addObserver(this, "quit-application-granted");
  },

  async _setPrefObservers() {
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "chrome-document-loaded":
        break;
      case "main-pane-loaded":
      case "final-ui-startup":
        this._beforeUIStartup();
        this._delayedTasks();
        break;
      case "quit-application-granted":
        this.shutdown();
        break;
    }
  },

  async _beforeUIStartup() {
  },

  async _delayedTasks() {
  },

  shutdown() {
  },
};
