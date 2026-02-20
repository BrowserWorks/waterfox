"use strict";

const TEST_DOMAIN = "https://example.net/";
const TEST_BLOCKED_3RD_PARTY_DOMAIN = "https://example.org/";
const TEST_ANNOTATED_3RD_PARTY_DOMAIN = "https://example.com/";
const TEST_PATH = "browser/toolkit/components/content-classifier/test/browser/";
const TEST_TOP_PAGE = TEST_DOMAIN + TEST_PATH + "page.html";
const BLOCK_LIST_URL = "https://example.net/" + TEST_PATH + "block_list.txt";
const ANNOTATE_LIST_URL =
  "https://example.net/" + TEST_PATH + "annotate_list.txt";
