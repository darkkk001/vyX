//! Reload on change (2026-09-26): the web announces every book change on NATS (lib/nats.ts SUBJECTS, relayed by the
//! gateway): a fill, a cancel, an SL / TP edit, a resting-order edit, a close, a balance or account change, a config
//! change. The risk hook's levels and the margin trigger's book used to learn about a change only on their 5 s poll, so
//! a just-set SL / TP was not watched for up to 5 s. The server subscribes to these subjects and feeds this debouncer,
//! which turns each burst of announcements into ONE reload request (a bulk close is dozens of events). The 5 s poll
//! stays as the safety net.

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

/// The web's book-change subjects (lib/nats.ts SUBJECTS: order.* / position.* / account.* / config.changed).
pub const BOOK_CHANGE_SUBJECTS: &[&str] = &["order.>", "position.>", "account.>", "config.changed"];

/// The debounce the server uses: announcements closer together than this make one reload.
pub const DEBOUNCE: Duration = Duration::from_millis(150);

/// Calls `on_change` once per burst: after the first announcement, as soon as `debounce` passes with no new one, and
/// at the latest 4 x `debounce` after the burst began (a steady stream of events still reloads). Runs until the
/// sender side is dropped.
pub fn spawn_debounced(mut rx: UnboundedReceiver<String>, debounce: Duration, on_change: Arc<dyn Fn() + Send + Sync>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while rx.recv().await.is_some() {
            let deadline = tokio::time::Instant::now() + debounce * 4;
            loop {
                let wait = debounce.min(deadline.saturating_duration_since(tokio::time::Instant::now()));
                if wait.is_zero() {
                    break;
                }
                match tokio::time::timeout(wait, rx.recv()).await {
                    Ok(Some(_)) => continue, // another announcement in the burst
                    Ok(None) => {
                        on_change();
                        return;
                    }
                    Err(_) => break, // quiet for `debounce`
                }
            }
            on_change();
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counter() -> (Arc<AtomicUsize>, Arc<dyn Fn() + Send + Sync>) {
        let n = Arc::new(AtomicUsize::new(0));
        let m = n.clone();
        (n, Arc::new(move || {
            m.fetch_add(1, Ordering::SeqCst);
        }))
    }

    #[tokio::test]
    async fn a_burst_of_announcements_makes_one_reload_soon_after_it_ends() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (n, f) = counter();
        spawn_debounced(rx, Duration::from_millis(50), f);
        for s in ["position.modified", "order.filled", "position.closed_bulk"] {
            tx.send(s.to_string()).unwrap();
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(n.load(Ordering::SeqCst), 0, "still inside the debounce");
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert_eq!(n.load(Ordering::SeqCst), 1, "one reload for the burst");
        tx.send("position.modified".into()).unwrap();
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(n.load(Ordering::SeqCst), 2, "a later announcement reloads again");
    }

    #[tokio::test]
    async fn a_steady_stream_still_reloads_within_four_debounces() {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        let (n, f) = counter();
        spawn_debounced(rx, Duration::from_millis(40), f);
        let t0 = tokio::time::Instant::now();
        while t0.elapsed() < Duration::from_millis(250) {
            tx.send("order.filled".into()).unwrap();
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(n.load(Ordering::SeqCst) >= 1, "reloaded despite never going quiet");
    }
}
