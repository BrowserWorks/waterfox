/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ctypes } from "resource://gre/modules/ctypes.sys.mjs";

const SEC_SUCCESS = 0;
const PR_TRUE = 1;
const PR_FALSE = 0;

const NSS_INIT_READONLY = 0x1;
const NSS_INIT_NOROOTINIT = 0x10;

const CKA_DECRYPT = 0x105;
const CKM_DES3_CBC = 0x133;
const CKM_AES_CBC = 0x1082;

const OIDS = new Map([
  ["42,134,72,134,247,13,3,7", CKM_DES3_CBC],
  ["96,134,72,1,101,3,4,1,2", CKM_AES_CBC],
  ["96,134,72,1,101,3,4,1,22", CKM_AES_CBC],
  ["96,134,72,1,101,3,4,1,42", CKM_AES_CBC],
]);

/**
 * Minimal DER reader for NSS SDR payloads.
 */
class DERReader {
  #bytes;
  #offset = 0;

  constructor(bytes) {
    this.#bytes = bytes;
  }

  readBytes(expectedTag) {
    let tag = this.#readByte();
    if (tag != expectedTag) {
      throw new Error(`Unexpected DER tag ${tag}; expected ${expectedTag}`);
    }

    let length = this.#readLength();
    if (this.#offset + length > this.#bytes.length) {
      throw new Error("DER value extends past end of input");
    }

    let start = this.#offset;
    this.#offset += length;
    return this.#bytes.subarray(start, this.#offset);
  }

  readSequence() {
    return new DERReader(this.readBytes(0x30));
  }

  assertDone() {
    if (this.#offset != this.#bytes.length) {
      throw new Error("Unexpected trailing DER data");
    }
  }

  #readByte() {
    if (this.#offset >= this.#bytes.length) {
      throw new Error("Unexpected end of DER data");
    }
    return this.#bytes[this.#offset++];
  }

  #readLength() {
    let first = this.#readByte();
    if (first < 0x80) {
      return first;
    }

    let lengthBytes = first & 0x7f;
    if (!lengthBytes || lengthBytes > 4) {
      throw new Error("Unsupported DER length");
    }

    let length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = (length << 8) | this.#readByte();
    }
    return length;
  }
}

/**
 * Decrypts Firefox login SDR values using a source profile's NSS key database.
 */
export class FirefoxProfileLoginCrypto {
  #context = null;
  #initParams = null;
  #initStringBuffers = [];
  #lib = null;
  #slot = null;
  #tokenName;

  constructor(profilePath) {
    this.#tokenName = `Waterfox Import ${Services.uuid
      .generateUUID()
      .toString()
      .slice(1, 9)}`;
    this.#openLibrary();
    try {
      this.#initialize(profilePath);
    } catch (ex) {
      this.close();
      throw ex;
    }
  }

  decrypt(cipherText) {
    let parsed = parseSDR(base64ToBytes(cipherText));
    let plaintext = this.#decryptParsedData(parsed);
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  }

  close() {
    if (this.#slot && !this.#slot.isNull()) {
      this._PK11_FreeSlot(this.#slot);
      this.#slot = null;
    }

    if (this.#context && !this.#context.isNull()) {
      this._NSS_ShutdownContext(this.#context);
      this.#context = null;
    }

    if (this.#lib) {
      this.#lib.close();
      this.#lib = null;
    }
  }

  #openLibrary() {
    this.#lib = ctypes.open(ctypes.libraryName("nss3"));

    this.SECItem = new ctypes.StructType("SECItem", [
      { type: ctypes.int },
      { data: ctypes.uint8_t.ptr },
      { len: ctypes.uint32_t },
    ]);
    this.NSSInitParameters = new ctypes.StructType("NSSInitParameters", [
      { length: ctypes.uint32_t },
      { passwordRequired: ctypes.int },
      { minPWLen: ctypes.int },
      { manufactureID: ctypes.char.ptr },
      { libraryDescription: ctypes.char.ptr },
      { cryptoTokenDescription: ctypes.char.ptr },
      { dbTokenDescription: ctypes.char.ptr },
      { FIPSTokenDescription: ctypes.char.ptr },
      { cryptoSlotDescription: ctypes.char.ptr },
      { dbSlotDescription: ctypes.char.ptr },
      { FIPSSlotDescription: ctypes.char.ptr },
    ]);

    this._NSS_InitContext = this.#declare(
      "NSS_InitContext",
      ctypes.voidptr_t,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      ctypes.char.ptr,
      this.NSSInitParameters.ptr,
      ctypes.uint32_t
    );
    this._NSS_ShutdownContext = this.#declare(
      "NSS_ShutdownContext",
      ctypes.int,
      ctypes.voidptr_t
    );
    this._PK11_FindSlotByName = this.#declare(
      "PK11_FindSlotByName",
      ctypes.voidptr_t,
      ctypes.char.ptr
    );
    this._PK11_FreeSlot = this.#declare(
      "PK11_FreeSlot",
      ctypes.void_t,
      ctypes.voidptr_t
    );
    this._PK11_Authenticate = this.#declare(
      "PK11_Authenticate",
      ctypes.int,
      ctypes.voidptr_t,
      ctypes.int,
      ctypes.voidptr_t
    );
    this._PK11_FreeSymKey = this.#declare(
      "PK11_FreeSymKey",
      ctypes.void_t,
      ctypes.voidptr_t
    );
    this._PK11_ListFixedKeysInSlot = this.#declare(
      "PK11_ListFixedKeysInSlot",
      ctypes.voidptr_t,
      ctypes.voidptr_t,
      ctypes.char.ptr,
      ctypes.voidptr_t
    );
    this._PK11_GetNextSymKey = this.#declare(
      "PK11_GetNextSymKey",
      ctypes.voidptr_t,
      ctypes.voidptr_t
    );
    this._PK11_CreateContextBySymKey = this.#declare(
      "PK11_CreateContextBySymKey",
      ctypes.voidptr_t,
      ctypes.unsigned_long,
      ctypes.unsigned_long,
      ctypes.voidptr_t,
      this.SECItem.ptr
    );
    this._PK11_DestroyContext = this.#declare(
      "PK11_DestroyContext",
      ctypes.void_t,
      ctypes.voidptr_t,
      ctypes.int
    );
    this._PK11_CipherOp = this.#declare(
      "PK11_CipherOp",
      ctypes.int,
      ctypes.voidptr_t,
      ctypes.uint8_t.ptr,
      ctypes.int.ptr,
      ctypes.int,
      ctypes.uint8_t.ptr,
      ctypes.int
    );
    this._PORT_GetError = this.#declare("PORT_GetError", ctypes.int);
  }

  #declare(name, returnType, ...argTypes) {
    return this.#lib.declare(name, ctypes.default_abi, returnType, ...argTypes);
  }

  #initialize(profilePath) {
    this.#initParams = new this.NSSInitParameters();
    this.#initParams.length = this.NSSInitParameters.size;
    this.#initParams.passwordRequired = PR_FALSE;
    this.#initParams.minPWLen = 0;
    this.#initParams.manufactureID = null;
    this.#initParams.libraryDescription = this.#makeCString(
      "Waterfox Import NSS"
    );
    this.#initParams.cryptoTokenDescription = this.#makeCString(
      `${this.#tokenName} Crypto`
    );
    this.#initParams.dbTokenDescription = this.#makeCString(this.#tokenName);
    this.#initParams.FIPSTokenDescription = null;
    this.#initParams.cryptoSlotDescription = this.#makeCString(
      `${this.#tokenName} Crypto Slot`
    );
    this.#initParams.dbSlotDescription = this.#makeCString(
      `${this.#tokenName} DB Slot`
    );
    this.#initParams.FIPSSlotDescription = null;

    this.#context = this._NSS_InitContext(
      `sql:${profilePath}`,
      "",
      "",
      "",
      this.#initParams.address(),
      NSS_INIT_READONLY | NSS_INIT_NOROOTINIT
    );
    if (!this.#context || this.#context.isNull()) {
      this.#throwLastError("Could not initialize NSS for Firefox profile");
    }

    this.#slot = this._PK11_FindSlotByName(this.#tokenName);
    if (!this.#slot || this.#slot.isNull()) {
      this.#throwLastError("Could not find Firefox profile NSS token");
    }

    if (this._PK11_Authenticate(this.#slot, PR_TRUE, null) != SEC_SUCCESS) {
      this.#throwLastError("Could not authenticate Firefox profile NSS token");
    }
  }

  #makeCString(value) {
    let buffer = ctypes.char.array()(value);
    this.#initStringBuffers.push(buffer);
    return buffer.addressOfElement(0);
  }

  #decryptParsedData(parsed) {
    let lastError = null;
    let keyList = this._PK11_ListFixedKeysInSlot(this.#slot, null, null);
    let currentKey = keyList;
    while (currentKey && !currentKey.isNull()) {
      let nextKey = this._PK11_GetNextSymKey(currentKey);
      try {
        try {
          let plaintext = this.#decryptWithKey(currentKey, parsed);
          this.#freeSymKeyList(nextKey);
          return plaintext;
        } catch (ex) {
          lastError = ex;
        }
      } finally {
        this._PK11_FreeSymKey(currentKey);
      }
      currentKey = nextKey;
    }

    if (lastError) {
      throw lastError;
    }
    this.#throwLastError("Could not find Firefox SDR key");
    throw new Error("Could not find Firefox SDR key");
  }

  #freeSymKeyList(key) {
    let currentKey = key;
    while (currentKey && !currentKey.isNull()) {
      let nextKey = this._PK11_GetNextSymKey(currentKey);
      this._PK11_FreeSymKey(currentKey);
      currentKey = nextKey;
    }
  }

  #decryptWithKey(key, parsed) {
    let params = makeSECItem(this.SECItem, parsed.iv);
    let context = this._PK11_CreateContextBySymKey(
      parsed.mechanism,
      CKA_DECRYPT,
      key,
      params.item.address()
    );
    if (!context || context.isNull()) {
      this.#throwLastError("Could not create Firefox SDR decrypt context");
    }

    try {
      let input = ctypes.uint8_t.array(parsed.data.length)(
        Array.from(parsed.data)
      );
      let output = ctypes.uint8_t.array(parsed.data.length)();
      let outputLength = new ctypes.int(0);
      let rv = this._PK11_CipherOp(
        context,
        output,
        outputLength.address(),
        parsed.data.length,
        input,
        parsed.data.length
      );
      if (rv != SEC_SUCCESS) {
        this.#throwLastError("Could not decrypt Firefox SDR data");
      }

      let plaintext = new Uint8Array(Number(outputLength.value));
      for (let i = 0; i < plaintext.length; i++) {
        plaintext[i] = output[i];
      }
      return unpad(plaintext, getBlockSize(parsed.mechanism));
    } finally {
      this._PK11_DestroyContext(context, PR_TRUE);
    }
  }

  #throwLastError(message) {
    throw new Error(`${message}: NSS error ${this._PORT_GetError()}`);
  }
}

function base64ToBytes(value) {
  let binary = atob(value);
  let bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function parseSDR(bytes) {
  let top = new DERReader(bytes).readSequence();
  let keyId = top.readBytes(0x04);
  let algorithm = top.readSequence();
  let oid = algorithm.readBytes(0x06);
  let mechanism = OIDS.get(Array.from(oid).join(","));
  if (!mechanism) {
    throw new Error("Unsupported Firefox SDR encryption algorithm");
  }
  let iv = algorithm.readBytes(0x04);
  algorithm.assertDone();
  let data = top.readBytes(0x04);
  top.assertDone();
  return { keyId, mechanism, iv, data };
}

function getBlockSize(mechanism) {
  switch (mechanism) {
    case CKM_DES3_CBC:
      return 8;
    case CKM_AES_CBC:
      return 16;
    default:
      throw new Error("Unsupported Firefox SDR encryption algorithm");
  }
}

function makeSECItem(SECItem, bytes) {
  let data = ctypes.uint8_t.array(bytes.length)(Array.from(bytes));
  let item = new SECItem();
  item.type = 0;
  item.data = data.addressOfElement(0);
  item.len = bytes.length;
  return { data, item };
}

function unpad(bytes, blockSize) {
  if (!blockSize || !bytes.length || bytes.length % blockSize) {
    throw new Error("Invalid Firefox SDR plaintext padding");
  }

  let padLength = bytes[bytes.length - 1];
  if (padLength < 1 || padLength > blockSize || padLength > bytes.length) {
    throw new Error("Invalid Firefox SDR plaintext padding");
  }

  for (let i = bytes.length - padLength; i < bytes.length; i++) {
    if (bytes[i] != padLength) {
      throw new Error("Invalid Firefox SDR plaintext padding");
    }
  }

  return bytes.subarray(0, bytes.length - padLength);
}
