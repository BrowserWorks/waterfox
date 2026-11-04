/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const fixtureResources = Services.io
  .getProtocolHandler("resource")
  .QueryInterface(Ci.nsIResProtocolHandler);
fixtureResources.setSubstitution(
  "icloud-passwords-test",
  Services.io.newFileURI(do_get_file("data"))
);
registerCleanupFunction(() =>
  fixtureResources.setSubstitution("icloud-passwords-test", null)
);
