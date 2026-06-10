/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { EngineCache } = ChromeUtils.importESModule(
  "resource:///modules/internal/EngineCache.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);

const DESCRIPTORS = [
  {
    filename: "atomic.txt",
    url: "https://example.com/atomic.txt",
  },
];
const LIST_RECORDS = [
  {
    filename: "atomic.txt",
    text: "||example.com^\n",
    url: "https://example.com/atomic.txt",
  },
];

function engineWithBytes(bytes) {
  return {
    serialize() {
      return new Uint8Array(bytes);
    },
  };
}

add_task(async function test_list_store_write_text_preserves_destination_on_failure() {
  const path = PathUtils.join(PathUtils.profileDir, "list-store-atomic.txt");
  const tmpPath = `${path}.tmp`;

  await IOUtils.writeUTF8(path, "old contents");

  const originalWrite = IOUtils.write;
  IOUtils.write = async function mockedWrite(targetPath, bytes, options = {}) {
    Assert.equal(targetPath, path, "ListStore should write to the requested path");
    Assert.equal(
      options.tmpPath,
      tmpPath,
      "ListStore should use a temp file for durable writes"
    );
    await originalWrite(tmpPath, new TextEncoder().encode("partial contents"));
    throw new Error("simulated write failure");
  };

  try {
    await Assert.rejects(
      ListStore.writeText(path, "new contents"),
      /simulated write failure/,
      "The simulated write failure should surface"
    );
  } finally {
    IOUtils.write = originalWrite;
  }

  Assert.equal(
    await IOUtils.readUTF8(path),
    "old contents",
    "A failed temp-file write should leave the destination untouched"
  );

  await IOUtils.remove(path, { ignoreAbsent: true });
  await IOUtils.remove(tmpPath, { ignoreAbsent: true });
});

add_task(async function test_list_store_write_json_uses_atomic_text_writer() {
  const path = PathUtils.join(PathUtils.profileDir, "list-store-atomic.json");
  const writes = [];
  const originalWrite = IOUtils.write;

  IOUtils.write = async function mockedWrite(targetPath, bytes, options = {}) {
    writes.push({ targetPath, tmpPath: options.tmpPath });
    return originalWrite(targetPath, bytes, options);
  };

  try {
    await ListStore.writeJSON(path, { ok: true });
  } finally {
    IOUtils.write = originalWrite;
  }

  Assert.deepEqual(
    JSON.parse(await IOUtils.readUTF8(path)),
    { ok: true },
    "ListStore.writeJSON should write valid JSON"
  );
  Assert.deepEqual(
    writes,
    [{ targetPath: path, tmpPath: `${path}.tmp` }],
    "ListStore.writeJSON should use the atomic text writer"
  );

  await IOUtils.remove(path, { ignoreAbsent: true });
});

add_task(async function test_engine_cache_writes_use_tmp_paths() {
  await EngineCache.clear();

  const writes = [];
  const originalWrite = IOUtils.write;

  IOUtils.write = async function mockedWrite(path, bytes, options = {}) {
    writes.push({ path, tmpPath: options.tmpPath });
    return originalWrite(path, bytes, options);
  };

  try {
    await EngineCache.write(engineWithBytes([1, 2, 3]), DESCRIPTORS, LIST_RECORDS);
  } finally {
    IOUtils.write = originalWrite;
    await EngineCache.clear();
  }

  Assert.equal(writes.length, 2, "Engine cache should write data and metadata");
  Assert.ok(
    writes.every(write => write.tmpPath === `${write.path}.tmp`),
    "Engine cache writes should all use temp paths"
  );
});

add_task(async function test_engine_cache_preserves_existing_cache_on_failure() {
  await EngineCache.clear();
  await EngineCache.write(engineWithBytes([1, 2, 3]), DESCRIPTORS, LIST_RECORDS);

  const originalBytes = Array.from(await EngineCache.read());
  const originalWrite = IOUtils.write;
  const tmpPaths = [];

  IOUtils.write = async function mockedWrite(path, bytes, options = {}) {
    Assert.equal(
      options.tmpPath,
      `${path}.tmp`,
      "EngineCache should write through a temp path"
    );
    tmpPaths.push(options.tmpPath);
    await originalWrite(options.tmpPath, new Uint8Array([9, 9, 9]));
    throw new Error("simulated cache write failure");
  };

  try {
    await Assert.rejects(
      EngineCache.write(engineWithBytes([4, 5, 6]), DESCRIPTORS, LIST_RECORDS),
      /simulated cache write failure/,
      "The simulated cache write failure should surface"
    );
  } finally {
    IOUtils.write = originalWrite;
  }

  Assert.deepEqual(
    Array.from(await EngineCache.read()),
    originalBytes,
    "A failed temp-file cache write should leave the prior cache intact"
  );

  await EngineCache.clear();
  for (const tmpPath of tmpPaths) {
    await IOUtils.remove(tmpPath, { ignoreAbsent: true });
  }
});
