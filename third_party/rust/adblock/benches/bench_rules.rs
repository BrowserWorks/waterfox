use criterion::*;
use once_cell::sync::Lazy;

use adblock::{Engine, FilterSet};

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

static DEFAULT_LISTS: Lazy<Vec<String>> =
    Lazy::new(|| rules_from_lists(&["data/easylist.to/easylist/easylist.txt"]).collect());

fn bench_string_hashing(filters: &Vec<String>) -> adblock::utils::Hash {
    let mut dummy: adblock::utils::Hash = 0;
    for filter in filters {
        dummy = (dummy + adblock::utils::fast_hash(filter)) % 1000000000;
    }
    dummy
}

fn bench_string_tokenize(filters: &Vec<String>) -> usize {
    let mut dummy: usize = 0;
    for filter in filters {
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

fn bench_parsing_impl(lists: &Vec<&Vec<String>>) -> usize {
    let mut dummy = 0;

    for list in lists {
        let (network_filters, _) = adblock::lists::parse_filters(*list, false, Default::default());
        dummy += network_filters.len() % 1000000;
    }

    dummy
}

fn list_parse(c: &mut Criterion) {
    let mut group = c.benchmark_group("parse-filters");

    group.throughput(Throughput::Elements(1));
    group.sample_size(10);

    group.bench_function("network filters", |b| {
        b.iter(|| bench_parsing_impl(&vec![DEFAULT_LISTS.as_ref()]))
    });

    group.bench_function("all filters", |b| {
        b.iter(|| bench_parsing_impl(&vec![DEFAULT_LISTS.as_ref()]))
    });

    group.finish();
}

fn get_engine(rules: impl IntoIterator<Item = impl AsRef<str>>) -> Engine {
    let (network_filters, cosmetic_filters) =
        adblock::lists::parse_filters(rules, false, Default::default());

    Engine::from_filter_set(
        FilterSet::new_with_rules(network_filters, cosmetic_filters, false),
        true,
    )
}

fn blocker_new(c: &mut Criterion) {
    let mut group = c.benchmark_group("blocker_new");

    group.throughput(Throughput::Elements(1));
    group.sample_size(10);

    let easylist_rules: Vec<_> = rules_from_lists(&[
        "data/easylist.to/easylist/easylist.txt",
        "data/easylist.to/easylist/easyprivacy.txt",
    ])
    .collect();
    let brave_list_rules: Vec<_> = rules_from_lists(&["data/brave/brave-main-list.txt"]).collect();
    let engine = Engine::from_rules(&brave_list_rules, Default::default());
    let engine_serialized = engine.serialize().to_vec();

    group.bench_function("el+ep", move |b| b.iter(|| get_engine(&easylist_rules)));
    group.bench_function("brave-list", move |b| {
        b.iter(|| get_engine(&brave_list_rules))
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
