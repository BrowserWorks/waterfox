/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { LIST_DESCRIPTOR_ORIGIN_CUSTOM, ListCatalog } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListCatalog.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);
const { ListUpdatesState } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListUpdates.sys.mjs"
);
const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function textResponse(text, etag) {
  return {
    body: null,
    headers: {
      get(name) {
        if (name.toLowerCase() === "etag") {
          return etag;
        }
        return null;
      },
    },
    ok: true,
    status: 200,
    text: async () => text,
    type: "basic",
  };
}

async function withMockedFetch(fetchImpl, task) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;

  try {
    await task();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function withListPaths(name, task) {
  const listsDir = PathUtils.join(PathUtils.profileDir, name);
  const metaPath = PathUtils.join(listsDir, "metadata.json");
  const listPath = filename => PathUtils.join(listsDir, filename);

  await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });

  const originalServiceListPath = WaterfoxBlockerService._listPath;
  const originalServiceListsDirPath = WaterfoxBlockerService._listsDirPath;
  const originalServiceListsMetadataPath =
    WaterfoxBlockerService._listsMetadataPath;
  const originalStoreListPath = ListStore.listPath;
  const originalStoreListsDirPath = ListStore.listsDirPath;
  const originalStoreListsMetadataPath = ListStore.listsMetadataPath;

  WaterfoxBlockerService._listPath = listPath;
  WaterfoxBlockerService._listsDirPath = () => listsDir;
  WaterfoxBlockerService._listsMetadataPath = () => metaPath;
  ListStore.listPath = listPath;
  ListStore.listsDirPath = () => listsDir;
  ListStore.listsMetadataPath = () => metaPath;

  try {
    await task({ listPath, metaPath });
  } finally {
    WaterfoxBlockerService._listPath = originalServiceListPath;
    WaterfoxBlockerService._listsDirPath = originalServiceListsDirPath;
    WaterfoxBlockerService._listsMetadataPath =
      originalServiceListsMetadataPath;
    ListStore.listPath = originalStoreListPath;
    ListStore.listsDirPath = originalStoreListsDirPath;
    ListStore.listsMetadataPath = originalStoreListsMetadataPath;
    await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  }
}

add_task(async function test_bootstrap_and_update_list_writes_are_serialized() {
  await withListPaths("serialized-list-write-test", async ({ listPath, metaPath }) => {
    const descriptor = {
      filename: "shared.txt",
      listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
      url: "https://example.com/shared.txt",
    };
    const initBody = "||init.example^\n";
    const updateBody = "||update.example^\n";
    let fetchCount = 0;

    const originalGetListDescriptors = ListCatalog.getListDescriptors;
    const originalWriteText = WaterfoxBlockerService._writeText;
    const initListWritten = deferred();
    const resumeInit = deferred();
    let didPauseInit = false;
    let didResumeInit = false;

    function releaseInit() {
      if (!didResumeInit) {
        didResumeInit = true;
        resumeInit.resolve();
      }
    }

    ListCatalog.getListDescriptors = async () => [descriptor];
    WaterfoxBlockerService._writeText = async function pausedWriteText(path, text) {
      await originalWriteText.call(this, path, text);

      if (!didPauseInit) {
        didPauseInit = true;
        initListWritten.resolve();
        await resumeInit.promise;
      }
    };

    await withMockedFetch(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return textResponse(initBody, '"init"');
      }
      return textResponse(updateBody, '"update"');
    }, async () => {
      const updateState = new ListUpdatesState();
      const initPromise = WaterfoxBlockerService._fetchAndPersistLists([
        descriptor,
      ]);

      try {
        await Promise.race([
          initListWritten.promise,
          initPromise.then(
            () => Promise.reject(new Error("Bootstrap finished before pausing")),
            error => Promise.reject(error)
          ),
        ]);

        const updatePromise = updateState.updateIfNeeded();
        await Promise.resolve();
        releaseInit();

        const [initRecords, updateResult] = await Promise.all([
          initPromise,
          updatePromise,
        ]);

        Assert.deepEqual(
          initRecords,
          [
            {
              filename: descriptor.filename,
              text: initBody,
              url: descriptor.url,
            },
          ],
          "Bootstrap should return the list it fetched"
        );
        Assert.equal(
          updateResult?.anyUpdated,
          true,
          "The queued update should run after bootstrap finishes"
        );
        Assert.equal(
          await IOUtils.readUTF8(listPath(descriptor.filename)),
          updateBody,
          "The list file should contain the later update body"
        );

        const metadata = JSON.parse(await IOUtils.readUTF8(metaPath));
        Assert.equal(metadata.lists.length, 1, "Metadata should have one entry");
        Assert.equal(
          metadata.lists[0].etag,
          '"update"',
          "Metadata should describe the later update write"
        );
        Assert.equal(
          metadata.lists[0].filename,
          descriptor.filename,
          "Metadata should keep the descriptor filename"
        );
      } finally {
        releaseInit();
        ListCatalog.getListDescriptors = originalGetListDescriptors;
        WaterfoxBlockerService._writeText = originalWriteText;
      }
    });
  });
});
