/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["IOUtils"];

var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

var kStringBlockSize = 4096;
var kStreamBlockSize = 8192;

var IOUtils = {
  /**
   * Read a file containing ASCII text into a string.
   *
   * @param aFile  An nsIFile representing the file to read or a string containing
   *               the file name of a file under user's profile.
   * @returns A string containing the contents of the file, presumed to be ASCII
   *          text. If the file didn't exist, returns null.
   */
  loadFileToString(aFile) {
    let file;
    if (!(aFile instanceof Ci.nsIFile)) {
      file = Services.dirsvc.get("ProfD", Ci.nsIFile);
      file.append(aFile);
    } else {
      file = aFile;
    }

    if (!file.exists()) {
      return null;
    }

    let fstream = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
      Ci.nsIFileInputStream
    );
    // PR_RDONLY
    fstream.init(file, 0x01, 0, 0);

    let sstream = Cc["@mozilla.org/scriptableinputstream;1"].createInstance(
      Ci.nsIScriptableInputStream
    );
    sstream.init(fstream);

    let data = "";
    while (sstream.available()) {
      data += sstream.read(kStringBlockSize);
    }

    sstream.close();
    fstream.close();

    return data;
  },

  /**
   * Save a string containing ASCII text into a file. The file will be overwritten
   * and contain only the given text.
   *
   * @param aFile   An nsIFile representing the file to write or a string containing
   *                the file name of a file under user's profile.
   * @param aData   The string to write.
   * @param aPerms  The octal file permissions for the created file. If unset
   *                the default of 0o600 is used.
   */
  saveStringToFile(aFile, aData, aPerms = 0o600) {
    let file;
    if (!(aFile instanceof Ci.nsIFile)) {
      file = Services.dirsvc.get("ProfD", Ci.nsIFile);
      file.append(aFile);
    } else {
      file = aFile;
    }

    let foStream = Cc[
      "@mozilla.org/network/safe-file-output-stream;1"
    ].createInstance(Ci.nsIFileOutputStream);

    // PR_WRONLY + PR_CREATE_FILE + PR_TRUNCATE
    foStream.init(file, 0x02 | 0x08 | 0x20, aPerms, 0);
    // safe-file-output-stream appears to throw an error if it doesn't write everything at once
    // so we won't worry about looping to deal with partial writes.
    // In case we try to use this function for big files where buffering
    // is needed we could use the implementation in saveStreamToFile().
    foStream.write(aData, aData.length);
    foStream.QueryInterface(Ci.nsISafeOutputStream).finish();
    foStream.close();
  },

  /**
   * Saves the given input stream to a file.
   *
   * @param aIStream The input stream to save.
   * @param aFile    The file to which the stream is saved.
   * @param aPerms   The octal file permissions for the created file. If unset
   *                 the default of 0o600 is used.
   */
  saveStreamToFile(aIStream, aFile, aPerms = 0o600) {
    if (!(aIStream instanceof Ci.nsIInputStream)) {
      throw new Error("Invalid stream passed to saveStreamToFile");
    }
    if (!(aFile instanceof Ci.nsIFile)) {
      throw new Error("Invalid file passed to saveStreamToFile");
    }

    let fstream = Cc[
      "@mozilla.org/network/safe-file-output-stream;1"
    ].createInstance(Ci.nsIFileOutputStream);
    let buffer = Cc[
      "@mozilla.org/network/buffered-output-stream;1"
    ].createInstance(Ci.nsIBufferedOutputStream);

    // Write the input stream to the file.
    // PR_WRITE + PR_CREATE + PR_TRUNCATE
    fstream.init(aFile, 0x04 | 0x08 | 0x20, aPerms, 0);
    buffer.init(fstream, kStreamBlockSize);

    buffer.writeFrom(aIStream, aIStream.available());

    // Close the output streams.
    if (buffer instanceof Ci.nsISafeOutputStream) {
      buffer.finish();
    } else {
      buffer.close();
    }
    if (fstream instanceof Ci.nsISafeOutputStream) {
      fstream.finish();
    } else {
      fstream.close();
    }

    // Close the input stream.
    aIStream.close();
    return aFile;
  },

  /**
   * Returns size of system memory.
   */
  getPhysicalMemorySize() {
    return Services.sysinfo.getPropertyAsInt64("memsize");
  },
};
