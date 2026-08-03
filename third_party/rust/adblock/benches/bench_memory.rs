/* Copyright (c) 2025 The Brave Authors. All rights reserved.
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */

use criterion::*;
use serde::{Deserialize, Serialize};
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use adblock::Engine;
use adblock::request::Request;
use adblock::resources::Resource;

#[path = "../tests/test_utils.rs"]
mod test_utils;
use test_utils::rules_from_lists;

// Custom allocator to track memory usage
#[global_allocator]
static ALLOCATOR: MemoryTracker = MemoryTracker::new();

struct MemoryTracker {
    frozen: AtomicBool,
    allocated: AtomicUsize,
    max_allocated: AtomicUsize,
    allocations_count: AtomicUsize,
    internal: System,
}

impl MemoryTracker {
    const fn new() -> Self {
        Self {
            frozen: AtomicBool::new(false),
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

    fn freeze(&self) {
        self.frozen.store(true, Ordering::SeqCst);
    }

    fn reset(&self) {
        self.frozen.store(false, Ordering::SeqCst);
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
        unsafe {
            let ret = self.internal.alloc(layout);
            if !ret.is_null() && !self.frozen.load(Ordering::SeqCst) {
                self.allocations_count.fetch_add(1, Ordering::SeqCst);
                self.allocated.fetch_add(layout.size(), Ordering::SeqCst);
                self.update_max_allocated(self.current_usage());
            }
            ret
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe {
            self.internal.dealloc(ptr, layout);
            if !self.frozen.load(Ordering::SeqCst) {
                self.allocated.fetch_sub(layout.size(), Ordering::SeqCst);
            }
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        unsafe {
            let ret = self.internal.realloc(ptr, layout, new_size);
            if !ret.is_null() && !self.frozen.load(Ordering::SeqCst) {
                self.allocations_count.fetch_add(1, Ordering::SeqCst);
                self.allocated.fetch_sub(layout.size(), Ordering::SeqCst);
                self.allocated.fetch_add(new_size, Ordering::SeqCst);
                self.update_max_allocated(self.current_usage());
            }
            ret
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        unsafe {
            let ret = self.internal.alloc_zeroed(layout);
            if !ret.is_null() && !self.frozen.load(Ordering::SeqCst) {
                self.allocations_count.fetch_add(1, Ordering::SeqCst);
                self.allocated.fetch_add(layout.size(), Ordering::SeqCst);
                self.update_max_allocated(self.current_usage());
            }
            ret
        }
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

impl MemoryAllocated {
    fn metric(&self) -> usize {
        match self {
            Self::Current => ALLOCATOR.current_usage(),
            Self::Max => ALLOCATOR.max_usage(),
            Self::AllocCount => ALLOCATOR.allocations_count(),
        }
    }
}

/// Measurement of allocated memory
enum MemoryAllocated {
    Current,
    Max,
    AllocCount,
}
impl criterion::measurement::Measurement for MemoryAllocated {
    type Intermediate = usize;
    type Value = usize;

    fn start(&self) -> Self::Intermediate {
        ALLOCATOR.reset();
        0
    }
    fn end(&self, _i: Self::Intermediate) -> Self::Value {
        self.metric()
    }
    fn add(&self, v1: &Self::Value, v2: &Self::Value) -> Self::Value {
        *v1 + *v2
    }
    fn zero(&self) -> Self::Value {
        0
    }
    fn to_f64(&self, val: &Self::Value) -> f64 {
        *val as f64
    }
    fn formatter(&self) -> &dyn criterion::measurement::ValueFormatter {
        match self {
            Self::Current | Self::Max => &MemoryFormatter,
            Self::AllocCount => &RawUnitsFormatter,
        }
    }
}

/// Prints allocation counts as a dimensionless integer.
struct RawUnitsFormatter;
impl criterion::measurement::ValueFormatter for RawUnitsFormatter {
    fn scale_values(&self, _typ: f64, _values: &mut [f64]) -> &'static str {
        "allocs"
    }

    fn scale_throughputs(&self, _typ: f64, _tp: &Throughput, _values: &mut [f64]) -> &'static str {
        unimplemented!()
    }

    fn scale_for_machines(&self, _values: &mut [f64]) -> &'static str {
        "allocs"
    }
}

/// Prints the number formatted as a quantity of bytes
struct MemoryFormatter;
impl criterion::measurement::ValueFormatter for MemoryFormatter {
    fn scale_values(&self, bytes: f64, values: &mut [f64]) -> &'static str {
        let (factor, unit) = if bytes < 1024f64.powi(1) {
            (1024f64.powi(0), "B")
        } else if bytes < 1024f64.powi(2) {
            (1024f64.powi(-1), "KB")
        } else if bytes < 1024f64.powi(3) {
            (1024f64.powi(-2), "MB")
        } else {
            (1024f64.powi(-3), "GB")
        };

        for val in values {
            *val *= factor;
        }

        unit
    }
    fn scale_throughputs(
        &self,
        _typical_value: f64,
        _tp: &Throughput,
        _values: &mut [f64],
    ) -> &'static str {
        unimplemented!()
    }
    fn scale_for_machines(&self, _values: &mut [f64]) -> &'static str {
        // no scale needed
        "B"
    }
}

fn bench_cb(
    run_requests: &[&TestRequest],
    metric: MemoryAllocated,
    b: &mut Bencher<MemoryAllocated>,
) {
    let single_run = || {
        ALLOCATOR.reset();
        let rules = rules_from_lists(["data/brave/brave-main-list.txt"]);
        let mut engine = Engine::new_with_list_text(rules);
        let resource_json = std::fs::read_to_string("data/brave/brave-resources.json").unwrap();
        let resource_list: Vec<Resource> = serde_json::from_str(&resource_json).unwrap();
        std::mem::drop(resource_json);
        engine.use_resources(resource_list);

        if run_requests.len() > 0 {
            ALLOCATOR.reset(); // disregard previous allocations
            for request in run_requests {
                std::hint::black_box(engine.check_network_request(&((*request).into())));
            }
        }

        ALLOCATOR.freeze();
        let result = metric.metric();
        // Prevent engine from being optimized
        std::hint::black_box(&engine);
        result
    };
    b.iter_custom(|iters| {
        let mut total = 0usize;
        for _ in 0..iters {
            total += single_run();
        }
        total
    });
}

fn bench_current_memory_usage(c: &mut Criterion<MemoryAllocated>) {
    let all_requests = load_requests();
    let first_1000_requests: Vec<_> = all_requests.iter().take(1000).collect();

    let mut group = c.benchmark_group("memory-usage-final");
    group
        .bench_function("brave-list-initial", |b| {
            bench_cb(&[], MemoryAllocated::Current, b)
        })
        .bench_function("brave-list-1000-requests", |b| {
            bench_cb(&first_1000_requests, MemoryAllocated::Current, b)
        });
    group.finish();
}

fn bench_max_memory_usage(c: &mut Criterion<MemoryAllocated>) {
    let mut group = c.benchmark_group("memory-usage-max");
    group.bench_function("brave-list-initial/max", |b| {
        bench_cb(&[], MemoryAllocated::Max, b)
    });
    group.finish();
}

fn bench_allocation_count(c: &mut Criterion<MemoryAllocated>) {
    let all_requests = load_requests();
    let first_1000_requests: Vec<_> = all_requests.iter().take(1000).collect();

    let mut group = c.benchmark_group("memory-usage-alloc-count");
    group
        .bench_function("brave-list-initial/alloc-count", |b| {
            bench_cb(&[], MemoryAllocated::AllocCount, b)
        })
        .bench_function("brave-list-1000-requests/alloc-count", |b| {
            bench_cb(&first_1000_requests, MemoryAllocated::AllocCount, b)
        });
    group.finish();
}

fn current_memory_usage_config() -> Criterion<MemoryAllocated> {
    Criterion::default()
        .sample_size(10)
        .measurement_time(std::time::Duration::from_secs(1))
        .with_measurement(MemoryAllocated::Current)
        .without_plots()
}

fn max_memory_usage_config() -> Criterion<MemoryAllocated> {
    Criterion::default()
        .sample_size(10)
        .measurement_time(std::time::Duration::from_secs(1))
        .with_measurement(MemoryAllocated::Max)
        .without_plots()
}

fn allocations_count_config() -> Criterion<MemoryAllocated> {
    Criterion::default()
        .sample_size(10)
        .measurement_time(std::time::Duration::from_secs(1))
        .with_measurement(MemoryAllocated::AllocCount)
        .without_plots()
}

criterion_group!(name = current_memory_usage_benches; config = current_memory_usage_config(); targets = bench_current_memory_usage);
criterion_group!(name = max_memory_usage_benches; config = max_memory_usage_config(); targets = bench_max_memory_usage);
criterion_group!(name = allocation_count_benches; config = allocations_count_config(); targets = bench_allocation_count);
criterion_main!(
    current_memory_usage_benches,
    max_memory_usage_benches,
    allocation_count_benches
);
