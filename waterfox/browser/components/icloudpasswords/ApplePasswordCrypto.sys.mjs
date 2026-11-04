/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const ERRORS = Object.freeze({
  unsupported: "Apple Passwords is not supported on this platform",
  "not-available": "The Apple Passwords native host is unavailable",
  locked: "Apple Passwords is locked",
  "invalid-state": "The Apple Passwords session is not in the required state",
  "invalid-origin": "An HTTP or HTTPS origin is required",
  "invalid-argument": "An Apple Passwords argument is invalid",
  "invalid-pin": "A valid six-digit Apple Passwords PIN is required",
  "pairing-failed": "Apple Passwords pairing could not be verified",
  "unsupported-protocol": "The Apple Passwords protocol is unsupported",
  "protocol-error": "The Apple Passwords native response is invalid",
  timeout: "The Apple Passwords operation timed out",
  "connection-closed": "The Apple Passwords native connection closed",
  "queue-full": "Too many Apple Passwords operations are pending",
  "invalid-session": "The Apple Passwords session has expired",
  "native-auth-required": "Authentication in Apple Passwords is required",
  "native-error": "The Apple Passwords operation failed",
  "no-results": "No matching Apple Passwords entry was found",
  "save-failed": "Apple Passwords could not save the entry",
  "setup-unavailable": "Apple Passwords verification code setup is unavailable",
  "duplicate-item": "Apple Passwords reported a duplicate entry",
});

/** Native failure exposing only an allowlisted code and sanitized message. */
export class ApplePasswordError extends Error {
  constructor(code = "protocol-error") {
    if (!Object.hasOwn(ERRORS, code)) {
      code = "protocol-error";
    }
    super(ERRORS[code]);
    this.name = "ApplePasswordError";
    this.code = code;
  }
}

// RFC 5054, Appendix A, 3072-bit group. Apple's protocol uses g = 5.
const N = BigInt(
  "0xFFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD129024E08" +
    "8A67CC74020BBEA63B139B22514A08798E3404DDEF9519B3CD3A431B" +
    "302B0A6DF25F14374FE1356D6D51C245E485B576625E7EC6F44C42E9" +
    "A637ED6B0BFF5CB6F406B7EDEE386BFB5A899FA5AE9F24117C4B1FE6" +
    "49286651ECE45B3DC2007CB8A163BF0598DA48361C55D39A69163FA8" +
    "FD24CF5F83655D23DCA3AD961C62F356208552BB9ED529077096966D" +
    "670C354E4ABC9804F1746C08CA18217C32905E462E36CE3BE39E772C" +
    "180E86039B2783A2EC07A28FB5C55DF06F4C52C9DE2BCBF695581718" +
    "3995497CEA956AE515D2261898FA051015728E5A8AAAC42DAD33170D" +
    "04507A33A85521ABDF1CBA64ECFB850458DBEF0A8AEA71575D060C7D" +
    "B3970F85A6E1E4C7ABF5AE8CDB0933D71E8C94E04A25619DCEE3D226" +
    "1AD2EE6BF12FFA06D98A0864D87602733EC86A64521F2B18177B200C" +
    "BBE117577A615D6C770988C0BAD946E208E24FA074E5AB3143DB5BFC" +
    "E0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF"
);
const GROUP_BYTES = 384;
const MAX_CIPHERTEXT = 1024 * 1024;
const MAX_MESSAGES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function sanitizeError(error) {
  return error instanceof ApplePasswordError ? error : new ApplePasswordError();
}

function concatenate(...parts) {
  let result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0)
  );
  let offset = 0;
  for (let part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function hex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function integer(bytes) {
  return bytes.length ? BigInt(`0x${hex(bytes)}`) : 0n;
}

function integerBytes(value, width = 0) {
  let text = value.toString(16);
  if (text.length % 2) {
    text = `0${text}`;
  }
  let size = value === 0n ? 0 : text.length / 2;
  let result = new Uint8Array(Math.max(width, size));
  for (let i = 0; i < size; i++) {
    result[result.length - size + i] = parseInt(
      text.slice(i * 2, i * 2 + 2),
      16
    );
  }
  return result;
}

function base64(bytes) {
  let chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  }
  return btoa(chunks.join(""));
}

function unbase64(text, maximum) {
  if (
    typeof text !== "string" ||
    !text.length ||
    text.length > Math.ceil(maximum / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(text) ||
    text.length % 4 === 1
  ) {
    throw new ApplePasswordError();
  }
  let bytes;
  try {
    bytes = Uint8Array.from(atob(text), char => char.charCodeAt(0));
  } catch {
    throw new ApplePasswordError();
  }
  if (
    bytes.length > maximum ||
    base64(bytes).replace(/=+$/, "") !== text.replace(/=+$/, "")
  ) {
    throw new ApplePasswordError();
  }
  return bytes;
}

function decodeWire(text, useBase64, maximum) {
  if (useBase64) {
    return unbase64(text, maximum);
  }
  if (typeof text !== "string" || text.length > maximum * 2 + 2) {
    throw new ApplePasswordError();
  }
  text = text.replace(/^0x/i, "");
  if (!text.length || text.length % 2 || !/^[0-9a-f]+$/i.test(text)) {
    throw new ApplePasswordError();
  }
  return Uint8Array.from(text.match(/../g), byte => parseInt(byte, 16));
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplePasswordError();
  }
  return value;
}

async function digest(...parts) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", concatenate(...parts))
  );
}

function equalProof(left, right) {
  let difference = left.length ^ right.length;
  for (let i = 0; i < right.length; i++) {
    difference |= (left[i] ?? 0) ^ right[i];
  }
  return difference === 0;
}

export function encodeApplePasswordHandshake(value) {
  return base64(encoder.encode(JSON.stringify(value)));
}

export function decodeApplePasswordHandshake(text) {
  try {
    return record(JSON.parse(decoder.decode(unbase64(text, 16 * 1024))));
  } catch {
    throw new ApplePasswordError();
  }
}

/** Holds one SRP attempt in memory; never reuse it after a failed proof. */
export class ApplePasswordCrypto {
  #useBase64;
  #random;
  #yieldControl;
  #phase = "new";
  #revision = 0;
  #tid;
  #a = 0n;
  #A = 0n;
  #B = 0n;
  #salt;
  #expectedProof;
  #key;
  #sentIVs = new Set();
  #receivedIVs = new Set();

  constructor({ useBase64 = false, randomBytes, yieldControl } = {}) {
    if (typeof useBase64 !== "boolean") {
      throw new ApplePasswordError("unsupported-protocol");
    }
    this.#useBase64 = useBase64;
    this.#random =
      randomBytes ?? (size => crypto.getRandomValues(new Uint8Array(size)));
    this.#yieldControl =
      yieldControl ?? (() => new Promise(resolve => setTimeout(resolve, 0)));
  }

  static async create(options) {
    let session = new ApplePasswordCrypto(options);
    try {
      session.#tid = session.#serialize(session.#randomBytes(16));
      let secret = session.#randomBytes(32);
      session.#a = integer(secret);
      secret.fill(0);
      if (!session.#a) {
        throw new ApplePasswordError("pairing-failed");
      }
      session.#A = await session.#power(5n, session.#a);
      session.#phase = "hello";
      return session;
    } catch (error) {
      session.destroy();
      throw sanitizeError(error);
    }
  }

  get tid() {
    return this.#tid;
  }

  get isVerified() {
    return this.#phase === "ready";
  }

  #randomBytes(size) {
    let bytes = this.#random(size);
    if (
      !ArrayBuffer.isView(bytes) ||
      Object.prototype.toString.call(bytes) !== "[object Uint8Array]" ||
      bytes.length !== size
    ) {
      throw new ApplePasswordError();
    }
    return new Uint8Array(bytes);
  }

  #serialize(bytes, prefix = true) {
    if (this.#useBase64) {
      return base64(bytes);
    }
    return `${prefix ? "0x" : ""}${hex(bytes)}`;
  }

  #check(revision) {
    if (this.#phase === "destroyed" || this.#revision !== revision) {
      throw new ApplePasswordError("locked");
    }
  }

  async #power(base, exponent) {
    let revision = this.#revision;
    let result = 1n;
    base = ((base % N) + N) % N;
    let steps = 0;
    while (exponent) {
      if (exponent & 1n) {
        result = (result * base) % N;
      }
      base = (base * base) % N;
      exponent >>= 1n;
      if (++steps % 16 === 0) {
        await this.#yieldControl();
        this.#check(revision);
      }
    }
    this.#check(revision);
    return result;
  }

  clientHello() {
    if (this.#phase !== "hello") {
      throw new ApplePasswordError("invalid-state");
    }
    return {
      TID: this.#tid,
      MSG: 0,
      A: this.#serialize(integerBytes(this.#A)),
      VER: "1.0",
      PROTO: [1],
    };
  }

  acceptServerHello(value) {
    try {
      record(value);
      if (
        this.#phase !== "hello" ||
        value.TID !== this.#tid ||
        ![1, "1"].includes(value.MSG) ||
        (value.ErrCode !== undefined && value.ErrCode !== 0)
      ) {
        throw new ApplePasswordError("pairing-failed");
      }
      if (
        value.PROTO !== 1 ||
        (value.VER !== undefined && value.VER !== "1.0")
      ) {
        throw new ApplePasswordError("unsupported-protocol");
      }
      this.#B = integer(decodeWire(value.B, this.#useBase64, GROUP_BYTES));
      let salt = decodeWire(value.s, this.#useBase64, 64);
      if (this.#B <= 0n || this.#B >= N || integer(salt) === 0n) {
        throw new ApplePasswordError("pairing-failed");
      }
      this.#salt = salt;
      this.#phase = "challenge";
    } catch (error) {
      this.destroy();
      throw sanitizeError(error);
    }
  }

  async clientProof(pin) {
    if (typeof pin !== "string" || !/^[0-9]{6}$/.test(pin)) {
      throw new ApplePasswordError("invalid-pin");
    }
    if (this.#phase !== "challenge") {
      throw new ApplePasswordError("invalid-state");
    }
    this.#phase = "computing";
    let revision = this.#revision;
    let keyMaterial;
    try {
      let [uBytes, kBytes, xBytes, nHash, gHash, identityHash] =
        await Promise.all([
          digest(
            integerBytes(this.#A, GROUP_BYTES),
            integerBytes(this.#B, GROUP_BYTES)
          ),
          digest(integerBytes(N), integerBytes(5n, GROUP_BYTES)),
          digest(encoder.encode(`${this.#tid}:${pin}`)).then(hash =>
            digest(this.#salt, hash)
          ),
          digest(integerBytes(N)),
          digest(integerBytes(5n, GROUP_BYTES)),
          digest(encoder.encode(this.#tid)),
        ]);
      pin = null;
      this.#check(revision);
      let u = integer(uBytes);
      if (u === 0n) {
        throw new ApplePasswordError("pairing-failed");
      }
      let x = integer(xBytes);
      let verifier = await this.#power(5n, x);
      let secret = await this.#power(
        this.#B - integer(kBytes) * verifier,
        this.#a + u * x
      );
      if (!secret) {
        throw new ApplePasswordError("pairing-failed");
      }
      // S is an unsigned integer; its SHA-256 digest retains all 32 bytes.
      keyMaterial = await digest(integerBytes(secret));
      this.#check(revision);
      let xor = nHash.map((byte, i) => byte ^ gHash[i]);
      let proof = await digest(
        xor,
        identityHash,
        this.#salt,
        integerBytes(this.#A),
        integerBytes(this.#B),
        keyMaterial
      );
      let expected = await digest(integerBytes(this.#A), proof, keyMaterial);
      let key = await crypto.subtle.importKey(
        "raw",
        keyMaterial.subarray(0, 16),
        "AES-GCM",
        false,
        ["encrypt", "decrypt"]
      );
      this.#check(revision);
      this.#expectedProof = expected;
      this.#key = key;
      this.#a = this.#A = this.#B = 0n;
      this.#salt.fill(0);
      this.#salt = null;
      this.#phase = "proof";
      return { TID: this.#tid, MSG: 2, M: this.#serialize(proof, false) };
    } catch (error) {
      this.destroy();
      throw sanitizeError(error);
    } finally {
      keyMaterial?.fill(0);
    }
  }

  verifyServerProof(value) {
    try {
      record(value);
      if (
        this.#phase !== "proof" ||
        value.TID !== this.#tid ||
        ![3, "3"].includes(value.MSG)
      ) {
        throw new ApplePasswordError("pairing-failed");
      }
      if (value.ErrCode !== 0) {
        throw new ApplePasswordError(
          value.ErrCode === 1 ? "invalid-pin" : "pairing-failed"
        );
      }
      let proof = decodeWire(value.HAMK, this.#useBase64, 32);
      let padded = new Uint8Array(32);
      padded.set(proof, 32 - proof.length);
      if (!equalProof(padded, this.#expectedProof)) {
        throw new ApplePasswordError("pairing-failed");
      }
      this.#expectedProof.fill(0);
      this.#expectedProof = null;
      this.#phase = "ready";
    } catch (error) {
      this.destroy();
      throw sanitizeError(error);
    }
  }

  #requireReady() {
    if (!this.isVerified || !this.#key) {
      throw new ApplePasswordError("locked");
    }
  }

  async encryptJSON(value) {
    this.#requireReady();
    let revision = this.#revision;
    let iv = this.#randomBytes(16);
    let ivID = hex(iv);
    if (this.#sentIVs.size >= MAX_MESSAGES || this.#sentIVs.has(ivID)) {
      this.destroy();
      throw new ApplePasswordError("invalid-session");
    }
    this.#sentIVs.add(ivID);
    let plaintext = encoder.encode(JSON.stringify(value));
    try {
      if (plaintext.length > MAX_CIPHERTEXT - 32) {
        throw new ApplePasswordError("invalid-argument");
      }
      let ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, tagLength: 128 },
          this.#key,
          plaintext
        )
      );
      this.#check(revision);
      // Browser -> host: ciphertext || tag || IV. Host -> browser: IV || ciphertext || tag.
      return this.#serialize(concatenate(ciphertext, iv));
    } catch (error) {
      throw sanitizeError(error);
    } finally {
      plaintext.fill(0);
    }
  }

  async decryptJSON(text) {
    this.#requireReady();
    let revision = this.#revision;
    let plaintext;
    try {
      let bytes = decodeWire(text, this.#useBase64, MAX_CIPHERTEXT);
      if (bytes.length < 33 || this.#receivedIVs.size >= MAX_MESSAGES) {
        throw new ApplePasswordError();
      }
      let iv = bytes.subarray(0, 16);
      let ivID = hex(iv);
      if (this.#receivedIVs.has(ivID)) {
        throw new ApplePasswordError();
      }
      plaintext = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, tagLength: 128 },
          this.#key,
          bytes.subarray(16)
        )
      );
      this.#check(revision);
      let value = record(JSON.parse(decoder.decode(plaintext)));
      this.#receivedIVs.add(ivID);
      return value;
    } catch (error) {
      this.destroy();
      throw sanitizeError(error);
    } finally {
      plaintext?.fill(0);
    }
  }

  destroy() {
    this.#revision++;
    this.#phase = "destroyed";
    this.#a = this.#A = this.#B = 0n;
    this.#salt?.fill(0);
    this.#expectedProof?.fill(0);
    this.#salt = this.#expectedProof = this.#key = null;
    this.#sentIVs.clear();
    this.#receivedIVs.clear();
  }
}
