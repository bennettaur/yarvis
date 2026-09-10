//! 1Password-backed secret storage, driven through the `op` CLI.
//!
//! An alternative to the macOS Keychain for the single secrets blob described
//! in [`crate::keychain`]. The blob is stored the same way it is there — one
//! JSON object in one item — so every module that nests a subtree under it
//! (`mcp`, `custom_providers`, `embeddings_secrets`) works unchanged. The item
//! is a Secure Note and the blob lives in its notes field, reachable as the
//! secret reference `op://<vault>/<item>/notesPlain`.
//!
//! The CLI rather than 1Password's SDK, because the SDK authenticates with a
//! service-account token — which would itself need storing somewhere, and
//! offers no biometric gate. `op` integrated with the desktop app authorizes
//! each access with Touch ID, which is the reason to prefer this over the
//! Keychain in the first place.
//!
//! A write hands `op` the blob on **stdin**, as a JSON item template, never as
//! a command-line argument. 1Password's own guidance is to use a template for
//! sensitive values because "command arguments can be visible to other
//! processes on your machine" — and argv is worse than it first sounds here,
//! since a read is gated behind the desktop app's authorization prompt while
//! argv is readable, with no prompt at all, by anything running as the user,
//! including the subprocesses this app spawns.
//!
//! The channel is fussy, and the shape below is what `op` 2.39 actually
//! accepts: the template must arrive on a real pipe. A shell redirect from a
//! regular file is not detected as stdin at all — `op` reports success and
//! silently applies nothing — and `--template=/dev/stdin` fails outright on a
//! pipe with "cannot edit an item from template and stdin at the same time".
//! Passing the template as a *file* would work, but only by putting the blob
//! on disk, which is what this avoids.

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Field of the Secure Note that carries the JSON blob.
const NOTES_FIELD: &str = "notesPlain";

/// Item category created when the configured item does not exist yet.
const ITEM_CATEGORY: &str = "Secure Note";

/// How long any single `op` invocation may take. Generous because a read can
/// sit waiting on a Touch ID prompt the user has not answered yet; short enough
/// that an `op` wedged on a locked vault cannot hang app startup forever.
const OP_TIMEOUT: Duration = Duration::from_secs(60);

/// Where to look for the CLI when it is not on the process `PATH`. A Tauri app
/// launched from Finder inherits a minimal `PATH` that has neither Homebrew
/// prefix on it, so the binary has to be found by hand.
const OP_CANDIDATES: &[&str] = &["/opt/homebrew/bin/op", "/usr/local/bin/op"];

/// Environment override for the `op` binary, for a non-standard install.
const OP_BIN_ENV: &str = "YARVIS_OP_BIN";

/// The 1Password item holding the secrets blob.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ItemRef {
    vault: String,
    item: String,
}

impl ItemRef {
    /// Validates and builds a reference. Both parts become path segments of an
    /// `op://` secret reference and arguments to `op`, so a separator or a
    /// control character would silently address something other than what the
    /// user typed rather than failing.
    pub fn new(vault: &str, item: &str) -> Result<Self, String> {
        let vault = vault.trim();
        let item = item.trim();
        for (label, value) in [("vault", vault), ("item", item)] {
            if value.is_empty() {
                return Err(format!("the 1Password {label} is required"));
            }
            // `/` separates the segments of the `op://` reference and `?`/`#`
            // start its query and fragment, so any of them would address
            // something other than the name that was typed.
            if value.contains(['/', '?', '#']) || value.chars().any(char::is_control) {
                return Err(format!(
                    "the 1Password {label} must not contain '/', '?', '#' or control characters"
                ));
            }
            if value.starts_with('-') {
                return Err(format!("the 1Password {label} must not start with '-'"));
            }
        }
        Ok(Self {
            vault: vault.to_string(),
            item: item.to_string(),
        })
    }

    /// The `op://` reference naming the notes field of this item.
    fn secret_reference(&self) -> String {
        format!("op://{}/{}/{NOTES_FIELD}", self.vault, self.item)
    }
}

/// What an `op` invocation produced.
enum Outcome {
    Ok(String),
    /// The item named does not exist. Distinguished from a failure because a
    /// missing item is how a first run looks, and the caller creates it rather
    /// than reporting an error. A missing *vault* is not this — it stays an
    /// error, since creating an item in a vault the user mistyped would put
    /// their secrets somewhere they will not look for them.
    MissingItem,
    /// The vault named does not exist.
    MissingVault,
}

/// The `op` binary to run: the override, else the first candidate path that
/// exists, else the bare name for `PATH` lookup.
fn op_bin() -> OsString {
    if let Some(path) = std::env::var_os(OP_BIN_ENV) {
        if !path.is_empty() {
            return path;
        }
    }
    for candidate in OP_CANDIDATES {
        if Path::new(candidate).exists() {
            return OsString::from(candidate);
        }
    }
    OsString::from("op")
}

/// True when `op`'s stderr says the *item* was not found, as opposed to any
/// other failure. Matched on text because the CLI reports both through the same
/// non-zero exit status.
///
/// Every phrase here names an item, and deliberately so — the classification is
/// dangerously asymmetric. A false negative only shows the user an error; a
/// false positive turns a read into `Ok(None)`, which the next read-modify-write
/// saves as a blob holding one key, erasing every other secret. Bare phrases
/// like "not found" match connection, session and plugin failures too, so they
/// are not enough to conclude the item is simply absent.
fn item_not_found(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("isn't an item")
        || stderr.contains("no item matches")
        || stderr.contains("item not found")
        || stderr.contains("item doesn't exist")
        // What `op item edit` says when the template arrives on stdin, which
        // is the phrasing the create fallback actually depends on — a read
        // failing the same way says "isn't an item" instead.
        || stderr.contains("could not find item to edit")
}

/// True when `op`'s stderr says the *vault* was not found. Kept apart from
/// [`item_not_found`] because only a missing item may be created; a missing
/// vault is the user's typo and must be reported.
fn vault_not_found(stderr: &str) -> bool {
    let stderr = stderr.to_ascii_lowercase();
    stderr.contains("isn't a vault")
        || stderr.contains("no vault matches")
        || stderr.contains("vault not found")
        || stderr.contains("vault doesn't exist")
}

fn read_args(item: &ItemRef) -> Vec<String> {
    vec![
        "read".to_string(),
        "--no-newline".to_string(),
        item.secret_reference(),
    ]
}

fn edit_args(item: &ItemRef) -> Vec<String> {
    vec![
        "item".to_string(),
        "edit".to_string(),
        item.item.clone(),
        "--vault".to_string(),
        item.vault.clone(),
    ]
}

/// Creates the item, taking the blob from the template on stdin so a first
/// write never leaves an empty item behind.
fn create_args(item: &ItemRef) -> Vec<String> {
    vec![
        "item".to_string(),
        "create".to_string(),
        "--category".to_string(),
        ITEM_CATEGORY.to_string(),
        "--title".to_string(),
        item.item.clone(),
        "--vault".to_string(),
        item.vault.clone(),
        // Tells `op item create` to read the template from stdin. `op item
        // edit` takes no such marker and rejects the command if given one.
        "-".to_string(),
    ]
}

/// The item template carrying the blob, for stdin.
///
/// Only the one field is named. `op` merges it into the existing item, so a
/// partial template is enough and there is no need to fetch the whole item
/// first just to write one field back.
fn notes_template(blob: &str) -> String {
    serde_json::json!({
        "fields": [{
            "id": NOTES_FIELD,
            "type": "STRING",
            "purpose": "NOTES",
            "label": NOTES_FIELD,
            "value": blob,
        }]
    })
    .to_string()
}

/// Whether an invocation's stderr may be shown to the user.
///
/// `op` quotes the input it could not process in its own diagnostics, so
/// relaying stderr from a write risks putting the secrets object into an error
/// string that Settings renders and a user pastes into a bug report — durable
/// and shareable, unlike anything the process itself holds.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Detail {
    /// Relay `op`'s message. Only for invocations that were handed no secret
    /// material on stdin or in their arguments.
    Show,
    Redact,
}

/// Runs `op` with `args`, writing `stdin_data` to its standard input and
/// enforcing [`OP_TIMEOUT`].
///
/// The child's stdout and stderr are pipes read only after it exits, so a
/// command whose output could exceed the pipe buffer would deadlock rather than
/// time out. Everything here is one JSON blob or one short error, well inside
/// that buffer; the same reasoning covers the template written below, which
/// goes in before the wait begins.
///
/// With no template to send, stdin is closed rather than left open, so `op`
/// fails instead of waiting on a prompt when it cannot reach the desktop app.
fn run_op(args: &[String], stdin_data: Option<&str>, detail: Detail) -> Result<Outcome, String> {
    let mut child = Command::new(op_bin())
        .args(args)
        .stdin(if stdin_data.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            format!("could not run the 1Password CLI ('op'): {e}. Install it, or set {OP_BIN_ENV}.")
        })?;

    if let Some(data) = stdin_data {
        // Dropped immediately after writing: `op` reads the template to EOF,
        // so leaving the pipe open would hang until the timeout.
        let mut pipe = child
            .stdin
            .take()
            .ok_or_else(|| "the 1Password CLI gave no stdin to write to".to_string())?;
        let written = pipe.write_all(data.as_bytes()).and_then(|()| pipe.flush());
        drop(pipe);
        if let Err(e) = written {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("could not send the item to the 1Password CLI: {e}"));
        }
    }

    let deadline = Instant::now() + OP_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "the 1Password CLI did not answer within {}s — is the desktop app unlocked?",
                    OP_TIMEOUT.as_secs()
                ));
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_string(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_string(&mut stderr);
    }

    if status.success() {
        return Ok(Outcome::Ok(stdout));
    }
    if vault_not_found(&stderr) {
        return Ok(Outcome::MissingVault);
    }
    if item_not_found(&stderr) {
        return Ok(Outcome::MissingItem);
    }
    let message = stderr.trim();
    Err(match (detail, message.is_empty()) {
        (Detail::Show, false) => format!("1Password: {message}"),
        _ => format!("the 1Password CLI failed ({status})"),
    })
}

fn no_such_vault(item: &ItemRef) -> String {
    format!("1Password has no vault named '{}'", item.vault)
}

/// Reads the secrets blob, or `None` when the item does not exist yet. An
/// unreachable or locked 1Password is an `Err`, never `None` — the caller
/// writes back what it reads, so the two must not be confused.
pub fn read_blob(item: &ItemRef) -> Result<Option<String>, String> {
    match run_op(&read_args(item), None, Detail::Show)? {
        Outcome::Ok(blob) => Ok(Some(blob)),
        Outcome::MissingItem => Ok(None),
        Outcome::MissingVault => Err(no_such_vault(item)),
    }
}

/// Writes the secrets blob, creating the item on first use.
pub fn write_blob(item: &ItemRef, blob: &str) -> Result<(), String> {
    write_blob_with(
        |args, template| run_op(args, Some(template), Detail::Redact),
        item,
        blob,
    )
}

/// The edit-then-create sequence, over an injected runner so the ordering can
/// be exercised without the CLI. The runner receives the arguments and the
/// template that goes to stdin, keeping the blob out of both the argument list
/// and any error `op` produces.
fn write_blob_with(
    run: impl Fn(&[String], &str) -> Result<Outcome, String>,
    item: &ItemRef,
    blob: &str,
) -> Result<(), String> {
    let template = notes_template(blob);
    match run(&edit_args(item), &template)? {
        Outcome::Ok(_) => Ok(()),
        Outcome::MissingVault => Err(no_such_vault(item)),
        Outcome::MissingItem => match run(&create_args(item), &template)? {
            Outcome::Ok(_) => Ok(()),
            Outcome::MissingVault | Outcome::MissingItem => Err(no_such_vault(item)),
        },
    }
}

/// Checks that `op` runs and the vault is reachable, so switching the app onto
/// 1Password fails while the Keychain copy is still intact rather than after.
/// A missing *item* is fine — the first write creates it — but a missing vault
/// is the user's typo.
pub fn probe(item: &ItemRef) -> Result<(), String> {
    let args = [
        "vault".to_string(),
        "get".to_string(),
        item.vault.clone(),
        "--format".to_string(),
        "json".to_string(),
    ];
    match run_op(&args, None, Detail::Show)? {
        Outcome::Ok(_) => Ok(()),
        Outcome::MissingVault | Outcome::MissingItem => Err(no_such_vault(item)),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        create_args, edit_args, item_not_found, notes_template, read_args, vault_not_found,
        write_blob_with, ItemRef, Outcome,
    };
    use std::cell::RefCell;

    fn item() -> ItemRef {
        ItemRef::new("Private", "Yarvis Secrets").unwrap()
    }

    #[test]
    fn a_reference_names_the_notes_field_of_the_item() {
        assert_eq!(
            item().secret_reference(),
            "op://Private/Yarvis Secrets/notesPlain"
        );
    }

    #[test]
    fn a_blank_or_reference_separating_part_is_rejected() {
        assert!(ItemRef::new("", "Yarvis").is_err());
        assert!(ItemRef::new("Private", "  ").is_err());
        assert!(ItemRef::new("Private/Nested", "Yarvis").is_err());
        assert!(ItemRef::new("Private", "Yar\nvis").is_err());
        assert!(ItemRef::new("Private", "Yarvis?attribute=otp").is_err());
        assert!(ItemRef::new("Private", "Yarvis#section").is_err());
    }

    /// A leading dash would be parsed by `op` as a flag rather than a name.
    #[test]
    fn a_leading_dash_is_rejected() {
        assert!(ItemRef::new("-Private", "Yarvis").is_err());
        assert!(ItemRef::new("Private", "--help").is_err());
    }

    #[test]
    fn parts_are_trimmed() {
        assert_eq!(
            ItemRef::new("  Private  ", " Yarvis ").unwrap(),
            ItemRef::new("Private", "Yarvis").unwrap()
        );
    }

    #[test]
    fn a_read_asks_for_the_reference_without_a_trailing_newline() {
        assert_eq!(
            read_args(&item()),
            vec![
                "read",
                "--no-newline",
                "op://Private/Yarvis Secrets/notesPlain"
            ]
        );
    }

    #[test]
    fn a_write_addresses_the_item_by_title_within_its_vault() {
        assert_eq!(
            edit_args(&item()),
            vec!["item", "edit", "Yarvis Secrets", "--vault", "Private"]
        );
    }

    #[test]
    fn a_created_item_is_a_secure_note_reading_its_template_from_stdin() {
        assert_eq!(
            create_args(&item()),
            vec![
                "item",
                "create",
                "--category",
                "Secure Note",
                "--title",
                "Yarvis Secrets",
                "--vault",
                "Private",
                "-",
            ]
        );
    }

    /// The point of the template: the blob must never reach the argument
    /// list, where any process running as this user could read it out of the
    /// process table with no authorization prompt.
    #[test]
    fn no_argument_of_either_write_carries_the_blob() {
        let blob = "{\"github_token\":\"sekrit\"}";
        for args in [edit_args(&item()), create_args(&item())] {
            assert!(
                !args.iter().any(|a| a.contains("sekrit")),
                "the blob reached argv: {args:?}"
            );
        }
        assert!(notes_template(blob).contains("sekrit"));
    }

    /// The shape `op` 2.39 accepts: a partial template naming just the notes
    /// field, which it merges into the item.
    #[test]
    fn the_template_names_only_the_notes_field() {
        let template: serde_json::Value =
            serde_json::from_str(&notes_template("{\"a\":1}")).unwrap();
        let fields = template["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(fields[0]["id"], "notesPlain");
        assert_eq!(fields[0]["purpose"], "NOTES");
        assert_eq!(fields[0]["value"], "{\"a\":1}");
    }

    /// Verified against `op` 2.39: a missing item reports differently
    /// depending on how the write arrived, and the create fallback hangs off
    /// the stdin phrasing.
    #[test]
    fn an_absent_item_is_recognised() {
        assert!(item_not_found(
            "[ERROR] unable to process line 1: could not find item to edit"
        ));
        assert!(item_not_found("\"Yarvis\" isn't an item. Specify the item"));
        assert!(item_not_found("error: no item matches \"Yarvis\""));
        assert!(item_not_found("ERROR: item not found"));
    }

    #[test]
    fn an_absent_vault_is_recognised_and_is_not_an_absent_item() {
        let stderr = "ERROR: \"Nope\" isn't a vault in this account";
        assert!(vault_not_found(stderr));
        assert!(!item_not_found(stderr));
    }

    /// The asymmetry that matters: misreading a failure as "the item isn't
    /// there" makes the read return an empty blob, and the next save writes
    /// that empty blob over every stored secret. Bare "not found" and "doesn't
    /// exist" appear in failures that have nothing to do with the item, so
    /// they must not classify.
    #[test]
    fn a_failure_that_is_not_about_the_item_never_reads_as_absent() {
        for stderr in [
            "error: authorization prompt dismissed, please try again",
            "error: could not connect to 1Password app",
            "error: connect: /Users/x/.1password/agent.sock: file not found",
            "error: account not found; run 'op signin'",
            "error: field \"notesPlain\" doesn't exist on this item",
            "error: the CLI plugin was not found",
        ] {
            assert!(!item_not_found(stderr), "classified as missing: {stderr}");
            assert!(!vault_not_found(stderr), "classified as missing: {stderr}");
        }
    }

    /// Records what the injected runner was asked to do, so the sequencing
    /// assertions read against real calls rather than a call count.
    fn recording_run<'a>(
        outcomes: Vec<Outcome>,
        log: &'a RefCell<Vec<Vec<String>>>,
        templates: &'a RefCell<Vec<String>>,
    ) -> impl Fn(&[String], &str) -> Result<Outcome, String> + 'a {
        let outcomes = RefCell::new(outcomes.into_iter());
        move |args: &[String], template: &str| {
            log.borrow_mut().push(args.to_vec());
            templates.borrow_mut().push(template.to_string());
            Ok(outcomes.borrow_mut().next().expect("an unexpected op call"))
        }
    }

    #[test]
    fn an_existing_item_is_edited_and_never_created() {
        let log = RefCell::new(Vec::new());
        let sent = RefCell::new(Vec::new());
        let run = recording_run(vec![Outcome::Ok(String::new())], &log, &sent);
        write_blob_with(run, &item(), "{}").unwrap();

        let calls = log.borrow();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0], edit_args(&item()));
    }

    #[test]
    fn a_missing_item_is_created_carrying_the_same_blob() {
        let log = RefCell::new(Vec::new());
        let sent = RefCell::new(Vec::new());
        let run = recording_run(
            vec![Outcome::MissingItem, Outcome::Ok(String::new())],
            &log,
            &sent,
        );
        write_blob_with(run, &item(), "{\"a\":1}").unwrap();

        let calls = log.borrow();
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1], create_args(&item()));
        // The create must carry the same blob the failed edit did, or a first
        // run would leave an item holding nothing.
        let templates = sent.borrow();
        assert_eq!(templates[0], templates[1]);
        assert!(templates[1].contains("{\\\"a\\\":1}"));
    }

    /// A mistyped vault must not be papered over by creating the item there:
    /// the secrets would land somewhere the user will never look.
    #[test]
    fn a_missing_vault_is_reported_rather_than_created_into() {
        let log = RefCell::new(Vec::new());
        let sent = RefCell::new(Vec::new());
        let run = recording_run(vec![Outcome::MissingVault], &log, &sent);
        let err = write_blob_with(run, &item(), "{}").unwrap_err();

        assert!(err.contains("Private"), "{err}");
        assert_eq!(
            log.borrow().len(),
            1,
            "no create should have been attempted"
        );
    }
}
