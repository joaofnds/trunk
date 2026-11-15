use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::{Client, Response, Url};
use tokio::sync::Notify;

#[derive(Clone, Default)]
pub(super) struct Cancellation(Arc<CancellationState>);

#[derive(Default)]
struct CancellationState {
    cancelled: AtomicBool,
    wake: Notify,
}

impl Cancellation {
    pub(super) fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.wake.notify_waiters();
    }

    pub(super) async fn cancelled(&self) {
        loop {
            let notified = self.0.wake.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.0.cancelled.load(Ordering::Acquire) {
                return;
            }

            notified.await;
        }
    }
}

pub(super) async fn fetch(
    url: &str,
    limit: usize,
    cancel: Cancellation,
    progress: impl Fn(u64, Option<u64>) + Send + Sync,
) -> Result<Vec<u8>, String> {
    let seconds = if limit <= 256 * 1024 { 30 } else { 300 };
    bounded(
        download(url, limit, &progress, &ReleaseNetwork),
        cancel,
        Duration::from_secs(seconds),
    )
    .await
}

async fn bounded<T: Send>(
    operation: impl Future<Output = Result<T, String>> + Send,
    cancel: Cancellation,
    duration: Duration,
) -> Result<T, String> {
    tokio::select! {
        biased;
        () = cancel.cancelled() => Err("Update download cancelled".into()),
        result = tokio::time::timeout(duration, operation) => {
            if cancel.0.cancelled.load(Ordering::Acquire) {
                Err("Update download cancelled".into())
            } else {
                result.map_err(|_| "Update download timed out".to_string())?
            }
        }
    }
}

async fn download(
    url: &str,
    limit: usize,
    progress: &(impl Fn(u64, Option<u64>) + Send + Sync),
    network: &impl Network,
) -> Result<Vec<u8>, String> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut url = validate_url(url)?;
    for redirects in 0..=5 {
        let host = url
            .host_str()
            .ok_or_else(|| "Invalid update host".to_string())?;
        let addresses = network.resolve(host).await?;
        if addresses.is_empty()
            || addresses.len() > 32
            || addresses
                .iter()
                .any(|address| !public_address(address.ip()))
        {
            return Err("Update service resolved to a non-public address".into());
        }

        let response = network.get(&url, &addresses).await?;
        if response.status().is_redirection() {
            if redirects == 5 {
                return Err("Update service redirected too many times".into());
            }

            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Update service returned an invalid redirect".to_string())?;
            let destination = url
                .join(location)
                .map_err(|_| "Update service returned an invalid redirect".to_string())?;
            url = validate_url(destination.as_str())?;
        } else {
            return read_body(response, limit, progress).await;
        }
    }

    Err("Update service redirected too many times".into())
}

fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "Invalid update URL".to_string())?;
    let allowed_host = matches!(
        url.host_str(),
        Some(
            "github.com" | "release-assets.githubusercontent.com" | "objects.githubusercontent.com"
        )
    );
    if url.scheme() != "https"
        || !allowed_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url.port_or_known_default() != Some(443)
    {
        return Err("Update URL is outside the trusted release service".into());
    }
    if url.host_str() == Some("github.com") && !url.path().starts_with("/joaofnds/trunk/releases/")
    {
        return Err("Update URL is outside the trusted release repository".into());
    }

    Ok(url)
}

trait Network: Sync {
    fn resolve(&self, host: &str) -> impl Future<Output = Result<Vec<SocketAddr>, String>> + Send;
    fn get(
        &self,
        url: &Url,
        addresses: &[SocketAddr],
    ) -> impl Future<Output = Result<Response, String>> + Send;
}

struct ReleaseNetwork;

impl Network for ReleaseNetwork {
    async fn resolve(&self, host: &str) -> Result<Vec<SocketAddr>, String> {
        tokio::net::lookup_host((host, 443))
            .await
            .map(Iterator::collect)
            .map_err(|_| "Could not resolve the update service".to_string())
    }

    async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> Result<Response, String> {
        let host = url
            .host_str()
            .ok_or_else(|| "Invalid update host".to_string())?;
        let client = Client::builder()
            .no_proxy()
            .https_only(true)
            .redirect(reqwest::redirect::Policy::none())
            .resolve_to_addrs(host, addresses)
            .build()
            .map_err(|_| "Could not initialize the update connection".to_string())?;

        client
            .get(url.clone())
            .header("Accept-Encoding", "identity")
            .send()
            .await
            .map_err(|_| "Could not connect to the update service".to_string())
    }
}

fn public_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => public_ipv4(address),
        IpAddr::V6(address) => public_ipv6(address),
    }
}

fn public_ipv4(address: Ipv4Addr) -> bool {
    let [a, b, c, _] = address.octets();
    !(a == 0
        || a == 10
        || a == 127
        || a >= 224
        || (a == 100 && (64..=127).contains(&b))
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && ((b == 0 && (c == 0 || c == 2)) || b == 168 || (b == 88 && c == 99)))
        || (a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
        || (a == 203 && b == 0 && c == 113))
}

const fn public_ipv6(address: Ipv6Addr) -> bool {
    let [a, b, ..] = address.segments();
    (a & 0xe000) == 0x2000
        && !(a == 0x2001 && (b <= 0x01ff || b == 0x0db8))
        && a != 0x2002
        && !(a == 0x3fff && b <= 0x0fff)
}

async fn read_body(
    mut response: Response,
    limit: usize,
    progress: &(impl Fn(u64, Option<u64>) + Send + Sync),
) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err("Update service returned an unsuccessful response".into());
    }

    let total = response.content_length();
    if total.is_some_and(|length| length > limit as u64) {
        return Err("Update download exceeds its size limit".into());
    }

    let mut bytes = Vec::new();
    progress(0, total);
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Update download was interrupted".to_string())?
    {
        if chunk.len() > limit.saturating_sub(bytes.len()) {
            return Err("Update download exceeds its size limit".into());
        }

        bytes
            .try_reserve_exact(chunk.len())
            .map_err(|_| "Could not allocate the update buffer".to_string())?;
        bytes.extend_from_slice(&chunk);
        progress(bytes.len() as u64, total);
    }

    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;

    use super::*;

    struct HttpFixture {
        url: String,
        stop: Option<oneshot::Sender<()>>,
        task: tokio::task::JoinHandle<()>,
    }

    impl HttpFixture {
        async fn serve(response: &'static [u8]) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!(
                "http://{}/private-test-token",
                listener.local_addr().unwrap()
            );
            let (stop, mut stopped) = oneshot::channel();
            let task = tokio::spawn(async move {
                let (mut stream, _) = tokio::select! {
                    accepted = listener.accept() => accepted.unwrap(),
                    _ = &mut stopped => return,
                };
                let mut request = [0; 1024];
                assert!(stream.read(&mut request).await.unwrap() > 0);
                stream.write_all(response).await.unwrap();
                let _ = stopped.await;
            });

            Self {
                url,
                stop: Some(stop),
                task,
            }
        }

        async fn response(&self) -> Response {
            let _ = rustls::crypto::ring::default_provider().install_default();
            Client::builder()
                .no_proxy()
                .build()
                .unwrap()
                .get(&self.url)
                .send()
                .await
                .unwrap()
        }

        async fn close(mut self) {
            self.stop.take().unwrap().send(()).unwrap();
            self.task.await.unwrap();
        }
    }

    #[derive(Default)]
    struct FakeNetwork {
        resolutions: BTreeMap<String, Vec<SocketAddr>>,
        routes: BTreeMap<String, String>,
        connections: Mutex<Vec<(String, Vec<SocketAddr>)>>,
    }

    impl FakeNetwork {
        fn resolve_host(&mut self, host: &str, address: &str) {
            self.resolutions
                .insert(host.into(), vec![address.parse().unwrap()]);
        }

        fn serve_url(&mut self, url: &str, fixture: &HttpFixture) {
            self.routes.insert(url.into(), fixture.url.clone());
        }
    }

    impl Network for FakeNetwork {
        fn resolve(
            &self,
            host: &str,
        ) -> impl Future<Output = Result<Vec<SocketAddr>, String>> + Send {
            std::future::ready(
                self.resolutions
                    .get(host)
                    .cloned()
                    .ok_or_else(|| "Unknown fixture host".into()),
            )
        }

        async fn get(&self, url: &Url, addresses: &[SocketAddr]) -> Result<Response, String> {
            self.connections
                .lock()
                .unwrap()
                .push((url.to_string(), addresses.to_vec()));
            let destination = self
                .routes
                .get(url.as_str())
                .ok_or_else(|| "Unknown fixture route".to_string())?;
            Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap()
                .get(destination)
                .send()
                .await
                .map_err(|_| "Fixture connection failed".into())
        }
    }

    const FEED: &str = "https://github.com/joaofnds/trunk/releases/latest/download/latest.json";
    const ASSET: &str = "https://release-assets.githubusercontent.com/package";

    #[tokio::test]
    async fn download_follows_a_valid_redirect_with_each_hosts_resolved_addresses() {
        let first = HttpFixture::serve(b"HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/package\r\nContent-Length: 0\r\n\r\n").await;
        let second = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello").await;
        let mut network = FakeNetwork::default();
        network.resolve_host("github.com", "140.82.116.3:443");
        network.resolve_host(
            "release-assets.githubusercontent.com",
            "185.199.108.133:443",
        );
        network.serve_url(FEED, &first);
        network.serve_url(ASSET, &second);

        let result = download(FEED, 5, &|_, _| {}, &network).await;

        assert_eq!(result, Ok(b"hello".to_vec()));
        assert_eq!(
            *network.connections.lock().unwrap(),
            vec![
                (FEED.into(), vec!["140.82.116.3:443".parse().unwrap()]),
                (ASSET.into(), vec!["185.199.108.133:443".parse().unwrap()]),
            ]
        );
        first.close().await;
        second.close().await;
    }

    #[tokio::test]
    async fn download_rejects_an_insecure_redirect_before_connecting_again() {
        let first = HttpFixture::serve(b"HTTP/1.1 302 Found\r\nLocation: http://release-assets.githubusercontent.com/package\r\nContent-Length: 0\r\n\r\n").await;
        let second = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello").await;
        let mut network = FakeNetwork::default();
        network.resolve_host("github.com", "140.82.116.3:443");
        network.resolve_host(
            "release-assets.githubusercontent.com",
            "185.199.108.133:443",
        );
        network.serve_url(FEED, &first);
        network.serve_url(
            "http://release-assets.githubusercontent.com/package",
            &second,
        );

        let result = download(FEED, 5, &|_, _| {}, &network).await;

        assert_eq!(
            result,
            Err("Update URL is outside the trusted release service".into())
        );
        assert_eq!(network.connections.lock().unwrap().len(), 1);
        first.close().await;
        second.close().await;
    }

    #[tokio::test]
    async fn download_rejects_private_dns_answers_on_the_redirected_host() {
        let first = HttpFixture::serve(b"HTTP/1.1 302 Found\r\nLocation: https://release-assets.githubusercontent.com/package\r\nContent-Length: 0\r\n\r\n").await;
        let second = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello").await;
        let mut network = FakeNetwork::default();
        network.resolve_host("github.com", "140.82.116.3:443");
        network.resolve_host("release-assets.githubusercontent.com", "127.0.0.1:443");
        network.serve_url(FEED, &first);
        network.serve_url(ASSET, &second);

        let result = download(FEED, 5, &|_, _| {}, &network).await;

        assert_eq!(
            result,
            Err("Update service resolved to a non-public address".into())
        );
        assert_eq!(network.connections.lock().unwrap().len(), 1);
        first.close().await;
        second.close().await;
    }

    #[tokio::test]
    async fn body_reader_reports_progress_and_returns_exact_bytes() {
        let fixture =
            HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello").await;
        let progress = Mutex::new(Vec::new());

        let result = read_body(fixture.response().await, 5, &|read, total| {
            progress.lock().unwrap().push((read, total));
        })
        .await;

        assert_eq!(result.unwrap(), b"hello");
        let observed = progress.into_inner().unwrap();
        assert_eq!(observed.first(), Some(&(0, Some(5))));
        assert_eq!(observed.last(), Some(&(5, Some(5))));
        fixture.close().await;
    }

    #[tokio::test]
    async fn oversized_content_length_fails_before_waiting_for_body() {
        let fixture = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n").await;

        let result = read_body(fixture.response().await, 5, &|_, _| {}).await;

        assert_eq!(result, Err("Update download exceeds its size limit".into()));
        fixture.close().await;
    }

    #[tokio::test]
    async fn chunked_body_cannot_exceed_the_limit_without_content_length() {
        let fixture = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n3\r\ndef\r\n0\r\n\r\n").await;

        let result = read_body(fixture.response().await, 5, &|_, _| {}).await;

        assert_eq!(result, Err("Update download exceeds its size limit".into()));
        fixture.close().await;
    }

    #[tokio::test]
    async fn failed_http_status_hides_urls_and_private_tokens() {
        let fixture =
            HttpFixture::serve(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n").await;

        let result = read_body(fixture.response().await, 5, &|_, _| {}).await;

        assert_eq!(
            result,
            Err("Update service returned an unsuccessful response".into())
        );
        fixture.close().await;
    }

    #[tokio::test]
    async fn cancellation_releases_a_stalled_response() {
        let fixture = HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n").await;
        let response = fixture.response().await;
        let cancellation = Cancellation::default();
        let pending = bounded(
            read_body(response, 5, &|_, _| {}),
            cancellation.clone(),
            Duration::from_secs(30),
        );

        let (result, ()) = tokio::join!(pending, async {
            cancellation.cancel();
        });

        assert_eq!(result, Err("Update download cancelled".into()));
        fixture.close().await;
    }

    #[tokio::test]
    async fn cancellation_wins_when_the_operation_completes_in_the_same_poll() {
        let cancellation = Cancellation::default();
        let operation = async {
            cancellation.cancel();
            Ok(())
        };

        let result = bounded(operation, cancellation.clone(), Duration::from_secs(30)).await;

        assert_eq!(result, Err("Update download cancelled".into()));
    }

    #[tokio::test]
    async fn truncated_body_returns_a_sanitized_transport_error() {
        let fixture =
            HttpFixture::serve(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort").await;
        let response = fixture.response().await;
        fixture.close().await;

        let result = read_body(response, 10, &|_, _| {}).await;

        assert_eq!(result, Err("Update download was interrupted".into()));
    }

    #[tokio::test]
    async fn cancellation_before_registration_is_not_lost() {
        let cancellation = Cancellation::default();
        cancellation.cancel();

        let result = fetch(
            "https://github.com/joaofnds/trunk/releases/latest/download/latest.json",
            5,
            cancellation,
            |_, _| {},
        )
        .await;

        assert_eq!(result, Err("Update download cancelled".into()));
    }

    #[tokio::test(start_paused = true)]
    async fn total_budget_includes_an_operation_that_never_returns() {
        let operation = std::future::pending::<Result<(), String>>();
        let cancellation = Cancellation::default();

        let result = bounded(operation, cancellation, Duration::from_secs(30)).await;

        assert_eq!(result, Err("Update download timed out".into()));
    }

    #[test]
    fn official_release_urls_are_admitted() {
        assert!(
            validate_url("https://github.com/joaofnds/trunk/releases/latest/download/latest.json")
                .is_ok()
        );
        assert!(validate_url("https://release-assets.githubusercontent.com/release-asset/123/package?token=secret").is_ok());
        assert!(
            validate_url(
                "https://objects.githubusercontent.com/release-asset/123/package?token=secret"
            )
            .is_ok()
        );
    }

    #[test]
    fn insecure_redirect_destinations_are_rejected() {
        assert!(validate_url("http://github.com/joaofnds/trunk/releases/download/v1/a").is_err());
    }

    #[test]
    fn unrelated_repository_urls_are_rejected() {
        assert!(validate_url("https://github.com/attacker/repo/releases/download/v1/a").is_err());
    }

    #[test]
    fn credential_bearing_urls_are_rejected() {
        assert!(
            validate_url("https://user:password@github.com/joaofnds/trunk/releases/download/v1/a")
                .is_err()
        );
    }

    #[test]
    fn non_https_ports_are_rejected() {
        assert!(
            validate_url("https://github.com:8443/joaofnds/trunk/releases/download/v1/a").is_err()
        );
    }

    #[test]
    fn fragments_are_rejected() {
        assert!(
            validate_url("https://github.com/joaofnds/trunk/releases/download/v1/a#token").is_err()
        );
    }

    #[test]
    fn literal_private_addresses_are_rejected() {
        assert!(validate_url("https://127.0.0.1/joaofnds/trunk/releases/download/v1/a").is_err());
    }

    #[test]
    fn private_ipv4_resolution_is_rejected() {
        assert!(!public_address("10.0.0.1".parse().unwrap()));
    }

    #[test]
    fn shared_ipv4_resolution_is_rejected() {
        assert!(!public_address("100.64.0.1".parse().unwrap()));
    }

    #[test]
    fn link_local_ipv4_resolution_is_rejected() {
        assert!(!public_address("169.254.169.254".parse().unwrap()));
    }

    #[test]
    fn private_ipv6_resolution_is_rejected() {
        assert!(!public_address("fd00::1".parse().unwrap()));
    }

    #[test]
    fn ipv4_mapped_ipv6_resolution_is_rejected() {
        assert!(!public_address("::ffff:127.0.0.1".parse().unwrap()));
    }

    #[test]
    fn public_resolution_is_admitted() {
        assert!(public_address("140.82.116.3".parse().unwrap()));
        assert!(public_address("2606:50c0:8000::154".parse().unwrap()));
    }
}
