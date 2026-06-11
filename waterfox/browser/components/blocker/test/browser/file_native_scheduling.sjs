/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

function handleRequest(request, response) {
  const params = {};
  for (const part of request.queryString.split("&")) {
    const [name, value = ""] = part.split("=");
    params[decodeURIComponent(name)] = decodeURIComponent(value);
  }
  const kind = params.case;
  const key = `native-scheduling-${params.token}`;
  response.setHeader("Cache-Control", "no-store", false);
  response.setHeader("Access-Control-Allow-Origin", "*", false);
  if (kind === "etp-list") {
    response.setHeader("Content-Type", "text/plain", false);
    response.write(`||example.com${request.path}?case=script$script\n`);
    return;
  }
  if (kind === "hits") {
    response.setHeader("Content-Type", "application/json", false);
    const cors = getState(`${key}-cors`);
    response.write(cors || JSON.stringify(Number(getState(key) || 0)));
    return;
  }
  if (kind === "rewrite" || kind === "rewrite-denied") {
    const hits = JSON.parse(
      getState(`${key}-cors`) || '{"preflights":0,"posts":0}'
    );
    if (request.method === "OPTIONS") {
      hits.preflights++;
      setState(`${key}-cors`, JSON.stringify(hits));
      response.setHeader("Access-Control-Allow-Methods", "POST", false);
      if (kind === "rewrite") {
        response.setHeader(
          "Access-Control-Allow-Headers",
          "X-Stage3-Header",
          false
        );
      }
      return;
    }
    hits.posts++;
    setState(`${key}-cors`, JSON.stringify(hits));
    const stream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    stream.init(request.bodyInputStream);
    response.setHeader("Content-Type", "application/json", false);
    response.write(
      JSON.stringify({
        method: request.method,
        query: request.queryString,
        body: stream.read(stream.available()),
        header: request.getHeader("X-Stage3-Header"),
      })
    );
    return;
  }
  if (kind === "script" || kind === "document") {
    setState(key, String(Number(getState(key) || 0) + 1));
  }
  if (kind === "script") {
    response.setHeader("Content-Type", "application/javascript", false);
    response.write(
      "window.nativeSchedulingExecutions = (window.nativeSchedulingExecutions || 0) + 1;"
    );
    return;
  }
  response.setHeader("Content-Type", "text/html; charset=utf-8", false);
  response.write(
    "<!doctype html><title>Native scheduling</title><body>publisher</body>"
  );
}
