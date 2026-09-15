/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COMMANDS = new Set([
  "List",
  "Create",
  "Remove",
  "Preview",
  "Refresh",
  "Import",
  "Export",
]);
const MAX_REQUEST_LENGTH = 16384;

/** A bounded event bridge, available only to the isolated about:feeds UI. */
export class FeedPageChild extends JSWindowActorChild {
  #isFeedPage() {
    try {
      return (
        this.manager.isCurrentGlobal &&
        !this.browsingContext.parent &&
        this.document?.nodePrincipal.isContentPrincipal &&
        this.document.documentURI.split(/[?#]/, 1)[0] === "about:feeds"
      );
    } catch {
      return false;
    }
  }

  async handleEvent(event) {
    if (event.type !== "FeedPage:Request" || !this.#isFeedPage()) {
      return;
    }
    const document = this.document;
    if (
      event.target !== document ||
      typeof event.detail !== "string" ||
      event.detail.length > MAX_REQUEST_LENGTH
    ) {
      return;
    }

    let request;
    try {
      request = JSON.parse(event.detail);
    } catch {
      return;
    }
    if (
      !request ||
      !Number.isSafeInteger(request.id) ||
      request.id < 0 ||
      !COMMANDS.has(request.command)
    ) {
      return;
    }

    let result;
    try {
      result = await this.sendQuery(`Feeds:${request.command}`, request.args);
    } catch {
      result = { ok: false, error: "feeds-error-unavailable" };
    }
    if (this.#isFeedPage() && this.document === document) {
      document.dispatchEvent(
        new this.contentWindow.CustomEvent("FeedPage:Response", {
          detail: JSON.stringify({ id: request.id, result }),
        })
      );
    }
  }

  receiveMessage({ name }) {
    if (name === "Feeds:Changed" && this.#isFeedPage()) {
      this.document.dispatchEvent(
        new this.contentWindow.CustomEvent("FeedPage:Changed")
      );
    }
  }
}
