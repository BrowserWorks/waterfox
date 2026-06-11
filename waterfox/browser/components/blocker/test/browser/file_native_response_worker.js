/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

self.onmessage = async ({ data }) => {
  try {
    if (data.kind === "import") {
      self.importScripts(data.url);
      self.postMessage({ success: true, imported: self.nativeImported || 0 });
      return;
    }
    const response = await fetch(data.url, { method: data.method || "GET" });
    self.postMessage({
      success: true,
      status: response.status,
      text: await response.text(),
    });
  } catch (error) {
    self.postMessage({
      success: false,
      name: error.name,
      imported: self.nativeImported || 0,
    });
  }
};
