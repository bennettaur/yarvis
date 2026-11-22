//! What sessions inherit from the server's own environment. A file of its own
//! because the test sets variables in this process, which is only sound while
//! no other test runs beside it, so add no other test here. It opens PTYs, which Claude Code's sandbox
//! refuses.

#![cfg(unix)]

mod common;

use std::sync::Arc;

use yarvis_server::pty::PtyOptions;
use yarvis_server::pty::session::{Session, Size};

use common::pty::{output_of, serve};
use common::until;

const WORKSPACE: &str = "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70";

/// What the line printed by [`REPORT`] says, once it has been printed. The
/// echoed command holds `%s`, so only the output follows the label otherwise.
fn reported(session: &Session) -> Option<String> {
    let out = output_of(session);
    let rest = out
        .split("seen=[")
        .skip(1)
        .find(|rest| !rest.starts_with('%'))?;
    Some(rest[..rest.find(']')?].to_string())
}

const REPORT: &str = "printf 'seen=[%s|%s]\\n' \"$ANTHROPIC_API_KEY\" \"$YARVIS_DATABASE_URL\"";

/// An agent session uses the user's Claude subscription, so it never gets the
/// server's `ANTHROPIC_API_KEY` (Remote Control refuses API-key auth). No
/// session gets the server's own database URL, which reaches its account and
/// device tables. A plain terminal keeps the key, as the user's own shell.
#[tokio::test(flavor = "current_thread")]
async fn sessions_never_get_the_servers_database_url_and_agents_not_its_api_key() {
    // SAFETY: the only test in this binary, and nothing else has started yet.
    unsafe {
        std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-inherited");
        std::env::set_var("YARVIS_DATABASE_URL", "postgres://server-own/yarvis");
    }
    let server = serve(PtyOptions::default()).await;
    let cwd = server.dir.path().to_string_lossy().into_owned();

    let pty = server.state.pty.clone();
    let shell = tokio::task::spawn_blocking(move || {
        pty.attach_or_spawn(
            "tab:terminal/t1/p1",
            Size {
                cols: 200,
                rows: 24,
            },
            None,
        )
    })
    .await
    .unwrap()
    .unwrap();
    shell
        .write(None, format!("{REPORT}\n").into_bytes())
        .await
        .unwrap();
    let seen = until("the shell's report", || {
        let shell = shell.clone();
        async move { reported(&shell) }
    })
    .await;
    assert_eq!(seen, "sk-ant-inherited|");

    // The launch line is the agent command, so this reports what the agent
    // would have started with.
    server.write_settings(serde_json::json!({ "agentCommand": REPORT }));
    let pty = server.state.pty.clone();
    let agent: Arc<Session> = tokio::task::spawn_blocking(move || {
        pty.spawn_claude_session(WORKSPACE, cwd, "n", false, None, None, None)?;
        pty.attach_or_spawn(
            &format!("ws-claude:{WORKSPACE}"),
            Size {
                cols: 200,
                rows: 24,
            },
            None,
        )
    })
    .await
    .unwrap()
    .unwrap();
    let seen = until("the agent's report", || {
        let agent = agent.clone();
        async move { reported(&agent) }
    })
    .await;
    assert_eq!(seen, "|");
}
