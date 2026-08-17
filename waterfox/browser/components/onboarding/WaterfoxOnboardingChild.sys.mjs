/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Exports a query function into the onboarding page so the otherwise
 * unprivileged about:welcome document can reach the parent actor.
 */
export class WaterfoxOnboardingChild extends JSWindowActorChild {
  actorCreated() {
    if (this.contentWindow) {
      Cu.exportFunction(this.wfxQuery.bind(this), this.contentWindow, {
        defineAs: "WFXOnboardingQuery",
      });
    }
  }

  // Registered for DOMDocElementInserted so the export happens before the
  // page scripts run. Nothing to do for the event itself.
  handleEvent() {}

  wfxQuery(name, data) {
    const win = this.contentWindow;
    return new win.Promise((resolve, reject) => {
      this.sendQuery(`WFXOnboarding:${name}`, data).then(
        result =>
          resolve(
            result === undefined || result === null
              ? result
              : Cu.cloneInto(result, win)
          ),
        () => reject(new win.Error(`WFXOnboarding:${name} failed`))
      );
    });
  }
}
