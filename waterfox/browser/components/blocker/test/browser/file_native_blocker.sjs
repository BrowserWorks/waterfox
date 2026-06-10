/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

function handleRequest(request, response) {
  const params = request.queryString.split("&");
  if (!params.includes("no-cors=1")) {
    response.setHeader("Access-Control-Allow-Origin", "*", false);
  }
  response.setHeader("Cache-Control", "max-age=3600", false);
  response.setHeader("X-Native-Blocker", "present", false);
  if (params.includes("case=player")) {
    response.setHeader("Content-Type", "application/json", false);
    response.write('{"adPlacements":[1],"adSlots":[2],"video":"content"}');
    return;
  }
  if (params.includes("case=echo")) {
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    response.setHeader("Content-Type", "text/plain", false);
    response.write(`${request.method}|${stream.read(stream.available())}`);
    return;
  }
  if (params.includes("case=script")) {
    response.setHeader("Content-Type", "application/javascript", false);
    response.write("window.nativeAdScriptRan = true;");
    return;
  }
  if (params.includes("case=redirect")) {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader(
      "Location",
      "file_native_blocker.sjs?case=redirect-target",
      false
    );
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(
    "<!doctype html><html><body><div id='native-ad'>advertisement</div><div id='native-keep'>content</div><script>window.nativeInlineRan = true;</script></body></html>"
  );
}
