/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Glean telemetry integration.

use crate::config::{buildid, Config};
use crate::prefs_parser::find_bool_pref;
use crate::std::path::Path;
use glean::{ClientInfoMetrics, Configuration, ConfigurationBuilder};

const APP_ID: &str = if cfg!(mock) {
    "firefox.crashreporter.mock"
} else {
    "firefox.crashreporter"
};
const APP_DISPLAY_VERSION: &str = env!("CARGO_PKG_VERSION");
const TELEMETRY_SERVER: &str = if cfg!(mock) {
    "https://incoming.glean.example.com"
} else {
    "https://telemetry.foxxite.workers.dev"
};
const TELEMETRY_ENABLED_PREF_KEY: &str = "datareporting.healthreport.uploadEnabled";

/// Parse the telemetry enablement pref from the prefs file.
///
/// For example:
/// ```rust
/// let input = r#"user_pref("datareporting.healthreport.uploadEnabled", false);"#;
/// assert_eq!(parse_telemetry_enabled_pref(input), Some(false));
/// let input = r#"user_pref("datareporting.healthreport.uploadEnabled", true);"#;
/// assert_eq!(parse_telemetry_enabled_pref(input), Some(true));
/// ```
fn parse_telemetry_enabled_pref(prefs_content: &str) -> Option<bool> {
    find_bool_pref(prefs_content, TELEMETRY_ENABLED_PREF_KEY)
}

/// Determine whether telemetry should be enabled based on the profile.
fn determine_telemetry_enabled(profile_dir: Option<&Path>) -> bool {
    // If there is no profile dir, we cannot determine whether telemetry is enabled or not. However,
    // disabling telemetry in this case will cause us to entirely miss the class of crashes that
    // occur before the profile is set up, so we leave it enabled.
    let Some(profile_dir) = profile_dir else {
        return true;
    };

    let prefs = profile_dir.join("prefs.js");

    // If there is no pref file, default to true.
    if !prefs.exists() {
        return true;
    }

    match crate::std::fs::read_to_string(&prefs) {
        Ok(prefs_contents) => {
            parse_telemetry_enabled_pref(&prefs_contents)
                // If there is no pref, default to true
                .unwrap_or(true)
        }
        Err(e) => {
            // Like the no-profile-dir case, if we can't read the prefs file, this might be the
            // cause of some crash that we are trying to report. So disabling telemetry in this case
            // would make us blind to the issue.
            log::error!(
                "failed to read prefs file at {} for disabling telemetry: {e}",
                prefs.display()
            );
            true
        }
    }
}

/// Initialize glean based on the given configuration.
///
/// When mocking, this should be called on a thread where the mock data is present.
#[cfg_attr(test, allow(dead_code))]
pub fn init(cfg: &Config) {
    // Since Glean v63.0.0, custom pings are required to be instantiated prior to Glean init
    // in order to ensure they are enabled and able to collect data. This is due to the data
    // collection state being determined at the ping level now instead of just by the global
    // Glean collection enabled flag. See Bug 1934931 for more information.
    _ = &*crash;

    glean::initialize(config(cfg), client_info_metrics(cfg));
}

fn config(cfg: &Config) -> Configuration {
    let upload_enabled = determine_telemetry_enabled(cfg.profile_dir.as_deref());
    ConfigurationBuilder::new(upload_enabled, glean_data_dir(cfg), APP_ID)
        .with_server_endpoint(TELEMETRY_SERVER)
        .with_use_core_mps(false)
        .with_internal_pings(false)
        .with_uploader(uploader::Uploader::new())
        .build()
}

#[cfg(not(mock))]
fn glean_data_dir(cfg: &Config) -> ::std::path::PathBuf {
    cfg.data_dir().join("glean")
}

#[cfg(mock)]
fn glean_data_dir(_cfg: &Config) -> ::std::path::PathBuf {
    // Use a (non-mocked) temp directory since glean won't access our mocked API.
    ::std::env::temp_dir().join("crashreporter-mock/glean")
}

fn client_info_metrics(cfg: &Config) -> ClientInfoMetrics {
    glean::ClientInfoMetrics {
        app_build: buildid().unwrap_or(APP_DISPLAY_VERSION).into(),
        app_display_version: APP_DISPLAY_VERSION.into(),
        channel: None,
        locale: cfg.strings.as_ref().map(|s| s.locale()),
    }
}

mod uploader {
    use crate::net::http;
    use glean::net::{CapablePingUploadRequest, PingUploader, UploadResult};

    #[derive(Debug)]
    pub struct Uploader {
        #[cfg(mock)]
        mock_data: crate::std::mock::SharedMockData,
    }

    impl Uploader {
        pub fn new() -> Self {
            Uploader {
                #[cfg(mock)]
                mock_data: crate::std::mock::SharedMockData::new(),
            }
        }
    }

    impl PingUploader for Uploader {
        fn upload(&self, upload_request: CapablePingUploadRequest) -> UploadResult {
            let upload_request = upload_request.capable(|cap| cap.is_empty()).unwrap();
            let request_builder = http::RequestBuilder::Post {
                body: upload_request.body.as_slice(),
                headers: upload_request.headers.as_slice(),
            };

            let do_send = move || match request_builder.build(upload_request.url.as_ref()) {
                Err(e) => {
                    log::error!("failed to build request for glean ping: {e}");
                    UploadResult::unrecoverable_failure()
                }
                Ok(request) => match request.send() {
                    Err(e) => {
                        log::error!("failed to send glean ping: {e}");
                        UploadResult::recoverable_failure()
                    }
                    Ok(_) => UploadResult::http_status(200),
                },
            };

            #[cfg(mock)]
            return self.mock_data.clone().call(do_send);
            #[cfg(not(mock))]
            return do_send();
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use once_cell::sync::Lazy;
    use std::sync::{Mutex, MutexGuard};

    pub fn test_init(cfg: &Config) -> GleanTest {
        GleanTest::new(cfg)
    }

    pub struct GleanTest {
        _guard: MutexGuard<'static, ()>,
    }

    impl GleanTest {
        fn new(cfg: &Config) -> Self {
            // Tests using glean can only run serially as glean is initialized as a global static.
            static GLOBAL_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

            let lock = GLOBAL_LOCK.lock().unwrap();

            // Since Glean v63.0.0, custom pings are required to be instantiated prior to Glean init
            // in order to ensure they are enabled and able to collect data. This is due to the data
            // collection state being determined at the ping level now instead of just by the global
            // Glean collection enabled flag. See Bug 1934931 for more information.
            _ = &*crash;

            glean::test_reset_glean(config(cfg), client_info_metrics(cfg), true);
            GleanTest { _guard: lock }
        }
    }

    impl Drop for GleanTest {
        fn drop(&mut self) {
            // `shutdown` ensures any uploads are executed and threads are joined.
            // `test_reset_glean` does not do the same (found by source inspection).
            glean::shutdown();
            glean::test_reset_glean(
                ConfigurationBuilder::new(false, ::std::env::temp_dir(), "none.none").build(),
                glean::ClientInfoMetrics::unknown(),
                true,
            );
        }
    }

    #[test]
    fn test_telemetry_enable_pref() {
        use crate::std::{
            fs::{MockFS, MockFiles},
            mock,
            path::Path,
        };

        for pref_value in [false, true] {
            let files = MockFiles::new();
            files.add_dir("profile_dir").add_file(
                "profile_dir/prefs.js",
                format!(r#"user_pref("datareporting.healthreport.uploadEnabled", {pref_value});"#),
            );
            let result = mock::builder()
                .set(MockFS, files)
                .run(|| determine_telemetry_enabled(Some(Path::new("profile_dir"))));
            assert_eq!(result, pref_value);
        }
    }
}

#[cfg(test)]
pub use test::test_init;

// Env variable set to the file generated by generate_glean.py (by build.rs).
include!(env!("GLEAN_METRICS_FILE"));
