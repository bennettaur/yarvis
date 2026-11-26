/// The app's own commands. `build.rs` includes this file and turns each one
/// into a permission (`allow-<command>`), so a command is callable only from an
/// origin whose capability names it: the connect page's in
/// `capabilities/default.json`, the server's page's in `server_link.rs`. A
/// command missing here is refused from every origin, so a command added to
/// `generate_handler!` in `lib.rs` goes here too.
pub const COMMANDS: &[&str] = &[
    "get_server_connection",
    "get_connection_settings",
    "save_connection_settings",
    "open_server",
    "fire_alarm",
    "release_alarm",
    "clipboard_history",
    "clipboard_clear_history",
    "clipboard_write",
    "focus_main_window",
];
