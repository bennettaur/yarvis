//! Checks and headers every response gets.
//!
//! - The `Host` header must name this server. A page on another site can
//!   point a DNS name at 127.0.0.1 (DNS rebinding) and reach a loopback
//!   server from the user's browser. Device tokens stop it from doing much,
//!   but the setup and sign-in routes need no token.
//! - The web UI renders model output and markdown, so a strict CSP limits
//!   what an injected script could do with the token the page holds, and
//!   `frame-ancestors 'none'` stops another site framing the approvals page.
//!   Images may come from any HTTPS host, since the UI shows avatars and
//!   pictures from GitHub, JIRA and the like; an image can't run script.

use axum::extract::{Request, State};
use axum::http::{HeaderValue, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::AppState;
use crate::error::ApiError;

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
                   img-src 'self' data: blob: https:; media-src 'self' blob:; connect-src 'self'; \
                   font-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; \
                   base-uri 'none'; form-action 'self'";

pub async fn guard(State(state): State<AppState>, request: Request, next: Next) -> Response {
    // HTTP/2 carries the host in the URI's authority rather than a header.
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .or_else(|| request.uri().authority().map(|a| a.as_str()))
        .unwrap_or("")
        .to_string();
    if !host_allowed(&state, &host) {
        return ApiError::forbidden("unknown host").into_response();
    }
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(CSP),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    response
}

/// Loopback names, the bind address itself, and the hosts of
/// `auth.origins` are allowed.
fn host_allowed(state: &AppState, host: &str) -> bool {
    let name = strip_port(host);
    if matches!(name, "localhost" | "127.0.0.1" | "[::1]") {
        return true;
    }
    if name == state.config.server.bind.ip().to_string() {
        return true;
    }
    state
        .config
        .auth
        .origins
        .iter()
        .filter_map(|origin| origin.split_once("://").map(|(_, rest)| rest))
        .any(|authority| strip_port(authority) == name)
}

fn strip_port(authority: &str) -> &str {
    // `[::1]:7878` keeps its brackets; `host:7878` loses the port.
    if authority.starts_with('[') {
        return authority
            .find(']')
            .map_or(authority, |end| &authority[..=end]);
    }
    authority.split(':').next().unwrap_or(authority)
}

#[cfg(test)]
mod tests {
    use super::strip_port;

    #[test]
    fn strips_ports_but_keeps_ipv6_brackets() {
        assert_eq!(strip_port("localhost:7878"), "localhost");
        assert_eq!(strip_port("[::1]:7878"), "[::1]");
        assert_eq!(strip_port("yarvis.example.com"), "yarvis.example.com");
    }
}
