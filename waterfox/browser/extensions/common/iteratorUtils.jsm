/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * This file contains helper methods for dealing with XPCOM iterators (arrays
 * and enumerators) in JS-friendly ways.
 */

const EXPORTED_SYMBOLS = ["fixIterator", "toXPCOMArray", "toArray"];

var JS_HAS_SYMBOLS = typeof Symbol === "function";
var ITERATOR_SYMBOL = JS_HAS_SYMBOLS ? Symbol.iterator : "@@iterator";

/**
 * This function will take a number of objects and convert them to an array.
 *
 * Currently, we support the following objects:
 *   Anything you can for (let x of aObj) on
 *                (e.g. toArray(fixIterator(enum))[4],
 *                 also a NodeList from element.children)
 *
 * @param aObj        The object to convert
 */
function toArray(aObj) {
  // Iterable object
  if (ITERATOR_SYMBOL in aObj) {
    return Array.from(aObj);
  }

  // New style generator function
  if (
    typeof aObj == "function" &&
    typeof aObj.constructor == "function" &&
    aObj.constructor.name == "GeneratorFunction"
  ) {
    return [...aObj()];
  }

  // We got something unexpected, notify the caller loudly.
  throw new Error(
    "An unsupported object sent to toArray: " +
      ("toString" in aObj ? aObj.toString() : aObj)
  );
}

/**
 * Given a JS array, JS iterator, or one of a variety of XPCOM collections or
 * iterators, return a JS iterator suitable for use in a for...of expression.
 *
 * Currently, we support the following types of XPCOM iterators:
 *   nsIArray
 *   nsISimpleEnumerator
 *
 * Note that old-style JS iterators are explicitly not supported in this
 * method, as they are going away.
 *
 *   @param aEnum  the enumerator to convert
 *   @param aIface (optional) an interface to QI each object to prior to
 *                 returning
 *
 *   @note This returns an object that can be used in 'for...of' loops.
 *         Do not use 'for each...in' or 'for...in'.
 *         This does *not* return an Array object. To create such an array, use
 *         let array = toArray(fixIterator(xpcomEnumerator));
 */
function fixIterator(aEnum, aIface) {
  // If the input is an array, nsISimpleEnumerator or something that sports Symbol.iterator,
  // then the original input is sufficient to directly return. However, if we want
  // to support the aIface parameter, we need to do a lazy version of
  // Array.prototype.map.
  if (
    Array.isArray(aEnum) ||
    aEnum instanceof Ci.nsISimpleEnumerator ||
    ITERATOR_SYMBOL in aEnum
  ) {
    if (!aIface) {
      return aEnum[ITERATOR_SYMBOL]();
    }
    return (function*() {
      for (let o of aEnum) {
        yield o.QueryInterface(aIface);
      }
    })();
  }

  let face = aIface || Ci.nsISupports;
  // Figure out which kind of array object we have.
  // First try nsIArray (covers nsIMutableArray too).
  if (aEnum instanceof Ci.nsIArray) {
    return (function*() {
      let count = aEnum.length;
      for (let i = 0; i < count; i++) {
        yield aEnum.queryElementAt(i, face);
      }
    })();
  }

  // We got something unexpected, notify the caller loudly.
  throw new Error(
    "An unsupported object sent to fixIterator: " +
      ("toString" in aEnum ? aEnum.toString() : aEnum)
  );
}

/**
 * This function takes an Array object and returns an XPCOM array
 * of the desired type. It will *not* work if you extend Array.prototype.
 *
 * @param aArray      the array (anything fixIterator supports) to convert to an XPCOM array
 * @param aInterface  the type of XPCOM array to convert
 *
 * @note The returned array is *not* dynamically updated.  Changes made to the
 *       JS array after a call to this function will not be reflected in the
 *       XPCOM array.
 */
function toXPCOMArray(aArray, aInterface) {
  if (aInterface.equals(Ci.nsIMutableArray)) {
    let mutableArray = Cc["@mozilla.org/array;1"].createInstance(
      Ci.nsIMutableArray
    );
    for (let item of fixIterator(aArray)) {
      mutableArray.appendElement(item);
    }
    return mutableArray;
  }

  // We got something unexpected, notify the caller loudly.
  throw new Error(
    "An unsupported interface requested from toXPCOMArray: " + aInterface
  );
}
