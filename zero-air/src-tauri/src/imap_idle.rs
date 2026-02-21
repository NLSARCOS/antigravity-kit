/// IMAP IDLE — sync `imap` crate in a dedicated OS thread.
/// Uses tokio mpsc to signal new-mail events to the Tauri runtime.
use tauri::{AppHandle, Emitter, Manager};
use crate::db::DbState;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};

#[derive(Clone, serde::Serialize)]
pub struct NewMailPayload {
    pub account_id: String,
    pub folder: String,
}

static IDLE_RUNNING: AtomicBool = AtomicBool::new(false);

pub fn stop_idle() {
    IDLE_RUNNING.store(false, Ordering::SeqCst);
}

pub fn start_idle_task(app: AppHandle) {
    if IDLE_RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }

    tokio::spawn(async move {
        sleep(Duration::from_secs(4)).await;

        loop {
            if !IDLE_RUNNING.load(Ordering::SeqCst) { break; }

            // Load primary account credentials from DB
            let state = app.state::<DbState>();
            let accounts = match sqlx::query_as::<_, crate::db::Account>(
                "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts LIMIT 1"
            )
            .fetch_all(&state.pool)
            .await {
                Ok(a) => a,
                Err(e) => {
                    log::warn!("[IDLE] DB error: {}. Retry in 10s.", e);
                    sleep(Duration::from_secs(10)).await;
                    continue;
                }
            };

            if accounts.is_empty() {
                sleep(Duration::from_secs(15)).await;
                continue;
            }

            let account = &accounts[0];
            let imap_host = match &account.imap_host { Some(h) => h.clone(), None => { sleep(Duration::from_secs(15)).await; continue; } };
            let imap_port = account.imap_port.unwrap_or(993) as u16;
            let email_addr = account.email.clone();
            let password = match &account.password { Some(p) => p.clone(), None => { sleep(Duration::from_secs(15)).await; continue; } };
            let account_id = account.id.clone();

            log::info!("[IDLE] Starting IDLE for {} on {}:{}", email_addr, imap_host, imap_port);

            // Channel: OS thread → tokio runtime
            let (tx, mut rx) = mpsc::channel::<bool>(4);
            let running = Arc::new(AtomicBool::new(true));
            let running_thread = running.clone();

            // OS thread: sync IMAP IDLE loop
            std::thread::spawn(move || {
                let tls = match native_tls::TlsConnector::builder().build() {
                    Ok(t) => t,
                    Err(e) => { log::error!("[IDLE] TLS error: {}", e); return; }
                };
                let client = match imap::connect((imap_host.as_str(), imap_port), &imap_host, &tls) {
                    Ok(c) => c,
                    Err(e) => { log::error!("[IDLE] Connect error: {}", e); return; }
                };
                let mut session = match client.login(&email_addr, &password) {
                    Ok(s) => s,
                    Err((e, _)) => { log::error!("[IDLE] Login error: {}", e); return; }
                };
                if let Err(e) = session.select("INBOX") {
                    log::error!("[IDLE] SELECT error: {}", e);
                    return;
                }

                log::info!("[IDLE] ✅ IMAP IDLE active for {}", email_addr);

                loop {
                    if !running_thread.load(Ordering::SeqCst) {
                        session.logout().ok();
                        break;
                    }

                    // Fetch current EXISTS count before IDLE
                    let before_exists = session.select("INBOX").ok().map(|mb| mb.exists).unwrap_or(0);

                    // Enter IDLE: blocks until server sends a response or 29-min keepalive
                    let idle_result = session.idle().and_then(|mut handle| {
                        handle.set_keepalive(std::time::Duration::from_secs(29 * 60));

                        // wait_with_timeout blocks until server data OR timeout
                        // Returns the session back after DONE command
                        handle.wait_keepalive()
                    });

                    match idle_result {
                        Ok(_) => {
                            // After IDLE ends, check if EXISTS count increased
                            if let Ok(mb) = session.select("INBOX") {
                                if mb.exists > before_exists {
                                    log::info!("[IDLE] 🔔 New email! EXISTS {} → {}", before_exists, mb.exists);
                                    let _ = tx.blocking_send(true);
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("[IDLE] IDLE error: {}. Thread exiting.", e);
                            break;
                        }
                    }
                }
            });

            // Tokio side: receive signal → emit Tauri event
            let app_clone = app.clone();
            let account_id_clone = account_id.clone();

            let mut mail_count: u32 = 0;
            while let Some(_) = rx.recv().await {
                if !IDLE_RUNNING.load(Ordering::SeqCst) { break; }
                log::info!("[IDLE] Emitting new-mail event to frontend");
                let _ = app_clone.emit("new-mail", NewMailPayload {
                    account_id: account_id_clone.clone(),
                    folder: "INBOX".to_string(),
                });

                // 🧠 Run autonomous triage on newly arrived emails
                let triage_app = app_clone.clone();
                let triage_account = account_id_clone.clone();
                tokio::spawn(async move {
                    crate::ai_triage::run_triage_on_new_emails(&triage_app, &triage_account).await;
                });

                // 🧠 Self-improvement: every 10 new mail events, run the learning cycle
                mail_count += 1;
                if mail_count % 10 == 0 {
                    let learn_app = app_clone.clone();
                    tokio::spawn(async move {
                        crate::ai_triage::run_self_improvement_cycle(&learn_app).await;
                    });
                }
            }

            running.store(false, Ordering::SeqCst);

            if !IDLE_RUNNING.load(Ordering::SeqCst) { break; }

            log::warn!("[IDLE] Reconnecting in 15s.");
            sleep(Duration::from_secs(15)).await;
        }

        IDLE_RUNNING.store(false, Ordering::SeqCst);
        log::info!("[IDLE] IMAP IDLE watcher stopped.");
    });
}
