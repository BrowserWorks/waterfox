/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ContentDOMReference: "resource://gre/modules/ContentDOMReference.sys.mjs",
  ContextMenuChild: "resource:///actors/ContextMenuChild.sys.mjs",
});

const MAX_URI = 4096;
const MAX_TARGET_SIDE = 4096;
const BASE32_UNUSED_BITS = [0, null, 2, null, 4, 1, null, 3];

function selectedKey(document, target) {
  if (target.closest("input, textarea, [contenteditable]")) {
    return null;
  }
  const selection = document.getSelection();
  if (selection.rangeCount !== 1 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const text = range.startContainer;
  const length = range.endOffset - range.startOffset;
  if (
    text.nodeType !== text.TEXT_NODE ||
    text !== range.endContainer ||
    !target.contains(text) ||
    length < 16 ||
    length > 256
  ) {
    return null;
  }
  const key = text
    .substringData(range.startOffset, length)
    .trim()
    .toUpperCase();
  if (!/^[A-Z2-7]{16,128}$/.test(key)) {
    return null;
  }
  // Reject impossible lengths and nonzero unused Base32 bits.
  const remainder = key.length % 8;
  const unused = BASE32_UNUSED_BITS[remainder];
  const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(key.at(-1));
  return unused !== null && !(last & ((1 << unused) - 1)) ? key : null;
}

function rasterTarget(target) {
  if (target.localName === "img" || target.localName === "canvas") {
    return target.namespaceURI === "http://www.w3.org/1999/xhtml"
      ? target
      : null;
  }
  if (target.namespaceURI !== "http://www.w3.org/2000/svg") {
    return null;
  }
  let svg = target.localName === "svg" ? target : target.ownerSVGElement;
  for (let depth = 0; svg?.ownerSVGElement && depth < 32; depth++) {
    svg = svg.ownerSVGElement;
  }
  return svg?.ownerSVGElement ? null : svg;
}

/** Reads only the authenticated context target and watches its active request. */
export class ICloudPasswordsSetupChild extends JSWindowActorChild {
  #watch = null;

  didDestroy() {
    this.#clearWatch();
  }

  receiveMessage({ name, data }) {
    if (name === "ICloudPasswordsSetup:Clear") {
      if (data?.token === this.#watch?.token) {
        this.#clearWatch();
      }
      return null;
    }
    if (name !== "ICloudPasswordsSetup:Inspect") {
      return null;
    }
    try {
      return this.#inspect(data);
    } catch {
      return null;
    }
  }

  #inspect({ targetIdentifier, timeStamp, token, allowSetup }) {
    const document = this.document;
    if (
      !this.manager.isCurrentGlobal ||
      document.documentURIObject.scheme !== "https" ||
      !document.nodePrincipal.schemeIs("https") ||
      targetIdentifier?.browsingContextId !== this.browsingContext.id ||
      typeof token !== "string" ||
      token.length > 64 ||
      (this.#watch?.token === token && this.#watch.invalidated)
    ) {
      return null;
    }
    const target = lazy.ContentDOMReference.resolve(targetIdentifier);
    const last = lazy.ContextMenuChild.getLastTarget(this.browsingContext);
    if (
      !target?.isConnected ||
      target.ownerDocument !== document ||
      last?.targetRef?.get() !== target ||
      last.timeStamp !== timeStamp
    ) {
      return null;
    }
    // ContextMenu:Hiding clears the active reference. The authenticated reference
    // to the last target still lets us revalidate admitted commands.
    const active = lazy.ContextMenuChild.getTarget(this.browsingContext, {});
    if (active && active !== target) {
      return null;
    }
    const element =
      target.nodeType === target.ELEMENT_NODE ? target : target.parentElement;
    if (!element) {
      return null;
    }
    const candidate = allowSetup ? this.#candidate(element) : { kind: "none" };
    return this.#watchTarget(token, element, candidate.kind === "key")
      ? candidate
      : null;
  }

  #candidate(element) {
    const document = this.document;
    const link = element.closest("a[href], area[href]");
    if (link) {
      const href =
        typeof link.href === "string" ? link.href : link.href?.baseVal;
      if (
        typeof href === "string" &&
        href.length <= MAX_URI &&
        /^(?:apple-)?otpauth:/i.test(href)
      ) {
        return { kind: "uri", value: href };
      }
    }
    const key = selectedKey(document, element);
    if (key) {
      return { kind: "key", value: key };
    }
    const raster = rasterTarget(element);
    if (!raster) {
      return { kind: "none" };
    }
    const win = document.defaultView;
    const rect = win.windowUtils.getBoundsWithoutFlushing(raster);
    if (
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) ||
      rect.width < 16 ||
      rect.height < 16 ||
      rect.width > MAX_TARGET_SIDE ||
      rect.height > MAX_TARGET_SIDE ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.right > win.innerWidth ||
      rect.bottom > win.innerHeight
    ) {
      return { kind: "none" };
    }
    // drawSnapshot takes document coordinates, not viewport coordinates.
    return {
      kind: "qr",
      rect: [
        rect.x + win.scrollX,
        rect.y + win.scrollY,
        rect.width,
        rect.height,
      ],
    };
  }

  #watchTarget(token, target, selection) {
    if (this.#watch?.token === token) {
      return !this.#watch.invalidated;
    }
    this.#clearWatch();
    const document = this.document;
    const win = document.defaultView;
    const record = { token, document, win, invalidated: false };
    const invalidate = () => {
      if (record.invalidated) {
        return;
      }
      record.invalidated = true;
      record.observer.disconnect();
      try {
        this.sendAsyncMessage("ICloudPasswordsSetup:Invalidated", { token });
      } catch {}
    };
    record.onEvent = event => {
      if (event.isTrusted) {
        invalidate();
      }
    };
    record.observer = new win.MutationObserver(invalidate);
    const root = rasterTarget(target) || target;
    record.observer.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    let ancestor = root.parentNode;
    for (let depth = 0; ancestor && depth < 64; depth++) {
      record.observer.observe(ancestor, { attributes: true, childList: true });
      ancestor = ancestor.parentNode;
    }
    this.#watch = record;
    if (ancestor) {
      this.#clearWatch();
      return false;
    }
    win.addEventListener("pagehide", record.onEvent, { capture: true });
    if (selection) {
      document.addEventListener("selectionchange", record.onEvent);
    }
    return true;
  }

  #clearWatch() {
    const record = this.#watch;
    if (record) {
      record.observer.disconnect();
      record.win.removeEventListener("pagehide", record.onEvent, {
        capture: true,
      });
      record.document.removeEventListener("selectionchange", record.onEvent);
      this.#watch = null;
    }
  }
}
