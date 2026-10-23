//! Ringing alarms with a full-screen takeover.
//!
//! The sidecar owns the alarm list and decides when one is due
//! (`sidecar/src/alarms/scheduler.ts`), then asks the core over the control
//! channel to ring it. Ringing lives here because only the core can take over
//! the window and play sound reliably while the webview is hidden and
//! throttled. When an alarm fires the core takes over the main window
//! (fullscreen + always-on-top + focus), shows a notification, plays an
//! escalating sound, and emits an event the frontend renders as a full-screen
//! overlay. It rings until the alarm is released: acknowledged, snoozed or
//! cancelled, from the webview or the sidecar.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Notify;
use tokio::time::sleep;

/// Seconds after firing before the alert escalates (more frequent, louder).
const ESCALATE_AFTER_SECS: i64 = 60;

/// An alarm as the sidecar sends it and the frontend's takeover reads it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    pub label: String,
    pub fire_at_ms: i64,
    #[serde(default = "default_true")]
    pub sound: bool,
    /// Join URL for a meeting-derived alarm, so the takeover can offer a
    /// "Join meeting" action. Absent for manually created alarms.
    #[serde(default)]
    pub meet_link: Option<String>,
    /// "scheduled" | "fired" | "acknowledged" | "cancelled"
    pub status: String,
}

fn default_true() -> bool {
    true
}

#[derive(Default)]
pub struct AlarmState {
    /// Stop signals for currently-ringing alarms, keyed by alarm id.
    stops: Mutex<HashMap<String, Arc<Notify>>>,
    /// Alarms that fired this run and still hold the window takeover. Tracked
    /// separately from `stops` because a silent alarm takes the window over
    /// without registering a ring loop, and the window may only be restored
    /// once *every* firing alarm has been dealt with.
    firing: Mutex<HashSet<String>>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Manages the ringing state. Call from `setup` before the control channel
/// opens, so a fire request can never find it missing.
pub fn init<R: Runtime>(app: &AppHandle<R>) {
    app.manage(AlarmState::default());
}

/// The file this instance kept its alarms in before the sidecar owned them.
pub fn legacy_store_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("alarms.json"))
}

/// Takes over the window and rings `alarm` until it is released.
pub fn fire<R: Runtime>(app: &AppHandle<R>, alarm: Alarm) {
    let state = app.state::<AlarmState>();
    if let Ok(mut firing) = state.firing.lock() {
        // Already ringing: the sidecar retried, and a second ring loop would
        // outlive the release that stops the first.
        if !firing.insert(alarm.id.clone()) {
            return;
        }
    }

    // Take over the main window on the main thread.
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_fullscreen(true);
            let _ = window.set_always_on_top(true);
            let _ = window.set_focus();
        }
    });

    // The frontend raises its takeover straight off this payload, so the
    // sidecar must have marked the alarm fired before asking for it — see
    // `handleFired` in src/lib/alarmStore.ts.
    let _ = app.emit("alarm-fired", &alarm);
    let _ = notify(app, &alarm);

    if alarm.sound {
        let stop = Arc::new(Notify::new());
        if let Ok(mut stops) = state.stops.lock() {
            stops.insert(alarm.id.clone(), stop.clone());
        }
        let fired_at = now_ms();
        tauri::async_runtime::spawn(async move {
            ring_until_stopped(stop, fired_at).await;
        });
    }
}

fn notify<R: Runtime>(app: &AppHandle<R>, alarm: &Alarm) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title("Alarm")
        .body(alarm.label.clone())
        .show()
        .map_err(|e| e.to_string())
}

/// Plays the alert sound on a loop until the stop signal fires, escalating
/// (shorter interval, higher volume) once past the escalation threshold.
async fn ring_until_stopped(stop: Arc<Notify>, fired_at: i64) {
    loop {
        let escalated = now_ms() - fired_at >= ESCALATE_AFTER_SECS * 1000;
        // afplay's failure is discarded below, so a missing sound file fails
        // silently with no fallback or log. Use only built-in macOS sounds
        // that ship across releases; Sonar.aiff is absent on current macOS,
        // which is why the escalated path uses Submarine.aiff.
        let (sound, volume, gap) = if escalated {
            (
                "/System/Library/Sounds/Submarine.aiff",
                "2",
                Duration::from_secs(2),
            )
        } else {
            (
                "/System/Library/Sounds/Ping.aiff",
                "1",
                Duration::from_secs(5),
            )
        };

        let _ = tokio::process::Command::new("afplay")
            .args(["-v", volume, sound])
            .spawn();

        tokio::select! {
            _ = stop.notified() => break,
            _ = sleep(gap) => {}
        }
    }
}

fn stop_ringing<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Ok(mut stops) = app.state::<AlarmState>().stops.lock() {
        if let Some(stop) = stops.remove(id) {
            stop.notify_one();
        }
    }
}

fn restore_window<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.set_fullscreen(false);
            let _ = window.set_always_on_top(false);
        }
    });
}

/// Drops an alarm from the firing set and hands the window back only once no
/// other alarm is still firing. Alarms set for the same minute all fire
/// together, so dealing with the first must not drop the takeover the others
/// still need to stay reachable. An alarm that wasn't firing (an upcoming one
/// being cancelled, or one left over from a previous run) leaves the window
/// alone entirely — it never took it over, and the user may have gone
/// full-screen themselves.
fn release_firing<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let state = app.state::<AlarmState>();
    let hand_back = match state.firing.lock() {
        Ok(mut firing) => remove_from_firing(&mut firing, id),
        // With the set unreadable there is no way to know who still holds the
        // window, so free it — a stuck full-screen, always-on-top window is
        // worse than dropping a takeover early.
        Err(_) => true,
    };
    if hand_back {
        restore_window(app);
    }
}

/// Removes `id` from the firing set, reporting whether that leaves the window
/// free to be handed back.
fn remove_from_firing(firing: &mut HashSet<String>, id: &str) -> bool {
    firing.remove(id) && firing.is_empty()
}

/// Stops an alarm ringing and gives up its hold on the window. Safe to call
/// for one that isn't ringing, and more than once: the webview and the sidecar
/// both release an alarm the user dealt with.
pub fn release<R: Runtime>(app: &AppHandle<R>, id: &str) {
    stop_ringing(app, id);
    release_firing(app, id);
}

// --- Commands ---

/// Called by the webview as soon as the user acknowledges, snoozes or cancels,
/// so the ringing stops even when the sidecar can't be reached.
#[tauri::command]
pub fn release_alarm<R: Runtime>(app: AppHandle<R>, id: String) {
    release(&app, &id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};

    fn firing_set(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn keeps_the_window_while_another_alarm_is_still_firing() {
        // Two alarms set for the same time fire together; dealing with the
        // first must leave the takeover up so the second stays reachable.
        let mut firing = firing_set(&["a", "b"]);
        assert!(!remove_from_firing(&mut firing, "a"));
        assert!(remove_from_firing(&mut firing, "b"));
    }

    #[test]
    fn hands_the_window_back_only_once_per_alarm() {
        // A repeated release must not report a second hand-back: the window
        // would be pulled out of a full-screen the user entered themselves.
        let mut firing = firing_set(&["a"]);
        assert!(remove_from_firing(&mut firing, "a"));
        assert!(!remove_from_firing(&mut firing, "a"));
    }

    #[test]
    fn leaves_the_window_alone_for_an_alarm_that_never_fired() {
        // Cancelling an upcoming alarm must not drag the window out of a
        // full-screen the user put it in themselves.
        let mut firing = HashSet::new();
        assert!(!remove_from_firing(&mut firing, "upcoming"));
    }

    // --- Tests against a mock app ---
    //
    // These drive the real fire/release paths so the wiring is covered, not
    // just the set arithmetic: deleting `fire`'s registration or reverting
    // `release` to an unconditional `restore_window` has to fail something.

    fn alarm(id: &str) -> Alarm {
        Alarm {
            id: id.to_string(),
            label: format!("alarm {id}"),
            fire_at_ms: now_ms(),
            // Silent: a ringing alarm spawns an `afplay` loop we don't want in
            // a test, and the firing set is deliberately independent of sound.
            sound: false,
            meet_link: None,
            status: "fired".to_string(),
        }
    }

    fn app() -> tauri::App<MockRuntime> {
        // The notification plugin has to be registered: `fire` shows one, and
        // `app.notification()` panics if the plugin's state was never managed.
        let app = mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(mock_context(noop_assets()))
            .expect("mock app");
        init(app.handle());
        app
    }

    fn firing_ids(app: &tauri::AppHandle<MockRuntime>) -> Vec<String> {
        let mut ids: Vec<String> = app
            .state::<AlarmState>()
            .firing
            .lock()
            .unwrap()
            .iter()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    #[test]
    fn firing_registers_the_alarm_as_holding_the_takeover() {
        let app = app();
        let handle = app.handle().clone();

        fire(&handle, alarm("a"));

        assert_eq!(firing_ids(&handle), vec!["a".to_string()]);
    }

    #[test]
    fn releasing_one_of_two_leaves_the_other_holding_the_takeover() {
        // The server-side half of issue #201: the first acknowledgement used to
        // restore the window unconditionally, dropping the takeover the second
        // alarm still needed.
        let app = app();
        let handle = app.handle().clone();
        fire(&handle, alarm("a"));
        fire(&handle, alarm("b"));

        release_alarm(handle.clone(), "a".to_string());
        assert_eq!(firing_ids(&handle), vec!["b".to_string()]);

        release_alarm(handle.clone(), "b".to_string());
        assert!(firing_ids(&handle).is_empty());
    }

    #[test]
    fn releasing_twice_is_harmless() {
        // The webview and the sidecar both release an alarm the user dealt with.
        let app = app();
        let handle = app.handle().clone();
        fire(&handle, alarm("a"));

        release(&handle, "a");
        release(&handle, "a");

        assert!(firing_ids(&handle).is_empty());
    }

    #[test]
    fn firing_the_same_alarm_twice_is_one_takeover() {
        // The sidecar retries a fire it didn't hear back about; one release
        // must still end it.
        let app = app();
        let handle = app.handle().clone();
        fire(&handle, alarm("a"));
        fire(&handle, alarm("a"));

        release(&handle, "a");

        assert!(firing_ids(&handle).is_empty());
        assert!(handle
            .state::<AlarmState>()
            .stops
            .lock()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn releasing_an_alarm_that_never_rang_does_nothing() {
        // The sidecar releases on every status change, ringing or not.
        let app = app();
        let handle = app.handle().clone();
        fire(&handle, alarm("a"));

        release(&handle, "unknown");

        assert_eq!(firing_ids(&handle), vec!["a".to_string()]);
    }
}
