//! `/api/sidecar/{*path}`: the reverse proxy in front of the Bun sidecar.
//!
//! `/api/sidecar/api/status` reaches the sidecar's `/api/status`: the prefix is
//! dropped and the rest, query included, is sent as is. Only `/health` and the
//! paths under `/api/` behind the sidecar's bearer wall are reachable. The
//! sidecar's other routes (`/ingest`, `/mcp`, `/browser`, the OAuth callbacks)
//! carry their own scoped tokens or state nonces, and are called on loopback by
//! local processes and browser redirects, so they stay off the proxy.
//!
//! The device is checked here. `GET`/`HEAD` need `read` and other methods
//! `chat`, except for the routes in [`SCOPE_RULES`]: those that change what
//! the sidecar or its agents may do need `admin`, and those that answer an
//! approval need `approve`. The device's `Authorization` header is dropped and
//! replaced with the sidecar's own bearer token, so the sidecar never sees a
//! device token. The device id goes along in `X-Yarvis-Device-Id`, replacing
//! any the client sent, so the sidecar can record who asked.
//!
//! Bodies stream both ways. Chat replies are SSE, and holding a response until
//! it ends would hold the whole reply. A response still streaming ends when
//! its device is revoked.
//!
//! A WebSocket upgrade is answered here, not passed through: a browser can't
//! set headers on a WebSocket, so the device authenticates with its first
//! message ([`crate::auth::authenticate_ws`]). Only then is the sidecar's
//! socket opened, with the bearer header, and frames relayed both ways. A
//! socket can send as well as read, so it needs what a write to its path does.

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{self, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{AUTHORIZATION, CONNECTION, COOKIE, HOST, HeaderName};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use tokio::sync::broadcast;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

use crate::AppState;
use crate::auth::{
    Admin, Approve, Authed, Chat, CloseReason, DeviceContext, Read, Scope, Terminal,
    authenticate_ws,
};
use crate::error::ApiError;

pub const DEVICE_ID_HEADER: &str = "x-yarvis-device-id";

/// The connection is on loopback, so a sidecar that takes longer than this to
/// accept is down or restarting rather than slow.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// The largest message a client may send on a proxied socket. The first one
/// is parsed before anyone is authenticated.
const MAX_CLIENT_MESSAGE: usize = 1024 * 1024;

/// Headers that describe one hop, not the request, so a proxy never forwards
/// them (RFC 9110 §7.6.1).
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Which methods a [`SCOPE_RULES`] entry covers.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Methods {
    /// Anything but `GET` and `HEAD`.
    Writes,
    All,
}

/// Sidecar routes that need more than the default scope, matched by path
/// segment (`*` is any one segment) on the path and everything below it. The
/// first match wins, so the narrow exceptions come before their prefixes.
///
/// `terminal`: saving a file into a worktree, the one sidecar route that is
/// raw shell access by another name (a planted hook runs as the server's
/// user). Starting workspaces and driving their agent sessions is `chat`,
/// since that is what a chat device is for.
///
/// `admin`: routes that change what the sidecar or its agents may do: MCP
/// servers (a stdio server is a command the sidecar runs), LLM providers and
/// model choices, the settings sections the sidecar owns, credentials (the
/// GitHub sign-in stores a token), standing consent for tools, scheduled job
/// and specialist definitions, and registered repos with their setup scripts.
/// The MCP endpoint's connection info carries the MCP token, so even reading
/// it is `admin`.
///
/// `approve`: answers to tool approvals, permission prompts and agent
/// questions, and the grant that lets a PR's setup script run.
const SCOPE_RULES: &[(&str, Methods, Scope)] = &[
    ("/api/mcp-endpoint/connection", Methods::All, Scope::Admin),
    ("/api/mcp/tools/search", Methods::Writes, Scope::Chat),
    ("/api/jobs/agent-jobs/*/run", Methods::Writes, Scope::Chat),
    (
        "/api/workspaces/*/repos/*/file",
        Methods::Writes,
        Scope::Terminal,
    ),
    ("/api/chat/approvals", Methods::Writes, Scope::Approve),
    (
        "/api/attention/permissions",
        Methods::Writes,
        Scope::Approve,
    ),
    ("/api/questions", Methods::Writes, Scope::Approve),
    ("/api/heads-down/questions", Methods::Writes, Scope::Approve),
    (
        "/api/review-workspaces/*/prs/*/setup",
        Methods::Writes,
        Scope::Approve,
    ),
    ("/api/custom-providers", Methods::Writes, Scope::Admin),
    ("/api/model-catalog", Methods::Writes, Scope::Admin),
    ("/api/complexity-models", Methods::Writes, Scope::Admin),
    ("/api/decision-model", Methods::Writes, Scope::Admin),
    ("/api/pr-models", Methods::Writes, Scope::Admin),
    (
        "/api/mutation-testing-config",
        Methods::Writes,
        Scope::Admin,
    ),
    ("/api/mcp", Methods::Writes, Scope::Admin),
    ("/api/github/config", Methods::Writes, Scope::Admin),
    ("/api/github-auth", Methods::Writes, Scope::Admin),
    ("/api/google/disconnect", Methods::Writes, Scope::Admin),
    (
        "/api/memory/embeddings/config",
        Methods::Writes,
        Scope::Admin,
    ),
    ("/api/chat/config", Methods::Writes, Scope::Admin),
    ("/api/wip/config", Methods::Writes, Scope::Admin),
    ("/api/voice/config", Methods::Writes, Scope::Admin),
    ("/api/voice/server", Methods::Writes, Scope::Admin),
    ("/api/jobs/config", Methods::Writes, Scope::Admin),
    ("/api/jobs/agent-jobs", Methods::Writes, Scope::Admin),
    ("/api/heads-down/config", Methods::Writes, Scope::Admin),
    (
        "/api/heads-down/allowed-tools",
        Methods::Writes,
        Scope::Admin,
    ),
    ("/api/heads-down/routines", Methods::Writes, Scope::Admin),
    ("/api/specialists", Methods::Writes, Scope::Admin),
    ("/api/repos", Methods::Writes, Scope::Admin),
];

/// Sidecar routes only the server calls. The turn detector's address carries
/// its token, and clients reach the detector through
/// [`turn_detector_socket`] instead.
const SERVER_ONLY: &[&str] = &[TURN_DETECTOR_UPSTREAM];

const TURN_DETECTOR_UPSTREAM: &str = "/api/voice/turn-detector/upstream";

/// The scope a request to the sidecar's `path` (no query) needs.
fn required_scope(method: &Method, path: &str) -> Scope {
    let read = matches!(*method, Method::GET | Method::HEAD);
    let rule = SCOPE_RULES.iter().find(|(pattern, methods, _)| {
        (*methods == Methods::All || !read) && path_matches(pattern, path)
    });
    match rule {
        Some((_, _, scope)) => *scope,
        None if read => Scope::Read,
        None => Scope::Chat,
    }
}

/// Whether `path` is `pattern` or below it, segment by segment.
fn path_matches(pattern: &str, path: &str) -> bool {
    let mut segments = path.split('/');
    pattern.split('/').all(|want| {
        segments
            .next()
            .is_some_and(|got| want == "*" || want == got)
    })
}

pub async fn proxy(State(state): State<AppState>, request: Request) -> Response {
    match forward(state, request).await {
        Ok(response) => response,
        Err(e) => e.into_response(),
    }
}

async fn forward(state: AppState, request: Request) -> Result<Response, ApiError> {
    let path_and_query = upstream_path(request.uri()).ok_or_else(ApiError::not_found)?;
    // Scopes are matched on the decoded path, since the sidecar's router
    // decodes it before routing: `/api/%77orkspaces` reaches `/api/workspaces`.
    let raw_path = path_and_query.split('?').next().unwrap_or_default();
    let path = decoded_path(raw_path).ok_or_else(ApiError::not_found)?;
    if SERVER_ONLY
        .iter()
        .any(|pattern| path_matches(pattern, &path))
    {
        return Err(ApiError::not_found());
    }
    let (mut parts, body) = request.into_parts();
    if is_websocket_upgrade(&parts.headers) {
        let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        let scope = required_scope(&Method::POST, &path);
        return Ok(upgrade
            .max_message_size(MAX_CLIENT_MESSAGE)
            .on_upgrade(move |socket| relay(socket, state, path_and_query, scope)));
    }
    // Subscribed before the token is checked, so a revocation that lands in
    // between still ends the response.
    let revoked = state.auth.subscribe_revocations();
    let scope = required_scope(&parts.method, &path);
    let device = authorize(&mut parts, &state, scope).await?;
    if !state.sidecar.is_running() {
        return Err(not_running());
    }

    let endpoint = state.sidecar.endpoint();
    let uri: Uri = format!("http://127.0.0.1:{}{path_and_query}", endpoint.port)
        .parse()
        .map_err(ApiError::internal)?;
    let mut upstream = hyper::Request::builder()
        .method(parts.method)
        .uri(uri)
        .body(body)
        .map_err(ApiError::internal)?;
    *upstream.headers_mut() = forwarded_headers(&parts.headers, &endpoint.token, &device)?;

    let response = client().request(upstream).await.map_err(|e| {
        tracing::warn!("sidecar proxy: {e}");
        not_running()
    })?;
    let (mut parts, body) = response.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    let body = body
        .into_data_stream()
        .take_until(until_revoked(revoked, device.device_id));
    Ok(Response::from_parts(parts, Body::from_stream(body)))
}

fn not_running() -> ApiError {
    ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "the sidecar isn't running right now",
    )
}

async fn authorize(
    parts: &mut Parts,
    state: &AppState,
    scope: Scope,
) -> Result<DeviceContext, ApiError> {
    Ok(match scope {
        Scope::Read => {
            Authed::<Read>::from_request_parts(parts, state)
                .await?
                .device
        }
        Scope::Chat => {
            Authed::<Chat>::from_request_parts(parts, state)
                .await?
                .device
        }
        Scope::Terminal => {
            Authed::<Terminal>::from_request_parts(parts, state)
                .await?
                .device
        }
        Scope::Approve => {
            Authed::<Approve>::from_request_parts(parts, state)
                .await?
                .device
        }
        Scope::Admin => {
            Authed::<Admin>::from_request_parts(parts, state)
                .await?
                .device
        }
    })
}

/// Resolves once `device_id` is revoked. A lagged receiver may have missed the
/// revocation, so it resolves then too.
async fn until_revoked(mut revoked: broadcast::Receiver<String>, device_id: String) {
    loop {
        match revoked.recv().await {
            Ok(id) if id == device_id => return,
            Ok(_) => {}
            Err(broadcast::error::RecvError::Lagged(_)) => return,
            Err(broadcast::error::RecvError::Closed) => std::future::pending().await,
        }
    }
}

/// The sidecar path for a proxied URI, or `None` for one the proxy doesn't
/// serve. Dot segments and encoded slashes or backslashes are refused, so a
/// path that starts under `/api/` can't climb out to a route outside the
/// bearer wall, and every path is matched against [`SCOPE_RULES`] the way the
/// sidecar will route it.
fn upstream_path(uri: &Uri) -> Option<String> {
    let rest = uri.path().strip_prefix("/api/sidecar")?;
    let allowed = rest == "/health" || rest.starts_with("/api/");
    if !allowed || rest.contains("//") || decoded_path(rest).is_none() {
        return None;
    }
    Some(match uri.query() {
        Some(query) => format!("{rest}?{query}"),
        None => rest.to_string(),
    })
}

/// `path` with each segment percent-decoded, or `None` for an encoding that
/// isn't valid UTF-8, a dot segment, or a separator hidden inside a segment.
fn decoded_path(path: &str) -> Option<String> {
    let segments = path
        .split('/')
        .map(|segment| {
            let decoded = percent_decode(segment)?;
            let hidden_separator = decoded.contains('/') || decoded.contains('\\');
            (!hidden_separator && decoded != "." && decoded != "..").then_some(decoded)
        })
        .collect::<Option<Vec<_>>>()?;
    Some(segments.join("/"))
}

fn percent_decode(segment: &str) -> Option<String> {
    let bytes = segment.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn is_websocket_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get(axum::http::header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// The client's headers minus what belongs to this hop or to the device, plus
/// the sidecar's bearer token and the device id.
fn forwarded_headers(
    incoming: &HeaderMap,
    token: &str,
    device: &DeviceContext,
) -> Result<HeaderMap, ApiError> {
    let mut headers = incoming.clone();
    strip_hop_by_hop(&mut headers);
    // Cookies aren't used for auth anywhere, and the sidecar has no business
    // with whatever the browser holds for this origin.
    for name in [AUTHORIZATION, HOST, COOKIE] {
        headers.remove(name);
    }
    headers.remove(DEVICE_ID_HEADER);
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {token}")).map_err(ApiError::internal)?,
    );
    headers.insert(
        HeaderName::from_static(DEVICE_ID_HEADER),
        HeaderValue::from_str(&device.device_id).map_err(ApiError::internal)?,
    );
    Ok(headers)
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    // A header named in `Connection` is hop-by-hop too.
    let named: Vec<String> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect();
    for name in HOP_BY_HOP
        .iter()
        .copied()
        .chain(named.iter().map(String::as_str))
    {
        headers.remove(name);
    }
}

fn client() -> &'static Client<HttpConnector, Body> {
    static CLIENT: OnceLock<Client<HttpConnector, Body>> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let mut connector = HttpConnector::new();
        connector.set_connect_timeout(Some(CONNECT_TIMEOUT));
        connector.set_nodelay(true);
        Client::builder(TokioExecutor::new()).build(connector)
    })
}

/// Authenticates the device on its first message, opens the sidecar's socket,
/// and relays frames until either side closes or the device is revoked.
async fn relay(mut socket: WebSocket, state: AppState, path_and_query: String, scope: Scope) {
    // Subscribed before authenticating, so a revocation that lands while the
    // token is being checked still closes this socket.
    let revoked = state.auth.subscribe_revocations();
    let Some((device, _)) = authenticate_ws(&mut socket, &state.auth, scope).await else {
        return;
    };
    let endpoint = state.sidecar.endpoint().clone();
    let upstream = if state.sidecar.is_running() {
        connect_upstream(&endpoint, &path_and_query, &device).await
    } else {
        Err("the sidecar isn't running".to_string())
    };
    let upstream = match upstream {
        Ok(upstream) => upstream,
        Err(e) => {
            tracing::warn!("sidecar proxy websocket: {e}");
            crate::auth::close(&mut socket, CloseReason::Internal).await;
            return;
        }
    };
    pump(socket, upstream, revoked, &device).await;
}

/// `GET /api/voice/turn-detector/socket` (WebSocket, `chat`): continuous
/// voice mode's audio, relayed to the sidecar's turn detector on loopback, so
/// a browser on another machine can use it through the server's own origin.
pub async fn turn_detector_socket(
    State(state): State<AppState>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade
        .max_message_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| relay_turn_detector(socket, state))
}

async fn relay_turn_detector(mut socket: WebSocket, state: AppState) {
    let revoked = state.auth.subscribe_revocations();
    let Some((device, _)) = authenticate_ws(&mut socket, &state.auth, Scope::Chat).await else {
        return;
    };
    match connect_turn_detector(&state).await {
        Ok(upstream) => pump(socket, upstream, revoked, &device).await,
        Err(e) => {
            tracing::warn!("turn detector websocket: {e}");
            crate::auth::close(&mut socket, CloseReason::Internal).await;
        }
    }
}

/// Asks the sidecar where its turn detector listens, then connects there.
async fn connect_turn_detector(state: &AppState) -> Result<UpstreamSocket, String> {
    if !state.sidecar.is_running() {
        return Err("the sidecar isn't running".into());
    }
    let endpoint = state.sidecar.endpoint();
    let request = axum::http::Request::get(format!(
        "http://127.0.0.1:{}{TURN_DETECTOR_UPSTREAM}",
        endpoint.port
    ))
    .header(AUTHORIZATION, format!("Bearer {}", endpoint.token))
    .body(Body::empty())
    .map_err(|e| e.to_string())?;
    let response = tokio::time::timeout(CONNECT_TIMEOUT, client().request(request))
        .await
        .map_err(|_| "timed out asking the sidecar".to_string())?
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("the sidecar answered {}", response.status()));
    }
    let body = response
        .into_body()
        .collect()
        .await
        .map_err(|e| e.to_string())?
        .to_bytes();
    let url = serde_json::from_slice::<serde_json::Value>(&body)
        .ok()
        .and_then(|v| v["url"].as_str().map(String::from))
        .ok_or("the turn detector isn't running")?;
    // Only ever a loopback address the sidecar reports; never somewhere else.
    if !url.starts_with("ws://127.0.0.1:") {
        return Err("the turn detector reported an address off loopback".into());
    }
    let connect = tokio_tungstenite::connect_async(url);
    let (socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| "timed out connecting to the turn detector".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(socket)
}

/// Relays frames both ways until either side closes or the device is revoked.
async fn pump(
    socket: WebSocket,
    upstream: UpstreamSocket,
    mut revoked: broadcast::Receiver<String>,
    device: &DeviceContext,
) {
    let (mut to_client, mut from_client) = socket.split();
    let (mut to_upstream, mut from_upstream) = upstream.split();
    loop {
        tokio::select! {
            message = from_client.next() => {
                let Some(Ok(message)) = message else { break };
                let closing = matches!(message, ws::Message::Close(_));
                if to_upstream.send(to_tungstenite(message)).await.is_err() || closing {
                    break;
                }
            }
            message = from_upstream.next() => {
                let Some(Ok(message)) = message else { break };
                let Some(message) = to_axum(message) else { continue };
                let closing = matches!(message, ws::Message::Close(_));
                if to_client.send(message).await.is_err() || closing {
                    break;
                }
            }
            id = revoked.recv() => match id {
                // A lagged receiver may have missed this device's revocation,
                // so it closes too and the client authenticates again.
                Ok(id) if id != device.device_id => {}
                Err(broadcast::error::RecvError::Closed) => {}
                _ => {
                    let frame = ws::CloseFrame {
                        code: CloseReason::Unauthorized.code(),
                        reason: "sign in first".into(),
                    };
                    let _ = to_client.send(ws::Message::Close(Some(frame))).await;
                    break;
                }
            },
        }
    }
    let _ = to_upstream.close().await;
}

type UpstreamSocket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_upstream(
    endpoint: &crate::sidecar::Endpoint,
    path_and_query: &str,
    device: &DeviceContext,
) -> Result<UpstreamSocket, String> {
    let url = format!("ws://127.0.0.1:{}{path_and_query}", endpoint.port);
    let mut request = url.into_client_request().map_err(|e| e.to_string())?;
    let headers = request.headers_mut();
    headers.insert(
        AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", endpoint.token)).map_err(|e| e.to_string())?,
    );
    headers.insert(
        HeaderName::from_static(DEVICE_ID_HEADER),
        HeaderValue::from_str(&device.device_id).map_err(|e| e.to_string())?,
    );
    let connect = tokio_tungstenite::connect_async(request);
    let (socket, _) = tokio::time::timeout(CONNECT_TIMEOUT, connect)
        .await
        .map_err(|_| "timed out connecting to the sidecar".to_string())?
        .map_err(|e| e.to_string())?;
    Ok(socket)
}

fn to_tungstenite(message: ws::Message) -> tungstenite::Message {
    match message {
        ws::Message::Text(text) => tungstenite::Message::text(text.as_str()),
        ws::Message::Binary(bytes) => tungstenite::Message::binary(bytes),
        ws::Message::Ping(bytes) => tungstenite::Message::Ping(bytes),
        ws::Message::Pong(bytes) => tungstenite::Message::Pong(bytes),
        ws::Message::Close(frame) => {
            tungstenite::Message::Close(frame.map(|f| tungstenite::protocol::CloseFrame {
                code: f.code.into(),
                reason: f.reason.as_str().into(),
            }))
        }
    }
}

fn to_axum(message: tungstenite::Message) -> Option<ws::Message> {
    Some(match message {
        tungstenite::Message::Text(text) => ws::Message::Text(text.as_str().into()),
        tungstenite::Message::Binary(bytes) => ws::Message::Binary(bytes),
        tungstenite::Message::Ping(bytes) => ws::Message::Ping(bytes),
        tungstenite::Message::Pong(bytes) => ws::Message::Pong(bytes),
        tungstenite::Message::Close(frame) => ws::Message::Close(frame.map(|f| ws::CloseFrame {
            code: f.code.into(),
            reason: f.reason.as_str().into(),
        })),
        // Raw frames only appear when writing; a read never yields one.
        tungstenite::Message::Frame(_) => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn path(uri: &str) -> Option<String> {
        upstream_path(&uri.parse().unwrap())
    }

    #[test]
    fn the_prefix_is_dropped_and_the_query_kept() {
        assert_eq!(
            path("/api/sidecar/api/status").as_deref(),
            Some("/api/status")
        );
        assert_eq!(
            path("/api/sidecar/api/chat/threads?limit=5").as_deref(),
            Some("/api/chat/threads?limit=5")
        );
        assert_eq!(path("/api/sidecar/health").as_deref(), Some("/health"));
    }

    /// Those routes take their own scoped tokens and are called on loopback.
    #[test]
    fn routes_outside_the_bearer_wall_are_not_proxied() {
        for uri in [
            "/api/sidecar/mcp",
            "/api/sidecar/ingest/permission",
            "/api/sidecar/browser/next",
            "/api/sidecar/oauth/google/callback",
            "/api/sidecar/healthz",
            "/api/sidecar/",
            "/api/sidecar",
        ] {
            assert_eq!(path(uri), None, "{uri}");
        }
    }

    #[test]
    fn dot_segments_cannot_climb_out_of_the_api() {
        for uri in [
            "/api/sidecar/api/../mcp",
            "/api/sidecar/api/%2e%2e/mcp",
            "/api/sidecar/api/%2E%2e/ingest",
            "/api/sidecar/api/./status",
            "/api/sidecar/api/..\\mcp",
        ] {
            assert_eq!(path(uri), None, "{uri}");
        }
    }

    #[test]
    fn encoded_separators_and_empty_segments_are_refused() {
        for uri in [
            "/api/sidecar/api/x%2f..%2fmcp",
            "/api/sidecar/api/x%2F..",
            "/api/sidecar/api/x%5c..%5cmcp",
            "/api/sidecar/api//mcp",
        ] {
            assert_eq!(path(uri), None, "{uri}");
        }
    }

    #[test]
    fn reads_and_writes_get_the_default_scopes() {
        assert_eq!(
            required_scope(&Method::GET, "/api/chat/threads"),
            Scope::Read
        );
        assert_eq!(
            required_scope(&Method::HEAD, "/api/chat/threads"),
            Scope::Read
        );
        assert_eq!(required_scope(&Method::POST, "/api/chat"), Scope::Chat);
        assert_eq!(required_scope(&Method::DELETE, "/api/todos/1"), Scope::Chat);
        assert_eq!(required_scope(&Method::GET, "/health"), Scope::Read);
    }

    /// A stdio MCP server is a command the sidecar runs, and the GitHub
    /// sign-in stores a token, so neither is a chat device's to change.
    #[test]
    fn routes_that_change_what_the_sidecar_may_do_need_admin() {
        for (method, path) in [
            (Method::POST, "/api/mcp/servers"),
            (Method::PATCH, "/api/mcp/servers/abc"),
            (Method::PATCH, "/api/mcp/tools/abc"),
            (Method::POST, "/api/custom-providers"),
            (Method::PUT, "/api/model-catalog"),
            (Method::POST, "/api/github-auth/device"),
            (Method::PUT, "/api/github/config"),
            (Method::POST, "/api/repos"),
            (Method::POST, "/api/jobs/agent-jobs"),
            (Method::PUT, "/api/heads-down/allowed-tools/x"),
            (Method::POST, "/api/voice/server/start"),
            (Method::GET, "/api/mcp-endpoint/connection"),
        ] {
            assert_eq!(
                required_scope(&method, path),
                Scope::Admin,
                "{method} {path}"
            );
        }
        // Reading these stays `read`.
        assert_eq!(
            required_scope(&Method::GET, "/api/mcp/servers"),
            Scope::Read
        );
        assert_eq!(required_scope(&Method::GET, "/api/repos"), Scope::Read);
    }

    #[test]
    fn answering_an_approval_needs_approve() {
        for path in [
            "/api/chat/approvals/call-1",
            "/api/attention/permissions/p1",
            "/api/questions/q1/answer",
            "/api/heads-down/questions/q1/dismiss",
            "/api/review-workspaces/w1/prs/p1/setup",
        ] {
            assert_eq!(
                required_scope(&Method::POST, path),
                Scope::Approve,
                "{path}"
            );
        }
    }

    /// The narrow exceptions sit before the prefixes they carve out of.
    #[test]
    fn exceptions_inside_admin_prefixes_stay_chat() {
        assert_eq!(
            required_scope(&Method::POST, "/api/mcp/tools/search"),
            Scope::Chat
        );
        assert_eq!(
            required_scope(&Method::POST, "/api/jobs/agent-jobs/j1/run"),
            Scope::Chat
        );
        assert_eq!(
            required_scope(&Method::PUT, "/api/jobs/agent-jobs/j1"),
            Scope::Admin
        );
        // A prefix only matches whole segments.
        assert_eq!(required_scope(&Method::POST, "/api/mcpx"), Scope::Chat);
    }

    /// Saving into a worktree is a shell by another name; the rest of the
    /// workspace routes, starting one and driving its agent included, are what
    /// a chat device is for.
    #[test]
    fn only_saving_a_worktree_file_needs_terminal() {
        assert_eq!(
            required_scope(&Method::PUT, "/api/workspaces/w1/repos/r1/file"),
            Scope::Terminal
        );
        assert_eq!(
            required_scope(&Method::GET, "/api/workspaces/w1/repos/r1/file"),
            Scope::Read
        );
        for (method, path) in [
            (Method::POST, "/api/workspaces"),
            (Method::POST, "/api/workspaces/w1/provision"),
            (Method::POST, "/api/workspaces/w1/repos/r1/stack/merge"),
            (Method::POST, "/api/workspaces/w1/review-comments"),
            (Method::POST, "/api/workspaces/w1/archive"),
            (Method::POST, "/api/review-workspaces/w1/claude-session"),
            (Method::POST, "/api/pr/resolve-conflicts"),
            (Method::POST, "/api/issues/github/start-work"),
            (Method::POST, "/api/heads-down/messages"),
        ] {
            assert_eq!(required_scope(&method, path), Scope::Chat, "{path}");
        }
    }

    /// The sidecar's router decodes the path before routing, so an encoded
    /// letter must not slip a request past its rule.
    #[test]
    fn rules_match_the_decoded_path() {
        assert_eq!(
            decoded_path("/api/%77orkspaces/w1/repos/r1/file").as_deref(),
            Some("/api/workspaces/w1/repos/r1/file")
        );
        assert_eq!(
            decoded_path("/api/%6dcp/servers").as_deref(),
            Some("/api/mcp/servers")
        );
        // Bad encodings, hidden separators and dot segments are refused.
        for bad in [
            "/api/x%zz",
            "/api/x%e2",
            "/api/a%2fb",
            "/api/a%5Cb",
            "/api/%2e%2e/x",
            "/api/./x",
        ] {
            assert_eq!(decoded_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn the_device_token_and_its_hop_headers_never_reach_the_sidecar() {
        let mut incoming = HeaderMap::new();
        incoming.insert(AUTHORIZATION, "Bearer device-token".parse().unwrap());
        incoming.insert(COOKIE, "a=b".parse().unwrap());
        incoming.insert(DEVICE_ID_HEADER, "someone-else".parse().unwrap());
        incoming.insert(CONNECTION, "keep-alive, x-private".parse().unwrap());
        incoming.insert("x-private", "1".parse().unwrap());
        incoming.insert("content-type", "application/json".parse().unwrap());
        let device = DeviceContext {
            device_id: "dev-1".into(),
            name: "laptop".into(),
            scopes: vec![Scope::Chat],
            verified_at: None,
        };
        let headers = forwarded_headers(&incoming, "sidecar-token", &device).unwrap();
        assert_eq!(headers[AUTHORIZATION], "Bearer sidecar-token");
        assert_eq!(headers[DEVICE_ID_HEADER], "dev-1");
        assert_eq!(headers["content-type"], "application/json");
        for gone in ["cookie", "connection", "x-private"] {
            assert!(!headers.contains_key(gone), "{gone}");
        }
    }
}
