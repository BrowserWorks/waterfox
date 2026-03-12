use adblock::Engine;
use criterion::*;

#[path = "../tests/test_utils.rs"]
mod test_utils;

pub fn make_engine() -> Engine {
    use adblock::resources::Resource;

    let rules = test_utils::rules_from_lists(&["data/brave/brave-main-list.txt"]);
    let resource_json = std::fs::read_to_string("data/brave/brave-resources.json").unwrap();
    let resource_list: Vec<Resource> = serde_json::from_str(&resource_json).unwrap();
    let mut engine = Engine::from_rules_parametrised(rules, Default::default(), true, true);
    engine.use_resources(resource_list);
    engine
}

const TEST_URLS: [&str; 3] = [
    "https://search.brave.com/search?q=test",
    "https://mail.google.com/",
    "https://google.com",
];

fn by_hostname(c: &mut Criterion) {
    let mut group = c.benchmark_group("url_cosmetic_resources");

    group.throughput(Throughput::Elements(1));
    group.sample_size(20);

    group.bench_function("brave-list", move |b| {
        let engine = make_engine();
        b.iter(|| {
            TEST_URLS
                .iter()
                .map(|url| engine.url_cosmetic_resources(url))
                .collect::<Vec<_>>()
        })
    });

    group.finish();
}

fn by_classes_ids(c: &mut Criterion) {
    let mut group = c.benchmark_group("cosmetic-class-id-match");

    group.throughput(Throughput::Elements(1));
    group.sample_size(20);

    let mut classes = vec![];
    let mut ids = vec![];

    group.bench_function("brave-list", |b| {
        for i in 0..1000 {
            classes.push(format!("class{i}"));
            ids.push(format!("id{i}"));
        }

        let engine = make_engine();
        let cases = TEST_URLS
            .iter()
            .map(|url| engine.url_cosmetic_resources(url).exceptions)
            .collect::<Vec<_>>();

        let engine = make_engine();
        b.iter(|| {
            cases
                .iter()
                .map(|e| engine.hidden_class_id_selectors(&classes, &ids, e))
                .collect::<Vec<_>>()
        })
    });
    group.finish();
}

criterion_group!(cosmetic_benches, by_hostname, by_classes_ids,);
criterion_main!(cosmetic_benches);
