//! A per-IP request limit for the routes anyone can call without a token
//! (sign-in and setup). Each one hashes a passphrase, a setup start holds a
//! pending enrollment, and wrong guesses burn the setup code or lock sign-in,
//! so an unlimited caller could tie up the server or lock the owner out.
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
/// request.
const SWEEP_AT: usize = 1024;

/// The most addresses tracked at once. When every slot holds a live window,
/// a new address is refused: a flood from many addresses can't grow the map
/// or make each sweep slower than this bound.
const MAX_TRACKED: usize = 8192;

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
        let ip = budget_key(ip);
        let now = Instant::now();
        let mut windows = self
            .windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if windows.len() >= SWEEP_AT {
            windows.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        if windows.len() >= MAX_TRACKED && !windows.contains_key(&ip) {
            return false;
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

/// One budget per IPv4 address, and per /64 for IPv6, since a single host
/// usually holds a whole /64 and could otherwise pick a fresh address per
/// request.
fn budget_key(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V4(_) => ip,
        IpAddr::V6(v6) => {
            let mut segments = v6.segments();
            segments[4..].fill(0);
            IpAddr::from(segments)
        }
    }
}

pub async fn limit(State(limiter): State<RateLimiter>, request: Request, next: Next) -> Response {
    // No peer address (tests, or a server not built with connect info):
    // every such request shares one budget.
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
        let limiter = RateLimiter::new(2, Duration::from_millis(500));
        let (a, b) = (IpAddr::from([10, 0, 0, 1]), IpAddr::from([10, 0, 0, 2]));
        assert!(limiter.allow(a) && limiter.allow(a));
        assert!(!limiter.allow(a));
        assert!(limiter.allow(b));
        // Real time: the limiter reads the clock itself.
        std::thread::sleep(Duration::from_millis(600));
        assert!(limiter.allow(a));
    }

    #[test]
    fn ipv6_addresses_in_one_64_share_a_budget() {
        let limiter = RateLimiter::new(1, Duration::from_secs(60));
        let a: IpAddr = "2001:db8:1:2::1".parse().unwrap();
        let b: IpAddr = "2001:db8:1:2:ffff::9".parse().unwrap();
        let other: IpAddr = "2001:db8:1:3::1".parse().unwrap();
        assert!(limiter.allow(a));
        assert!(!limiter.allow(b));
        assert!(limiter.allow(other));
    }
}
