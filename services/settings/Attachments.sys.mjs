/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  RemoteSettingsWorker:
    "resource://services-settings/RemoteSettingsWorker.sys.mjs",
  Utils: "resource://services-settings/Utils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "console", () => lazy.Utils.log);

class DownloadError extends Error {
  constructor(url, resp) {
    super(`Could not download ${url}`);
    this.name = "DownloadError";
    this.resp = resp;
  }
}

class DownloadBundleError extends Error {
  constructor(url, resp) {
    super(`Could not download bundle ${url}`);
    this.name = "DownloadBundleError";
    this.resp = resp;
  }
}

class BadContentError extends Error {
  constructor(path) {
    super(`${path} content does not match server hash`);
    this.name = "BadContentError";
  }
}

class ServerInfoError extends Error {
  constructor(error) {
    super(`Server response is invalid ${error}`);
    this.name = "ServerInfoError";
    this.original = error;
  }
}

class NotFoundError extends Error {
  constructor(url, resp) {
    super(`Could not find ${url} in cache or dump`);
    this.name = "NotFoundError";
    this.resp = resp;
  }
}

// Helper for the `download` method for commonly used methods, to help with
// lazily accessing the record and attachment content.
class LazyRecordAndBuffer {
  constructor(getRecordAndLazyBuffer) {
    this.getRecordAndLazyBuffer = getRecordAndLazyBuffer;
  }

  async _ensureRecordAndLazyBuffer() {
    if (!this.recordAndLazyBufferPromise) {
      this.recordAndLazyBufferPromise = this.getRecordAndLazyBuffer();
    }
    return this.recordAndLazyBufferPromise;
  }

  /**
   * @returns {object} The attachment record, if found. null otherwise.
   **/
  async getRecord() {
    try {
      return (await this._ensureRecordAndLazyBuffer()).record;
    } catch (e) {
      return null;
    }
  }

  /**
   * @param {object} requestedRecord An attachment record
   * @returns {boolean} Whether the requested record matches this record.
   **/
  async isMatchingRequestedRecord(requestedRecord) {
    const record = await this.getRecord();
    return (
      record &&
      record.last_modified === requestedRecord.last_modified &&
      record.attachment.size === requestedRecord.attachment.size &&
      record.attachment.hash === requestedRecord.attachment.hash
    );
  }

  /**
   * Generate the return value for the "download" method.
   *
   * @throws {*} if the record or attachment content is unavailable.
   * @returns {Object} An object with two properties:
   *   buffer: ArrayBuffer with the file content.
   *   record: Record associated with the bytes.
   **/
  async getResult() {
    const { record, readBuffer } = await this._ensureRecordAndLazyBuffer();
    if (!this.bufferPromise) {
      this.bufferPromise = readBuffer();
    }
    return { record, buffer: await this.bufferPromise };
  }
}

export class Downloader {
  static get DownloadError() {
    return DownloadError;
  }
  static get DownloadBundleError() {
    return DownloadBundleError;
  }
  static get BadContentError() {
    return BadContentError;
  }
  static get ServerInfoError() {
    return ServerInfoError;
  }
  static get NotFoundError() {
    return NotFoundError;
  }

  constructor(bucketName, collectionName, ...subFolders) {
    this.folders = ["settings", bucketName, collectionName, ...subFolders];
    this.bucketName = bucketName;
    this.collectionName = collectionName;
  }

  /**
   * @returns {Object} An object with async "get", "set" and "delete" methods.
   *                   The keys are strings, the values may be any object that
   *                   can be stored in IndexedDB (including Blob).
   */
  get cacheImpl() {
    throw new Error("This Downloader does not support caching");
  }

  /**
   * Download attachment and return the result together with the record.
   * If the requested record cannot be downloaded and fallbacks are enabled, the
   * returned attachment may have a different record than the input record.
   *
   * @param {Object} record A Remote Settings entry with attachment.
   *                        If omitted, the attachmentId option must be set.
   * @param {Object} options Some download options.
   * @param {Number} [options.retries] Number of times download should be retried (default: `3`)
   * @param {Boolean} [options.checkHash] Check content integrity (default: `true`)
   * @param {string} [options.attachmentId] The attachment identifier to use for
   *                                      caching and accessing the attachment.
   *                                      (default: `record.id`)
   * @param {Boolean} [options.fallbackToCache] Return the cached attachment when the
   *                                          input record cannot be fetched.
   *                                          (default: `false`)
   * @param {Boolean} [options.fallbackToDump] Use the remote settings dump as a
   *                                         potential source of the attachment.
   *                                         (default: `false`)
   * @throws {Downloader.DownloadError} if the file could not be fetched.
   * @throws {Downloader.BadContentError} if the downloaded content integrity is not valid.
   * @throws {Downloader.ServerInfoError} if the server response is not valid.
   * @throws {NetworkError} if fetching the server infos and fetching the attachment fails.
   * @returns {Object} An object with two properties:
   *   `buffer` `ArrayBuffer`: the file content.
   *   `record` `Object`: record associated with the attachment.
   *   `_source` `String`: identifies the source of the result. Used for testing.
   */
  async download(record, options) {
    return this.#fetchAttachment(record, options);
  }

  /**
   * Downloads an attachment bundle for a given collection, if one exists. Fills in the cache
   * for all attachments provided by the bundle.
   *
   * @param {Boolean} force Set to true to force a sync even when local data exists
   * @returns {Boolean} True if all attachments were processed successfully, false if failed, null if skipped.
   */
  async cacheAll(force = false) {
    // If we're offline, don't try
    if (lazy.Utils.isOffline) {
      return null;
    }

    // Do nothing if local cache has some data and force is not true
    if (!force && (await this.cacheImpl.hasData())) {
      return null;
    }

    // Save attachments in bulks.
    const BULK_SAVE_COUNT = 50;

    const url =
      (await lazy.Utils.baseAttachmentsURL()) +
      `bundles/${this.bucketName}--${this.collectionName}.zip`;
    const tmpZipFilePath = PathUtils.join(
      PathUtils.tempDir,
      `${Services.uuid.generateUUID().toString().slice(1, -1)}.zip`
    );
    let allSuccess = true;

    try {
      // 1. Download the zip archive to disk
      const resp = await lazy.Utils.fetch(url);
      if (!resp.ok) {
        throw new Downloader.DownloadBundleError(url, resp);
      }

      const downloaded = await resp.arrayBuffer();
      await IOUtils.write(tmpZipFilePath, new Uint8Array(downloaded), {
        tmpPath: `${tmpZipFilePath}.tmp`,
      });

      // 2. Read the zipped content
      const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
        Ci.nsIZipReader
      );

      const tmpZipFile = await IOUtils.getFile(tmpZipFilePath);
      zipReader.open(tmpZipFile);

      const cacheEntries = [];
      const zipFiles = Array.from(zipReader.findEntries("*.meta.json"));
      allSuccess = !!zipFiles.length;

      for (let i = 0; i < zipFiles.length; i++) {
        const lastLoop = i == zipFiles.length - 1;
        const entryName = zipFiles[i];
        try {
          // 3. Read the meta.json entry
          const recordZStream = zipReader.getInputStream(entryName);
          const recordDataLength = recordZStream.available();
          const recordStream = Cc[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci.nsIScriptableInputStream);
          recordStream.init(recordZStream);
          const recordBytes = recordStream.readBytes(recordDataLength);
          const recordBlob = new Blob([recordBytes], {
            type: "application/json",
          });
          const record = JSON.parse(await recordBlob.text());
          recordZStream.close();
          recordStream.close();

          // 4. Read the attachment entry
          const zStream = zipReader.getInputStream(record.id);
          const dataLength = zStream.available();
          const stream = Cc[
            "@mozilla.org/scriptableinputstream;1"
          ].createInstance(Ci.nsIScriptableInputStream);
          stream.init(zStream);
          const fileBytes = stream.readBytes(dataLength);
          const blob = new Blob([fileBytes]);

          cacheEntries.push([record.id, { record, blob }]);

          stream.close();
          zStream.close();
        } catch (ex) {
          lazy.console.warn(
            `${this.bucketName}/${this.collectionName}: Unable to extract attachment of ${entryName}.`,
            ex
          );
          allSuccess = false;
        }

        // 5. Save bulk to cache (last loop or reached count)
        if (lastLoop || cacheEntries.length == BULK_SAVE_COUNT) {
          try {
            await this.cacheImpl.setMultiple(cacheEntries);
          } catch (ex) {
            lazy.console.warn(
              `${this.bucketName}/${this.collectionName}: Unable to save attachments in cache`,
              ex
            );
            allSuccess = false;
          }
          cacheEntries.splice(0); // start new bulk.
        }
      }
    } catch (ex) {
      lazy.console.warn(
        `${this.bucketName}/${this.collectionName}: Unable to retrieve remote-settings attachment bundle.`,
        ex
      );
      return false;
    }

    return allSuccess;
  }

  /**
   * Gets an attachment from the cache or local dump, avoiding requesting it
   * from the server.
   * If the only found attachment hash does not match the requested record, the
   * returned attachment may have a different record, e.g. packaged in binary
   * resources or one that is outdated.
   *
   * @param {Object} record A Remote Settings entry with attachment.
   *                        If omitted, the attachmentId option must be set.
   * @param {Object} options Some download options.
   * @param {Number} [options.retries] Number of times download should be retried (default: `3`)
   * @param {Boolean} [options.checkHash] Check content integrity (default: `true`)
   * @param {string} [options.attachmentId] The attachment identifier to use for
   *                                      caching and accessing the attachment.
   *                                      (default: `record.id`)
   * @throws {Downloader.DownloadError} if the file could not be fetched.
   * @throws {Downloader.BadContentError} if the downloaded content integrity is not valid.
   * @throws {Downloader.ServerInfoError} if the server response is not valid.
   * @throws {NetworkError} if fetching the server infos and fetching the attachment fails.
   * @returns {Object} An object with two properties:
   *   `buffer` `ArrayBuffer`: the file content.
   *   `record` `Object`: record associated with the attachment.
   *   `_source` `String`: identifies the source of the result. Used for testing.
   */
  async get(
    record,
    options = {
      attachmentId: record?.id,
    }
  ) {
    return this.#fetchAttachment(record, {
      ...options,
      avoidDownload: true,
      fallbackToCache: true,
      fallbackToDump: true,
    });
  }

  async #fetchAttachment(record, options) {
    let {
      retries,
      checkHash,
      attachmentId = record?.id,
      fallbackToCache = false,
      fallbackToDump = false,
      avoidDownload = false,
    } = options || {};
    if (!attachmentId) {
      // Check for pre-condition. This should not happen, but it is explicitly
      // checked to avoid mixing up attachments, which could be dangerous.
      throw new Error(
        "download() was called without attachmentId or `record.id`"
      );
    }

    if (!lazy.Utils.LOAD_DUMPS) {
      if (fallbackToDump) {
        lazy.console.warn(
          "#fetchAttachment: Forcing fallbackToDump to false due to Utils.LOAD_DUMPS being false"
        );
      }
      fallbackToDump = false;
    }

    avoidDownload = true;
    fallbackToCache = true;
    fallbackToDump = true;

    const dumpInfo = new LazyRecordAndBuffer(() =>
      this._readAttachmentDump(attachmentId)
    );
    const cacheInfo = new LazyRecordAndBuffer(() =>
      this._readAttachmentCache(attachmentId)
    );

    // Check if an attachment dump has been packaged with the client.
    // The dump is checked before the cache because dumps are expected to match
    // the requested record, at least shortly after the release of the client.
    if (fallbackToDump && record) {
      if (await dumpInfo.isMatchingRequestedRecord(record)) {
        try {
          return { ...(await dumpInfo.getResult()), _source: "dump_match" };
        } catch (e) {
          // Failed to read dump: record found but attachment file is missing.
          console.error(e);
        }
      }
    }

    // Check if the requested attachment has already been cached.
    if (record) {
      if (await cacheInfo.isMatchingRequestedRecord(record)) {
        try {
          return { ...(await cacheInfo.getResult()), _source: "cache_match" };
        } catch (e) {
          // Failed to read cache, e.g. IndexedDB unusable.
          console.error(e);
        }
      }
    }

    let errorIfAllFails;

    // There is no local version that matches the requested record.
    // Try to download the attachment specified in record.
    if (!avoidDownload && record && record.attachment) {
      try {
        const newBuffer = await this.downloadAsBytes(record, {
          retries,
          checkHash,
        });
        const blob = new Blob([newBuffer]);
        // Store in cache but don't wait for it before returning.
        this.cacheImpl
          .set(attachmentId, { record, blob })
          .catch(e => console.error(e));
        return { buffer: newBuffer, record, _source: "remote_match" };
      } catch (e) {
        // No network, corrupted content, etc.
        errorIfAllFails = e;
      }
    }

    // Unable to find an attachment that matches the record. Consider falling
    // back to local versions, even if their attachment hash do not match the
    // one from the requested record.

    // Unable to find a valid attachment, fall back to the cached attachment.
    const cacheRecord = fallbackToCache && (await cacheInfo.getRecord());
    if (cacheRecord) {
      const dumpRecord = fallbackToDump && (await dumpInfo.getRecord());
      if (dumpRecord?.last_modified >= cacheRecord.last_modified) {
        // The dump can be more recent than the cache when the client (and its
        // packaged dump) is updated.
        try {
          return { ...(await dumpInfo.getResult()), _source: "dump_fallback" };
        } catch (e) {
          // Failed to read dump: record found but attachment file is missing.
          console.error(e);
        }
      }

      try {
        return { ...(await cacheInfo.getResult()), _source: "cache_fallback" };
      } catch (e) {
        // Failed to read from cache, e.g. IndexedDB unusable.
        console.error(e);
      }
    }

    // Unable to find a valid attachment, fall back to the packaged dump.
    if (fallbackToDump && (await dumpInfo.getRecord())) {
      try {
        return { ...(await dumpInfo.getResult()), _source: "dump_fallback" };
      } catch (e) {
        errorIfAllFails = e;
      }
    }

    if (errorIfAllFails) {
      throw errorIfAllFails;
    }

    if (avoidDownload) {
      throw new Downloader.NotFoundError(attachmentId);
    }
    throw new Downloader.DownloadError(attachmentId);
  }

  /**
   * Is the record downloaded? This does not check if it was bundled.
   *
   * @param record A Remote Settings entry with attachment.
   * @returns {Promise<boolean>}
   */
  isDownloaded(record) {
    const cacheInfo = new LazyRecordAndBuffer(() =>
      this._readAttachmentCache(record.id)
    );
    return cacheInfo.isMatchingRequestedRecord(record);
  }

  /**
   * Delete the record attachment downloaded locally.
   * No-op if the attachment does not exist.
   *
   * @param record A Remote Settings entry with attachment.
   * @param {Object} [options] Some options.
   * @param {string} [options.attachmentId] The attachment identifier to use for
   *                                      accessing and deleting the attachment.
   *                                      (default: `record.id`)
   */
  async deleteDownloaded(record, options) {
    let { attachmentId = record?.id } = options || {};
    if (!attachmentId) {
      // Check for pre-condition. This should not happen, but it is explicitly
      // checked to avoid mixing up attachments, which could be dangerous.
      throw new Error(
        "deleteDownloaded() was called without attachmentId or `record.id`"
      );
    }
    return this.cacheImpl.delete(attachmentId);
  }

  /**
   * Clear the cache from obsolete downloaded attachments.
   *
   * @param {Array<String>} excludeIds List of attachments IDs to exclude from pruning.
   */
  async prune(excludeIds) {
    return this.cacheImpl.prune(excludeIds);
  }
  /**
   * Download the record attachment and return its content as bytes.
   *
   * @param {Object} record A Remote Settings entry with attachment.
   * @param {Object} options Some download options.
   * @param {Number} options.retries Number of times download should be retried (default: `3`)
   * @param {Boolean} options.checkHash Check content integrity (default: `true`)
   * @throws {Downloader.DownloadError} if the file could not be fetched.
   * @throws {Downloader.BadContentError} if the downloaded content integrity is not valid.
   * @returns {ArrayBuffer} the file content.
   */
  async downloadAsBytes(record, options = {}) {
    const {
      attachment: { location, hash, size },
    } = record;

    return (await this.#fetchAttachment(record)).buffer;
    // eslint-disable-next-line no-unreachable
    let baseURL;
    try {
      baseURL = await lazy.Utils.baseAttachmentsURL();
    } catch (error) {
      throw new Downloader.ServerInfoError(error);
    }

    const remoteFileUrl = baseURL + location;

    const { retries = 3, checkHash = true } = options;
    let retried = 0;
    while (true) {
      try {
        const buffer = await this._fetchAttachment(remoteFileUrl);
        if (!checkHash) {
          return buffer;
        }
        if (
          await lazy.RemoteSettingsWorker.checkContentHash(buffer, size, hash)
        ) {
          return buffer;
        }
        // Content is corrupted.
        throw new Downloader.BadContentError(location);
      } catch (e) {
        if (retried >= retries) {
          throw e;
        }
      }
      retried++;
    }
  }

  async _fetchAttachment(url) {
    const headers = new Headers();
    headers.set("Accept-Encoding", "gzip");
    const resp = await lazy.Utils.fetch(url, { headers });
    if (!resp.ok) {
      throw new Downloader.DownloadError(url, resp);
    }
    return resp.arrayBuffer();
  }

  async _readAttachmentCache(attachmentId) {
    const cached = await this.cacheImpl.get(attachmentId);
    if (!cached) {
      throw new Downloader.DownloadError(attachmentId);
    }
    return {
      record: cached.record,
      async readBuffer() {
        const buffer = await cached.blob.arrayBuffer();
        const { size, hash } = cached.record.attachment;
        if (
          await lazy.RemoteSettingsWorker.checkContentHash(buffer, size, hash)
        ) {
          return buffer;
        }
        // Really unexpected, could indicate corruption in IndexedDB.
        throw new Downloader.BadContentError(attachmentId);
      },
    };
  }

  async _readAttachmentDump(attachmentId) {
    async function fetchResource(resourceUrl) {
      try {
        return await fetch(resourceUrl);
      } catch (e) {
        throw new Downloader.DownloadError(resourceUrl);
      }
    }
    const resourceUrlPrefix =
      Downloader._RESOURCE_BASE_URL + "/" + this.folders.join("/") + "/";
    const recordUrl = `${resourceUrlPrefix}${attachmentId}.meta.json`;
    const attachmentUrl = `${resourceUrlPrefix}${attachmentId}`;
    const record = await (await fetchResource(recordUrl)).json();
    return {
      record,
      async readBuffer() {
        return (await fetchResource(attachmentUrl)).arrayBuffer();
      },
    };
  }

  // Separate variable to allow tests to override this.
  static _RESOURCE_BASE_URL = "resource://app/defaults";
}

/**
 * A bare downloader that does not store anything in cache.
 */
export class UnstoredDownloader extends Downloader {
  get cacheImpl() {
    const cacheImpl = {
      get: async () => {},
      set: async () => {},
      setMultiple: async () => {},
      delete: async () => {},
      prune: async () => {},
      hasData: async () => false,
    };
    Object.defineProperty(this, "cacheImpl", { value: cacheImpl });
    return cacheImpl;
  }
}
