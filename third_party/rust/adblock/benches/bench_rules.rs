use criterion::*;
use std::sync::LazyLock;

use adblock::Engine;

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

static DEFAULT_LISTS: LazyLock<String> =
    LazyLock::new(|| rules_from_lists(["data/easylist.to/easylist/easylist.txt"]));

fn bench_string_hashing(filters: &str) -> adblock::utils::Hash {
    let mut dummy: adblock::utils::Hash = 0;
    for filter in filters.lines() {
        dummy = (dummy + adblock::utils::fast_hash(filter)) % 1000000000;
    }
    dummy
}

fn bench_string_tokenize(filters: &str) -> usize {
    let mut dummy: usize = 0;
    for filter in filters.lines() {
        dummy = (dummy + adblock::utils::tokenize(filter).len()) % 1000000000;
    }
    dummy
}

fn string_hashing(c: &mut Criterion) {
    let mut group = c.benchmark_group("string-hashing");

    group.throughput(Throughput::Elements(1));

    group.bench_function("hash", move |b| {
        b.iter(|| bench_string_hashing(&DEFAULT_LISTS))
    });

    group.finish();
}

fn string_tokenize(c: &mut Criterion) {
    let mut group = c.benchmark_group("string-tokenize");

    group.throughput(Throughput::Elements(1));

    group.bench_function("tokenize", move |b| {
        b.iter(|| bench_string_tokenize(&DEFAULT_LISTS))
    });

    group.finish();
}

fn bench_parsing_impl(lists: &str) -> usize {
    let (network_filters, _) =
        adblock::lists::parse_filters(lists.lines(), false, Default::default());
    network_filters.len() % 1000000
}

fn list_parse(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse-filters");

    group.throughput(Throughput::Elements(1));
    group.sample_size(10);

    group.bench_function("network filters", |b| {
        b.iter(|| bench_parsing_impl(&DEFAULT_LISTS))
    });

    group.bench_function("all filters", |b| {
        b.iter(|| bench_parsing_impl(&DEFAULT_LISTS))
    });

    group.finish();
}

fn blocker_new(c: &mut Criterion) {
    let mut group = c.benchmark_group("blocker_new");

    group.throughput(Throughput::Elements(1));
    group.sample_size(10);

    let easylist_rules = rules_from_lists([
        "data/easylist.to/easylist/easylist.txt",
        "data/easylist.to/easylist/easyprivacy.txt",
    ]);
    let brave_list_rules = rules_from_lists(["data/brave/brave-main-list.txt"]);
    let engine = Engine::new_with_list_text(brave_list_rules.clone());
    let engine_serialized = engine.serialize().to_vec();

    group.bench_function("el+ep", move |b| {
        b.iter(|| Engine::new_with_list_text(easylist_rules.clone()))
    });
    group.bench_function("brave-list", move |b| {
        b.iter(|| Engine::new_with_list_text(brave_list_rules.clone()))
    });
    group.bench_function("brave-list-deserialize", move |b| {
        b.iter(|| {
            let mut engine = Engine::default();
            engine.deserialize(&engine_serialized).unwrap();
            engine
        })
    });

    group.finish();
}

criterion_group!(
    benches,
    blocker_new,
    list_parse,
    string_hashing,
    string_tokenize
);
criterion_main!(benches);
