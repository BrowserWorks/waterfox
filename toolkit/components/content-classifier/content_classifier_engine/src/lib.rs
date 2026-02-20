/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::sync::Mutex;

use adblock::Engine;
use cstr::cstr;
use nserror::{nsresult, NS_ERROR_INVALID_ARG, NS_ERROR_SERVICE_NOT_AVAILABLE, NS_OK};
use nsstring::{nsACString, nsCString};
use thin_vec::ThinVec;

use xpcom::interfaces::nsIEffectiveTLDService;

static ETLD_SERVICE: Mutex<Option<xpcom::RefPtr<nsIEffectiveTLDService>>> = Mutex::new(None);

pub struct ContentClassifierFFIEngine {
    engine: Engine,
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_initialize_domain_resolver() -> nsresult {
    let etld_service = match xpcom::get_service::<nsIEffectiveTLDService>(cstr!(
        "@mozilla.org/network/effective-tld-service;1"
    )) {
        Some(s) => s,
        None => return NS_ERROR_SERVICE_NOT_AVAILABLE,
    };
    if let Ok(mut guard) = ETLD_SERVICE.lock() {
        guard.replace(etld_service);
    }
    let resolver = Box::new(SchemelessSiteResolver {});
    let _ = adblock::url_parser::set_domain_resolver(resolver);
    return NS_OK;
}

#[no_mangle]
pub extern "C" fn content_classifier_teardown_domain_resolver() {
    if let Ok(mut guard) = ETLD_SERVICE.lock() {
        guard.take();
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_from_rules(
    rules: &ThinVec<nsCString>,
    out_engine: *mut *mut ContentClassifierFFIEngine,
) -> nsresult {
    if out_engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let rules_vec: Vec<String> = rules
        .iter()
        .map(|r| String::from_utf8_lossy(r.as_ref()).to_string())
        .collect();

    let engine = Engine::from_rules(
        rules_vec,
        adblock::lists::ParseOptions {
            ..adblock::lists::ParseOptions::default()
        },
    );

    let boxed_engine = Box::new(ContentClassifierFFIEngine { engine });
    *out_engine = Box::into_raw(boxed_engine);
    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_destroy(
    engine: *mut ContentClassifierFFIEngine,
) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_check_network_request_preparsed(
    engine: *const ContentClassifierFFIEngine,
    url: &nsACString,
    schemeless_site: &nsACString,
    source_schemeless_site: &nsACString,
    request_type: &nsACString,
    third_party: bool,
    out_matched: *mut bool,
    out_important: *mut bool,
    out_exception: *mut nsCString,
) -> nsresult {
    if engine.is_null() || out_matched.is_null() || out_important.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let engine = &(*engine).engine;

    let url_str = String::from_utf8_lossy(url.as_ref()).to_string();
    let schemeless_site_str = String::from_utf8_lossy(schemeless_site.as_ref()).to_string();
    let source_schemeless_site_str =
        String::from_utf8_lossy(source_schemeless_site.as_ref()).to_string();
    let request_type_str = String::from_utf8_lossy(request_type.as_ref()).to_string();

    let request = adblock::request::Request::preparsed(
        &url_str,
        &schemeless_site_str,
        &source_schemeless_site_str,
        &request_type_str,
        third_party,
    );

    let result = engine.check_network_request(&request);

    *out_matched = result.matched;
    *out_important = result.important;

    if !out_exception.is_null() {
        if let Some(exception) = result.exception {
            (*out_exception).assign(&exception);
        } else {
            (*out_exception).truncate();
        }
    }

    NS_OK
}

struct SchemelessSiteResolver {}

impl adblock::url_parser::ResolvesDomain for SchemelessSiteResolver {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        let guard = match ETLD_SERVICE.lock() {
            Ok(g) => g,
            Err(_) => return (0, host.len()),
        };
        let etld_service = match guard.as_ref() {
            Some(s) => s,
            None => return (0, host.len()),
        };

        let mut host_cstring = nsCString::new();
        host_cstring.assign(host);

        let mut base_domain = nsCString::new();

        unsafe {
            if etld_service
                .GetBaseDomainFromHost(&*host_cstring, 0, &mut *base_domain)
                .succeeded()
            {
                let base_domain_len = base_domain.len();
                if base_domain_len > 0 && base_domain_len <= host.len() {
                    return (host.len() - base_domain_len, host.len());
                }
            }
        }

        (0, host.len())
    }
}
