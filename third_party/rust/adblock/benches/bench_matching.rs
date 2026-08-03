use criterion::*;

use serde::{Deserialize, Serialize};

use adblock::Engine;
use adblock::request::Request;
use adblock::url_parser::parse_url;

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

#[allow(non_snake_case)]
#[derive(Serialize, Deserialize, Clone)]
struct TestRequest {
    frameUrl: String,
    url: String,
    cpt: String,
}

impl From<&TestRequest> for Request {
    fn from(v: &TestRequest) -> Self {
        Request::new(&v.url, &v.frameUrl, &v.cpt, "").unwrap()
    }
}

fn load_requests() -> Vec<TestRequest> {
    let requests_str = rules_from_lists(["data/requests.json"]);
    let reqs: Vec<TestRequest> = requests_str
        .lines()
        .map(serde_json::from_str)
        .filter_map(Result::ok)
        .collect();
    reqs
}

fn bench_rule_matching(engine: &Engine, requests: &[TestRequest]) -> (u32, u32) {
    let mut matches = 0;
    let mut passes = 0;
    requests.iter().for_each(|r| {
        let res = engine.check_network_request(&r.into());
        if res.should_block() {
            matches += 1;
        } else {
            passes += 1;
        }
    });
    // println!("Got {} matches, {} passes, {} errors", matches, passes, errors);
    (matches, passes)
}

fn bench_matching_only(engine: &Engine, requests: &[Request]) -> (u32, u32) {
    let mut matches = 0;
    let mut passes = 0;
    requests.iter().for_each(|parsed| {
        let check = engine.check_network_request(parsed);
        if check.should_block() {
            matches += 1;
        } else {
            passes += 1;
        }
    });
    // println!("Got {} matches, {} passes", matches, passes);
    (matches, passes)
}

type ParsedRequest = (String, String, String, String, bool);

fn bench_rule_matching_browserlike(blocker: &Engine, requests: &[ParsedRequest]) -> (u32, u32) {
    let mut matches = 0;
    let mut passes = 0;
    requests.iter().for_each(
        |(url, hostname, source_hostname, request_type, third_party)| {
            let check = blocker.check_network_request(&Request::preparsed(
                url,
                hostname,
                source_hostname,
                request_type,
                *third_party,
                "",
            ));
            if check.should_block() {
                matches += 1;
            } else {
                passes += 1;
            }
        },
    );
    // println!("Got {} matches, {} passes", matches, passes);
    (matches, passes)
}

fn rule_match(c: &mut Criterion) {
    let mut group = c.benchmark_group("rule-match");

    let requests = load_requests();
    let elep_req = requests.clone();
    let el_req = requests.clone();
    let slim_req = requests.clone();
    let requests_len = requests.len() as u64;

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("el+ep", move |b| {
        let rules = rules_from_lists([
            "data/easylist.to/easylist/easylist.txt",
            "data/easylist.to/easylist/easyprivacy.txt",
        ]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching(&engine, &elep_req))
    });
    group.bench_function("easylist", move |b| {
        let rules = rules_from_lists(["data/easylist.to/easylist/easylist.txt"]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching(&engine, &el_req))
    });
    group.bench_function("slimlist", move |b| {
        let rules = rules_from_lists(["data/slim-list.txt"]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching(&engine, &slim_req))
    });

    group.finish();
}

fn rule_match_parsed_el(c: &mut Criterion) {
    let mut group = c.benchmark_group("rule-match-parsed");

    let rules = rules_from_lists(["data/easylist.to/easylist/easylist.txt"]);
    let requests = load_requests();
    let requests_parsed: Vec<_> = requests
        .into_iter()
        .map(|r| Request::new(&r.url, &r.frameUrl, &r.cpt, ""))
        .filter_map(Result::ok)
        .collect();
    let requests_len = requests_parsed.len() as u64;
    let engine = Engine::new_with_list_text(rules);

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("easylist", move |b| {
        b.iter(|| bench_matching_only(&engine, &requests_parsed))
    });

    group.finish();
}

fn rule_match_parsed_elep_slimlist(c: &mut Criterion) {
    let mut group = c.benchmark_group("rule-match-parsed");

    let full_rules = rules_from_lists([
        "data/easylist.to/easylist/easylist.txt",
        "data/easylist.to/easylist/easyprivacy.txt",
    ]);
    let engine = Engine::new_with_list_text(full_rules);

    let requests = load_requests();
    let requests_parsed: Vec<_> = requests
        .into_iter()
        .map(|r| Request::new(&r.url, &r.frameUrl, &r.cpt, ""))
        .filter_map(Result::ok)
        .collect();
    let requests_len = requests_parsed.len() as u64;

    let slim_rules = rules_from_lists(["data/slim-list.txt"]);
    let slim_engine = Engine::new_with_list_text(slim_rules);

    let requests_copy = load_requests();
    let requests_parsed_copy: Vec<_> = requests_copy
        .into_iter()
        .map(|r| Request::new(&r.url, &r.frameUrl, &r.cpt, ""))
        .filter_map(Result::ok)
        .collect();

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("el+ep", move |b| {
        b.iter(|| bench_matching_only(&engine, &requests_parsed))
    });
    group.bench_function("slimlist", move |b| {
        b.iter(|| bench_matching_only(&slim_engine, &requests_parsed_copy))
    });

    group.finish();
}

fn rule_match_browserlike_comparable(c: &mut Criterion) {
    let mut group = c.benchmark_group("rule-match-browserlike");

    let requests = load_requests();
    let requests_len = requests.len() as u64;

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    fn requests_parsed(requests: &[TestRequest]) -> Vec<(String, String, String, String, bool)> {
        requests
            .iter()
            .map(|r| {
                let url_norm = r.url.to_ascii_lowercase();
                let source_url_norm = r.frameUrl.to_ascii_lowercase();

                let maybe_parsed_url = parse_url(&url_norm);
                if maybe_parsed_url.is_none() {
                    return Err("bad url");
                }
                let parsed_url = maybe_parsed_url.unwrap();

                let maybe_parsed_source = parse_url(&source_url_norm);

                if let Some(parsed_source) = maybe_parsed_source {
                    Ok((
                        parsed_url.url.to_owned(),
                        parsed_url.hostname().to_owned(),
                        parsed_source.hostname().to_owned(),
                        r.cpt.clone(),
                        parsed_source.domain() != parsed_url.domain(),
                    ))
                } else {
                    Ok((
                        parsed_url.url.to_owned(),
                        parsed_url.hostname().to_owned(),
                        "".to_owned(),
                        r.cpt.clone(),
                        true,
                    ))
                }
            })
            .filter_map(Result::ok)
            .collect::<Vec<_>>()
    }

    let requests = requests_parsed(&requests);

    group.bench_function("el+ep", |b| {
        let rules = rules_from_lists([
            "data/easylist.to/easylist/easylist.txt",
            "data/easylist.to/easylist/easyprivacy.txt",
        ]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching_browserlike(&engine, &requests))
    });
    group.bench_function("el", |b| {
        let rules = rules_from_lists(["data/easylist.to/easylist/easylist.txt"]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching_browserlike(&engine, &requests))
    });
    group.bench_function("slimlist", |b| {
        let rules = rules_from_lists(["data/slim-list.txt"]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching_browserlike(&engine, &requests))
    });
    group.bench_function("brave-list", |b| {
        let rules = rules_from_lists(["data/brave/brave-main-list.txt"]);
        let engine = Engine::new_with_list_text(rules);
        b.iter(|| bench_rule_matching_browserlike(&engine, &requests))
    });

    group.finish();
}

fn rule_match_first_request(c: &mut Criterion) {
    let mut group = c.benchmark_group("rule-match-first-request");

    group.sample_size(10);

    let requests: Vec<ParsedRequest> = vec![(
        "https://example.com".to_string(),
        "example.com".to_string(),
        "example.com".to_string(),
        "document".to_string(),
        false,
    )];

    group.bench_function("brave-list", |b| {
        b.iter_custom(|iters| {
            let mut total_time = std::time::Duration::ZERO;
            for _ in 0..iters {
                let rules = rules_from_lists(["data/brave/brave-main-list.txt"]);
                let engine = Engine::new_with_list_text(rules);

                // Measure only the matching time, skip setup and destruction
                let start_time = std::time::Instant::now();
                bench_rule_matching_browserlike(&engine, &requests);
                total_time += start_time.elapsed();
            }
            total_time
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    rule_match,
    rule_match_parsed_el,
    rule_match_parsed_elep_slimlist,
    rule_match_browserlike_comparable,
    rule_match_first_request,
);
criterion_main!(benches);
