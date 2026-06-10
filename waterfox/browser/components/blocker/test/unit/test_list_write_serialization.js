/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { LIST_DESCRIPTOR_ORIGIN_CUSTOM, ListCatalog } =
  ChromeUtils.importESModule(
    "resource:///modules/internal/ListCatalog.sys.mjs"
  );
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);
const { ListUpdatesState } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListUpdates.sys.mjs"
);

do_get_profile();

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
  await task(fetchImpl);
}

async function withListPaths(name, task) {
  const listsDir = PathUtils.join(PathUtils.profileDir, name);
  const metaPath = PathUtils.join(listsDir, "metadata.json");
  const listPath = filename => PathUtils.join(listsDir, filename);

  await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  await IOUtils.makeDirectory(listsDir, {
    createAncestors: true,
    ignoreExisting: true,
  });

  const originalListPath = ListStore.listPath;
  const originalListsDirPath = ListStore.listsDirPath;
  const originalListsMetadataPath = ListStore.listsMetadataPath;

  ListStore.listPath = listPath;
  ListStore.listsDirPath = () => listsDir;
  ListStore.listsMetadataPath = () => metaPath;

  try {
    await task({ listPath, metaPath });
  } finally {
    ListStore.listPath = originalListPath;
    ListStore.listsDirPath = originalListsDirPath;
    ListStore.listsMetadataPath = originalListsMetadataPath;
    await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  }
}

add_task(async function test_list_updates_are_serialized() {
  await withListPaths(
    "serialized-list-write-test",
    async ({ listPath, metaPath }) => {
      const descriptor = {
        filename: "shared.txt",
        listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
        url: "https://example.com/shared.txt",
      };
      const initBody = "||init.example^\n";
      const updateBody = "||update.example^\n";
      let fetchCount = 0;

      const originalGetListDescriptors = ListCatalog.getListDescriptors;
      const originalWriteText = ListStore.writeText;
      const firstListWritten = deferred();
      const resumeFirstUpdate = deferred();
      let didPauseFirstWrite = false;
      let didReleaseFirstWrite = false;
      let firstUpdatePromise = null;
      let secondUpdatePromise = null;

      function releaseFirstWrite() {
        if (!didReleaseFirstWrite) {
          didReleaseFirstWrite = true;
          resumeFirstUpdate.resolve();
        }
      }

      await withMockedFetch(
        async () => {
          fetchCount++;
          if (fetchCount === 1) {
            return textResponse(initBody, '"init"');
          }
          return textResponse(updateBody, '"update"');
        },
        async mockFetch => {
          try {
            ListCatalog.getListDescriptors = async () => [descriptor];
            ListStore.writeText = async function pausedWriteText(path, text) {
              await originalWriteText.call(this, path, text);

              if (!didPauseFirstWrite) {
                didPauseFirstWrite = true;
                firstListWritten.resolve();
                await resumeFirstUpdate.promise;
              }
            };

            const firstUpdateState = new ListUpdatesState({
              fetchImpl: mockFetch,
            });
            const secondUpdateState = new ListUpdatesState({
              fetchImpl: mockFetch,
            });
            firstUpdatePromise = firstUpdateState.updateIfNeeded();

            await Promise.race([
              firstListWritten.promise,
              firstUpdatePromise.then(
                () =>
                  Promise.reject(
                    new Error("First update finished before its write paused")
                  ),
                error => Promise.reject(error)
              ),
            ]);

            secondUpdatePromise = secondUpdateState.updateIfNeeded();
            await Promise.resolve();
            Assert.equal(
              fetchCount,
              1,
              "The second update should wait for the first write lock"
            );
            releaseFirstWrite();

            const [firstUpdateResult, secondUpdateResult] = await Promise.all([
              firstUpdatePromise,
              secondUpdatePromise,
            ]);

            Assert.equal(
              firstUpdateResult?.anyUpdated,
              true,
              "The first update should report a written list"
            );
            Assert.equal(
              secondUpdateResult?.anyUpdated,
              true,
              "The second update should report a written list"
            );
            Assert.equal(
              await IOUtils.readUTF8(listPath(descriptor.filename)),
              updateBody,
              "The list file should contain the second update body"
            );

            const metadata = JSON.parse(await IOUtils.readUTF8(metaPath));
            Assert.equal(
              metadata.lists.length,
              1,
              "Metadata should have one entry"
            );
            Assert.equal(
              metadata.lists[0].etag,
              '"update"',
              "Metadata should describe the second update"
            );
            Assert.equal(
              metadata.lists[0].filename,
              descriptor.filename,
              "Metadata should keep the descriptor filename"
            );
          } finally {
            releaseFirstWrite();
            try {
              await Promise.allSettled(
                [firstUpdatePromise, secondUpdatePromise].filter(Boolean)
              );
            } finally {
              ListCatalog.getListDescriptors = originalGetListDescriptors;
              ListStore.writeText = originalWriteText;
            }
          }
        }
      );
    }
  );
});
