/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { LIST_DESCRIPTOR_ORIGIN_CATALOG, LIST_DESCRIPTOR_ORIGIN_CUSTOM } =
  ChromeUtils.importESModule(
    "resource:///modules/internal/ListCatalog.sys.mjs"
  );
const { MAX_LIST_BYTES, readListResponseText } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListUpdates.sys.mjs"
);
const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

function makeHeaders(headers = {}) {
  const normalized = new Map(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      String(value),
    ])
  );

  return {
    get(name) {
      return normalized.get(name.toLowerCase()) ?? null;
    },
  };
}

function oversizedContentLengthResponse(readBody) {
  return {
    body: {
      getReader() {
        readBody();
        throw new Error("Oversized list body should not be read");
      },
    },
    headers: makeHeaders({
      "Content-Length": MAX_LIST_BYTES + 1,
    }),
    ok: true,
    status: 200,
    text() {
      readBody();
      throw new Error("Oversized list body should not be read");
    },
  };
}

function streamingResponse(chunks, headers = {}) {
  const encoder = new TextEncoder();
  let index = 0;
  let cancelReason = null;
  let cancelled = false;

  const reader = {
    async read() {
      if (index >= chunks.length) {
        return { done: true };
      }
      return {
        done: false,
        value: encoder.encode(chunks[index++]),
      };
    },
    async cancel(reason) {
      cancelled = true;
      cancelReason = reason;
    },
  };

  return {
    get cancelReason() {
      return cancelReason;
    },
    get cancelled() {
      return cancelled;
    },
    response: {
      body: {
        getReader() {
          return reader;
        },
      },
      headers: makeHeaders(headers),
      ok: true,
      status: 200,
      type: "basic",
    },
  };
}

function opaqueRedirectResponse() {
  return {
    body: null,
    headers: makeHeaders(),
    ok: false,
    status: 0,
    text() {
      throw new Error("Redirect response body should not be read");
    },
    type: "opaqueredirect",
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

async function withServicePaths(name, task) {
  const listsDir = PathUtils.join(PathUtils.profileDir, name);
  const metaPath = PathUtils.join(listsDir, "metadata.json");

  await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });

  const originalListPath = WaterfoxBlockerService._listPath;
  const originalListsDirPath = WaterfoxBlockerService._listsDirPath;
  const originalListsMetadataPath = WaterfoxBlockerService._listsMetadataPath;

  WaterfoxBlockerService._listPath = filename =>
    PathUtils.join(listsDir, filename);
  WaterfoxBlockerService._listsDirPath = () => listsDir;
  WaterfoxBlockerService._listsMetadataPath = () => metaPath;

  try {
    await task({
      listPath(filename) {
        return PathUtils.join(listsDir, filename);
      },
      metaPath,
    });
  } finally {
    WaterfoxBlockerService._listPath = originalListPath;
    WaterfoxBlockerService._listsDirPath = originalListsDirPath;
    WaterfoxBlockerService._listsMetadataPath = originalListsMetadataPath;
    await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  }
}

add_task(async function test_read_list_response_rejects_content_length() {
  let didReadBody = false;

  await Assert.rejects(
    readListResponseText(
      oversizedContentLengthResponse(() => {
        didReadBody = true;
      })
    ),
    /Fetched list exceeds/,
    "Oversized Content-Length should reject the list"
  );

  Assert.equal(
    didReadBody,
    false,
    "Content-Length rejection should not read the response body"
  );
});

add_task(async function test_read_list_response_rejects_streaming_over_cap() {
  const stream = streamingResponse(["x".repeat(MAX_LIST_BYTES), "x"], {
    "Content-Length": MAX_LIST_BYTES,
  });

  await Assert.rejects(
    readListResponseText(stream.response),
    /Fetched list exceeds/,
    "Streaming reads should reject when the decoded body exceeds the cap"
  );

  Assert.equal(
    stream.cancelled,
    true,
    "Overflowing streams should be cancelled"
  );
  Assert.ok(
    stream.cancelReason instanceof Error,
    "Stream cancellation should receive the overflow error"
  );
});

add_task(
  async function test_bootstrap_fetch_rejects_oversized_list_without_writing() {
    await withServicePaths("oversized-list-test", async ({ listPath }) => {
      let didReadBody = false;
      let fetchOptions = null;

      await withMockedFetch(
        async (_url, options) => {
          fetchOptions = options;
          return oversizedContentLengthResponse(() => {
            didReadBody = true;
          });
        },
        async () => {
          const records = await WaterfoxBlockerService._fetchAndPersistLists([
            {
              filename: "oversized.txt",
              url: "https://example.com/oversized.txt",
            },
          ]);

          Assert.deepEqual(records, [], "Oversized list should be rejected");
          Assert.equal(
            didReadBody,
            false,
            "Bootstrap fetch should reject before reading the oversized body"
          );
          Assert.ok(
            !(await IOUtils.exists(listPath("oversized.txt"))),
            "Rejected list should not create a list file"
          );
          Assert.equal(
            fetchOptions?.redirect,
            "manual",
            "Unknown-origin list fetches should fail safe and not follow redirects"
          );
        }
      );
    });
  }
);

add_task(async function test_curated_list_fetch_follows_redirects() {
  await withServicePaths("curated-list-redirect-test", async ({ listPath }) => {
    const body = "! curated list\nexample.com##.ad\n";
    const descriptor = {
      filename: "curated.txt",
      listOrigin: LIST_DESCRIPTOR_ORIGIN_CATALOG,
      url: "https://example.com/curated.txt",
    };
    let fetchOptions = null;

    await withMockedFetch(
      async (_url, options) => {
        fetchOptions = options;
        return streamingResponse([body], {
          "Content-Length": body.length,
        }).response;
      },
      async () => {
        const records = await WaterfoxBlockerService._fetchAndPersistLists([
          descriptor,
        ]);

        Assert.equal(
          fetchOptions?.redirect,
          "follow",
          "Curated catalog lists should follow redirects"
        );
        Assert.deepEqual(
          records,
          [
            {
              filename: descriptor.filename,
              text: body,
              url: descriptor.url,
            },
          ],
          "Curated final response bodies should be read and persisted"
        );
        Assert.equal(
          await IOUtils.readUTF8(listPath(descriptor.filename)),
          body,
          "Curated final response bodies should be written"
        );
      }
    );
  });
});

add_task(
  async function test_custom_list_redirect_is_rejected_without_writing() {
    await withServicePaths(
      "custom-list-redirect-test",
      async ({ listPath }) => {
        const descriptor = {
          filename: "custom.txt",
          listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
          url: "https://example.com/custom.txt",
        };
        let fetchOptions = null;

        await withMockedFetch(
          async (_url, options) => {
            fetchOptions = options;
            return opaqueRedirectResponse();
          },
          async () => {
            await Assert.rejects(
              WaterfoxBlockerService._fetchListForBootstrap(descriptor),
              /custom list URL redirected; redirects are not followed/,
              "Custom list redirects should get a distinct error"
            );
            Assert.equal(
              fetchOptions?.redirect,
              "manual",
              "Custom list fetches should not follow redirects"
            );

            fetchOptions = null;
            const records = await WaterfoxBlockerService._fetchAndPersistLists([
              descriptor,
            ]);

            Assert.deepEqual(
              records,
              [],
              "Redirected custom lists should not be persisted"
            );
            Assert.equal(
              fetchOptions?.redirect,
              "manual",
              "Custom list persistence fetches should not follow redirects"
            );
            Assert.ok(
              !(await IOUtils.exists(listPath(descriptor.filename))),
              "Redirected custom list should not create a list file"
            );
          }
        );
      }
    );
  }
);
