//! A per-IP request limit for the routes anyone can call without a token
//! (sign-in and setup). Each start stores ceremony state and each setup
//! attempt can burn the setup code, so an unlimited caller could fill memory
//! or lock the owner out.
//!
//! The address is the TCP peer's. Behind a reverse proxy on the same machine
//! (`tailscale serve`) every client shares 127.0.0.1 and so shares one budget,
//! which is still enough for one person signing in. Forwarded-for headers are
//! ignored because any client can set them.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use crate::error::ApiError;

/// Past this many tracked addresses, expired windows are swept on the next
/// request so the map can't grow without bound.
const SWEEP_AT: usize = 1024;

#[derive(Clone)]
pub struct RateLimiter {
    limit: u32,
    window: Duration,
    windows: Arc<Mutex<HashMap<IpAddr, (Instant, u32)>>>,
}

impl RateLimiter {
    /// Allows `limit` requests per address in each `window`.
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit,
            window,
            windows: Arc::default(),
        }
    }

    fn allow(&self, ip: IpAddr) -> bool {
        let now = Instant::now();
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if windows.len() >= SWEEP_AT {
            windows.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let (start, count) = windows.entry(ip).or_insert((now, 0));
        if now.duration_since(*start) >= self.window {
            *start = now;
            *count = 0;
        }
        *count += 1;
        *count <= self.limit
    }
}

pub async fn limit(State(limiter): State<RateLimiter>, request: Request, next: Next) -> Response {
    // Requests built in tests carry no peer address; they share one budget.
    let ip = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    if !limiter.allow(ip) {
        return ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many requests")
            .with_detail("wait a minute and try again")
            .into_response();
    }
    next.run(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_address_gets_its_own_budget_and_it_refills() {
        let limiter = RateLimiter::new(2, Duration::from_millis(50));
        let (a, b) = (IpAddr::from([10, 0, 0, 1]), IpAddr::from([10, 0, 0, 2]));
        assert!(limiter.allow(a) && limiter.allow(a));
        assert!(!limiter.allow(a));
        assert!(limiter.allow(b));
        // The behavior under test is the window passing.
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.allow(a));
    }
}
