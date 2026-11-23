# Client-server parity audit

This maps everything the old Tauri Rust core did on `main` to where it lives
in the client-server stack (PR #710 on #682), and names the test that covers
the new path. It is an audit: nothing here changes behaviour.

"Before" is `origin/main:src-tauri/src/`. "After" is this branch. The design
is in [client-server.md](client-server.md).

A test counts only if it runs the real new code path. Frontend suites that
stub Tauri `invoke`, `core()` or `serverFetch` don't count, and neither does a
generic test such as the scope table in `core_api.rs`. Where a command is
tested only by calling its server module directly, with no test sending the
HTTP request, the Notes say "route: scope table only".

Paths: `srv/` is `server/crates/yarvis-server/src/`, `srvt/` is
`server/crates/yarvis-server/tests/`, `tauri/` is `src-tauri/src/`, `e2e` is
`e2e/client-server.e2e.ts`.

## Summary

The old core had 49 `#[tauri::command]`s. The frontend called 48 of them;
`get_secret_status` was never called. It emitted four kinds of event to the
frontend (`alarm-fired`, `omni-chat-summon`, `clipboard-summon`, and PTY
output plus `pty-exit:{id}`) and listened for none. Main had no tray and no
deep links.

| Status | Rows |
|---|---|
| covered | 142 |
| moved, untested | 15 |
| dropped on purpose | 5 |
| missing | 0 |
| unsure | 1 |
| **total** | **163** |

The rows that matter most, riskiest first. The list holds the moved-untested
rows that could lose data or break a feature, plus the one unsure row, which
is the riskiest:

1. **Tauri IPC under the server's CSP** (unsure). The server's CSP has
   `connect-src 'self'` with no `ipc:` or `http://ipc.localhost`, which main's
   CSP had. If Tauri's postMessage fallback doesn't take over, every bridge
   command fails in the app: alarms, clipboard, hotkey events, notifications.
2. **Alarm ringing depends on the page** (moved, untested). On main the core
   rang an alarm straight from the control channel. Now the server only
   appends `alarm.fire`, and the page's JS has to call the `fire_alarm`
   bridge. If the window is on the connect page, the events socket is down, or
   the hidden webview is throttled, the alarm doesn't take over the window or
   ring. The JS step is tested only in `src/lib/alarms.test.ts`, which stubs
   `invoke`.
3. **Keychain backend** (moved, untested). I read the code and the service
   and account match main, but no test checks them. If they were wrong, an
   upgraded install would see an empty store. A test would need the real
   Keychain.
4. **Login `PATH` handed to the local server** (moved, untested). The app
   gives the server it starts the login shell's `PATH`. No test runs that
   hand-off. A server the app didn't start can now set `[server] path`
   instead, which is tested.

The rows left as moved, untested are the Keychain and `op` calls, which need
the real tools; two low-risk server rows, the free port pick and the
`YARVIS_DEBUG_*` pass-through; and the desktop shell's: the alarm page steps
for firing and releasing, the clipboard, hotkeys, `label_window`,
single-instance, autostart and the login `PATH` hand-off. Those need a manual check in a release build: ring an alarm
with the window hidden, copy and paste through the clipboard palette, press
both hotkeys, open a second copy and a `dev:instance`, and run `echo $PATH` in
a terminal of an app opened from Finder.

Loose ends from rows that are fine on their own:

- `get_sidecar_log_path` is dropped on purpose. Diagnostics no longer asks for
  it, and it and the docs name `logs/sidecar.log` under the server's data
  folder instead of a full path.
- The legacy `alarms.json` import is dropped on purpose (ce6ebfc1), and the
  sidecar's import code went with it. Someone upgrading from a build before
  #486 (October 2026) loses their alarms;
  `docs/features/calendar-and-alarms.md` says so.
- The startup Keychain migrations (legacy settings, the old embeddings item)
  now run only when `server.toml` leaves the backend unset or picks
  `keychain`. Main always ran them. No test runs `start_core`, which calls
  them.
- Most settings and secret commands are tested only at the module level.
  Only `set_secret`, `list_secret_status`, `get_settings`, `set_agent`,
  `set_max_pty_sessions`, `set_secret_backend` and `restart_sidecar` go
  through `/api/core` in a test. I checked the frontend's argument names against the server's
  argument structs by reading them, and they match.
- No frontend test counts for any row except `src/lib/pty.test.ts`, which
  drives the real PTY client against a fake socket. The e2e covers sign-in,
  devices, the terminal, the event stream and the vault's commit-signing
  approval. It asserts nothing about settings,
  secrets or alarms.

## Settings and secrets

Every command here is `POST /api/core/{command}` → `srv/core_api.rs:run`,
reached from the frontend through `core()` in `src/lib/core.ts`.

### Secret commands (`keychain.rs`)

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `set_secret` | `secret_blob.rs:SecretBlob::set_secret` | `srvt/sidecar.rs::secrets_are_written_by_admins_and_only_their_presence_is_read_back`, `::an_unknown_secret_key_is_a_400_naming_it`; `srvt/auth_flow.rs::a_backend_switch_needs_a_fresh_device_and_a_secret_write_does_not` | covered | HTTP. Needs `admin`, not fresh. |
| `get_secret_status` | `SecretBlob::get_secret_status` | `srv/secret_blob.rs::status_reports_presence_and_delete_removes` | covered | Route: scope table only. Never called by the frontend, on main or now. |
| `delete_secret` | `SecretBlob::delete_secret` | `srv/secret_blob.rs::status_reports_presence_and_delete_removes`, `::an_unknown_key_is_refused_for_every_operation` | covered | Route: scope table only. |
| `list_secret_status` | `SecretBlob::list_secret_status` | `srvt/sidecar.rs::secrets_are_written_by_admins_and_only_their_presence_is_read_back` | covered | HTTP. Checks no value comes back. |

### Custom provider, MCP and embeddings secret commands

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `list_custom_provider_secret_status` | `srv/custom_providers.rs` | `srv/custom_providers.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_providers`, `::the_status_serializes_with_the_camel_case_names_the_client_reads` | covered | Route: scope table only. |
| `set_custom_provider_secret` | `srv/custom_providers.rs` | `srv/custom_providers.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_providers`, `::reserved_and_unknown_slots_are_refused_without_writing`, `::a_failed_read_writes_nothing` | covered | Route: scope table only. A missing `value` is now a 400. |
| `delete_custom_provider_secret` | `srv/custom_providers.rs` | `srv/custom_providers.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_providers` | covered | Route: scope table only. |
| `delete_custom_provider_all_secrets` | `srv/custom_providers.rs` | `srv/custom_providers.rs::deleting_all_of_a_providers_secrets_leaves_the_others` | covered | Route: scope table only. |
| `list_mcp_secret_status` | `srv/mcp.rs` | `srv/mcp.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_entries` | covered | Route: scope table only. |
| `set_mcp_secret` | `srv/mcp.rs` | `srv/mcp.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_entries`, `::reserved_and_malformed_slots_are_refused_without_writing`, `::a_server_id_cannot_smuggle_a_path_or_separator` | covered | Route: scope table only. |
| `delete_mcp_secret` | `srv/mcp.rs` | `srv/mcp.rs::set_list_and_delete_keep_sibling_keys_and_prune_empty_entries` | covered | Route: scope table only. |
| `delete_mcp_all_secrets` | `srv/mcp.rs:delete_mcp_all_secrets` | `srv/mcp.rs::deleting_all_of_a_servers_secrets_leaves_the_others`, `::a_failed_read_writes_nothing` | covered | Route: scope table only. |
| `get_embeddings_secret_status` | `srv/embeddings_secrets.rs` | `srv/embeddings_secrets.rs::set_status_and_delete_round_trip_without_touching_siblings`, `::the_status_serializes_with_the_camel_case_names_the_client_reads` | covered | Route: scope table only. |
| `set_embeddings_secret` | `srv/embeddings_secrets.rs` | `srv/embeddings_secrets.rs::set_status_and_delete_round_trip_without_touching_siblings`, `::rejects_empty_or_unknown_slots` | covered | Route: scope table only. |
| `delete_embeddings_secret` | `srv/embeddings_secrets.rs` | `srv/embeddings_secrets.rs::set_status_and_delete_round_trip_without_touching_siblings` | covered | Route: scope table only. |

### Settings commands (`settings.rs`)

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `get_settings` | `srv/settings.rs:SettingsStore::view` | `srvt/sidecar.rs::settings_round_trip_in_the_frontends_shape`; `srv/settings.rs::the_view_carries_the_keys_the_frontend_reads` | covered | HTTP. Reads the file on every call; no cache. |
| `set_max_pty_sessions` | `SettingsStore` | `srvt/sidecar.rs::settings_round_trip_in_the_frontends_shape`; `srv/settings.rs::a_cap_out_of_range_is_rejected_and_nothing_is_stored`, `::a_stored_cap_survives_and_clearing_it_does_too` | covered | HTTP covers 0 → 400. |
| `set_agent` | `SettingsStore` | `srvt/sidecar.rs::settings_round_trip_in_the_frontends_shape`; `srv/settings.rs::a_blank_agent_field_clears_back_to_the_default`, `::a_control_character_in_the_agent_command_is_rejected` | covered | HTTP. |
| `set_agent_harnesses` | `SettingsStore::set_agent_harnesses` | `srv/settings.rs::a_harness_list_and_default_survive_and_the_built_in_is_stored_as_absent`, `::an_invalid_harness_list_is_rejected_and_nothing_is_stored`, `::a_dropped_secret_variable_loses_its_stored_value`, `::a_save_whose_dropped_secrets_cannot_be_cleared_stores_nothing` | covered | Route: scope table only. |
| `list_agent_harness_secret_status` | `SettingsStore` | `srv/settings.rs::a_harness_secret_is_written_only_for_a_declared_variable` | covered | Route: scope table only. |
| `set_agent_harness_secret` | `SettingsStore` | `srv/settings.rs::a_harness_secret_is_written_only_for_a_declared_variable`, `::removing_a_harness_secret_works_for_any_name_and_drops_an_emptied_entry` | covered | Route: scope table only. |
| `set_allowed_slash_commands` | `SettingsStore` | `srv/settings.rs::allowed_slash_commands_are_normalized_and_deduplicated`, `::a_slash_command_with_arguments_or_that_widens_the_session_is_rejected` | covered | Route: scope table only. |
| `set_azure_devops_org_url` | `set_text_field(AzureDevopsOrgUrl)` | `srv/settings.rs::a_blank_text_setting_clears_back_to_unset` | covered | Route: scope table only. |
| `set_jira_base_url` | `set_text_field(JiraBaseUrl)` | `srv/settings.rs::the_jira_and_google_fields_are_stored_and_reach_the_sidecar` | covered | Route: scope table only. Checks the value reaches the sidecar as `JIRA_BASE_URL`. |
| `set_jira_email` | `set_text_field(JiraEmail)` | `srv/settings.rs::a_save_keeps_the_sidecar_sections_and_clears_what_it_clears` | covered | Clear path only. Route: scope table only. |
| `set_google_client_id` | `set_text_field(GoogleClientId)` | `srv/settings.rs::the_jira_and_google_fields_are_stored_and_reach_the_sidecar` | covered | Route: scope table only. Checks the value reaches the sidecar as `GOOGLE_CLIENT_ID`. |
| `set_telegram_otp_window_minutes` | `SettingsStore` | `srv/settings.rs::small_settings_round_trip_and_zero_is_rejected` | covered | Route: scope table only. |
| `set_color_theme` | `set_text_field(ColorTheme)` | `srv/settings.rs::small_settings_round_trip_and_zero_is_rejected` | covered | Route: scope table only. |
| `set_terminal_font_size` | `SettingsStore` | `srv/settings.rs::small_settings_round_trip_and_zero_is_rejected`, `::a_setter_keeps_what_another_process_wrote_since` | covered | Route: scope table only. |
| `set_channel_messaging` | `SettingsStore` | `srv/settings.rs::small_settings_round_trip_and_zero_is_rejected` | covered | Route: scope table only. |
| `set_attention_animation` | `SettingsStore` | `srv/settings.rs::small_settings_round_trip_and_zero_is_rejected` | covered | Route: scope table only. |
| `set_secret_backend` | `Fresh<Admin>` → `SettingsStore::set_secret_backend` | `srvt/auth_flow.rs::a_backend_switch_needs_a_fresh_device_and_a_secret_write_does_not`; `srvt/sidecar.rs::switching_to_a_backend_server_toml_did_not_choose_is_a_409`; `srv/settings.rs::a_backend_other_than_the_configured_one_is_refused`, `::a_onepassword_switch_needs_a_vault_and_an_item`, `::with_no_configured_backend_settings_hold_the_choice`, `::re_saving_the_same_item_is_unchanged` | covered | Guards and refusals tested. A real switch that copies secrets isn't; see the next table. |

### Secrets blob, locking and backends

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `keychain.rs` one JSON blob, `SECRET_KEYS` allowlist | `srv/secret_blob.rs:SECRET_KEYS`, `check_known` | `srv/secret_blob.rs::an_unknown_key_is_refused_for_every_operation`, `::writing_one_key_preserves_every_other` | covered | `database_url` left the list; see below. |
| `read_root` is fallible; a failed read writes nothing | `SecretBlob::read_root`, `update_root_locked` | `srv/secret_blob.rs::a_failed_read_names_the_store_and_writes_nothing`, `::an_absent_or_unparseable_blob_reads_as_an_empty_object`; each module's `a_failed_read_writes_nothing` | covered | |
| `lock_for_write`, in-process mutex | `SecretBlob::lock_for_write` | `srv/secret_blob.rs::concurrent_writers_keep_every_change` | covered | |
| `~/.yarvis/secrets.lock`, 180s wait | `srv/secret_blob.rs:lock_file`; `SettingsStore::secrets_lock_path` | `srv/secret_blob.rs::the_lock_file_shuts_out_a_second_holder_until_released`, `::the_write_lock_holds_the_shared_lock_file`; `srv/settings.rs::the_secrets_lock_sits_beside_the_settings_file` | covered | Always taken now; main skipped it when the settings path was unknown. |
| `update_root` / `update_subtree`; a no-op edit writes nothing | `SecretBlob::update_root`, `update_subtree`, `edit_subtree` | `srv/secret_blob.rs::an_edit_that_changes_nothing_writes_nothing`, `::a_subtree_edit_keeps_sibling_keys`, `::a_subtree_edit_that_changes_nothing_writes_nothing`, `::a_subtree_that_is_not_an_object_reads_as_empty` | covered | |
| `store_github_token` validation | `SecretBlob::store_github_token` | `srv/secret_blob.rs::a_github_token_must_be_one_printable_word` | covered | The control method is under "Control channel". |
| `secret_store.rs::active`: `secretBackend` in settings picks the store | `SecretBlob::from_config`, `active` | `srv/secret_blob.rs::an_unset_backend_follows_settings`, `::onepassword_without_an_item_is_an_error_not_the_keychain` | covered | `server.toml` can now override it, and there is a `vault` backend. |
| Keychain store (service `com.mikebennett.yarvis`, account `secrets`) | `srv/secret_store/keychain.rs:KeychainBackend` | none | moved, untested | Same service and account, by reading. No test on main either. A test would need the real Keychain. |
| `onepassword.rs` `op` read, edit-then-create write, blob on stdin, missing vault vs item | `srv/secret_store/onepassword.rs` | `srv/secret_store/onepassword.rs::a_read_asks_for_the_reference_without_a_trailing_newline`, `::no_argument_of_either_write_carries_the_blob`, `::an_existing_item_is_edited_and_never_created`, `::a_missing_item_is_created_carrying_the_same_blob`, `::a_missing_vault_is_reported_rather_than_created_into`, `::an_absent_vault_is_recognised_and_is_not_an_absent_item` | covered | Main's tests moved with the same names. Injected runner; no test calls the real `op`. |
| `ItemRef` validation | `onepassword.rs:ItemRef::new` | `srv/secret_store/onepassword.rs::a_blank_or_reference_separating_part_is_rejected`, `::a_leading_dash_is_rejected`, `::parts_are_trimmed` | covered | |
| `onepassword::probe` before a switch | `onepassword.rs:probe` | none | moved, untested | Calls the real `op`. No test on main either. That a failed probe stops the switch is tested: `srv/settings.rs::a_failed_probe_copies_and_saves_nothing`. |
| `copy_secrets` on a backend switch | `srv/settings.rs:copy_secrets` | `srv/settings.rs::an_empty_target_receives_the_source_blob`, `::nothing_is_copied_from_an_empty_source`, `::an_occupied_target_is_left_alone`, `::an_unreachable_or_unwritable_target_is_reported` | covered | The copy step alone. No test runs a whole switch. |
| Switch order: reach, copy, then save under the lock | `SettingsStore::set_secret_backend` | `srv/settings.rs::re_saving_the_same_item_is_unchanged`, `::with_no_configured_backend_settings_hold_the_choice` | covered | Only the unchanged path. |
| First 1Password item filled from the Keychain | `SettingsStore::set_secret_backend` (`current = Target::Keychain`) | `srv/settings.rs::the_first_onepassword_item_is_filled_from_the_keychain`, `::a_failed_probe_copies_and_saves_nothing` | covered | The stores and the probe are fakes passed to `set_secret_backend_with`. |
| The desktop app switches the backend itself | `set_secret_backend` needs a fresh device (`core_api.rs:FRESH_COMMANDS`) | `srvt/auth_flow.rs::a_backend_switch_needs_a_fresh_device_and_a_secret_write_does_not` | dropped on purpose | The local app's CLI-made token is never fresh, so only a signed-in browser can switch. `docs/client-server.md:886-891`; PR #682. |

### Startup and `settings.json`

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `settings::init`: create `~/.yarvis` as 0700 | `srv/main.rs:start_core` → `SettingsStore::ensure_dir`, `default_path` | `srv/settings.rs::the_settings_folder_is_created_private` | covered | The call from `start_core` isn't tested. |
| `migrate_legacy_app_data_file`: move `settings.json` from the app-data folder to `~/.yarvis` | `tauri/legacy_settings.rs:migrate`, from `tauri/server_link.rs:start_local` before the local server starts | `tauri/legacy_settings.rs::an_old_file_moves_into_a_fresh_yarvis_folder`, `::settings_already_in_place_are_never_replaced`, `::with_no_old_file_nothing_is_created` | covered | In the app, since only it knows its app-data folder. The call from `start_local` isn't tested. Only a build from before #277 (September 2026) is affected. |
| `migrate_keychain_settings`: legacy non-secret values off the Keychain, once | `SettingsStore::migrate_keychain_settings` from `start_core` | `srv/settings.rs::legacy_keychain_values_are_migrated_and_secrets_stay`, `::migration_never_overwrites_and_discards_a_bad_otp_window`, `::the_migration_moves_values_out_of_the_keychain_once`, `::an_unreadable_keychain_skips_the_migration_until_next_time`, `::a_keychain_that_cannot_be_cleared_still_keeps_the_migrated_values` | covered | The call from `start_core` isn't tested, and it's skipped when `server.toml` picks `onepassword` or `vault`. |
| `embeddings_secrets::migrate_legacy_item` | `srv/embeddings_secrets.rs:migrate_legacy_item` from `start_core` | `srv/embeddings_secrets.rs::migration_moves_the_legacy_value_in_sets_the_flag_and_deletes_the_old_item`, `::migration_never_overwrites_a_value_already_in_the_shared_item`, `::migration_with_no_legacy_item_still_sets_the_flag_and_runs_once`, `::a_failed_write_keeps_the_legacy_item`, `::migration_writes_nothing_when_the_shared_item_is_unreadable` | covered | Fake legacy item; the real keyring one isn't tested. Skipped under the same condition as the row above. |
| `save`: atomic rename, 0600, sidecar sections kept | `srv/settings.rs:save` | `srv/settings.rs::a_save_keeps_the_sidecar_sections_and_clears_what_it_clears` | covered | 0600 not asserted, now or on main. |
| Re-read before each setter | `SettingsStore::update` | `srv/settings.rs::a_setter_keeps_what_another_process_wrote_since` | covered | |
| Malformed or missing file reads as defaults | `settings.rs:read_from_disk` | `srv/settings.rs::a_malformed_file_reads_as_defaults` | covered | |
| View defaults (PTY cap, agent name and command, OTP 120, default slash commands) | `SettingsView`, `agent_policy` | `srv/settings.rs::the_view_carries_the_keys_the_frontend_reads` | covered | |
| Validation of each setting | `SettingsStore::set_*`, `agent_policy` | see the command rows | covered | |

### Database URL

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `database_url` as a secret, set from Settings and onboarding | Removed from `SECRET_KEYS`; `set_secret` with it is a 400 | `srv/secret_blob.rs::an_unknown_key_is_refused_for_every_operation` | dropped on purpose | The server needs it at boot, before sign-in. 4417669b (PR #710); `docs/client-server.md:343-345`. |
| Reading it for the sidecar | `srv/database_url.rs:resolve`: env, `server.toml`, legacy blob, default | `srv/database_url.rs::the_env_var_beats_the_config_file_which_beats_the_secret_store`, `::the_secret_store_is_only_read_when_nothing_else_names_a_database`, `::a_vault_install_never_reads_the_secret_store_and_gets_the_default`, `::a_secret_store_that_cant_be_read_stops_the_server_rather_than_using_the_default`, `::a_password_never_shows` | covered | The hand-off to the sidecar is under "Sidecar". |
| Settings shows whether it is set | `POST /api/core/get_database_info` | `srvt/http.rs::settings_see_where_the_database_url_came_from_but_never_its_password` | covered | Masked URL and its source. |

## PTY sessions

### Commands (`pty.rs`)

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `pty_attach` | `GET /api/pty/{id}` WebSocket → `srv/pty/ws.rs`, `PtyManager::attach_or_spawn` | `srvt/pty_ws.rs::attaching_spawns_a_shell_and_streams_its_output`, `::a_client_resuming_from_its_offset_gets_exactly_what_it_missed`, `::an_offset_older_than_the_scrollback_gets_a_flagged_snapshot`, `::an_exit_reaches_clients_after_the_last_byte_and_the_event_log`; e2e "terminal: run a command, then resume the scrollback after a reload" | covered | `POST /api/core/pty_attach` is a 404 on purpose (`the_core_commands_drive_and_report_on_a_session`). |
| `pty_write` | WS input, `POST /api/core/pty_write` → `PtyManager::write` | `srvt/pty_ws.rs::two_clients_see_the_same_stream_and_either_can_type`, `::input_over_the_write_limit_closes_the_socket`, `::the_core_commands_drive_and_report_on_a_session`, `::every_core_command_needs_its_scope` | covered | Needs `terminal`. |
| `pty_resize` | WS `resize`/`focus`, `POST /api/core/pty_resize` | `srvt/pty_ws.rs::the_core_commands_drive_and_report_on_a_session`, `::the_first_client_owns_the_size_and_a_later_one_waits_its_turn`, `::focus_and_resize_move_the_size_to_that_client` | covered | Size ownership across clients is new. |
| `pty_kill` | `POST /api/core/pty_kill` | `srvt/pty_ws.rs::the_core_commands_drive_and_report_on_a_session` | covered | |
| `pty_exists` | `POST /api/core/pty_exists` | `srvt/pty_ws.rs::the_core_commands_drive_and_report_on_a_session` | covered | |
| `pty_start_claude` | `POST /api/core/pty_start_claude` → `PtyManager::spawn_claude_session` | `srvt/pty_ws.rs::pty_start_claude_launches_the_configured_agent`, `::every_core_command_needs_its_scope` | covered | `workspaceId` is now validated here too. |
| `pty_is_busy` | `POST /api/core/pty_is_busy` | `srvt/pty_ws.rs::the_core_commands_drive_and_report_on_a_session` | covered | |
| `get_agent_config` | `POST /api/core/get_agent_config` | `srvt/pty_ws.rs::the_core_commands_drive_and_report_on_a_session`, `::pty_start_claude_launches_the_configured_agent` | covered | Now needs `terminal`, since a command can carry an inline secret. |
| `pty_session_harness` | `POST /api/core/pty_session_harness` | `srvt/pty_ws.rs::pty_start_claude_launches_the_configured_agent`, `::the_core_commands_drive_and_report_on_a_session` | covered | |

### Events

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `pty-output:{id}` event `{offset, bytes}` | Binary WS frames on `/api/pty/{id}` (8-byte offset + bytes), `resync` for slow clients | `srvt/pty_ws.rs::attaching_spawns_a_shell_and_streams_its_output`, `::a_client_that_stops_reading_is_resynced_without_holding_up_the_other`; e2e terminal test | covered | |
| `pty-exit:{id}` event | WS `exit` message with the code, then close; `pty.exited` on `/api/events` | `srvt/pty_ws.rs::an_exit_reaches_clients_after_the_last_byte_and_the_event_log` | covered | Nothing in `src/` subscribes to `pty.exited`; terminals use the WS `exit`. |
| `src/lib/pty.ts` over `listen` and `invoke` | One WS per session, `core("pty_*")` for the rest | `src/lib/pty.test.ts` › "the PTY socket client" (4 tests, real client, fake socket); e2e terminal test | covered | Component suites stub `lib/pty` and don't count. |

### Session lifecycle and environment

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| Session cap (60 default, 1000 max), checked before and after spawn | `srv/agent_policy.rs:resolve_max_sessions`; `PtyManager::spawn_into_state` | `srvt/pty_ws.rs::the_session_cap_refuses_one_more_shell`; `srv/agent_policy.rs::resolve_max_sessions_falls_back_or_clamps` | covered | |
| 1 MiB scrollback with stream offsets | `srv/pty/session.rs:Inner::append` | `srv/pty/session.rs::append_*` (7 tests); `srvt/pty_ws.rs::an_offset_older_than_the_scrollback_gets_a_flagged_snapshot` | covered | |
| Two spawns racing for one id: the loser is killed | `spawn_into_state` | `srvt/pty_ws.rs::racing_spawns_for_one_id_leave_one_shell` | covered | The race can't be forced, so it runs 10 times and counts the shells left. Fails with the kill removed. |
| Dead session reaped on the next attach | `PtyManager::reap` | `srvt/pty_ws.rs::an_exit_reaches_clients_after_the_last_byte_and_the_event_log` | covered | |
| Sidecar session env (`YARVIS_SIDECAR_PORT`, attention token, session key and HMAC token, MCP token, workspace id) | `srv/pty/env.rs:session_env`, `session_token` | `srv/pty/env.rs::session_env_populates_workspace_claude_sessions` and 8 more | covered | Derivation only; that a real shell gets them isn't tested, as on main. |
| `YARVIS_AGENT_HARNESS` and its token | `PtyManager::spawn_session`; `env.rs:harness_token` | `srv/pty/env.rs::harness_token_matches_the_sidecars_known_answer`, `::harness_token_is_bound_to_the_session_and_the_harness` | covered | Derivation only. |
| `ANTHROPIC_API_KEY` stripped for agent and review sessions | `PtyManager::spawn_session` | `srvt/pty_env.rs::sessions_never_get_the_servers_database_url_and_agents_not_its_api_key` | covered | Also checks `YARVIS_DATABASE_URL` is stripped from every shell and a plain terminal keeps the key. Only the agent session is run. A review session's launch line also drops the key with `env -u` (`REVIEW_SESSION_UNSET_ENV`, tested in `srv/pty/review.rs`), so a test there couldn't tell the two apart. |
| `SSH_AUTH_SOCK` inherited from the app | `env.rs:ssh_auth_sock` from `[ssh_agent]` | `srv/pty/env.rs::with_the_agent_off_sessions_get_the_upstream_socket_or_the_servers_own`, `::with_the_agent_on_sessions_get_only_the_servers_agent`; `srvt/pty_ws.rs::shells_get_the_upstream_agent_or_the_servers_own`; e2e terminal test | covered | |
| `TERM`, `$SHELL` or `/bin/zsh`, cwd or `$HOME` | `spawn_session` | `srvt/pty_ws.rs::the_session_list_shows_what_a_terminal_device_can_attach_to` (cwd) | covered | `TERM` not asserted. |
| `raise_fd_limit` at startup | `srv/pty/process.rs:raise_fd_limit` from `srv/main.rs:serve` | `srv/pty/process.rs::raises_a_low_inherited_soft_limit` and 4 more | covered | The call site isn't tested, as on main. |
| Shells end when the app quits | `PtyManager::kill_all` on server shutdown | `srvt/pty_ws.rs::racing_spawns_for_one_id_leave_one_shell` (its end) | covered | The call in `srv/main.rs:serve` isn't tested. |

### Review session (`review-claude:`)

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `review_session_id`, `refuse_plain_review_shell` | `srv/pty/review.rs` | `srv/pty/review.rs::refuses_a_plain_shell_under_a_review_id`, `::is_review_session_matches_only_review_ids`; `srvt/pty_ws.rs::a_review_id_never_gets_a_plain_shell` | covered | |
| Launch line (`exec_claude_program`, `review_launch_command`, `MAX_LAUNCH_LINE_BYTES`) | `srv/pty/review.rs` | `srv/pty/review.rs::exec_claude_program_drops_the_agent_commands_own_flags`, `::review_launch_command_loads_the_repos_config_only_when_asked`, `::review_launch_line_fits_what_a_fresh_shell_reads` | covered | |
| `REVIEW_SESSION_UNSET_ENV` | `srv/pty/review.rs` | `srv/pty/review.rs::exec_claude_program_drops_the_agent_commands_own_flags` | covered | Same list as main. |
| Settings file (`.review/<id>/.ask-claude`, 0600, temp then rename) | `srv/pty/review.rs` | `srv/pty/review.rs::review_settings_add_the_checkouts_and_keep_the_rest`, `::review_files_go_in_the_workspace_folder_and_replace_a_link` | covered | |
| Folder checks (`check_review_spawn`) | `srv/pty/review.rs` | `srv/pty/review.rs::check_review_spawn_refuses_an_unsafe_or_malformed_spawn` | covered | |
| No sidecar tokens for review ids | `env.rs:session_env` | `srv/pty/env.rs::a_review_session_gets_no_sidecar_tokens` | covered | |
| `spawn_review_claude_session`: leave a running one alone, replace a dead one, write the prompt file | `PtyManager::spawn_review_claude_session` | `srvt/control_socket.rs::claude_spawn_review_starts_one_session_and_kill_review_ends_it` | covered | A fake `claude`. |

### Agent launch policy and input guards

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| Agent command (default, `YARVIS_CLAUDE_COMMAND`, blank is unset, control chars stripped) | `srv/agent_policy.rs:resolve_agent_command` | `srv/agent_policy.rs::resolve_agent_command_uses_the_default_when_nothing_is_set`, `::resolve_agent_command_lets_the_env_override_outrank_the_setting`, `::resolve_agent_command_treats_a_blank_value_as_unset`, `::resolve_agent_command_strips_control_characters_from_either_source` | covered | |
| Agent name | `agent_policy::resolve_agent_name` | `srv/agent_policy.rs::a_blank_agent_name_is_the_default` | covered | |
| Harness settings and secret env read at launch | `PtyManager::harness_settings`, `launch_harness` | `srv/harness.rs::secret_env_is_read_for_the_harness_and_a_missing_value_is_an_error` | covered | Not run end to end for an interactive launch. |
| `harness.rs` (resolve, validate, program, prompt args) | `srv/harness.rs` | All 29 old tests present by name in `srv/harness.rs` | covered | |
| `check_assistant_may_launch` | `srv/harness.rs`, `PtyManager::check_sidecar_harness` | `srv/harness.rs::the_assistant_may_start_only_the_default_the_builtin_and_opted_in_harnesses`; `srv/control.rs::a_spawn_naming_a_harness_the_assistant_may_not_start_is_refused`; `srvt/control_socket.rs::claude_spawn_refuses_a_harness_the_assistant_may_not_start` | covered | The socket test only sends an unknown id; the unit tests cover a real harness that hasn't opted in. |
| Resume id (UUID only, Claude Code only, before the instruction) | `srv/pty/guards.rs` | `srv/pty/guards.rs::is_valid_resume_id_accepts_only_a_uuid`, `::check_resume_refuses_a_resume_the_agent_cannot_take`, `::agent_launch_command_resumes_a_session_before_any_instruction` | covered | |
| Remote Control flags and session name | `srv/pty/guards.rs` | `srv/pty/guards.rs::remote_control_command_*` (7), `::check_remote_control_needs_a_claude_code_harness` | covered | |
| `agent_launch_command` with an instruction | `srv/pty/guards.rs` | `srv/pty/guards.rs::agent_launch_command_appends_an_instruction_as_one_quoted_argument`, `::agent_launch_command_quotes_a_hostile_instruction_placed_by_prompt_args` and 3 more | covered | |
| `prepare_instruction` | `srv/pty/guards.rs` | `srv/pty/guards.rs::prepare_instruction_*` (4); `srvt/control_socket.rs::claude_send_types_only_at_the_registered_agent` | covered | |
| Slash command allowlist and refused list | `srv/agent_policy.rs`, `guards.rs:prepare_slash_command` | `srv/agent_policy.rs::the_defaults_and_the_user_list_are_both_allowed`, `::no_refused_command_is_a_default_and_a_namespaced_one_is_refused_too`; `srv/pty/guards.rs::prepare_slash_command_*` (4), `::a_command_that_widens_the_session_is_refused_even_when_listed` | covered | |
| `foreground_is_agent` (registered pid, else executable name) | `srv/pty/mod.rs:foreground_is_agent` | `srvt/control_socket.rs::claude_send_types_only_at_the_registered_agent` | covered | The executable-name fallback has no test, now or on main. |
| Type, pause, re-check, Enter | `PtyManager::submit_at_agent_prompt` | `srvt/control_socket.rs::a_send_whose_agent_exits_during_the_pause_is_not_submitted`, `::claude_send_types_only_at_the_registered_agent` | covered | |
| 64 KiB write cap | `srv/pty/mod.rs:MAX_WRITE_BYTES` | see `pty_write` | covered | |

## Control channel

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| Socket `core-control.sock`, 0700 folder, 0600 file, stale socket cleared | `srv/control.rs:start`, in the server's data dir, or a short private dir when that path is too long (`srv/socket_dir.rs`) | `srvt/control_socket.rs::the_socket_is_private_to_the_user`, `srvt/control_socket.rs::a_long_data_dir_still_gets_a_working_private_socket`; `srv/control.rs::a_stale_socket_is_cleared_but_a_planted_file_is_not` | covered | Permissions now fail closed. |
| `YARVIS_CORE_SOCK` in the sidecar's env | `srv/main.rs:serve` → `srv/lib.rs:hand_off_to_sidecar` | `srvt/sidecar.rs::the_sidecar_gets_the_database_the_control_socket_and_the_scoped_tokens` | covered | Checks the path answers. The call in `srv/main.rs:serve` isn't tested. |
| NDJSON, 64 KiB line cap, unknown method | `srv/control.rs:handle_conn` | `srvt/control_socket.rs::an_unknown_method_or_a_malformed_line_is_answered_with_an_error`, `::a_request_line_over_the_limit_ends_the_connection` | covered | |
| `validate_workspace_id` | `srv/control.rs` | `srvt/control_socket.rs::claude_spawn_refuses_a_harness_the_assistant_may_not_start`; `srvt/pty_ws.rs::every_core_command_needs_its_scope` | covered | |
| Sidecar client `sidecar/src/core/controlClient.ts` | Unchanged | `sidecar/src/core/controlClient.test.ts` | covered | |
| `claude.spawn` | `PtyManager::spawn_claude_session` | `srvt/control_socket.rs::claude_spawn_refuses_a_harness_the_assistant_may_not_start`; `srv/control.rs::reads_the_resume_id_the_sidecar_sends` | covered | Refusals over the socket; a successful spawn only through `pty_start_claude`. |
| `claude.spawnReview` | `PtyManager::spawn_review_claude_session` | `srvt/control_socket.rs::claude_spawn_review_starts_one_session_and_kill_review_ends_it`; `srv/control.rs::reads_the_review_session_the_sidecar_sends` | covered | Also the refusal for an agent that isn't Claude Code. |
| `claude.kill` | `PtyManager::kill` | `srvt/control_socket.rs::claude_send_types_only_at_the_registered_agent` | covered | |
| `claude.killReview` | `PtyManager::kill(review_session_id(..))` | `srvt/control_socket.rs::claude_spawn_review_starts_one_session_and_kill_review_ends_it` | covered | |
| `claude.send` | `PtyManager::send_session_instruction` | `srvt/control_socket.rs::claude_send_types_only_at_the_registered_agent`, `::client_input_waits_until_an_agent_send_has_pressed_enter`, `::a_send_whose_agent_exits_during_the_pause_is_not_submitted` | covered | Other input now waits until the Enter (`docs/client-server.md:736-738`). |
| `claude.slash` | `PtyManager::send_session_slash_command` | `srvt/control_socket.rs::claude_send_types_only_at_the_registered_agent`; `srv/control.rs::reads_the_slash_command_the_sidecar_sends` | covered | |
| `mcp.saveOAuth` | `srv/mcp.rs:store_oauth` on the server's backend | `srvt/control_socket.rs::mcp_save_oauth_writes_one_servers_oauth_subtree` | covered | |
| `github.saveToken` | `SecretBlob::store_github_token` | `srvt/control_socket.rs::github_save_token_writes_only_that_key` | covered | |
| `alarm.fire` (check, then take over the window) | `srv/control.rs:fire_alarm` appends `alarm.fire` | `srvt/control_socket.rs::firing_and_releasing_an_alarm_become_events`, `::a_refused_alarm_records_nothing`; `srv/control.rs::reads_the_alarm_the_sidecar_sends`, `::refuses_a_join_link_that_isnt_a_web_link`, `::cuts_a_long_label`, `::refuses_a_junk_alarm_id` | covered | The method. The takeover is under "Alarms". `docs/client-server.md:746-748`. |
| `alarm.release` | `srv/control.rs:release_alarm` appends `alarm.release` | `srvt/control_socket.rs::firing_and_releasing_an_alarm_become_events` | covered | |
| `harness.runEnv` | `srv/control.rs:harness_run_env` → `harness::headless_run_env` | `srvt/control_socket.rs::harness_run_env_refuses_a_blank_or_unknown_harness`; `srv/control.rs::reads_the_harness_the_sidecar_asks_for_and_answers_its_run_env`; `srv/harness.rs::a_headless_run_takes_only_a_claude_code_harness_and_only_its_program` and 2 more | covered | The success path over the socket isn't tested. |

## Sidecar

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `get_sidecar_info` (port and token for the webview) | Dropped; clients use `/api/sidecar/*` | `srvt/sidecar.rs::a_get_reaches_the_sidecar_with_its_token_and_the_device_id`; `srv/core_api.rs::client_local_and_dropped_commands_are_not_served` | dropped on purpose | `docs/client-server.md:868-870`; PR #682. |
| `get_sidecar_log_path` | Dropped; the sidecar's `/api/logs` serves recent lines | `srv/core_api.rs::client_local_and_dropped_commands_are_not_served` | dropped on purpose | `docs/client-server.md:868-870`. Diagnostics names the file instead. |
| `restart_sidecar` | `POST /api/core/restart_sidecar` → `Sidecar::restart` | `srvt/sidecar.rs::the_restart_route_restarts_the_sidecar`, `::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar` | covered | HTTP. Needs `admin`. |
| Free loopback port | `srv/sidecar.rs:pick_free_port` | none | moved, untested | Same code; no test on main. The proxy sends nothing while no sidecar runs: `srvt/sidecar.rs::nothing_is_sent_while_no_sidecar_is_running`. |
| `YARVIS_SIDECAR_TOKEN` | `srv/sidecar.rs:random_token`, `build_command` | `srvt/sidecar.rs::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar`, `::a_get_reaches_the_sidecar_with_its_token_and_the_device_id` | covered | |
| `YARVIS_ATTENTION_TOKEN`, `YARVIS_MCP_TOKEN` | `srv/sidecar.rs:build_command`; shells get the same through `Sidecar::session_env` | `srvt/sidecar.rs::the_sidecar_gets_the_database_the_control_socket_and_the_scoped_tokens`; `srvt/pty_ws.rs::workspace_shells_get_the_sidecars_scoped_tokens` | covered | Both ends, so a mismatch would show. The shells' test uses the details `AppState::new` handed its PTY manager. |
| Secrets as env vars (12 keys plus custom provider, MCP and embeddings JSON) | `srv/sidecar.rs:sidecar_env` | `srv/sidecar.rs::secrets_and_settings_reach_the_environment_and_empty_values_do_not`; `srvt/sidecar.rs::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar`; `srv/custom_providers.rs::the_sidecar_env_is_the_subtree_or_nothing`; `srv/mcp.rs::the_sidecar_env_is_the_subtree_or_nothing` | covered | |
| `DATABASE_URL` | `srv/main.rs:serve` → `srv/lib.rs:hand_off_to_sidecar` | `srvt/sidecar.rs::the_sidecar_gets_the_database_the_control_socket_and_the_scoped_tokens` | covered | Resolution is covered under "Database URL". The call in `srv/main.rs:serve` isn't tested. |
| Settings as env vars (Azure, JIRA, Google client id, Telegram OTP window) | `srv/sidecar.rs:sidecar_env` | `srv/sidecar.rs::secrets_and_settings_reach_the_environment_and_empty_values_do_not` | covered | |
| `YARVIS_INSTANCE`, `YARVIS_BACKGROUND_WORKERS` | `srv/sidecar.rs:instance_env` | `srv/sidecar.rs::the_sidecar_is_told_which_instance_it_serves_and_whether_it_owns_the_workers` | covered | |
| `YARVIS_ALLOWED_ORIGINS` | `srv/sidecar.rs:allowed_origins` from `auth.origins` | `srv/sidecar.rs::an_origin_that_could_widen_the_list_is_dropped` | covered | `tauri://localhost` no longer needed. |
| `YARVIS_DEBUG_MEMORY`, `YARVIS_DEBUG_MCP` passed explicitly | Inherited from the server's env | none | moved, untested | Debug logging only. |
| `YARVIS_LEGACY_ALARMS_PATH` (import the old `alarms.json`) | Nothing sets it, and the sidecar's import code is gone | none | dropped on purpose | ce6ebfc1 ("the desktop app no longer hands over its old alarms file"). |
| Restart on exit (1s), retry a failed spawn (2s), restart on request | `srv/sidecar.rs:Sidecar::supervise` | `srvt/sidecar.rs::a_sidecar_that_exits_is_restarted`, `::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar` | covered | Adds `sidecar.started` and `sidecar.stopped` events. |
| Start without secrets when the read fails | Waits and retries every 5s; follows the vault | `srvt/sidecar.rs::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar`, `::the_sidecar_follows_the_vault_lock` | covered | Changed on purpose: `srv/sidecar.rs` module doc, 8b4e0734. |
| `ENDPOINT_OVERRIDE_VARS` stripped | `srv/sidecar.rs`, last in `build_command` | `srv/sidecar.rs::endpoint_overrides_never_reach_the_sidecar` | covered | |
| Overrides accepted only for loopback (sidecar side) | `sidecar/src/config.ts`, unchanged | `sidecar/src/config.test.ts` › parseEndpointOverride › "refuses any other host, even over https" | covered | |
| Log file, 0600, rotated at 5 MB, tee to stdout | `<data_dir>/logs/sidecar.log` | `srv/sidecar.rs::a_large_log_is_rotated_aside_so_the_previous_run_survives`; `srvt/sidecar.rs::the_supervisor_waits_for_the_secrets_then_starts_and_restarts_the_sidecar` | covered | Moved off `~/Library/Logs/<bundle>/`. |
| Dev `bun run` vs bundled `yarvis-sidecar` and `YARVIS_MIGRATIONS_DIR` | `srv/sidecar.rs:command_base`; the app writes `[sidecar] command` and `migrations_dir` | `tauri/local_server.rs::a_first_config_points_the_server_at_the_bundle`, `::a_dev_build_leaves_the_sidecar_to_the_servers_default`; `srv/sidecar.rs::an_empty_command_is_refused` | covered | A packaged server not started by the app has to set `[sidecar] command`. |
| Login shell `PATH` for the release sidecar (`login_path.rs`) | `tauri/login_path.rs`, given to a local server (`tauri/server_link.rs:server_path`); the sidecar and PTYs inherit it. A server the app didn't start sets `[server] path` (`docs/configuration.md`) | `tauri/login_path.rs::reads_the_marked_value_past_rc_file_noise`, `::reads_path_from_a_real_shell`, `::drops_empty_and_relative_entries`, `::missing_or_empty_markers_read_as_nothing`; `[server] path`: `srvt/sidecar.rs::the_configured_path_finds_the_sidecar_and_reaches_it`, `srvt/pty_ws.rs::shells_start_with_the_configured_path` | moved, untested | Reading is tested; the app's hand-off isn't. Needs a manual check: `echo $PATH` in a terminal of an app opened from Finder. |
| `kill_on_drop` (the sidecar only) | `srv/sidecar.rs` kills the sidecar's process tree; the app stops the local server on exit | `srvt/sidecar.rs::stopping_the_sidecar_kills_its_children_too`, `::stopping_the_supervisor_kills_the_sidecar`; `tauri/local_server.rs::stopping_ends_the_running_server_and_its_restarts` | covered | Also kills grandchildren, which main didn't. |

## Alarms

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `alarms::init` | `tauri/alarms.rs:init` | `tauri/alarms.rs` tests (the fixture calls `init`) | covered | |
| Ringing from the control channel, whatever the webview was doing; `alarm-fired` event to the page | Server appends `alarm.fire`; the page's `onAlarmFired` (`src/lib/alarms.ts:69`) calls the `fire_alarm` bridge | `tauri/alarms.rs::the_fire_command_takes_the_alarm_as_the_event_carries_it` (bridge); `srvt/control_socket.rs::firing_and_releasing_an_alarm_become_events` (server) | moved, untested | The page step is only in `src/lib/alarms.test.ts` › "alarm events from the server", which stubs `invoke`. Ringing now needs the page loaded and connected; a hidden, throttled webview delays it. |
| Window takeover (fullscreen, on top, focus), notification, `afplay`, hand back when none ring | Same code in `tauri/alarms.rs` | `tauri/alarms.rs::firing_registers_the_alarm_as_holding_the_takeover`, `::releasing_one_of_two_leaves_the_other_holding_the_takeover`, `::firing_the_same_alarm_twice_is_one_takeover`, `::keeps_the_window_while_another_alarm_is_still_firing`, `::hands_the_window_back_only_once_per_alarm`, `::leaves_the_window_alone_for_an_alarm_that_never_fired` | covered | Mock runtime, as on main. A remote server can now trigger it too. |
| `release_alarm` command | `tauri/alarms.rs:release_alarm` | `tauri/alarms.rs::releasing_twice_is_harmless`, `::releasing_an_alarm_that_never_rang_does_nothing` | covered | |
| Release from the control channel | `alarm.release` event → page → `release_alarm` bridge | `srvt/control_socket.rs::firing_and_releasing_an_alarm_become_events` | moved, untested | Same page step as firing, stub-only. A release on another device now silences this one. |

## Desktop shell

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| `focus_main_window` | Same, `tauri/lib.rs` | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` | moved, untested | ACL only. In a browser `core()` throws `LocalOnlyError`. |
| `clipboard_history` | `tauri/clipboard.rs`, granted only to a local server | `tauri/clipboard.rs::records_newest_first`, `::moves_a_repeat_to_the_front_instead_of_duplicating`, `::drops_the_oldest_past_the_limit`, `::gives_each_clip_a_distinct_id`; `tauri/server_link.rs::a_remote_server_never_gets_the_clipboard_history` | covered | No history with a remote server or in a browser. |
| `clipboard_clear_history` | Same | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` | moved, untested | ACL only. |
| `clipboard_write` | Same; `src/lib/clipboard.ts` falls back to `navigator.clipboard` | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` | moved, untested | ACL only. |
| Clipboard poller (`clipboard::init`) | Same | none | moved, untested | No test on main either. Needs a manual check. |
| Global hotkeys and the `omni-chat-summon`, `clipboard-summon` events | Same in `tauri/lib.rs`; the page listens through `onNativeEvent` | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` (`plugin:event\|listen`) | moved, untested | ACL only. No-op in a browser. Needs a manual check. |
| `instance::global_shortcuts_enabled` | `tauri/instance.rs` | `tauri/instance.rs::flags_recognize_only_explicit_values`, `::a_primary_owned_capability_follows_the_instance_unless_forced` | covered | |
| `instance::background_workers_enabled` | `srv/sidecar.rs:resolve_background_workers` | `srv/sidecar.rs::the_sidecar_is_told_which_instance_it_serves_and_whether_it_owns_the_workers` | covered | |
| `instance::database_url_override` | `srv/database_url.rs`; the local server inherits the app's env | `srv/database_url.rs::the_env_var_beats_the_config_file_which_beats_the_secret_store` | covered | A named instance also gets its own schema: `tauri/local_server.rs::a_named_instance_gets_its_own_schema_unless_the_file_names_one`. |
| `instance::dev_port` | `tauri/instance.rs` → `auth.origins` and the bridge origin | `tauri/instance.rs::a_dev_port_that_could_widen_the_origin_list_is_refused`; `tauri/local_server.rs::a_dev_build_lets_vite_serve_the_ui_and_reach_the_server` | covered | |
| `instance::label_window` | Same | none | moved, untested | No test on main either. Needs a manual check. |
| Single-instance plugin | Same, registered first | none | moved, untested | Needs a manual check. |
| Notification plugin | Same; `notification:default` in `BRIDGE_PERMISSIONS` | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` (`plugin:notification\|notify`) | covered | In a browser `src/lib/notify.ts` never asks for permission, so it never notifies. That is the new client, not parity. |
| Opener `openUrl` | `opener:allow-open-url`, `opener:allow-default-urls` | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` (`plugin:opener\|open_url`) | covered | `window.open` in a browser. |
| Opener `revealItemInDir` (from `opener:default`) | `opener:allow-reveal-item-in-dir` in `LOCAL_SERVER_PERMISSIONS`, since the path is on the server's machine; `src/components/voice/VoiceStudio.tsx` shows a refusal | `tauri/server_link.rs::the_servers_page_can_use_the_bridge` (`plugin:opener\|reveal_item_in_dir`), `::a_remote_server_never_gets_the_clipboard_history_or_finder` | covered | ACL only. With a remote server the button reports the refusal; a browser shows "Saved". |
| Autostart plugin | Same | none | moved, untested | No capability and no caller, on main or now. Needs a manual check. |
| Main window capability (`core:default`, `opener:default`, `opener:allow-open-url`, `notification:default`) | Connect page keeps `default.json`; the server's origin gets a runtime capability (`tauri/server_link.rs`) | `tauri/server_link.rs::the_servers_page_can_use_the_bridge`, `::the_servers_page_cannot_repoint_the_app`, `::no_other_origin_gets_the_token`, `::the_connect_page_can_change_the_connection`, `::every_app_command_is_open_to_the_server_only_when_the_bridge_names_it`, `::a_remote_server_never_gets_the_clipboard_history` | covered | Nothing in `src/` used the rest of `core:default`. |
| CSP for the bundled UI (`connect-src` had `ipc:` and `http://ipc.localhost`) | The server's CSP (`srv/http_guard.rs:21`), `connect-src 'self'` only | e2e (fails on any CSP violation, Chromium only) | unsure | To settle it, run `bun run tauri dev` with devtools open and check that `invoke` works and logs no CSP error. |

## OAuth callbacks and deep links

Main registered no deep-link scheme, so there is nothing to port.

| Old (origin/main) | Now | Test | Status | Notes |
|---|---|---|---|---|
| OAuth redirects to the sidecar's loopback callback; the core did nothing | `GET /api/oauth/mcp/callback`, `GET /api/oauth/google/callback` → `srv/sidecar_proxy.rs:oauth_callback_router`; `YARVIS_PUBLIC_ORIGIN` for the redirect | `srvt/sidecar.rs::an_oauth_redirect_on_the_servers_origin_reaches_the_sidecars_callback`; `sidecar/src/mcp/oauth.test.ts` › "points at the server's origin when it is reached from other machines"; `sidecar/src/google/routes.test.ts` › "is the server's origin when it is reached from other machines, for a Web client" | covered | Google on a `*.ts.net` name is untried (`docs/client-server.md:877-880`). |

## Added in the new stack

These aren't counted above, since main had no equivalent: the tray (Open,
Server connection, Quit), the connect page and its commands, local server
supervision in the app, the device token in the Keychain, `GET /api/pty`, and
the `pty.started` event.
