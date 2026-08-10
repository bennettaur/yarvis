//! Alarms with a full-screen takeover.
//!
//! Alarms live in the Rust core so they fire reliably even when the window is
//! hidden (the webview is throttled in the background). A scheduler task checks
//! for due alarms; when one fires it takes over the main window (fullscreen +
//! always-on-top + focus), shows a notification, plays an escalating sound, and
//! emits an event the frontend renders as a full-screen overlay.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::Rng;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::sync::Notify;
use tokio::time::sleep;

/// Seconds after firing before the alert escalates (more frequent, louder).
const ESCALATE_AFTER_SECS: i64 = 60;
const SCHEDULER_TICK: Duration = Duration::from_secs(1);

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

pub struct AlarmState {
    alarms: Mutex<Vec<Alarm>>,
    path: PathBuf,
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

fn random_id() -> String {
    let mut bytes = [0u8; 8];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl AlarmState {
    fn load(path: PathBuf) -> Self {
        let alarms = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<Alarm>>(&s).ok())
            .unwrap_or_default();
        Self {
            alarms: Mutex::new(alarms),
            path,
            stops: Mutex::new(HashMap::new()),
            firing: Mutex::new(HashSet::new()),
        }
    }

    fn save(&self) {
        if let Ok(alarms) = self.alarms.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*alarms) {
                // Atomic write: serialize to a sibling file then rename over the
                // target so a crash mid-write can't leave alarms.json truncated.
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, &self.path);
                }
            }
        }
    }
}

/// Initializes alarm state and starts the scheduler. Call from `setup`.
pub fn init<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    let state = AlarmState::load(dir.join("alarms.json"));
    app.manage(state);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        scheduler(handle).await;
    });
    Ok(())
}

async fn scheduler<R: Runtime>(app: AppHandle<R>) {
    loop {
        sleep(SCHEDULER_TICK).await;
        let state = app.state::<AlarmState>();
        let now = now_ms();

        // Collect alarms that just came due, marking them fired under the lock.
        let mut due: Vec<Alarm> = Vec::new();
        if let Ok(mut alarms) = state.alarms.lock() {
            for alarm in alarms.iter_mut() {
                if alarm.status == "scheduled" && alarm.fire_at_ms <= now {
                    alarm.status = "fired".to_string();
                    due.push(alarm.clone());
                }
            }
        }
        if due.is_empty() {
            continue;
        }
        state.save();
        for alarm in due {
            fire(&app, alarm);
        }
    }
}

fn fire<R: Runtime>(app: &AppHandle<R>, alarm: Alarm) {
    if let Ok(mut firing) = app.state::<AlarmState>().firing.lock() {
        firing.insert(alarm.id.clone());
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
    // scheduler must have marked the alarm fired before emitting — see
    // `handleFired` in src/lib/alarmStore.ts.
    let _ = app.emit("alarm-fired", &alarm);
    let _ = notify(app, &alarm);

    if alarm.sound {
        let stop = Arc::new(Notify::new());
        if let Ok(mut stops) = app.state::<AlarmState>().stops.lock() {
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
/// other alarm is still firing. Alarms set for the same minute all fire in one
/// scheduler tick, so dealing with the first must not drop the takeover the
/// others still need to stay reachable. An alarm that wasn't firing (an upcoming
/// one being cancelled, or one left over from a previous run) leaves the window
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

fn set_status<R: Runtime>(app: &AppHandle<R>, id: &str, status: &str) {
    let state = app.state::<AlarmState>();
    if let Ok(mut alarms) = state.alarms.lock() {
        if let Some(alarm) = alarms.iter_mut().find(|a| a.id == id) {
            alarm.status = status.to_string();
        }
    }
    state.save();
}

// --- Commands ---

#[tauri::command]
pub fn list_alarms(state: tauri::State<'_, AlarmState>) -> Vec<Alarm> {
    state.alarms.lock().map(|a| a.clone()).unwrap_or_default()
}

#[tauri::command]
pub fn create_alarm(
    state: tauri::State<'_, AlarmState>,
    label: String,
    fire_at_ms: i64,
    sound: Option<bool>,
    meet_link: Option<String>,
) -> Result<Alarm, String> {
    let alarm = Alarm {
        id: random_id(),
        label,
        fire_at_ms,
        sound: sound.unwrap_or(true),
        meet_link,
        status: "scheduled".to_string(),
    };
    if let Ok(mut alarms) = state.alarms.lock() {
        alarms.push(alarm.clone());
    }
    state.save();
    Ok(alarm)
}

#[tauri::command]
pub fn cancel_alarm<R: Runtime>(app: AppHandle<R>, id: String) {
    stop_ringing(&app, &id);
    // Cancel can reach an alarm that is already firing, and leaving its id in
    // the firing set would mean the window is never handed back at all.
    release_firing(&app, &id);
    set_status(&app, &id, "cancelled");
}

#[tauri::command]
pub fn acknowledge_alarm<R: Runtime>(app: AppHandle<R>, id: String) {
    stop_ringing(&app, &id);
    release_firing(&app, &id);
    set_status(&app, &id, "acknowledged");
}

#[tauri::command]
pub fn snooze_alarm<R: Runtime>(app: AppHandle<R>, id: String, minutes: i64) {
    stop_ringing(&app, &id);
    release_firing(&app, &id);
    let state = app.state::<AlarmState>();
    if let Ok(mut alarms) = state.alarms.lock() {
        if let Some(alarm) = alarms.iter_mut().find(|a| a.id == id) {
            alarm.fire_at_ms = now_ms() + minutes * 60_000;
            alarm.status = "scheduled".to_string();
        }
    }
    state.save();
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
        // Two alarms set for the same time fire in one tick; dealing with the
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

    // --- Command-level tests against a mock app ---
    //
    // These drive the real commands so the wiring is covered, not just the set
    // arithmetic: deleting `fire`'s registration or reverting a command to an
    // unconditional `restore_window` has to fail something.

    fn alarm(id: &str) -> Alarm {
        Alarm {
            id: id.to_string(),
            label: format!("alarm {id}"),
            fire_at_ms: now_ms(),
            // Silent: a ringing alarm spawns an `afplay` loop we don't want in
            // a test, and the firing set is deliberately independent of sound.
            sound: false,
            meet_link: None,
            status: "scheduled".to_string(),
        }
    }

    /// A mock app with alarm state managed over a scratch file.
    fn app_with_alarms(alarms: Vec<Alarm>) -> tauri::App<MockRuntime> {
        // The notification plugin has to be registered: `fire` shows one, and
        // `app.notification()` panics if the plugin's state was never managed.
        let app = mock_builder()
            .plugin(tauri_plugin_notification::init())
            .build(mock_context(noop_assets()))
            .expect("mock app");
        // Unique per test: `save()` writes through on every status change, and
        // parallel tests would otherwise interleave on one path.
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("yarvis-alarms-test-{n}.json"));
        let state = AlarmState::load(path);
        *state.alarms.lock().unwrap() = alarms;
        app.manage(state);
        app
    }

    /// Mirrors the scheduler: mark the stored alarm fired, then take the window.
    fn fire_due(app: &tauri::AppHandle<MockRuntime>, id: &str) {
        let state = app.state::<AlarmState>();
        let due = {
            let mut alarms = state.alarms.lock().unwrap();
            let alarm = alarms.iter_mut().find(|a| a.id == id).expect("alarm");
            alarm.status = "fired".to_string();
            alarm.clone()
        };
        fire(app, due);
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

    fn status_of(app: &tauri::AppHandle<MockRuntime>, id: &str) -> String {
        app.state::<AlarmState>()
            .alarms
            .lock()
            .unwrap()
            .iter()
            .find(|a| a.id == id)
            .map(|a| a.status.clone())
            .unwrap_or_default()
    }

    #[test]
    fn firing_registers_the_alarm_as_holding_the_takeover() {
        let app = app_with_alarms(vec![alarm("a")]);
        let handle = app.handle().clone();

        fire_due(&handle, "a");

        assert_eq!(firing_ids(&handle), vec!["a".to_string()]);
    }

    #[test]
    fn acknowledging_one_of_two_leaves_the_other_holding_the_takeover() {
        // The server-side half of issue #201: the first acknowledgement used to
        // restore the window unconditionally, dropping the takeover the second
        // alarm still needed.
        let app = app_with_alarms(vec![alarm("a"), alarm("b")]);
        let handle = app.handle().clone();
        fire_due(&handle, "a");
        fire_due(&handle, "b");

        acknowledge_alarm(handle.clone(), "a".to_string());

        assert_eq!(firing_ids(&handle), vec!["b".to_string()]);
        assert_eq!(status_of(&handle, "a"), "acknowledged");
        assert_eq!(status_of(&handle, "b"), "fired");

        acknowledge_alarm(handle.clone(), "b".to_string());
        assert!(firing_ids(&handle).is_empty());
    }

    #[test]
    fn snoozing_releases_the_takeover_and_reschedules() {
        let app = app_with_alarms(vec![alarm("a")]);
        let handle = app.handle().clone();
        fire_due(&handle, "a");

        snooze_alarm(handle.clone(), "a".to_string(), 5);

        assert!(firing_ids(&handle).is_empty());
        assert_eq!(status_of(&handle, "a"), "scheduled");
    }

    #[test]
    fn cancelling_a_firing_alarm_releases_the_takeover() {
        let app = app_with_alarms(vec![alarm("a")]);
        let handle = app.handle().clone();
        fire_due(&handle, "a");

        cancel_alarm(handle.clone(), "a".to_string());

        assert!(firing_ids(&handle).is_empty());
        assert_eq!(status_of(&handle, "a"), "cancelled");
    }
}
