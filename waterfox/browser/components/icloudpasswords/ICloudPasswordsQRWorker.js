/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

self.onmessage = ({ data }) => {
  self.onmessage = null;
  let pixels;
  let uri = null;
  try {
    const { width, height, rgba } = data;
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 16 ||
      height < 16 ||
      width > 1024 ||
      height > 1024 ||
      width * height > 1024 * 1024 ||
      !(rgba instanceof Uint8ClampedArray) ||
      rgba.length !== width * height * 4 ||
      rgba.byteOffset !== 0 ||
      rgba.buffer.byteLength !== rgba.byteLength
    ) {
      return;
    }
    pixels = rgba;
    self.importScripts(
      "chrome://browser/content/waterfox/icloudpasswords/third_party/jsqr/jsQR.js"
    );
    const result = self.jsQR(pixels, width, height, {
      inversionAttempts: "attemptBoth",
    });
    if (
      typeof result?.data === "string" &&
      result.data.length <= 4096 &&
      /^(?:apple-)?otpauth:/i.test(result.data)
    ) {
      uri = result.data;
    }
  } catch {
    // Keep decoder exceptions and decoded payloads out of diagnostics.
  } finally {
    pixels?.fill(0);
    self.postMessage({ uri });
    self.close();
  }
};
