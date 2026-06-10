/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use std::sync::Mutex;

use adblock::{lists::FilterSet, resources::Resource, Engine};
use cstr::cstr;
use nserror::{
    nsresult, NS_ERROR_FAILURE, NS_ERROR_INVALID_ARG, NS_ERROR_SERVICE_NOT_AVAILABLE, NS_OK,
};
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

    let list_text = rules.iter().fold(String::new(), |mut list, rule| {
        list.push_str(&String::from_utf8_lossy(rule.as_ref()));
        list.push('\n');
        list
    });
    let mut filter_set = FilterSet::new(false);
    filter_set.add_filter_list(list_text, adblock::lists::ParseOptions::default());
    let engine = Engine::new_with_filter_set(filter_set);

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
    request_method: &nsACString,
    third_party: bool,
    previously_matched_rule: bool,
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
    let request_method_str = String::from_utf8_lossy(request_method.as_ref()).to_string();

    let request = adblock::request::Request::preparsed(
        &url_str,
        &schemeless_site_str,
        &source_schemeless_site_str,
        &request_type_str,
        third_party,
        &request_method_str,
    );

    let result = engine.check_network_request_subset(&request, previously_matched_rule, false);

    *out_matched = result.should_block();
    *out_important = result.important;

    if !out_exception.is_null() {
        if let Some(exception) = result.exception {
            (*out_exception).assign(&exception.to_string());
        } else {
            (*out_exception).truncate();
        }
    }

    NS_OK
}

/// Request check for the Waterfox blocker that also reports redirect and
/// rewrite directives. Kept separate from the function above so upstream can
/// reshape its own check without touching the blocker path.
#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_check_network_request_preparsed_detailed(
    engine: *const ContentClassifierFFIEngine,
    url: &nsACString,
    hostname: &nsACString,
    source_hostname: &nsACString,
    request_type: &nsACString,
    request_method: &nsACString,
    third_party: bool,
    out_matched: *mut bool,
    out_important: *mut bool,
    out_redirect: *mut nsCString,
    out_rewritten_url: *mut nsCString,
    out_exception: *mut nsCString,
) -> nsresult {
    if engine.is_null() || out_matched.is_null() || out_important.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let engine = &(*engine).engine;

    let url_str = String::from_utf8_lossy(url.as_ref()).to_string();
    let hostname_str = String::from_utf8_lossy(hostname.as_ref()).to_string();
    let source_hostname_str = String::from_utf8_lossy(source_hostname.as_ref()).to_string();
    let request_type_str = String::from_utf8_lossy(request_type.as_ref()).to_string();
    let request_method_str = String::from_utf8_lossy(request_method.as_ref()).to_string();

    let request = adblock::request::Request::preparsed(
        &url_str,
        &hostname_str,
        &source_hostname_str,
        &request_type_str,
        third_party,
        &request_method_str,
    );

    // Exceptions land in separate lists from the rules they relax, so force
    // exception checks the same way the function above does.
    let result = engine.check_network_request_subset(&request, false, true);

    *out_matched = result.should_block();
    *out_important = result.important;

    if !out_redirect.is_null() {
        if let Some(redirect) = result.redirect.as_deref() {
            (*out_redirect).assign(redirect);
        } else {
            (*out_redirect).truncate();
        }
    }

    if !out_rewritten_url.is_null() {
        if let Some(rewritten_url) = result.rewritten_url.as_deref() {
            (*out_rewritten_url).assign(rewritten_url);
        } else {
            (*out_rewritten_url).truncate();
        }
    }

    if !out_exception.is_null() {
        if let Some(exception) = result.exception {
            (*out_exception).assign(&exception.to_string());
        } else {
            (*out_exception).truncate();
        }
    }

    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_get_csp_directives_preparsed(
    engine: *const ContentClassifierFFIEngine,
    url: &nsACString,
    hostname: &nsACString,
    source_hostname: &nsACString,
    request_type: &nsACString,
    request_method: &nsACString,
    third_party: bool,
    out_directives: *mut nsCString,
) -> nsresult {
    if engine.is_null() || out_directives.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let engine = &(*engine).engine;

    let url_str = String::from_utf8_lossy(url.as_ref()).to_string();
    let hostname_str = String::from_utf8_lossy(hostname.as_ref()).to_string();
    let source_hostname_str = String::from_utf8_lossy(source_hostname.as_ref()).to_string();
    let request_type_str = String::from_utf8_lossy(request_type.as_ref()).to_string();
    let request_method_str = String::from_utf8_lossy(request_method.as_ref()).to_string();

    let request = adblock::request::Request::preparsed(
        &url_str,
        &hostname_str,
        &source_hostname_str,
        &request_type_str,
        third_party,
        &request_method_str,
    );

    if let Some(directives) = engine.get_csp_directives(&request) {
        (*out_directives).assign(&directives);
    } else {
        (*out_directives).truncate();
    }

    NS_OK
}

/// `$replace=` requires adblock-rs support that is not part of the vendored
/// crate. Keep the FFI surface stable for the Waterfox blocker service, but
/// report no native directives unless the vendored engine grows them.
#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_get_replace_directives_preparsed(
    engine: *const ContentClassifierFFIEngine,
    _url: &nsACString,
    _hostname: &nsACString,
    _source_hostname: &nsACString,
    _request_type: &nsACString,
    _request_method: &nsACString,
    _third_party: bool,
    out_directives_json: *mut nsCString,
) -> nsresult {
    if engine.is_null() || out_directives_json.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    (*out_directives_json).assign("[]");
    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_serialize(
    engine: *const ContentClassifierFFIEngine,
    out_data: &mut ThinVec<u8>,
) -> nsresult {
    if engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let serialized = (*engine).engine.serialize();
    *out_data = serialized.into();
    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_deserialize(
    out_engine: *mut *mut ContentClassifierFFIEngine,
    data: &ThinVec<u8>,
) -> nsresult {
    if out_engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let mut engine = Engine::default();
    if engine.deserialize(data.as_slice()).is_err() {
        return NS_ERROR_FAILURE;
    }

    let boxed_engine = Box::new(ContentClassifierFFIEngine { engine });
    *out_engine = Box::into_raw(boxed_engine);
    NS_OK
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_url_cosmetic_resources(
    engine: *const ContentClassifierFFIEngine,
    url: &nsACString,
    out_json: &mut nsCString,
) -> nsresult {
    if engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let url_str = String::from_utf8_lossy(url.as_ref()).to_string();
    let resources = (*engine).engine.url_cosmetic_resources(&url_str);

    match serde_json::to_string(&resources) {
        Ok(json) => {
            out_json.assign(&json);
            NS_OK
        }
        Err(_) => NS_ERROR_FAILURE,
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_hidden_class_id_selectors(
    engine: *const ContentClassifierFFIEngine,
    classes_json: &nsACString,
    ids_json: &nsACString,
    exceptions_json: &nsACString,
    out_json: &mut nsCString,
) -> nsresult {
    if engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let classes: Vec<String> = match serde_json::from_slice(classes_json.as_ref()) {
        Ok(v) => v,
        Err(_) => return NS_ERROR_INVALID_ARG,
    };
    let ids: Vec<String> = match serde_json::from_slice(ids_json.as_ref()) {
        Ok(v) => v,
        Err(_) => return NS_ERROR_INVALID_ARG,
    };
    let exceptions: std::collections::HashSet<String> =
        match serde_json::from_slice(exceptions_json.as_ref()) {
            Ok(v) => v,
            Err(_) => return NS_ERROR_INVALID_ARG,
        };

    let selectors = (*engine)
        .engine
        .hidden_class_id_selectors(&classes, &ids, &exceptions);

    match serde_json::to_string(&selectors) {
        Ok(json) => {
            out_json.assign(&json);
            NS_OK
        }
        Err(_) => NS_ERROR_FAILURE,
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_use_resources(
    engine: *mut ContentClassifierFFIEngine,
    resources_json: &nsACString,
) -> nsresult {
    if engine.is_null() {
        return NS_ERROR_INVALID_ARG;
    }

    let resources: Vec<Resource> = match serde_json::from_slice(resources_json.as_ref()) {
        Ok(v) => v,
        Err(_) => return NS_ERROR_INVALID_ARG,
    };

    (*engine).engine.use_resources(resources);
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
