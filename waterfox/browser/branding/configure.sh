# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

MOZ_APP_DISPLAYNAME=Waterfox
MOZ_APP_NAME=Waterfox
MOZ_APP_PROFILE=Waterfox
MOZ_APP_VENDOR="WaterfoxLimited"
MOZ_DISTRIBUTION_ID=net.waterfox
MOZ_INCLUDE_SOURCE_INFO=1
MOZ_REQUIRE_SIGNING=
MOZ_APP_REMOTINGNAME=waterfox-default
MOZ_TELEMETRY_REPORTING=

if test "$MOZ_UPDATE_CHANNEL" = "beta"; then
  # Official beta builds
  MOZ_ASYNCIHANDLERCONTROL_IID="d4d2d920-5d8d-46b0-8169-6c75518fd6e8"
  MOZ_HANDLER_CLSID="bb83e31f-4bed-47ec-9edb-cd328ce4c65a"
  MOZ_IGECKOBACKCHANNEL_IID="3248b994-9ae6-4eb6-81c7-f50c95ad9e9d"
  MOZ_IHANDLERCONTROL_IID="eced8a70-3d19-4d40-b4eb-726231285528"
else
  # Official release/esr builds
  MOZ_ASYNCIHANDLERCONTROL_IID="fb2703de-e41b-4565-a50b-777f44879c65"
  MOZ_HANDLER_CLSID="af069df1-ed1c-4994-9097-8c033d09539c"
  MOZ_IGECKOBACKCHANNEL_IID="6f2c203c-73b4-4f74-8a79-1e99202815e3"
  MOZ_IHANDLERCONTROL_IID="713883ba-0f4e-481e-823e-e1cb9a7a283c"
fi
