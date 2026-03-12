use criterion::*;

use adblock::Engine;

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

fn serialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("blocker-serialization");

    group.sample_size(20);

    group.bench_function("el+ep", move |b| {
        let full_rules = rules_from_lists(&[
            "data/easylist.to/easylist/easylist.txt",
            "data/easylist.to/easylist/easyprivacy.txt",
        ]);

        let engine = Engine::from_rules(full_rules, Default::default());
        b.iter(|| assert!(!engine.serialize().to_vec().is_empty()))
    });
    group.bench_function("el", move |b| {
        let full_rules = rules_from_lists(&["data/easylist.to/easylist/easylist.txt"]);

        let engine = Engine::from_rules(full_rules, Default::default());
        b.iter(|| assert!(!engine.serialize().to_vec().is_empty()))
    });
    group.bench_function("slimlist", move |b| {
        let full_rules = rules_from_lists(&["data/slim-list.txt"]);

        let engine = Engine::from_rules(full_rules, Default::default());
        b.iter(|| assert!(!engine.serialize().to_vec().is_empty()))
    });

    group.finish();
}

fn deserialization(c: &mut Criterion) {
    let mut group = c.benchmark_group("blocker-deserialization");

    group.sample_size(20);

    group.bench_function("el+ep", move |b| {
        let full_rules = rules_from_lists(&[
            "data/easylist.to/easylist/easylist.txt",
            "data/easylist.to/easylist/easyprivacy.txt",
        ]);

        let engine = Engine::from_rules(full_rules, Default::default());
        let serialized = engine.serialize().to_vec();

        b.iter(|| {
            let mut deserialized = Engine::default();
            assert!(deserialized.deserialize(&serialized).is_ok());
        })
    });
    group.bench_function("el", move |b| {
        let full_rules = rules_from_lists(&["data/easylist.to/easylist/easylist.txt"]);

        let engine = Engine::from_rules(full_rules, Default::default());
        let serialized = engine.serialize().to_vec();

        b.iter(|| {
            let mut deserialized = Engine::default();
            assert!(deserialized.deserialize(&serialized).is_ok());
        })
    });
    group.bench_function("slimlist", move |b| {
        let full_rules = rules_from_lists(&["data/slim-list.txt"]);

        let engine = Engine::from_rules(full_rules, Default::default());
        let serialized = engine.serialize().to_vec();

        b.iter(|| {
            let mut deserialized = Engine::default();
            assert!(deserialized.deserialize(&serialized).is_ok());
        })
    });

    group.finish();
}

criterion_group!(benches, serialization, deserialization);
criterion_main!(benches);
