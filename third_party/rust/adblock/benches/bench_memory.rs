/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

use criterion::*;
use serde::{Deserialize, Serialize};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

use adblock::request::Request;
use adblock::resources::Resource;
use adblock::Engine;

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

// Custom allocator to track memory usage
#[global_allocator]
static ALLOCATOR: MemoryTracker = MemoryTracker::new();

struct MemoryTracker {
    allocated: AtomicUsize,
    max_allocated: AtomicUsize,
    allocations_count: AtomicUsize,
    internal: System,
}

impl MemoryTracker {
    const fn new() -> Self {
        Self {
            allocated: AtomicUsize::new(0),
            max_allocated: AtomicUsize::new(0),
            allocations_count: AtomicUsize::new(0),
            internal: System,
        }
    }

    fn current_usage(&self) -> usize {
        self.allocated.load(Ordering::SeqCst)
    }

    fn max_usage(&self) -> usize {
        self.max_allocated.load(Ordering::SeqCst)
    }

    fn allocations_count(&self) -> usize {
        self.allocations_count.load(Ordering::SeqCst)
    }

    fn reset(&self) {
        self.allocated.store(0, Ordering::SeqCst);
        self.max_allocated.store(0, Ordering::SeqCst);
        self.allocations_count.store(0, Ordering::SeqCst);
    }

    fn update_max_allocated(&self, current: usize) {
        let mut max = self.max_allocated.load(Ordering::SeqCst);
        while current > max {
            match self.max_allocated.compare_exchange_weak(
                max,
                current,
                Ordering::SeqCst,
                Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(x) => max = x,
            }
        }
    }
}

unsafe impl GlobalAlloc for MemoryTracker {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ret = self.internal.alloc(layout);
        if !ret.is_null() {
            self.allocations_count.fetch_add(1, Ordering::SeqCst);
            self.allocated.fetch_add(layout.size(), Ordering::SeqCst);
            self.update_max_allocated(self.current_usage());
        }
        ret
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.internal.dealloc(ptr, layout);
        self.allocated.fetch_sub(layout.size(), Ordering::SeqCst);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let ret = self.internal.realloc(ptr, layout, new_size);
        if !ret.is_null() {
            self.allocations_count.fetch_add(1, Ordering::SeqCst);
            self.allocated.fetch_sub(layout.size(), Ordering::SeqCst);
            self.allocated.fetch_add(new_size, Ordering::SeqCst);
            self.update_max_allocated(self.current_usage());
        }
        ret
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let ret = self.internal.alloc_zeroed(layout);
        if !ret.is_null() {
            self.allocations_count.fetch_add(1, Ordering::SeqCst);
            self.allocated.fetch_add(layout.size(), Ordering::SeqCst);
            self.update_max_allocated(self.current_usage());
        }
        ret
    }
}

#[allow(non_snake_case)]
#[derive(Serialize, Deserialize, Clone)]
struct TestRequest {
    frameUrl: String,
    url: String,
    cpt: String,
}

impl From<&TestRequest> for Request {
    fn from(v: &TestRequest) -> Self {
        Request::new(&v.url, &v.frameUrl, &v.cpt).unwrap()
    }
}

fn load_requests() -> Vec<TestRequest> {
    let requests_str = rules_from_lists(&["data/requests.json"]);
    let reqs: Vec<TestRequest> = requests_str
        .into_iter()
        .map(|r| serde_json::from_str(&r))
        .filter_map(Result::ok)
        .collect();
    reqs
}

fn bench_memory_usage(c: &mut Criterion) {
    let mut group = c.benchmark_group("memory-usage");
    group.sample_size(10);
    group.measurement_time(std::time::Duration::from_secs(1));

    let mut noise = 0;
    let all_requests = load_requests();
    let first_1000_requests: Vec<_> = all_requests.iter().take(1000).collect();

    let mut cb = |metric: fn() -> usize, run_requests: bool, b: &mut Bencher| {
        let mut result = 0;
        b.iter_custom(|iters| {
            for _ in 0..iters {
                ALLOCATOR.reset();
                let rules = rules_from_lists(&["data/brave/brave-main-list.txt"]);
                let mut engine = Engine::from_rules(rules, Default::default());
                let resource_json =
                    std::fs::read_to_string("data/brave/brave-resources.json").unwrap();
                let resource_list: Vec<Resource> = serde_json::from_str(&resource_json).unwrap();
                std::mem::drop(resource_json);
                engine.use_resources(resource_list);

                if run_requests {
                    ALLOCATOR.reset();
                    for request in first_1000_requests.clone() {
                        criterion::black_box(engine.check_network_request(&request.into()));
                    }
                }

                noise += 1; // add some noise to make criterion happy
                result += metric() + noise;

                // Prevent engine from being optimized
                criterion::black_box(&engine);
            }

            // Return the memory usage as a Duration
            std::time::Duration::from_nanos(result as u64)
        });
    };

    group.bench_function("brave-list-initial", |b| {
        cb(|| ALLOCATOR.current_usage(), false, b)
    });
    group.bench_function("brave-list-initial/max", |b| {
        cb(|| ALLOCATOR.max_usage(), false, b)
    });
    group.bench_function("brave-list-initial/alloc-count", |b| {
        cb(|| ALLOCATOR.allocations_count(), false, b)
    });

    group.bench_function("brave-list-1000-requests", |b| {
        cb(|| ALLOCATOR.current_usage(), true, b)
    });
    group.bench_function("brave-list-1000-requests/alloc-count", |b| {
        cb(|| ALLOCATOR.allocations_count(), true, b)
    });

    group.finish();
}

criterion_group!(benches, bench_memory_usage);
criterion_main!(benches);
