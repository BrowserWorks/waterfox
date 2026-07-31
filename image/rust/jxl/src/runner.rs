// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

//! Spreads one JXL decode's work across a thread pool dedicated to JXL decoding.
//!
//! # Why a pool of our own
//!
//! The helpers run on a different pool from the decode itself, which is what
//! makes waiting here safe: the thread that blocks and the threads it waits on
//! belong to different pools, so a blocked decode can never be holding a thread
//! that a helper needs. An AVIF decode does the same thing, fanning out to
//! dav1d's own threads.
//!
//! The pool is a `SharedThreadPool`, so it costs nothing until the first
//! parallel decode in the process, it is shut down for us at
//! xpcom-shutdown-threads, and its threads are reaped once they go idle.
//!
//! # Why the closure's lifetime is erased
//!
//! The closure jxl-rs hands us borrows its decode state, so it is only valid for
//! the duration of the call. A helper is an `nsIRunnable`, which has to be
//! `'static`. Both cannot be true, so the lifetime is transmuted away and the
//! closure travels behind a raw pointer.
//!
//! What puts the guarantee back is that the call does not return until every
//! helper it queued has been accounted for. `Helper` decrements the outstanding
//! count from its `Drop`, which runs whether the helper ran or was thrown away
//! without running, and `WaitForHelpers` blocks until that count is zero.
//!
//! `WaitForHelpers` does its waiting from a destructor rather than from a
//! statement after the work, so it also covers the calling thread's own
//! invocation of the closure panicking, which would otherwise unwind past the
//! wait and leave helpers dereferencing a closure jxl-rs has taken back. Gecko
//! builds Rust with `panic=abort` so that unwind does not arise in Firefox, but
//! rusttests builds with unwinding.
//!
//! Helpers are dispatched with `DISPATCH_FALLIBLE`, which asks the pool to
//! release a helper it cannot queue instead of leaking it, so a failed dispatch
//! runs the `Drop` as well.
//!
//! # What this asks of the pool
//!
//! This depends on a queued helper eventually either running or being released,
//! since the wait is for its payload's destructor. `nsThreadPool` has that
//! property: its threads drain the queue to empty before exiting, even once it
//! is shutting down, and `Shutdown` joins them.

use std::sync::{Arc, Condvar, Mutex};

use jxl::api::{JxlParallelRunner, JxlParallelRunnerFun};
use jxl::error::{Error, Result};
use xpcom::interfaces::nsIThreadPool;
use xpcom::RefPtr;

extern "C" {
    /// Gets the JXL decode pool, creating it on the first call.
    ///
    /// `thread_limit` only has an effect on the call that creates the pool.
    ///
    /// Null late in shutdown, once there is no longer a pool to be had. Earlier
    /// than that it can hand back a pool that refuses work, which shows up as a
    /// dispatch failure instead.
    fn JxlGetDecodePool(thread_limit: u32) -> *const nsIThreadPool;
}

/// How many threads may work on one decode, counting the calling thread. One
/// participant means no helpers, which is why 1 turns parallel decoding off.
///
/// At 0 this is the machine's number of cpus clamped to between 2 and 8. The
/// lower bound so a single-core machine still gets a helper; the upper because
/// there are diminishing returns.
///
/// Any other value is taken literally.
fn participant_count() -> usize {
    match static_prefs::pref!("image.jxl.decode_participants") {
        0 => std::thread::available_parallelism()
            .map_or(2, std::num::NonZero::get)
            .clamp(2, 8),
        n => n as usize,
    }
}

/// The calling thread does work and so is included in the count so ask for 1
/// fewer threads from the pool to account for that.
fn pool_thread_limit(participants: usize) -> u32 {
    participants.saturating_sub(1) as u32
}

fn acquire_pool(participants: usize) -> Option<RefPtr<nsIThreadPool>> {
    // SAFETY: the callee returns one already-addrefed pointer, or null.
    unsafe { RefPtr::from_raw_dont_addref(JxlGetDecodePool(pool_thread_limit(participants))) }
}

/// Everything the participants share, behind one mutex, which is never held
/// while the closure runs.
struct State {
    /// Next index to hand out, counting up to `num`.
    next: usize,
    /// Helpers queued but not yet finished. The caller waits for zero.
    outstanding: usize,
    /// First error reported by any participant. Once set, no further indices are
    /// handed out, though a participant already inside `run_ordered`'s loop over
    /// jxl-rs's own counter keeps going.
    err: Option<Error>,
}

struct Shared {
    /// The closure, with its real lifetime erased. Valid until this call returns.
    /// The caller waiting until `outstanding` reaches zero guarantees no one uses
    /// the closure past its real lifetime.
    fun: *const JxlParallelRunnerFun<'static>,
    /// Number of indices jxl-rs asked for: the closure runs once for each index
    /// below it.
    num: usize,
    state: Mutex<State>,
    /// Notified when outstanding becomes 0.
    idle: Condvar,
}

// SAFETY: only the raw pointer makes these unsafe. It is dereferenced solely as a
// shared reference, and `JxlParallelRunnerFun` carries a `Sync` bound, so several
// threads holding one at once is sound. What keeps the pointee alive that long is
// argued at the transmute in `run_in_parallel`.
unsafe impl Send for Shared {}
// SAFETY: same reason.
unsafe impl Sync for Shared {}

impl Shared {
    /// The next index to run, or `None` once the work is exhausted or a
    /// participant has failed.
    fn claim(&self) -> Option<usize> {
        let mut state = self.state.lock().unwrap();
        if state.err.is_some() || state.next >= self.num {
            return None;
        }
        let i = state.next;
        state.next += 1;
        Some(i)
    }

    /// Records an error if it is the first error, which also stops any further
    /// indices being handed out.
    fn fail(&self, e: Error) {
        let mut state = self.state.lock().unwrap();
        if state.err.is_none() {
            state.err = Some(e);
        }
    }

    /// The first error any participant reported. Only meaningful once they have
    /// all finished.
    fn take_err(&self) -> Option<Error> {
        self.state.lock().unwrap().err.take()
    }

    /// Take and run indices until they are exhausted or a participant failed.
    /// Runs on either kind of participant: a helper, or the calling thread.
    fn drain(&self) {
        while let Some(i) = self.claim() {
            // SAFETY: the closure outlives every use of it here. The calling
            // thread is inside the call; a helper is counted in `outstanding`
            // from before it is queued until its `Drop`, and the call does not
            // return while that count is above zero.
            let fun = unsafe { &*self.fun };
            if let Err(e) = fun(i) {
                self.fail(e);
                return;
            }
        }
    }

    fn increase_count(&self) {
        self.state.lock().unwrap().outstanding += 1;
    }

    fn release_one(&self) {
        let mut state = self.state.lock().unwrap();
        // An underflow hangs `WaitForHelpers`, so crash instead.
        state.outstanding = state
            .outstanding
            .checked_sub(1)
            .expect("a JXL decode helper was accounted for twice");
        if state.outstanding == 0 {
            self.idle.notify_all();
        }
    }
}

/// One queued helper. Dropping it is what tells the caller this helper is done
/// with the closure, whether the helper ran or was discarded.
struct Helper(Arc<Shared>);

impl Drop for Helper {
    fn drop(&mut self) {
        self.0.release_one();
    }
}

/// Blocks until every queued helper has been accounted for.
///
/// Waits from a destructor rather than from a call sited after the work, so it
/// happens however the caller leaves: a normal return, or a panic in the closure
/// unwinding past it.
struct WaitForHelpers<'a>(&'a Shared);

impl Drop for WaitForHelpers<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        while state.outstanding > 0 {
            state = self.0.idle.wait(state).unwrap();
        }
    }
}

/// Runs `fun(0..num)`, spread over the decode pool plus the calling thread.
/// Blocks until every index has completed, or returns the first error.
fn run_in_parallel(
    pool: &nsIThreadPool,
    participants: usize,
    num: usize,
    fun: &JxlParallelRunnerFun<'_>,
) -> Result<()> {
    // The whole design rests on the caller not being one of this pool's threads:
    // it blocks until the helpers finish, so a caller that was a pool thread could
    // be holding the thread a helper needs.
    debug_assert!(
        !moz_task::is_on_current_thread(pool.coerce()),
        "a JXL decode must not run on the JXL decode pool: it waits for helpers there"
    );

    // Starting with rustc 1.94 an `as` cast cannot extend the lifetime bound of a
    // trait object pointer, so this has to be a transmute.
    // https://github.com/rust-lang/rust/issues/141402
    //
    // SAFETY: the `'static` is not true; the closure only lives for this call.
    // Sound because we do not return while a helper is still counted in
    // `outstanding`.
    #[allow(clippy::transmute_ptr_to_ptr)]
    let fun_static: *const JxlParallelRunnerFun<'static> =
        unsafe { std::mem::transmute(std::ptr::from_ref(fun)) };

    let shared = Arc::new(Shared {
        fun: fun_static,
        num,
        state: Mutex::new(State {
            next: 0,
            outstanding: 0,
            err: None,
        }),
        idle: Condvar::new(),
    });

    // Declared before anything is queued and dropped after the work, so the wait
    // covers every helper on every path out of here.
    let wait = WaitForHelpers(&shared);

    let helpers = participants.saturating_sub(1).min(num - 1);
    for _ in 0..helpers {
        // Increased before the helper exists, helper's decrement will be sound.
        shared.increase_count();
        let helper = Helper(Arc::clone(&shared));
        let queued = moz_task::RunnableBuilder::new("JxlDecodeHelper", move || {
            helper.0.drain();
        })
        .options(moz_task::DispatchOptions::default().fallible(true))
        .dispatch(pool.coerce());
        if queued.is_err() {
            // Dispatching fallibly means the pool released the helper rather than
            // leaking it, so its `Drop` has already run.
            break;
        }
    }

    // Also a participant, not just a waiter, so the work gets done even if no
    // helper was queued.
    shared.drain();

    // Explicit, because the error has to be read after every helper has finished
    // reporting one.
    drop(wait);

    match shared.take_err() {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Spreads the work jxl-rs hands us across the JXL decode pool.
pub struct PoolRunner {
    // Snapshot once so a live pref change cannot create a zero-thread pool.
    participants: usize,
    /// Left as `None` until there is some work big enough to need it.
    pool: Option<RefPtr<nsIThreadPool>>,
}

impl PoolRunner {
    /// `None` at one participant: with no helpers there is nothing to spread, so
    /// let jxl-rs use its own sequential runner instead of ours.
    pub fn new() -> Option<Self> {
        let participants = participant_count();
        if participants == 1 {
            return None;
        }
        Some(Self {
            participants,
            pool: None,
        })
    }
}

impl JxlParallelRunner for PoolRunner {
    fn run(&mut self, num: usize, fun: &JxlParallelRunnerFun<'_>) -> Result<()> {
        if num == 0 {
            return Ok(());
        }
        // Nothing to spread: stay on this thread and leave the pool alone.
        if num == 1 {
            return fun(0);
        }
        if self.pool.is_none() {
            self.pool = acquire_pool(self.participants);
        }
        match &self.pool {
            Some(pool) => run_in_parallel(pool, self.participants, num, fun),
            None => (0..num).try_for_each(fun),
        }
    }

    fn num_threads(&self) -> usize {
        self.participants
    }
}

/// Builds the `Option<&mut dyn _>` argument the jxl-rs entry points take, borrowed
/// from an owned runner. One value cannot be reused across calls: `Option<&mut _>`
/// moves when passed, and the implicit reborrow that lets a bare `&mut` be passed
/// again does not reach inside the `Option`.
pub fn as_dyn(runner: &mut Option<PoolRunner>) -> Option<&mut dyn JxlParallelRunner> {
    runner.as_mut().map(|r| r as &mut dyn JxlParallelRunner)
}
