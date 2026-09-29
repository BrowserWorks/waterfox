/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FEED_MIME_TYPES } from "resource:///modules/FeedConstants.sys.mjs";

const XML_TYPE = "application/xml";

/** Lets the XML document loader consume inline feeds without changing bytes. */
export class FeedStreamConverter {
  QueryInterface = ChromeUtils.generateQI([
    "nsIStreamConverter",
    "nsIStreamListener",
    "nsIRequestObserver",
  ]);

  #listener = null;
  #fromType = null;

  convert() {
    throw Components.Exception(
      "Asynchronous conversion only",
      Cr.NS_ERROR_NOT_IMPLEMENTED
    );
  }

  getConvertedType(fromType, channel) {
    const loadInfo = channel?.loadInfo;
    const context = loadInfo?.targetBrowsingContext;
    if (
      !FEED_MIME_TYPES.includes(fromType) ||
      !(channel instanceof Ci.nsIHttpChannel) ||
      channel instanceof Ci.nsIMultiPartChannel ||
      (!channel.URI.schemeIs("http") && !channel.URI.schemeIs("https")) ||
      loadInfo.externalContentPolicyType !==
        Ci.nsIContentPolicy.TYPE_DOCUMENT ||
      loadInfo.isUserTriggeredSave ||
      !context ||
      context.parent
    ) {
      throw Components.Exception(
        "Not an inline top-level HTTP feed",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }

    let attachment = false;
    try {
      attachment =
        channel.contentDisposition === Ci.nsIChannel.DISPOSITION_ATTACHMENT;
    } catch (error) {
      if (error.result !== Cr.NS_ERROR_NOT_AVAILABLE) {
        throw error;
      }
    }
    if (attachment) {
      throw Components.Exception(
        "Feed is an attachment",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }

    const mimeInfo = Cc["@mozilla.org/mime;1"]
      .getService(Ci.nsIMIMEService)
      .getFromTypeAndExtension(fromType, "");
    const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(
      Ci.nsIHandlerService
    );
    if (
      handlers.exists(mimeInfo) &&
      (mimeInfo.alwaysAskBeforeHandling ||
        mimeInfo.preferredAction !== Ci.nsIHandlerInfo.handleInternally)
    ) {
      throw Components.Exception(
        "Respect the saved feed handler",
        Cr.NS_ERROR_NOT_AVAILABLE
      );
    }
    return XML_TYPE;
  }

  asyncConvertData(fromType, toType, listener, context) {
    if (toType !== "*/*" && toType !== XML_TYPE) {
      throw Components.Exception(
        "Unsupported output type",
        Cr.NS_ERROR_INVALID_ARG
      );
    }
    this.getConvertedType(fromType, context?.QueryInterface(Ci.nsIChannel));
    this.#fromType = fromType;
    this.#listener = listener;
  }

  onStartRequest(request) {
    const channel = request.QueryInterface(Ci.nsIChannel);
    this.getConvertedType(this.#fromType, channel);
    channel.contentType = XML_TYPE;
    this.#listener.onStartRequest(request);
  }

  onDataAvailable(request, stream, offset, count) {
    this.#listener.onDataAvailable(request, stream, offset, count);
  }

  onStopRequest(request, status) {
    const listener = this.#listener;
    this.#listener = null;
    this.#fromType = null;
    listener.onStopRequest(request, status);
  }

  maybeRetarget() {}

  checkListenerChain() {
    throw Components.Exception(
      "Keep XML conversion on the main thread",
      Cr.NS_ERROR_NO_INTERFACE
    );
  }

  onDataFinished() {}
}
