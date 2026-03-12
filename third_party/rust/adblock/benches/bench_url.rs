use criterion::*;

use serde::{Deserialize, Serialize};

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

fn load_requests() -> Vec<TestRequest> {
    rules_from_lists(&["data/requests.json"])
        .map(|r| serde_json::from_str(&r))
        .filter_map(Result::ok)
        .collect::<Vec<_>>()
}

fn request_parsing_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("throughput-request");

    let requests = load_requests();
    let requests_len = requests.len() as u64;

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("create", move |b| {
        b.iter(|| {
            let mut successful = 0;
            requests.iter().for_each(|r| {
                let req: Result<Request, _> = Request::new(&r.url, &r.frameUrl, &r.cpt);
                if req.is_ok() {
                    successful += 1;
                }
            })
        })
    });

    group.finish();
}

fn request_extract_hostname(c: &mut Criterion) {
    let mut group = c.benchmark_group("throughput-request");

    let requests = load_requests();
    let requests_len = requests.len() as u64;

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("hostname+domain extract", move |b| {
        b.iter(|| {
            let mut successful = 0;
            requests.iter().for_each(|r| {
                if parse_url(&r.url).is_some() {
                    successful += 1;
                }
                if parse_url(&r.frameUrl).is_some() {
                    successful += 1;
                }
            });
        })
    });

    group.finish();
}

fn request_new_throughput(c: &mut Criterion) {
    let mut group = c.benchmark_group("throughput-request");

    let requests = load_requests();
    let requests_len = requests.len() as u64;

    group.throughput(Throughput::Elements(requests_len));
    group.sample_size(10);

    group.bench_function("new", move |b| {
        b.iter(|| {
            let mut successful = 0;
            requests.iter().for_each(|r| {
                Request::new(&r.url, &r.frameUrl, &r.cpt).ok();
                successful += 1;
            });
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    request_new_throughput,
    request_extract_hostname,
    request_parsing_throughput
);
criterion_main!(benches);
