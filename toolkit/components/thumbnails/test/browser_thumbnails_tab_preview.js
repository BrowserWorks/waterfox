/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

function createPreviewCapture(overrides = {}) {
  let contentInfo = {
    width: 800,
    documentHeight: 1200,
    scrollY: 0,
    ...overrides,
  };
  let sendQuery = sinon.stub().resolves(contentInfo);
  let context = { currentWindowGlobal: { getActor: () => ({ sendQuery }) } };
  let drawImage = sinon.spy();
  let canvas = {
    width: 280,
    height: 140,
    getContext: () => ({ drawImage }),
  };
  let snapshot = {};
  let browser = {
    browsingContext: context,
    drawSnapshot: sinon.stub().resolves(snapshot),
  };
  return {
    browser,
    canvas,
    context,
    contentInfo,
    sendQuery,
    drawImage,
    snapshot,
  };
}

add_task(async function test_skipped_capture() {
  let cases = [
    ["canvas", "width", 0],
    ["canvas", "height", 0],
    ["browser", "browsingContext", null],
    ["context", "currentWindowGlobal", null],
    ["browser", "browsingContext", null, true],
    ["context", "currentWindowGlobal", {}, true],
    ...["width", "documentHeight"].flatMap(dimension =>
      [0, -1, NaN, Infinity].map(size => ["contentInfo", dimension, size])
    ),
    ...[NaN, Infinity].map(scrollY => ["contentInfo", "scrollY", scrollY]),
  ];
  for (let [target, property, value, duringQuery] of cases) {
    let capture = createPreviewCapture();
    if (duringQuery) {
      capture.sendQuery.callsFake(async () => {
        capture[target][property] = value;
        return capture.contentInfo;
      });
    } else {
      capture[target][property] = value;
    }
    let { browser, canvas, sendQuery, drawImage } = capture;
    Assert.equal(
      await PageThumbs.captureTabPreviewThumbnail(browser, canvas),
      false,
      `Skip ${target}.${property}=${value}, duringQuery=${!!duringQuery}`
    );
    Assert.equal(
      sendQuery.callCount,
      Number(target === "contentInfo" || !!duringQuery),
      "Only query a drawable canvas with an existing window global"
    );
    Assert.ok(browser.drawSnapshot.notCalled, "Do not request a snapshot");
    Assert.ok(drawImage.notCalled, "Do not draw a skipped capture");
  }

  let { browser, canvas, drawImage } = createPreviewCapture();
  browser.drawSnapshot.resolves(false);
  Assert.equal(
    await PageThumbs.captureTabPreviewThumbnail(browser, canvas),
    false,
    "Skip a failed snapshot"
  );
  Assert.ok(drawImage.notCalled, "Do not draw a failed snapshot");
});

add_task(async function test_valid_capture() {
  for (let [contentInfo, expectedRect, expectedRender] of [
    [{}, [0, 0, 800, 400, 0.7], [0, 0, 280, 140]],
    [{ documentHeight: 100 }, [0, 0, 800, 100, 2.8], [-420, 0, 1120, 140]],
    [{ scrollY: 1000 }, [0, 800, 800, 400, 0.7], [0, 0, 280, 140]],
  ]) {
    let { browser, canvas, drawImage, snapshot } =
      createPreviewCapture(contentInfo);
    Assert.equal(
      await PageThumbs.captureTabPreviewThumbnail(browser, canvas),
      true,
      "Capture a drawable document"
    );
    Assert.deepEqual(
      browser.drawSnapshot.firstCall.args,
      [...expectedRect, "transparent", false],
      "Preserve snapshot scaling and scroll adjustment"
    );
    Assert.ok(
      drawImage.calledOnceWithExactly(snapshot, ...expectedRender),
      "Draw the snapshot with the expected cropping"
    );
  }
});
