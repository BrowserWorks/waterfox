/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function describe(value) {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

function isIterable(value) {
  return (
    value !== null &&
    value !== undefined &&
    typeof value[Symbol.iterator] === "function"
  );
}

function* queryInterfaceIterator(iterable, iface) {
  for (const item of iterable) {
    yield item.QueryInterface(iface);
  }
}

export function toArray(obj) {
  if (isIterable(obj)) {
    return Array.from(obj);
  }

  if (
    typeof obj === "function" &&
    obj.constructor?.name === "GeneratorFunction"
  ) {
    return Array.from(obj());
  }

  throw new Error(`An unsupported object sent to toArray: ${describe(obj)}`);
}

export function fixIterator(enumerator, iface = null) {
  if (isIterable(enumerator)) {
    return iface
      ? queryInterfaceIterator(enumerator, iface)
      : enumerator[Symbol.iterator]();
  }

  if (enumerator instanceof Ci.nsISimpleEnumerator) {
    return (function* () {
      while (enumerator.hasMoreElements()) {
        const item = enumerator.getNext();
        yield iface ? item.QueryInterface(iface) : item;
      }
    })();
  }

  if (enumerator instanceof Ci.nsIArray) {
    const itemInterface = iface ?? Ci.nsISupports;
    return (function* () {
      for (let index = 0; index < enumerator.length; index++) {
        yield enumerator.queryElementAt(index, itemInterface);
      }
    })();
  }

  throw new Error(
    `An unsupported object sent to fixIterator: ${describe(enumerator)}`
  );
}

export function toXPCOMArray(array, iface) {
  if (iface?.equals(Ci.nsIMutableArray)) {
    const mutableArray = Cc["@mozilla.org/array;1"].createInstance(
      Ci.nsIMutableArray
    );
    for (const item of fixIterator(array)) {
      mutableArray.appendElement(item);
    }
    return mutableArray;
  }

  throw new Error(
    `An unsupported interface requested from toXPCOMArray: ${describe(iface)}`
  );
}
