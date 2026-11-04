/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  encodeApplePasswordHandshake,
  decodeApplePasswordHandshake,
} from "resource:///modules/ApplePasswordCrypto.sys.mjs";

// Expected SRP results calculated with Python hashlib/pow.
export const SRP_VECTOR = Object.freeze({
  A: "6e08063dfd1a6bbfc6422fe2f5209c65cddc53c28a93df8dc9ffe34cf4d873fd86e9c24ac84f1c3d5d73a6bd640636923360a0cc2b5b4f82933238b9b3e691648b37077c944dc502b789642efccb565de76a54f73c2a2a9284af59b29c8eea47434d62c67699b4072b08d287df798ee6186f467cf6a8bcb90d64be509d979d1d8643945f16412f940a48dd68b42782d0ab7e486de6d72c84ab3fe49c9bb7e071ce0b60e9bf4c4925e5184f5a4b9ad09e2f3d0676dcf5b057821b44f7f172962c12d23d57ddea9ed9acbb945a9ccd6a36f49d15f591004ad8ece7e147ace5c7e0db8d13fdc7baa737d875ae518d08f6b3ae5a703472fdfe1d2459a79e33a46a615bbc24ad7069e5ac2c5ae10b8a6a296e052ac49174e7730ed1b7225eed43d8b82c28d7aa4d06826de2768b3a434719363d6a4e2fea50fa62dc5d02a64c0c1aefd0fe664476b1f7da1e329db6da7dfb395be32611a5423c74a8fff54d7a33642e87a5723df5985cada6d9af2cc1e71af17c1b00858526a3df0b866fcb67dc6307",
  B: "b5b10295f591bcf57ee187732235192b773bd4043572e82b542ea185f49dd4e4c4689f47d33492feb931782e74cd0ca3d1c3f15a4766951b67df9a9d3fbc72018b42cd51f1298e0c2184d7974608a2a6ef84dc71761e4debe5d9f01b4068fc65b83c2392f1340bc3eeafa6d05f6cd9be567d13ea3e1706682d611fc511df3d58101adfb0d7b7762a57f2ba76b52b19fa9e7176a033d89195e8d833bb652dce549bc3ab79d00f196d4be0d464b49313d61d1ba662c882041f81983349e5d9bd4b8504eb341f73dea70d9d18329f6e462908a97b02228e6560affce5a992db86377a87990538f3fea6e2c599ce76ed888c89447c047230865650625b7f6897f9f3ab9265d530f2722509be73863bc8d8ba57046d907249ca395171a9749d365a1885cc46e4f592c9b098e8a37ee89a6464843cb484b65813ee786c0aa50d2f5a734326b6951c5a1868d2cabf655e23f33e30fd9d08a913ed7024e3224b9cd2750231c6a13e41a626bd408c67c62b0f22c78462a05c539c7571ea859eda43d4d257",
  salt: "00000102030405060708090a0b0c0d0e0f",
  M: "336bf27bd5f9ac6de410abdd5a5c175b8cccdc4d3015e4d4f0f99dd04f91f33f",
  HAMK: "bce02a068203e15b6d9bdeec3cfa7dd70f85865fc9cd52961fca199f510df36b",
  key: "70f5aaad63753a6c7436edcbc492956d",
});

export function fromHex(text) {
  return Uint8Array.from(text.replace(/^0x/, "").match(/../g), part =>
    parseInt(part, 16)
  );
}
export function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
export function deterministicRandom() {
  let call = 0;
  return size => {
    let start = call++ * 16;
    return Uint8Array.from({ length: size }, (_, i) => (start + i) & 255);
  };
}

export function encodeNativeMessage(message) {
  let bytes = new TextEncoder().encode(JSON.stringify(message));
  let frame = new Uint8Array(4 + bytes.length);
  frame.set(new Uint8Array(Uint32Array.of(bytes.length).buffer));
  frame.set(bytes, 4);
  return frame;
}

/** Uses JSON without encryption; cryptography is tested separately. */
export class FakeCrypto {
  tid = "synthetic-session";
  isVerified = false;
  clientHello() {
    return { TID: this.tid, MSG: 0 };
  }
  acceptServerHello(value) {
    if (value.MSG !== 1) {
      throw new Error("Synthetic handshake mismatch");
    }
  }
  async clientProof() {
    return { TID: this.tid, MSG: 2 };
  }
  verifyServerProof(value) {
    this.isVerified = value.HAMK === "fake-proof";
  }
  async encryptJSON(value) {
    return JSON.stringify(value);
  }
  async decryptJSON(value) {
    return JSON.parse(value);
  }
  destroy() {
    this.isVerified = false;
  }
}

/** Reassembles fragmented host output for reads of a requested size. */
class BytePipe {
  data = new Uint8Array();
  reader;
  feed(bytes) {
    let data = new Uint8Array(this.data.length + bytes.length);
    data.set(this.data);
    data.set(bytes, this.data.length);
    this.data = data;
    this.flush();
  }
  flush() {
    if (this.reader && this.data.length >= this.reader.length) {
      let { length, resolve } = this.reader;
      this.reader = null;
      let result = this.data.slice(0, length).buffer;
      this.data = this.data.slice(length);
      resolve(result);
    }
  }
  read(length) {
    return new Promise((resolve, reject) => {
      this.reader = { length, resolve, reject };
      this.flush();
    });
  }
  async readUint32() {
    return new Uint32Array(await this.read(4))[0];
  }
  async readJSON(length) {
    return JSON.parse(new TextDecoder().decode(await this.read(length)));
  }
  close() {
    this.reader?.reject(new Error("Synthetic EOF"));
    this.reader = null;
  }
}

/** Simulates native messaging with framed JSON and fragmented replies. */
export class FakeAppleHost {
  stdout = new BytePipe();
  requests = [];
  closed = false;
  response = {
    STATUS: 0,
    Entries: [{ USR: "test-user", PWD: "synthetic", sites: ["example.test"] }],
  };
  constructor() {
    this.exited = new Promise(resolve => {
      this.resolveExit = resolve;
    });
    this.stdin = { write: frame => this.reply(frame), close() {} };
  }
  reply(frame) {
    let size = new Uint32Array(frame, 0, 1)[0];
    if (size !== frame.byteLength - 4) {
      throw new Error("Synthetic frame length mismatch");
    }
    let message = JSON.parse(
      new TextDecoder().decode(new Uint8Array(frame, 4))
    );
    this.requests.push(message);
    let response;
    if (message.cmd === 14) {
      response = {
        cmd: 14,
        capabilities: { secretSessionVersion: 1, shouldUseBase64: false },
      };
    } else if (message.cmd === 2) {
      let pake = decodeApplePasswordHandshake(message.msg.PAKE);
      response = {
        cmd: 2,
        payload: {
          PAKE: encodeApplePasswordHandshake({
            TID: pake.TID,
            MSG: pake.MSG === 0 ? 1 : 3,
            HAMK: "fake-proof",
          }),
        },
      };
    } else {
      let payload = JSON.parse(message.payload);
      let envelope = JSON.parse(payload.SMSG);
      message.body = JSON.parse(envelope.SDATA);
      response = {
        cmd: message.cmd === 6 ? 4 : message.cmd,
        payload: {
          QID: payload.QID,
          SMSG: { TID: envelope.TID, SDATA: JSON.stringify(this.response) },
        },
      };
    }
    let output = encodeNativeMessage(response);
    this.stdout.feed(output.subarray(0, 2));
    this.stdout.feed(output.subarray(2, 7));
    this.stdout.feed(output.subarray(7));
    return Promise.resolve();
  }
  wait() {
    return this.exited;
  }
  kill() {
    this.closed = true;
    this.stdout.close();
    this.resolveExit({ exitCode: 0 });
  }
}
