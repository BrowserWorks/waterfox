/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ApplePasswordCrypto } = ChromeUtils.importESModule(
  "resource:///modules/ApplePasswordCrypto.sys.mjs"
);
const { deterministicRandom, fromHex, toHex } = ChromeUtils.importESModule(
  "resource://icloud-passwords-test/ApplePasswordTestUtils.sys.mjs"
);

// Test server group from RFC 5054, Appendix A (3072 bits).
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

// Proof and key hashes calculated with Python hashlib/pow using S = (A * v^u)^b mod N.
const VECTORS = [
  {
    salt: "0102030405060708090a0b0c0d0e0f10",
    leadingZeroKey: false,
    hex: {
      b: 7,
      proofHash:
        "8c6a8ccac3e20d7c0d0b0765d15542187b53fa7a83fe0f380605c5292836ba87",
      keyHash:
        "68a8ab17126ac354ea08f4776cbe5635546e685d21560f8ada91c30504537895",
    },
    base64: {
      b: 7,
      proofHash:
        "b37df923936be95498149f384d0596a2cf91c32299ff1046af582a64ea911370",
      keyHash:
        "bdcd4405931987e7c2a262db7b1f2ac927abb716fab9a84ef9a9d6ac66816d44",
    },
  },
  {
    salt: "000102030405060708090a0b0c0d0e0f",
    leadingZeroKey: false,
    hex: {
      b: 7,
      proofHash:
        "11302c2636af57cc7d063ad17e4aac2c488f9c83b1229a4ab1833f78257b0b7f",
      keyHash:
        "7d73745e627252812240a91cd79cf0304d049063a9fc4e2b92af46af66afdc01",
    },
    base64: {
      b: 7,
      proofHash:
        "8d7659220f957d5365378200e8011242ad5c9f4346fbf96e9e7e9568dd7c5dd3",
      keyHash:
        "b4841ec33bd1d868e2f8123cdd948034e828bf8df6a2892e3ae4c4986d8ed7fd",
    },
  },
  {
    salt: "0102030405060708090a0b0c0d0e0f10",
    leadingZeroKey: true,
    hex: {
      b: 360,
      proofHash:
        "9a8773474f632316e1dae4707b73641c387acf4d0dd3f59612b415b87d7ba7bf",
      keyHash:
        "c9654d4fa26754d769dd314293ad6158142db3670f82d30c3c0e3659c0bbe545",
    },
    base64: {
      b: 82,
      proofHash:
        "dde5dcdfcb0c4f3682b4a7ef25578139f5c9f19a3f1117045428b7b4b8fd5ff4",
      keyHash:
        "731505344760fc19ea2ccb7664fd40b078a4209dae0d7e94aca58e2e4c26b54c",
    },
  },
];

async function hash(...values) {
  let bytes = new Uint8Array(
    values.reduce((size, value) => size + value.length, 0)
  );
  let offset = 0;
  for (let value of values) {
    bytes.set(value, offset);
    offset += value.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

function integer(bytes) {
  return BigInt(`0x${toHex(bytes)}`);
}

function integerBytes(value, width = 0) {
  let text = value.toString(16);
  return fromHex(
    text.padStart(Math.max(width * 2, text.length + (text.length % 2)), "0")
  );
}

function power(base, exponent) {
  let result = 1n;
  while (exponent) {
    if (exponent % 2n) {
      result = (result * base) % N;
    }
    base = (base * base) % N;
    exponent /= 2n;
  }
  return result;
}

function wire(bytes, useBase64) {
  return useBase64 ? btoa(String.fromCharCode(...bytes)) : `0x${toHex(bytes)}`;
}

function unwire(text, useBase64) {
  return useBase64
    ? Uint8Array.from(atob(text), char => char.charCodeAt(0))
    : fromHex(text);
}

async function referencePeer(vector, useBase64) {
  let session = await ApplePasswordCrypto.create({
    randomBytes: deterministicRandom(),
    useBase64,
  });
  registerCleanupFunction(() => session.destroy());
  let hello = session.clientHello();
  let A = integer(unwire(hello.A, useBase64));
  let salt = fromHex(vector.salt);
  let encoding = vector[useBase64 ? "base64" : "hex"];
  let b = BigInt(encoding.b);
  let identity = new TextEncoder().encode(hello.TID);
  let x = integer(
    await hash(
      salt,
      await hash(new TextEncoder().encode(`${hello.TID}:123456`))
    )
  );
  let v = power(5n, x);
  let k = integer(await hash(integerBytes(N), integerBytes(5n, 384)));
  let B = (k * v + power(5n, b)) % N;
  let u = integer(await hash(integerBytes(A, 384), integerBytes(B, 384)));
  let shared = power((A * power(v, u)) % N, b);
  let keyBytes = await hash(integerBytes(shared));
  let nHash = await hash(integerBytes(N));
  let gHash = await hash(integerBytes(5n, 384));
  let proof = await hash(
    nHash.map((byte, i) => byte ^ gHash[i]),
    await hash(identity),
    salt,
    integerBytes(A),
    integerBytes(B),
    keyBytes
  );
  Assert.equal(toHex(await hash(proof)), encoding.proofHash);
  Assert.equal(toHex(await hash(keyBytes)), encoding.keyHash);
  Assert.equal(keyBytes[0] === 0, vector.leadingZeroKey);
  let serverProof = await hash(integerBytes(A), proof, keyBytes);
  let key = await crypto.subtle.importKey(
    "raw",
    keyBytes.subarray(0, 16),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  keyBytes.fill(0);
  session.acceptServerHello({
    TID: hello.TID,
    MSG: 1,
    PROTO: 1,
    B: wire(integerBytes(B), useBase64),
    s: wire(salt, useBase64),
  });
  let clientProof = await session.clientProof("123456");
  Assert.strictEqual(
    toHex(unwire(clientProof.M, useBase64)),
    toHex(proof),
    "Client proof matches the independently checked server"
  );
  return { session, serverProof, key };
}

function verifyPeer(peer, useBase64) {
  peer.session.verifyServerProof({
    TID: peer.session.tid,
    MSG: 3,
    ErrCode: 0,
    HAMK: wire(peer.serverProof, useBase64),
  });
}

async function encryptedReply(key) {
  let iv = new Uint8Array(16).fill(42);
  let ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      new TextEncoder().encode('{"STATUS":0}')
    )
  );
  let reply = new Uint8Array(iv.length + ciphertext.length);
  reply.set(iv);
  reply.set(ciphertext, iv.length);
  return reply;
}

add_task(async function test_srp_mutual_proof_and_aes_directions() {
  for (let useBase64 of [false, true]) {
    for (let vector of VECTORS) {
      let peer = await referencePeer(vector, useBase64);
      let { session, key } = peer;
      try {
        Assert.ok(!session.isVerified);
        await Assert.rejects(
          session.encryptJSON({ ACT: 5 }),
          error => error.code === "locked",
          "A shared key alone does not authenticate the host"
        );
        verifyPeer(peer, useBase64);
        Assert.ok(session.isVerified);
        let body = { ACT: 5, URL: "example.test" };
        let request = unwire(await session.encryptJSON(body), useBase64);
        let opened = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: request.slice(-16), tagLength: 128 },
          key,
          request.slice(0, -16)
        );
        Assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), body);
        Assert.deepEqual(
          await session.decryptJSON(wire(await encryptedReply(key), useBase64)),
          { STATUS: 0 },
          "Request IV is last; response IV is first"
        );
      } finally {
        session.destroy();
      }
    }
  }
});

add_task(async function test_tamper_and_replay_destroy_session() {
  for (let useBase64 of [false, true]) {
    for (let failure of ["server-proof", "ciphertext", "replay"]) {
      let peer = await referencePeer(VECTORS[0], useBase64);
      let { session, key } = peer;
      try {
        if (failure === "server-proof") {
          peer.serverProof[0] ^= 1;
          Assert.throws(
            () => verifyPeer(peer, useBase64),
            error => error.code === "pairing-failed"
          );
        } else {
          verifyPeer(peer, useBase64);
          let reply = await encryptedReply(key);
          if (failure === "replay") {
            await session.decryptJSON(wire(reply, useBase64));
          } else {
            reply[16] ^= 1;
          }
          await Assert.rejects(
            session.decryptJSON(wire(reply, useBase64)),
            error => error.code === "protocol-error"
          );
        }
        Assert.ok(!session.isVerified);
        await Assert.rejects(
          session.encryptJSON({}),
          error => error.code === "locked",
          "A failed proof, corrupt ciphertext or replay destroys the session"
        );
      } finally {
        session.destroy();
      }
    }
  }
});
