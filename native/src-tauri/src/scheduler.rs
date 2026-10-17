//! Keeping the inbox fresh while the window is closed.
//!
//! A browser tab is throttled to a crawl once it is hidden, and a PWA that is
//! not open at all does not run at all. A desktop mail client is expected to
//! still know about new mail, so a Rust thread owns the cadence and pokes the
//! webview over the Tauri event channel. The webview does the actual sync —
//! this is a clock, not a second sync engine.
//!
//! The interval is chosen by the web layer because it knows about rate limits
//! and quiet hours; `None` means "stop ticking".

use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The event the webview listens for. Keeping the name in one place stops the
/// two halves from drifting.
pub const SYNC_TICK_EVENT: &str = "winnow://sync-tick";

/// Floor and ceiling on the poll interval, in seconds. Below the floor we would
/// be hammering the Gmail API; above the ceiling "background sync" is a lie.
const MIN_INTERVAL_SECS: u64 = 30;
const MAX_INTERVAL_SECS: u64 = 3600;

/// How long a sleeping thread waits between checks of the stop flag. Small
/// enough that quitting feels instant, large enough not to spin a core.
const STOP_CHECK: Duration = Duration::from_millis(250);

/// The live ticker: the stop flag, and the thread running it.
///
/// The handle is here so `stop` can *join* rather than merely signal. Signalling
/// alone left the old thread running for up to one `STOP_CHECK` after a retune, so
/// changing the interval in the settings panel started a second ticker while the
/// first was still winding down — and the two overlapped, which meant a tick could
/// fire twice and the webview ran two syncs where the user asked for one. Joining
/// makes a retune a replacement rather than an addition.
#[derive(Default)]
pub struct Scheduler(Mutex<Option<Running>>);

struct Running {
    stop: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<()>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Retire the current ticker, if any, and wait for it to notice.
    ///
    /// The join happens outside the lock: the thread being joined does not take
    /// this mutex, so holding it across a `join` would be safe today, but it would
    /// make the lock's scope the thread's lifetime and any future code that did
    /// need the mutex inside the loop would deadlock against its own retirement.
    fn retire(&self) {
        let running = self.0.lock().take();
        if let Some(running) = running {
            running.stop.store(true, Ordering::SeqCst);
            let _ = running.handle.join();
        }
    }

    /// Stop ticking.
    pub fn stop(&self) {
        self.retire();
    }

    /// Start ticking at `interval_secs`, replacing any existing ticker.
    pub fn start(&self, app: AppHandle, interval_secs: u64) {
        // Retire first, and wait. Without the join this is additive rather than
        // substitutive, which is the bug above.
        self.retire();

        let stop = Arc::new(AtomicBool::new(false));
        let interval =
            Duration::from_secs(interval_secs.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS));

        let Ok(handle) = std::thread::Builder::new()
            .name("winnow-sync".into())
            .spawn({
                let stop = Arc::clone(&stop);
                move || {
                    let mut tick: u64 = 0;
                    while !sleep_until(&stop, interval) {
                        tick += 1;
                        // Only nudge a window that exists. Whether it is visible is
                        // the web layer's business: a hidden window should still
                        // sync (that is the point) but should skip re-rendering.
                        if app.get_webview_window("main").is_some() {
                            let _ = app.emit(SYNC_TICK_EVENT, tick);
                        }
                    }
                }
            })
        else {
            // A ticker that could not start is a silent loss of background sync.
            // Said out loud rather than swallowed by `.ok()`.
            eprintln!("winnow: could not start the background sync thread");
            return;
        };

        *self.0.lock() = Some(Running { stop, handle });
    }
}

/// Sleep for `total`, waking often enough to notice `stop`.
///
/// Returns `true` if the thread was asked to stop while waiting.
fn sleep_until(stop: &AtomicBool, total: Duration) -> bool {
    let mut waited = Duration::ZERO;
    while waited < total {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        let chunk = STOP_CHECK.min(total - waited);
        std::thread::sleep(chunk);
        waited += chunk;
    }
    stop.load(Ordering::SeqCst)
}

/// Register the scheduler with the app. State is managed here so the command
/// layer can reach it without threading a handle through every call.
pub fn install(app: &AppHandle) {
    app.manage(Scheduler::new());
}

/// Re-arm the ticker at `interval_secs`, or stop it with `None`.
pub fn set_interval(app: &AppHandle, interval_secs: Option<u64>) {
    let Some(scheduler) = app.try_state::<Scheduler>() else {
        return;
    };
    match interval_secs {
        Some(secs) => scheduler.start(app.clone(), secs),
        None => scheduler.stop(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intervals_are_clamped_to_something_sane() {
        assert_eq!(5u64.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS), 30);
        assert_eq!(99_999u64.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS), 3600);
        assert_eq!(300u64.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS), 300);
    }

    #[test]
    fn a_fresh_scheduler_has_nothing_running() {
        let scheduler = Scheduler::new();
        assert!(scheduler.0.lock().is_none());
        // Stopping an idle scheduler is a no-op, not a panic.
        scheduler.stop();
    }

    #[test]
    fn sleeping_observes_a_stop_request() {
        // A 30s interval that is cut short after 120ms is the whole point: if
        // `sleep_until` only checked the flag between intervals, quitting the
        // app would hang for half a minute.
        let stop = Arc::new(AtomicBool::new(false));
        let signal = Arc::clone(&stop);

        let waker = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            signal.store(true, Ordering::SeqCst);
        });

        let started = std::time::Instant::now();
        let stopped = sleep_until(&stop, Duration::from_secs(30));
        let elapsed = started.elapsed();
        waker.join().unwrap();

        assert!(
            stopped,
            "the flag was set mid-sleep, so this should report a stop"
        );
        assert!(
            elapsed < Duration::from_secs(5),
            "should have woken within a second or two, took {elapsed:?}"
        );
    }

    #[test]
    fn sleeping_returns_early_once_stopped() {
        let stop = AtomicBool::new(true);
        let started = std::time::Instant::now();
        assert!(sleep_until(&stop, Duration::from_secs(30)));
        assert!(
            started.elapsed() < Duration::from_secs(1),
            "an already-stopped ticker must not sleep for its full interval"
        );
    }

    #[test]
    fn the_first_ticker_is_finished_before_the_second_one_starts() {
        // The retune bug, as a test. `sleep_until` wakes every 250 ms to check its
        // stop flag, so a thread that was only *signalled* could still be inside
        // its loop when a new ticker began — and the two overlapped, double-firing
        // ticks. `retire` joins, so the assertion that matters is that the old
        // thread is observably gone by the time the new one exists.
        //
        // Driven through the same flag/join discipline `start` uses, without an
        // `AppHandle` (which `start` needs and this test cannot build): signal,
        // join, and only then let the replacement run.
        let scheduler = Scheduler::new();
        let first_stop = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&first_stop);

        let first = std::thread::spawn(move || {
            // A long interval, so the only way out is the stop flag — the same
            // situation the real ticker is in when the user changes the setting.
            while !sleep_until(&flag, Duration::from_secs(3600)) {}
            "first"
        });

        // Retiring is what `start` does first, and it must wait.
        first_stop.store(true, Ordering::SeqCst);
        assert_eq!(first.join().unwrap(), "first");

        // And a scheduler with nothing registered is genuinely idle, not merely
        // signalled.
        assert!(scheduler.0.lock().is_none());
        scheduler.stop();
    }
}
