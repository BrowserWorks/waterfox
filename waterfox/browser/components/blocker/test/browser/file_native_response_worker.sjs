/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

function handleRequest(request, response) {
  const params = new Map(
    request.queryString.split("&").map(pair => {
      const [name, value = ""] = pair.split("=");
      return [decodeURIComponent(name), decodeURIComponent(value)];
    })
  );
  const kind = params.get("case");
  const cache = params.get("cache");
  response.setHeader("Access-Control-Allow-Origin", "*", false);
  response.setHeader(
    "Access-Control-Expose-Headers",
    "X-Stage3-Adapter",
    false
  );
  response.setHeader("X-Stage3-Adapter", "present", false);
  if (kind === "auth") {
    response.setHeader("Cache-Control", "max-age=3600", false);
    if (!request.hasHeader("Authorization")) {
      response.setStatusLine(request.httpVersion, 401, "Unauthorized");
      response.setHeader(
        "WWW-Authenticate",
        `Basic realm="${params.get("token")}"`,
        false
      );
      if (params.get("challenge") === "different") {
        response.setHeader("Content-Security-Policy", "img-src 'none'", false);
      }
      response.write("authentication-challenge");
      return;
    }
    response.setHeader(
      "Content-Security-Policy",
      "script-src 'nonce-stage3'; img-src 'self'",
      false
    );
    response.setHeader("Content-Type", "text/html; charset=utf-8", false);
    response.write(
      "<!doctype html><html><body>" +
        "<div id='native-keep'>authenticated-body</div>" +
        "<script>window.nativeAdRan = true;</script>" +
        "<script nonce='stage3'>window.nativeKeepRan = true;</script>" +
        "</body></html>"
    );
    return;
  }
  response.setHeader("Content-Security-Policy", "img-src 'self'", false);
  let cacheControl = "no-store";
  if (cache === "fresh") {
    cacheControl = "max-age=3600";
  } else if (cache === "revalidate") {
    cacheControl = "max-age=0, must-revalidate";
  }
  response.setHeader("Cache-Control", cacheControl, false);
  if (kind === "partial") {
    response.setStatusLine(request.httpVersion, 206, "Partial Content");
  }

  if (cache) {
    const etag = '"stage3-response-v1"';
    response.setHeader("ETag", etag, false);
    if (
      request.hasHeader("If-None-Match") &&
      request.getHeader("If-None-Match") === etag
    ) {
      response.setStatusLine(request.httpVersion, 304, "Not Modified");
      return;
    }
  }

  if (kind === "import") {
    response.setHeader("Content-Type", "application/javascript", false);
    response.write("self.nativeImported = (self.nativeImported || 0) + 1;");
    return;
  }
  if (kind === "data" || kind === "sw-fallback") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write("network-body");
    return;
  }
  if (kind === "sw-synthetic" || kind === "sw-cache") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write("unexpected-network-body");
    return;
  }

  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(
    "<!doctype html><html><body>" +
      "<div id='native-ad'>advertisement</div>" +
      "<div id='native-keep'>original-body-token</div>" +
      "<script id='native-ad-script'>window.nativeAdRan = true;</script>" +
      "<script>window.nativeKeepRan = true;</script>" +
      "</body></html>"
  );
}
