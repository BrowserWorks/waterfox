/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { LIST_DESCRIPTOR_ORIGIN_CATALOG, LIST_DESCRIPTOR_ORIGIN_CUSTOM } =
  ChromeUtils.importESModule(
    "resource:///modules/internal/ListCatalog.sys.mjs"
  );
const {
  MAX_LIST_BYTES,
  fetchList,
  getListFetchRedirectMode,
  readListResponseText,
} = ChromeUtils.importESModule(
  "resource:///modules/internal/ListUpdates.sys.mjs"
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
  await task(fetchImpl);
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
  Assert.equal(
    stream.cancelReason?.message,
    `Fetched list exceeds ${MAX_LIST_BYTES} bytes`,
    "Stream cancellation should receive the overflow error"
  );
});

add_task(async function test_fetch_list_rejects_oversized_content_length() {
  const descriptor = {
    filename: "oversized.txt",
    url: "https://example.com/oversized.txt",
  };
  let didReadBody = false;
  let fetchOptions = null;

  await withMockedFetch(
    async (_url, options) => {
      fetchOptions = options;
      return oversizedContentLengthResponse(() => {
        didReadBody = true;
      });
    },
    async mockFetch => {
      await Assert.rejects(
        fetchList(
          descriptor,
          null,
          false,
          getListFetchRedirectMode(descriptor),
          mockFetch
        ),
        /Fetched list exceeds/,
        "Oversized lists should be rejected"
      );
    }
  );

  Assert.equal(
    didReadBody,
    false,
    "List fetch should reject before reading the oversized body"
  );
  Assert.equal(
    fetchOptions?.redirect,
    "manual",
    "Unknown-origin list fetches should fail safe and not follow redirects"
  );
});

add_task(async function test_curated_list_fetch_follows_redirects() {
  const body = "! curated list\nexample.com##.ad\n";
  const lastModified = "Wed, 21 Oct 2015 07:28:00 GMT";
  const descriptor = {
    filename: "curated.txt",
    listOrigin: LIST_DESCRIPTOR_ORIGIN_CATALOG,
    url: "https://example.com/curated.txt",
  };
  let fetchOptions = null;
  let result = null;

  await withMockedFetch(
    async (_url, options) => {
      fetchOptions = options;
      return streamingResponse([body], {
        "Content-Length": body.length,
        ETag: '"curated"',
        "Last-Modified": lastModified,
      }).response;
    },
    async mockFetch => {
      result = await fetchList(
        descriptor,
        null,
        false,
        getListFetchRedirectMode(descriptor),
        mockFetch
      );
    }
  );

  Assert.equal(
    fetchOptions?.redirect,
    "follow",
    "Curated catalog lists should follow redirects"
  );
  Assert.deepEqual(
    result,
    {
      etag: '"curated"',
      lastModified,
      notModified: false,
      text: body,
    },
    "Curated list fetches should return the response text and metadata"
  );
});

add_task(async function test_custom_list_redirect_is_rejected() {
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
    async mockFetch => {
      await Assert.rejects(
        fetchList(
          descriptor,
          null,
          false,
          getListFetchRedirectMode(descriptor),
          mockFetch
        ),
        /custom list URL redirected; redirects are not followed/,
        "Custom list redirects should get a distinct error"
      );
    }
  );

  Assert.equal(
    fetchOptions?.redirect,
    "manual",
    "Custom list fetches should not follow redirects"
  );
});
