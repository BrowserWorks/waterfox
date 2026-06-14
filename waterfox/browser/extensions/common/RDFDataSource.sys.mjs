/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const RDF_NAMESPACE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";

export const RDFDataSource = {
  loadFromString(text) {
    const document = new DOMParser().parseFromString(text, "application/xml");
    const parserError = document.querySelector("parsererror");
    if (parserError) {
      throw new Error(parserError.textContent.trim());
    }

    if (
      document.documentElement.namespaceURI !== RDF_NAMESPACE ||
      document.documentElement.localName !== "RDF"
    ) {
      throw new Error("Install manifest is not an RDF document");
    }

    return document;
  },
};
