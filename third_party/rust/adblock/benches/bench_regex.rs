use criterion::*;

use regex::{bytes::Regex as BytesRegex, Regex, RegexSet};

fn bench_simple_regexes(c: &mut Criterion) {
    let mut group = c.benchmark_group("regex");

    let pattern = "?/static/adv/foobar/asd?q=1";

    let rules = [
        Regex::new(r"(?:[^\\w\\d\\._%-])/static/ad-").unwrap(),
        Regex::new(r"(?:[^\\w\\d\\._%-])/static/ad/.*").unwrap(),
        Regex::new(r"(?:[^\\w\\d\\._%-])/static/ads/.*").unwrap(),
        Regex::new(r"(?:[^\\w\\d\\._%-])/static/adv/.*").unwrap(),
    ];

    group.bench_function("list", move |b| {
        b.iter(|| {
            for rule in rules.iter() {
                criterion::black_box(rule.is_match(pattern));
            }
        })
    });

    group.finish();
}

fn bench_joined_regex(c: &mut Criterion) {
    let mut group = c.benchmark_group("regex");

    let pattern = "?/static/adv/foobar/asd?q=1";

    let rule = Regex::new(r"(?:([^\\w\\d\\._%-])/static/ad-)|(?:([^\\w\\d\\._%-])/static/ad/.*)(?:([^\\w\\d\\._%-])/static/ads/.*)(?:([^\\w\\d\\._%-])/static/adv/.*)").unwrap();

    group.bench_function("joined", move |b| b.iter(|| rule.is_match(pattern)));

    group.finish();
}

fn bench_joined_bytes_regex(c: &mut Criterion) {
    let mut group = c.benchmark_group("regex");

    let pattern = "?/static/adv/foobar/asd?q=1";

    let rule = BytesRegex::new(r"(?:([^\\w\\d\\._%-])/static/ad-)|(?:([^\\w\\d\\._%-])/static/ad/.*)(?:([^\\w\\d\\._%-])/static/ads/.*)(?:([^\\w\\d\\._%-])/static/adv/.*)").unwrap();

    group.bench_function("u8", move |b| b.iter(|| rule.is_match(pattern.as_bytes())));

    group.finish();
}

fn bench_regex_set(c: &mut Criterion) {
    let mut group = c.benchmark_group("regex");

    let pattern = "?/static/adv/foobar/asd?q=1";

    let set = RegexSet::new([
        r"(?:[^\\w\\d\\._%-])/static/ad-",
        r"(?:[^\\w\\d\\._%-])/static/ad/.*",
        r"(?:[^\\w\\d\\._%-])/static/ads/.*",
        r"(?:[^\\w\\d\\._%-])/static/adv/.*",
    ])
    .unwrap();

    group.bench_function("set", move |b| b.iter(|| set.is_match(pattern)));

    group.finish();
}

criterion_group!(
    benches,
    bench_simple_regexes,
    bench_joined_regex,
    bench_joined_bytes_regex,
    bench_regex_set
);
criterion_main!(benches);
