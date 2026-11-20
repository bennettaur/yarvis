//! `/api/sidecar/{*path}`: the reverse proxy in front of the Bun sidecar.
//!
//! `/api/sidecar/api/status` reaches the sidecar's `/api/status`: the prefix is
//! dropped and the rest, query included, is sent as is. Only `/health` and the
//! paths under `/api/` behind the sidecar's bearer wall are reachable. The
//! sidecar's other routes (`/ingest`, `/mcp`, `/browser`, the OAuth callbacks)
//! carry their own scoped tokens or state nonces, and are called on loopback by
//! local processes and browser redirects, so they stay off the proxy.
//!
//! The device is checked here (`read` for `GET`/`HEAD`, `chat` for everything
//! else). Its `Authorization` header is dropped and replaced with the sidecar's
//! own bearer token, so the sidecar never sees a device token. The device id
//! goes along in `X-Yarvis-Device-Id`, replacing any the client sent, so the
//! sidecar can record who asked.
//!
//! Bodies stream both ways. Chat replies are SSE, and holding a response until
//! it ends would hold the whole reply.
//!
//! A WebSocket upgrade is answered here, not passed through: a browser can't
//! set headers on a WebSocket, so the device authenticates with its first
//! message ([`crate::auth::authenticate_ws`]). Only then is the sidecar's
//! socket opened, with the bearer header, and frames relayed both ways. A
//! socket can send as well as read, so it needs `chat`.

use std::sync::OnceLock;
use std::time::Duration;

use axum::body::Body;
use axum::extract::ws::{self, WebSocket, WebSocketUpgrade};
use axum::extract::{FromRequestParts, Request, State};
use axum::http::header::{AUTHORIZATION, CONNECTION, COOKIE, HOST, HeaderName};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest};

use crate::AppState;
use crate::auth::{Authed, Chat, DeviceContext, Read, Scope, authenticate_ws};
use crate::error::ApiError;

pub const DEVICE_ID_HEADER: &str = "x-yarvis-device-id";

/// The connection is on loopback, so a sidecar that takes longer than this to
/// accept is down or restarting rather than slow.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

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

pub async fn proxy(State(state): State<AppState>, request: Request) -> Response {
    match forward(state, request).await {
        Ok(response) => response,
        Err(e) => e.into_response(),
    }
}

async fn forward(state: AppState, request: Request) -> Result<Response, ApiError> {
    let path_and_query = upstream_path(request.uri()).ok_or_else(ApiError::not_found)?;
    let (mut parts, body) = request.into_parts();
    if is_websocket_upgrade(&parts.headers) {
        let upgrade = WebSocketUpgrade::from_request_parts(&mut parts, &state)
            .await
            .map_err(|e| ApiError::bad_request(e.body_text()))?;
        return Ok(upgrade.on_upgrade(move |socket| relay(socket, state, path_and_query)));
    }
    let device = if matches!(parts.method, Method::GET | Method::HEAD) {
        Authed::<Read>::from_request_parts(&mut parts, &state)
            .await?
            .device
    } else {
        Authed::<Chat>::from_request_parts(&mut parts, &state)
            .await?
            .device
    };

    let endpoint = state.sidecar.endpoint();
    let uri: Uri = format!("http://127.0.0.1:{}{path_and_query}", endpoint.port)
        .parse()
        .map_err(|_| ApiError::not_found())?;
    let mut upstream = hyper::Request::builder()
        .method(parts.method)
        .uri(uri)
        .body(body)
        .map_err(ApiError::internal)?;
    *upstream.headers_mut() = forwarded_headers(&parts.headers, &endpoint.token, &device)?;

    let response = client().request(upstream).await.map_err(|e| {
        tracing::warn!("sidecar proxy: {e}");
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "the sidecar isn't reachable right now",
        )
    })?;
    let (mut parts, body) = response.into_parts();
    strip_hop_by_hop(&mut parts.headers);
    Ok(Response::from_parts(parts, Body::new(body)))
}

/// The sidecar path for a proxied URI, or `None` for one the proxy doesn't
/// serve. Dot segments are refused, raw or percent-encoded, so a path that
/// starts under `/api/` can't climb out to a route outside the bearer wall.
fn upstream_path(uri: &Uri) -> Option<String> {
    let rest = uri.path().strip_prefix("/api/sidecar")?;
    let allowed = rest == "/health" || rest.starts_with("/api/");
    let dotted = rest.split('/').any(|segment| {
        let decoded = segment.replace("%2e", ".").replace("%2E", ".");
        decoded == "." || decoded == ".."
    });
    if !allowed || dotted || rest.contains('\\') {
        return None;
    }
    Some(match uri.query() {
        Some(query) => format!("{rest}?{query}"),
        None => rest.to_string(),
    })
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
async fn relay(mut socket: WebSocket, state: AppState, path_and_query: String) {
    let Some((device, _)) = authenticate_ws(&mut socket, &state.auth, Scope::Chat).await else {
        return;
    };
    let endpoint = state.sidecar.endpoint().clone();
    let upstream = match connect_upstream(&endpoint, &path_and_query, &device).await {
        Ok(upstream) => upstream,
        Err(e) => {
            tracing::warn!("sidecar proxy websocket: {e}");
            let _ = socket
                .send(ws::Message::Close(Some(ws::CloseFrame {
                    code: 1011,
                    reason: "the sidecar isn't reachable right now".into(),
                })))
                .await;
            return;
        }
    };
    let mut revoked = state.auth.subscribe_revocations();
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
            id = revoked.recv() => {
                if matches!(id, Ok(id) if id == device.device_id) {
                    let _ = to_client.send(ws::Message::Close(None)).await;
                    break;
                }
            }
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
