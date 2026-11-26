use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tracing_subscriber::EnvFilter;
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::database_url::{self, DatabaseUrl, UrlSource};
use yarvis_server::devices::{add_token_device, parse_scope_list};
use yarvis_server::events::EventLog;
use yarvis_server::secret_blob::{SecretBlob, Store as SecretStore};
use yarvis_server::secret_migration::{self, Migrated, OnConflict};
use yarvis_server::settings::SettingsStore;
use yarvis_server::sidecar::SupervisorDeps;
use yarvis_server::store::Store;
use yarvis_server::vault::Vault;
use yarvis_server::{AppState, app};

const USAGE: &str = "usage: yarvis-server [--config PATH]
       yarvis-server device add --name NAME --scopes read,chat,terminal,approve,admin [--config PATH]
       yarvis-server auth reset [--sign-out-all] [--config PATH]
       yarvis-server vault init [--passphrase-stdin] [--config PATH]
       yarvis-server secrets migrate --from STORE --to STORE [--force-source | --force-dest]
                     [--passphrase-stdin] [--config PATH]
         (STORE is keychain, onepassword or vault)";

#[derive(Debug)]
enum Command {
    Serve,
    /// Pairs a client that can't sign in itself. Only someone who can run commands on
    /// the server machine can do this, the same trust as reading the setup code.
    AddDevice {
        name: String,
        scopes: String,
    },
    /// Creates the vault and prints its recovery key, once. The vault
    /// passphrase is asked for on the terminal, or read from stdin.
    VaultInit {
        passphrase_stdin: bool,
    },
    /// Copies the secrets from one store into another, leaving the source as
    /// it was. A vault passphrase, when one is needed, comes from the terminal
    /// or stdin.
    SecretsMigrate {
        from: SecretBackendKind,
        to: SecretBackendKind,
        on_conflict: OnConflict,
        passphrase_stdin: bool,
    },
    /// Removes the account and prints a new setup code, for an owner who lost
    /// both the authenticator and the backup codes. The same trust as
    /// `device add`: whoever runs it can already reach the database.
    AuthReset {
        /// Also revokes every device, for a reset after a compromise.
        sign_out_all: bool,
    },
}

#[tokio::main]
async fn main() {
    let (command, config_path) = match parse_args(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    // sqlx logs every Postgres notice ("schema already exists") at info.
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,sqlx=warn".into());
    let logs = tracing_subscriber::fmt().with_env_filter(filter);
    // A CLI command's stdout is its result (a token, a code), so its logs go
    // to stderr.
    if let Command::Serve = command {
        logs.init();
    } else {
        logs.with_writer(std::io::stderr).init();
    }
    let config = Config::load(&config_path).unwrap_or_else(|e| fail(e));
    create_private_dir(&config.server.data_dir).unwrap_or_else(|e| {
        fail(format!(
            "couldn't create {}: {e}",
            config.server.data_dir.display()
        ))
    });
    note_ignored_server_db(&config.server.data_dir);
    let database = find_database(&config).await;
    let store =
        Store::connect_lazy(&database.url, &config.database.schema).unwrap_or_else(|e| fail(e));
    // `serve` waits for the database in the background; a CLI command needs
    // it before it can do anything.
    match command {
        Command::Serve => serve(config, store, database).await,
        Command::AddDevice { name, scopes } => {
            wait_for_database(&store, &database).await;
            add_device(store, &name, &scopes).await
        }
        Command::VaultInit { passphrase_stdin } => {
            wait_for_database(&store, &database).await;
            vault_init(&config, store, passphrase_stdin).await;
        }
        Command::SecretsMigrate {
            from,
            to,
            on_conflict,
            passphrase_stdin,
        } => {
            let target = MigrationTarget {
                config: &config,
                config_path: &config_path,
                store,
                database: &database,
            };
            secrets_migrate(target, from, to, on_conflict, passphrase_stdin).await
        }
        Command::AuthReset { sign_out_all } => {
            wait_for_database(&store, &database).await;
            auth_reset(&config, store, sign_out_all).await
        }
    }
}

/// For a CLI command. Each try can itself take up to the pool's acquire
/// timeout on a host that doesn't answer, so this can run past the limit.
async fn wait_for_database(store: &Store, database: &DatabaseUrl) {
    store
        .migrate_with_retry(Some(CLI_DATABASE_WAIT))
        .await
        .unwrap_or_else(|e| {
            fail(format!(
                "couldn't open the database at {}: {e}",
                database.masked()
            ))
        });
}

/// How long a CLI command waits for Postgres before giving up.
const CLI_DATABASE_WAIT: Duration = Duration::from_secs(10);

/// The database URL, from the environment, `server.toml`, on an older
/// install the secret store, or else the default.
async fn find_database(config: &Config) -> DatabaseUrl {
    let legacy_config = config.clone();
    // Blocking: the fallback reads the Keychain or runs `op`.
    let database = tokio::task::spawn_blocking(move || {
        database_url::resolve(&legacy_config, database_url::from_env(), || {
            database_url::from_legacy_secret_store(&legacy_config)
        })
    })
    .await
    .unwrap_or_else(|e| fail(format!("finding the database failed: {e}")))
    .unwrap_or_else(|e| fail(e));
    if database.source == UrlSource::Default {
        tracing::info!(
            "no database URL set ({} or [database] url in server.toml), so using {}",
            database_url::ENV_VAR,
            database_url::DEFAULT_URL
        );
    }
    if database.source == UrlSource::SecretStore {
        tracing::warn!(
            "using the database URL saved in the secret store. Set {} or `url` under [database] \
             in server.toml instead: the server can't read the secret store before the vault \
             is unlocked or outside a login session",
            database_url::ENV_VAR
        );
    }
    database
}

/// A `<data_dir>/server.db` left by an older version is never read: the
/// account, devices and events are in Postgres, and the account is set up
/// again there.
fn note_ignored_server_db(data_dir: &Path) {
    let old = data_dir.join("server.db");
    if old.exists() {
        tracing::info!(
            "{} isn't used: the server keeps its state in Postgres, so set the account up again. \
             The file can be deleted.",
            old.display()
        );
    }
}

/// The data dir holds the setup code, the sockets and, with the vault
/// backend, the vault, so only its owner may enter it.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

async fn serve(config: Config, store: Store, database: DatabaseUrl) {
    #[cfg(unix)]
    if let Err(e) = yarvis_server::pty::process::raise_fd_limit() {
        tracing::warn!("couldn't raise the file descriptor limit: {e}");
    }
    let bind = config.server.bind;
    let mut state = AppState::new(config, store);
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .unwrap_or_else(|e| fail(format!("couldn't listen on {bind}: {e}")));
    yarvis_server::hand_off_to_sidecar(&mut state, database)
        .await
        .unwrap_or_else(|e| fail(e));
    let pty = state.pty.clone();
    // Listening first, so `/api/health` answers 503 while Postgres comes up
    // rather than the port refusing connections.
    let startup = tokio::spawn(start_when_database_ready(state.clone()));
    tracing::info!("listening on http://{bind}");
    // The peer address feeds the per-IP limit on the sign-in routes.
    let server = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .into_future();
    // Graceful shutdown waits for every connection, and event and PTY
    // WebSockets never end on their own, so give them a few seconds and go.
    tokio::select! {
        result = server => result.expect("server error"),
        _ = async {
            shutdown_signal().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => tracing::info!("open connections didn't close in time; exiting"),
    }
    // Dropping the supervisor kills the sidecar (`kill_on_drop`), so it never
    // outlives the server.
    startup.abort();
    if let Ok(Some(supervisor)) = startup.await {
        supervisor.abort();
        let _ = supervisor.await;
    }
    pty.kill_all();
}

/// Waits for Postgres, then does the startup work that needs it and starts
/// the sidecar, which uses the same database. Returns the sidecar
/// supervisor's task, if the sidecar runs.
async fn start_when_database_ready(state: AppState) -> Option<tokio::task::JoinHandle<()>> {
    if let Err(e) = state.store.migrate_with_retry(None).await {
        fail(format!("couldn't set up the database: {e}"));
    }
    tracing::info!("connected to the database");
    match state.approvals.deny_orphaned().await {
        Ok(0) => {}
        Ok(n) => tracing::info!("denied {n} approvals left pending by the last run"),
        Err(e) => fail(e),
    }
    // stdout and a private file, never the log: whoever holds this code can
    // claim the server.
    let setup_code_file = state.config.server.data_dir.join("setup-code");
    match state
        .account
        .issue_setup_code_if_needed(Some(&setup_code_file))
        .await
    {
        Ok(Some(code)) => println!(
            "This server isn't set up yet. Setup code: {code} (also in {})",
            setup_code_file.display()
        ),
        Ok(None) => {}
        Err(e) => fail(e),
    }
    let watch = state.auth.watch_outside_revocations();
    tokio::spawn(async move {
        if let Err(e) = watch.await {
            tracing::error!("stopped closing sockets of devices revoked by the CLI: {e}");
        }
    });
    start_core(&state).await
}

const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Ctrl-C, or SIGTERM from launchd.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

async fn add_device(store: Store, name: &str, scopes: &str) {
    let name = yarvis_server::devices::device_name(name).unwrap_or_else(|e| fail(e.error));
    let scopes = parse_scope_list(scopes).unwrap_or_else(|e| fail(e));
    let events = EventLog::new(store.clone());
    let signed_in = add_token_device(&store, &events, &name, &scopes, None)
        .await
        .unwrap_or_else(|e| fail(e));
    // Only the token goes to stdout, so a caller can capture it as-is.
    println!("{}", signed_in.token);
}

/// The recovery key goes to stdout and nowhere else; the rest goes to
/// stderr, so `vault init > key.txt` captures only the key. Returns the
/// passphrase, for a caller that unlocks the new vault next.
async fn vault_init(
    config: &Config,
    store: Store,
    passphrase_stdin: bool,
) -> zeroize::Zeroizing<String> {
    if !config.uses_vault() {
        eprintln!(
            "note: neither secrets.backend = \"vault\" nor ssh_agent.enabled = true is set, \
             so the server won't use this vault until one is"
        );
    }
    let data_dir = &config.server.data_dir;
    // Before the prompt, so nobody types a passphrase for nothing.
    if data_dir.join("vault.json").exists() {
        fail("a vault already exists here");
    }
    let passphrase = read_vault_passphrase(passphrase_stdin);
    let account = yarvis_server::auth::account::Account::new(store);
    if account
        .is_sign_in_passphrase(passphrase.clone())
        .await
        .unwrap_or_else(|e| fail(e))
    {
        fail("that is the sign-in passphrase; the vault needs a different one");
    }
    let created =
        Vault::init(data_dir, config.ssh_agent.enabled, &passphrase).unwrap_or_else(|e| fail(e));
    eprintln!(
        "Created {}. Write down the recovery key below; it is shown only this once.",
        data_dir.join("vault.json").display()
    );
    println!("{}", created.recovery_key.expose());
    if let Some(public_key) = created.signing_public_key {
        eprintln!("Git signing key (add it to GitHub as a signing key): {public_key}");
    }
    passphrase
}

/// What `secrets migrate` needs from `main` beyond its own flags.
struct MigrationTarget<'a> {
    config: &'a Config,
    config_path: &'a Path,
    store: Store,
    database: &'a DatabaseUrl,
}

/// Merges the secrets in `from` into `to`. Conflicting keys stop it unless a
/// `--force-` flag says which side wins. Key names go to stderr; values never
/// leave the stores.
async fn secrets_migrate(
    target: MigrationTarget<'_>,
    from: SecretBackendKind,
    to: SecretBackendKind,
    on_conflict: OnConflict,
    passphrase_stdin: bool,
) {
    use std::io::IsTerminal;
    let config = target.config;
    if from == to {
        fail("--from and --to name the same store");
    }
    // Only a server using the vault holds it in memory, for its secrets or
    // just the signing key, and it writes that copy back on its next change,
    // which would drop what this adds.
    let running_server_check =
        (to == SecretBackendKind::Vault && config.uses_vault()).then_some(config.server.bind);
    if let Some(bind) = running_server_check {
        refuse_if_running(bind).unwrap_or_else(|e| fail(e));
    }
    let settings = SettingsStore::new(SettingsStore::default_path());
    let vault = if from == SecretBackendKind::Vault || to == SecretBackendKind::Vault {
        let vault = Vault::new(&config.server.data_dir);
        let exists = vault
            .path()
            .try_exists()
            .unwrap_or_else(|e| fail(format!("couldn't check {}: {e}", vault.path().display())));
        let interactive = !passphrase_stdin && std::io::stdin().is_terminal();
        let passphrase = match vault_plan(exists, to == SecretBackendKind::Vault, interactive) {
            VaultPlan::Unlock => read_existing_vault_passphrase(passphrase_stdin),
            VaultPlan::OfferToCreate => {
                // Checked first, so a run with nothing to copy doesn't leave
                // a new, empty vault behind.
                let source = store_for(from, &settings, None);
                blocking(move || secret_migration::read_source(&source).map(|_| ()))
                    .await
                    .unwrap_or_else(|e| fail(e));
                if !ask_yes_no(&format!(
                    "There is no vault at {} yet. Create one now? [y/N] ",
                    vault.path().display()
                )) {
                    fail("No vault was created, so nothing was copied.");
                }
                wait_for_database(&target.store, target.database).await;
                vault_init(config, target.store.clone(), false).await
            }
            VaultPlan::Refuse(reason) => fail(format!("{reason}: {}", vault.path().display())),
        };
        let unlocking = vault.clone();
        blocking(move || unlocking.unlock_with_passphrase(&passphrase))
            .await
            .unwrap_or_else(|e| fail(format!("couldn't unlock the vault: {e}")));
        Some(vault)
    } else {
        None
    };
    let source = store_for(from, &settings, vault.as_ref());
    let destination = store_for(to, &settings, vault.as_ref());
    let (source_label, destination_label) = (source.label, destination.label);

    let migrated = blocking(move || {
        let blob = SecretBlob::with_store(destination.clone(), settings);
        let guard = blob.lock_for_write()?;
        // Again under the lock: the prompts above leave time for a server to
        // start.
        if let Some(bind) = running_server_check {
            refuse_if_running(bind)?;
        }
        secret_migration::migrate(&guard, &source, &destination, on_conflict)
            .map_err(|e| e.to_string())
    })
    .await
    .unwrap_or_else(|e| fail(e));

    if migrated == Migrated::default() {
        eprintln!("{destination_label} already holds everything in {source_label}.");
    } else {
        eprintln!("Copied from {source_label} to {destination_label}.");
    }
    for (what, keys) in [
        ("Added".to_string(), &migrated.added),
        (
            format!("Replaced with {source_label}'s value"),
            &migrated.replaced,
        ),
        (format!("Kept {destination_label}'s value"), &migrated.kept),
    ] {
        if !keys.is_empty() {
            eprintln!("{what}: {}", keys.join(", "));
        }
    }
    eprintln!("{source_label} still holds its copy. Remove it yourself once you've checked.");
    if config.secrets.backend != Some(to) {
        eprintln!(
            "To use {destination_label}, set `backend = \"{}\"` under [secrets] in {} and \
             restart the server.",
            backend_name(to),
            target.config_path.display()
        );
    }
}

/// Runs `work` on the blocking pool: the Keychain may prompt, `op` can take
/// up to a minute, and unlocking stretches the passphrase. A panic's message
/// isn't shown, since it could come from code holding a secret.
async fn blocking<T: Send + 'static, E: std::fmt::Display + Send + 'static>(
    work: impl FnOnce() -> Result<T, E> + Send + 'static,
) -> Result<T, String> {
    tokio::task::spawn_blocking(work)
        .await
        .unwrap_or_else(|_| fail("the migration stopped unexpectedly; nothing more was changed"))
        .map_err(|e| e.to_string())
}

#[derive(Debug, PartialEq, Eq)]
enum VaultPlan {
    Unlock,
    OfferToCreate,
    Refuse(&'static str),
}

/// What to do about the vault, by whether it exists, whether it's being
/// copied into, and whether someone is at the terminal to answer a question.
fn vault_plan(exists: bool, is_destination: bool, interactive: bool) -> VaultPlan {
    match (exists, is_destination, interactive) {
        (true, _, _) => VaultPlan::Unlock,
        (false, false, _) => VaultPlan::Refuse("there is no vault to copy from at"),
        (false, true, false) => VaultPlan::Refuse(
            "there is no vault yet. Create one with `yarvis-server vault init`, then run this \
             again. It would be at",
        ),
        (false, true, true) => VaultPlan::OfferToCreate,
    }
}

fn refuse_if_running(bind: SocketAddr) -> Result<(), String> {
    if server_is_running(bind) {
        return Err(format!(
            "the server is running on {bind}. Stop it first: it keeps its own copy of the vault \
             in memory and would overwrite what this copies."
        ));
    }
    Ok(())
}

/// Whether something answers on the server's address. A wildcard bind is
/// tried on loopback, since connecting to 0.0.0.0 doesn't work everywhere.
fn server_is_running(bind: SocketAddr) -> bool {
    let mut address = bind;
    if address.ip().is_unspecified() {
        address.set_ip(match address {
            SocketAddr::V4(_) => std::net::Ipv4Addr::LOCALHOST.into(),
            SocketAddr::V6(_) => std::net::Ipv6Addr::LOCALHOST.into(),
        });
    }
    std::net::TcpStream::connect_timeout(&address, Duration::from_secs(1)).is_ok()
}

/// The passphrase of a vault that already exists, asked for once.
fn read_existing_vault_passphrase(from_stdin: bool) -> zeroize::Zeroizing<String> {
    use zeroize::Zeroizing;
    if from_stdin {
        // Sized up front so `read_line` doesn't reallocate and leave a copy
        // behind that is never zeroed.
        let mut line = Zeroizing::new(String::with_capacity(1024));
        std::io::stdin()
            .read_line(&mut line)
            .unwrap_or_else(|e| fail(format!("couldn't read the passphrase: {e}")));
        let len = line.trim_end_matches(['\r', '\n']).len();
        line.truncate(len);
        return line;
    }
    Zeroizing::new(
        rpassword::prompt_password("Vault passphrase: ")
            .unwrap_or_else(|e| fail(format!("couldn't read the passphrase: {e}"))),
    )
}

fn ask_yes_no(question: &str) -> bool {
    use std::io::Write;
    eprint!("{question}");
    let _ = std::io::stderr().flush();
    let mut answer = String::new();
    std::io::stdin()
        .read_line(&mut answer)
        .unwrap_or_else(|e| fail(format!("couldn't read the answer: {e}")));
    matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes")
}

/// The store `kind` names. The 1Password item comes from Settings, as it
/// does for the server.
fn store_for(
    kind: SecretBackendKind,
    settings: &SettingsStore,
    vault: Option<&Vault>,
) -> SecretStore {
    match kind {
        SecretBackendKind::Keychain => SecretStore::keychain(),
        SecretBackendKind::OnePassword => settings
            .snapshot()
            .onepassword_item()
            .map(SecretStore::onepassword)
            .unwrap_or_else(|e| {
                fail(format!(
                    "1Password needs a vault and an item, set in Settings → Secrets: {e}"
                ))
            }),
        SecretBackendKind::Vault => SecretStore {
            label: "the server's vault",
            backend: vault
                .expect("opened for a vault migration")
                .secret_backend(),
        },
    }
}

fn backend_name(kind: SecretBackendKind) -> &'static str {
    match kind {
        SecretBackendKind::Keychain => "keychain",
        SecretBackendKind::OnePassword => "onepassword",
        SecretBackendKind::Vault => "vault",
    }
}

fn parse_backend(name: &str) -> Result<SecretBackendKind, String> {
    match name {
        "keychain" => Ok(SecretBackendKind::Keychain),
        "onepassword" => Ok(SecretBackendKind::OnePassword),
        "vault" => Ok(SecretBackendKind::Vault),
        other => Err(format!(
            "unknown store: {other} (use keychain, onepassword or vault)"
        )),
    }
}

/// The vault passphrase, from the first line of stdin or asked for twice on
/// the terminal with no echo. It is separate from the sign-in passphrase.
fn read_vault_passphrase(from_stdin: bool) -> zeroize::Zeroizing<String> {
    use zeroize::Zeroizing;
    let passphrase = if from_stdin {
        let mut line = Zeroizing::new(String::new());
        std::io::stdin()
            .read_line(&mut line)
            .unwrap_or_else(|e| fail(format!("couldn't read the passphrase: {e}")));
        Zeroizing::new(line.trim_end_matches(['\r', '\n']).to_string())
    } else {
        let ask = |prompt: &str| {
            Zeroizing::new(
                rpassword::prompt_password(prompt)
                    .unwrap_or_else(|e| fail(format!("couldn't read the passphrase: {e}"))),
            )
        };
        let first = ask("Vault passphrase (not your sign-in passphrase): ");
        if *ask("Again: ") != *first {
            fail("the passphrases don't match");
        }
        first
    };
    if let Err(reason) = yarvis_server::auth::account::check_passphrase_shape(&passphrase) {
        fail(reason);
    }
    passphrase
}

/// The new setup code goes to stdout and to the private file the server
/// would write, and the running server accepts it at once, since both read it
/// from the database. Signed-in devices stay signed in unless
/// `sign_out_all`.
///
/// Revocations reach a running server's open sockets through its poll of
/// the devices table; requests refuse the tokens at once.
async fn auth_reset(config: &Config, store: Store, sign_out_all: bool) {
    let reset = yarvis_server::auth::account::reset(&store, sign_out_all)
        .await
        .unwrap_or_else(|e| fail(e));
    let code = reset.setup_code;
    let file = config.server.data_dir.join("setup-code");
    if let Err(e) = yarvis_server::auth::account::remove_if_present(&file)
        .and_then(|()| yarvis_server::auth::account::write_private(&file, &format!("{code}\n")))
    {
        eprintln!("couldn't write {}: {e}", file.display());
    }
    let events = EventLog::new(store);
    for id in &reset.revoked_devices {
        if let Err(e) = events
            .append(
                None,
                "device.revoked",
                serde_json::json!({ "deviceId": id }),
            )
            .await
        {
            eprintln!("couldn't record revoking {id}: {e}");
        }
    }
    let data = serde_json::json!({
        "signOutAll": sign_out_all,
        "revokedDevices": reset.revoked_devices,
    });
    if let Err(e) = events.append(None, "account.reset", data).await {
        eprintln!("couldn't record the reset: {e}");
    }
    if sign_out_all {
        eprintln!("Signed out {} devices.", reset.revoked_devices.len());
    }
    eprintln!(
        "The account is removed. Open the server and set it up again with this code (also in {}):",
        file.display()
    );
    println!("{code}");
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

/// Flags may come before or after the `device add` words, so a caller can
/// put `--config` first for every command.
fn parse_args(args: impl Iterator<Item = String>) -> Result<(Command, PathBuf), String> {
    let (mut words, mut config, mut name, mut scopes) = (Vec::new(), None, None, None);
    let (mut passphrase_stdin, mut sign_out_all) = (false, false);
    let (mut from, mut to, mut force_source, mut force_dest) = (None, None, false, false);
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |flag: &str| args.next().ok_or(format!("{flag} needs a value"));
        match arg.as_str() {
            "--config" => config = Some(value("--config")?),
            "--name" => name = Some(value("--name")?),
            "--scopes" => scopes = Some(value("--scopes")?),
            "--passphrase-stdin" => passphrase_stdin = true,
            "--sign-out-all" => sign_out_all = true,
            "--from" => from = Some(value("--from")?),
            "--to" => to = Some(value("--to")?),
            "--force-source" => force_source = true,
            "--force-dest" => force_dest = true,
            flag if flag.starts_with('-') => return Err(format!("unknown argument: {flag}")),
            _ => words.push(arg),
        }
    }
    let migrating = words == ["secrets", "migrate"];
    if passphrase_stdin && words != ["vault", "init"] && !migrating {
        return Err("--passphrase-stdin goes with `vault init` or `secrets migrate`".into());
    }
    if !migrating && (from.is_some() || to.is_some() || force_source || force_dest) {
        return Err(
            "--from, --to, --force-source and --force-dest go with `secrets migrate`".into(),
        );
    }
    if sign_out_all && words != ["auth", "reset"] {
        return Err("--sign-out-all goes with `auth reset`".into());
    }
    let command = match words.as_slice() {
        [] if name.is_none() && scopes.is_none() => Command::Serve,
        [] => return Err("--name and --scopes go with `device add`".into()),
        [auth, reset] if auth == "auth" && reset == "reset" => {
            if name.is_some() || scopes.is_some() {
                return Err("--name and --scopes go with `device add`".into());
            }
            Command::AuthReset { sign_out_all }
        }
        [vault, init] if vault == "vault" && init == "init" => {
            if name.is_some() || scopes.is_some() {
                return Err("--name and --scopes go with `device add`".into());
            }
            Command::VaultInit { passphrase_stdin }
        }
        [secrets, migrate] if secrets == "secrets" && migrate == "migrate" => {
            if name.is_some() || scopes.is_some() {
                return Err("--name and --scopes go with `device add`".into());
            }
            let on_conflict = match (force_source, force_dest) {
                (true, true) => {
                    return Err("pick one of --force-source and --force-dest".into());
                }
                (true, false) => OnConflict::SourceWins,
                (false, true) => OnConflict::DestinationWins,
                (false, false) => OnConflict::Refuse,
            };
            let from = parse_backend(&from.ok_or("secrets migrate needs --from")?)?;
            let to = parse_backend(&to.ok_or("secrets migrate needs --to")?)?;
            let vault = SecretBackendKind::Vault;
            if passphrase_stdin && from != vault && to != vault {
                return Err("--passphrase-stdin is for the vault's passphrase".into());
            }
            Command::SecretsMigrate {
                from,
                to,
                on_conflict,
                passphrase_stdin,
            }
        }
        [device, add] if device == "device" && add == "add" => Command::AddDevice {
            name: name.ok_or("device add needs --name")?,
            scopes: scopes.ok_or("device add needs --scopes")?,
        },
        _ => return Err(format!("unknown command: {}", words.join(" "))),
    };
    let config = config
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path);
    Ok((command, config))
}

fn default_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".yarvis").join("server.toml"))
        .unwrap_or_else(|| PathBuf::from("server.toml"))
}

/// Settings and secrets housekeeping, then the sidecar. Returns the
/// supervisor's task, if the sidecar runs.
async fn start_core(state: &AppState) -> Option<tokio::task::JoinHandle<()>> {
    state.settings.ensure_dir();
    // Both migrations move values a past desktop build wrote to the Keychain,
    // so they run unless server.toml picked another store for this server.
    if matches!(
        state.config.secrets.backend,
        None | Some(SecretBackendKind::Keychain)
    ) {
        let (settings, secrets) = (state.settings.clone(), state.secrets.clone());
        let migrated = tokio::task::spawn_blocking(move || {
            let keychain = SecretStore::keychain();
            settings.migrate_keychain_settings(&secrets, &keychain);
            yarvis_server::embeddings_secrets::migrate_legacy_item(&secrets, &keychain);
        })
        .await;
        if let Err(e) = migrated {
            tracing::error!("the Keychain migrations panicked: {e}");
        }
    }
    if !state.config.sidecar.enabled {
        tracing::info!("sidecar.enabled is false; not starting the sidecar");
        return None;
    }
    let deps = SupervisorDeps {
        config: state.config.clone(),
        settings: state.settings.clone(),
        secrets: state.secrets.clone(),
        events: state.events.clone(),
        vault_unlocked: state
            .config
            .secrets_in_vault()
            .then(|| state.vault.subscribe()),
    };
    Some(tokio::spawn(state.sidecar.clone().supervise(deps)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<(Command, PathBuf), String> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_device_add() {
        let (command, config) = parse(&[
            "device",
            "add",
            "--name",
            "tauri",
            "--scopes",
            "read,chat",
            "--config",
            "x.toml",
        ])
        .unwrap();
        assert!(
            matches!(command, Command::AddDevice { ref name, ref scopes } if name == "tauri" && scopes == "read,chat")
        );
        assert_eq!(config, PathBuf::from("x.toml"));
    }

    #[test]
    fn config_may_come_before_the_subcommand() {
        let (command, config) = parse(&[
            "--config", "x.toml", "device", "add", "--name", "t", "--scopes", "read",
        ])
        .unwrap();
        assert!(matches!(command, Command::AddDevice { .. }));
        assert_eq!(config, PathBuf::from("x.toml"));
    }

    #[test]
    fn refuses_device_flags_on_serve_and_missing_ones_on_add() {
        assert!(parse(&["--name", "x"]).is_err());
        assert!(
            parse(&["device", "add", "--name", "x"])
                .unwrap_err()
                .contains("--scopes")
        );
        assert!(parse(&["device", "remove"]).is_err());
        assert!(matches!(parse(&[]).unwrap().0, Command::Serve));
    }

    #[test]
    fn parses_auth_reset() {
        assert!(matches!(
            parse(&["auth", "reset", "--config", "x.toml"]).unwrap().0,
            Command::AuthReset {
                sign_out_all: false
            }
        ));
        assert!(matches!(
            parse(&["--sign-out-all", "auth", "reset"]).unwrap().0,
            Command::AuthReset { sign_out_all: true }
        ));
        assert!(parse(&["auth", "reset", "--name", "x"]).is_err());
        assert!(parse(&["--sign-out-all"]).is_err());
        assert!(parse(&["vault", "init", "--sign-out-all"]).is_err());
    }

    #[test]
    fn parses_secrets_migrate() {
        let (command, _) = parse(&[
            "secrets",
            "migrate",
            "--from",
            "keychain",
            "--to",
            "vault",
            "--passphrase-stdin",
        ])
        .unwrap();
        assert!(matches!(
            command,
            Command::SecretsMigrate {
                from: SecretBackendKind::Keychain,
                to: SecretBackendKind::Vault,
                on_conflict: OnConflict::Refuse,
                passphrase_stdin: true,
            }
        ));
        let on_conflict = |flag: &str| match parse(&[
            "secrets",
            "migrate",
            "--from",
            "vault",
            "--to",
            "onepassword",
            flag,
        ])
        .unwrap()
        .0
        {
            Command::SecretsMigrate { on_conflict, .. } => on_conflict,
            other => panic!("{other:?}"),
        };
        assert_eq!(on_conflict("--force-source"), OnConflict::SourceWins);
        assert_eq!(on_conflict("--force-dest"), OnConflict::DestinationWins);
    }

    #[test]
    fn refuses_a_bad_secrets_migrate() {
        let migrate = |extra: &[&str]| {
            let mut args = vec!["secrets", "migrate", "--from", "keychain", "--to", "vault"];
            args.extend_from_slice(extra);
            parse(&args)
        };
        assert!(
            migrate(&["--force-source", "--force-dest"])
                .unwrap_err()
                .contains("pick one")
        );
        assert!(
            parse(&["secrets", "migrate", "--to", "vault"])
                .unwrap_err()
                .contains("--from")
        );
        assert!(
            parse(&["secrets", "migrate", "--from", "keychain", "--to", "disk"])
                .unwrap_err()
                .contains("unknown store")
        );
        assert!(parse(&["vault", "init", "--from", "keychain"]).is_err());
        assert!(parse(&["--force-source"]).is_err());
        assert!(migrate(&["--name", "x"]).is_err());
        assert!(
            parse(&[
                "secrets",
                "migrate",
                "--from",
                "keychain",
                "--to",
                "onepassword",
                "--passphrase-stdin",
            ])
            .unwrap_err()
            .contains("vault")
        );
    }

    #[test]
    fn the_vault_is_created_only_as_a_destination_someone_is_there_to_confirm() {
        assert_eq!(vault_plan(true, false, false), VaultPlan::Unlock);
        assert_eq!(vault_plan(true, true, true), VaultPlan::Unlock);
        assert_eq!(vault_plan(false, true, true), VaultPlan::OfferToCreate);
        assert!(
            matches!(vault_plan(false, true, false), VaultPlan::Refuse(r) if r.contains("vault init"))
        );
        assert!(matches!(
            vault_plan(false, false, true),
            VaultPlan::Refuse(_)
        ));
    }

    #[test]
    fn a_server_answering_on_its_address_blocks_a_vault_migration() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // The server's own bind is often the wildcard address.
        let wildcard = SocketAddr::from(([0, 0, 0, 0], port));
        assert!(
            refuse_if_running(wildcard)
                .unwrap_err()
                .contains("Stop it first")
        );
        drop(listener);
        assert!(refuse_if_running(wildcard).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn the_data_dir_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("nested").join("data");
        create_private_dir(&data).unwrap();
        let mode = std::fs::metadata(&data).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o700);
    }

    #[test]
    fn parses_vault_init() {
        assert!(matches!(
            parse(&["vault", "init", "--config", "x.toml"]).unwrap().0,
            Command::VaultInit {
                passphrase_stdin: false
            }
        ));
        assert!(matches!(
            parse(&["vault", "init", "--passphrase-stdin"]).unwrap().0,
            Command::VaultInit {
                passphrase_stdin: true
            }
        ));
        assert!(parse(&["--passphrase-stdin"]).is_err());
        assert!(parse(&["vault", "init", "--name", "x"]).is_err());
    }
}
