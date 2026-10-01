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

/// The thread handle for the current ticker. Dropping the `Arc` it holds is
/// what stops the thread, so there is no explicit join to manage.
#[derive(Default)]
pub struct Scheduler(Mutex<Option<Arc<AtomicBool>>>);

impl Scheduler {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Retire the current ticker, if any.
    pub fn stop(&self) {
        if let Some(stop) = self.0.lock().take() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    /// Start ticking at `interval_secs`.
    pub fn start(&self, app: AppHandle, interval_secs: u64) {
        self.stop();
        let stop = Arc::new(AtomicBool::new(false));
        *self.0.lock() = Some(Arc::clone(&stop));

        let interval = Duration::from_secs(interval_secs.clamp(MIN_INTERVAL_SECS, MAX_INTERVAL_SECS));

        std::thread::Builder::new()
            .name("winnow-sync".into())
            .spawn(move || {
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
            })
            .ok();
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

        assert!(stopped, "the flag was set mid-sleep, so this should report a stop");
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
}
