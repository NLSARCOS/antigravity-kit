use tauri::{AppHandle, Manager};
use crate::db::DbState;
use serde_json;
use mailparse::parse_mail;

#[tauri::command]
pub async fn sync_emails(app: AppHandle, account_id: String, folder: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let state = app.state::<DbState>();
    let pool = state.pool.clone();

    // 1. Load account credentials from DB
    let account = sqlx::query_as::<_, crate::db::Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = $1"
    )
    .bind(&account_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or_else(|| "Account not found".to_string())?;

    let imap_host = account.imap_host.clone().ok_or("IMAP host not configured")?;
    let imap_port = account.imap_port.unwrap_or(993) as u16;
    let email_addr = account.email.clone();
    let password = account.password.clone().ok_or("Password not configured")?;
    let acct_id = account_id.clone();

    let target_folder = folder.unwrap_or_else(|| "INBOX".to_string());
    let folder_for_thread = target_folder.clone();
    let folder_for_db = target_folder.clone();

    log::info!("Connecting to IMAP {}:{} for {} (folder: {})", imap_host, imap_port, email_addr, target_folder);

    // 2. Run sync IMAP in a blocking thread
    let fetched_emails = tokio::task::spawn_blocking(move || -> Result<Vec<serde_json::Value>, String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS error: {}", e))?;

        let client = imap::connect(
            (imap_host.as_str(), imap_port),
            &imap_host,
            &tls,
        ).map_err(|e| format!("IMAP connect error: {}", e))?;

        let mut session = client
            .login(&email_addr, &password)
            .map_err(|e| format!("IMAP login error: {}", e.0))?;

        // Map UI folder names to IMAP folder names
        let imap_folders: Vec<String> = match folder_for_thread.as_str() {
            "INBOX" => vec!["INBOX".to_string()],
            "Drafts" => vec!["Drafts", "INBOX.Drafts", "Draft", "INBOX.Draft", "[Gmail]/Drafts"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Sent" => vec!["Sent", "INBOX.Sent", "Sent Messages", "[Gmail]/Sent Mail"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Archive" => vec!["Archive", "INBOX.Archive", "[Gmail]/All Mail"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Trash" => vec!["Trash", "INBOX.Trash", "[Gmail]/Trash"]
                .into_iter().map(|s| s.to_string()).collect(),
            other => vec![other.to_string()],
        };

        // Try each possible folder name
        let mut mailbox = None;
        for f in &imap_folders {
            match session.select(f) {
                Ok(mb) => { mailbox = Some(mb); break; }
                Err(_) => continue,
            }
        }
        let mailbox = mailbox.ok_or_else(|| format!("Could not find folder: {}", folder_for_thread))?;
        let total = mailbox.exists;

        if total == 0 {
            session.logout().ok();
            return Ok(vec![]);
        }

        // Fetch last 200 messages (was 50 — increased for full history)
        let range = if total > 200 {
            format!("{}:{}", total - 199, total)
        } else {
            format!("1:{}", total)
        };

        // Fetch full RFC822 message
        let messages = session
            .fetch(&range, "(UID ENVELOPE RFC822)")
            .map_err(|e| format!("Fetch error: {}", e))?;

        let mut emails: Vec<serde_json::Value> = Vec::new();

        for msg in messages.iter() {
            let uid = msg.uid.unwrap_or(0);
            let envelope = msg.envelope();

            let subject = envelope
                .and_then(|env| env.subject.as_ref())
                .map(|s| String::from_utf8_lossy(s).to_string())
                .unwrap_or_default();

            // Extract sender
            let (sender, sender_email) = {
                let mut name_str = "Unknown".to_string();
                let mut email_str = String::new();
                if let Some(env) = envelope {
                    if let Some(ref addrs) = env.from {
                        if let Some(addr) = addrs.get(0) {
                            let name = addr.name.as_ref().map(|n| String::from_utf8_lossy(n).to_string());
                            let mb = addr.mailbox.as_ref().map(|m| String::from_utf8_lossy(m).to_string()).unwrap_or_default();
                            let host = addr.host.as_ref().map(|h| String::from_utf8_lossy(h).to_string()).unwrap_or_default();
                            email_str = format!("{}@{}", mb, host);
                            name_str = name.unwrap_or_else(|| email_str.clone());
                        }
                    }
                }
                (name_str, email_str)
            };

            // Extract recipient (To) — critical for drafts
            let to_email = {
                let mut to_str = String::new();
                if let Some(env) = envelope {
                    if let Some(ref addrs) = env.to {
                        if let Some(addr) = addrs.get(0) {
                            let mb = addr.mailbox.as_ref().map(|m| String::from_utf8_lossy(m).to_string()).unwrap_or_default();
                            let host = addr.host.as_ref().map(|h| String::from_utf8_lossy(h).to_string()).unwrap_or_default();
                            to_str = format!("{}@{}", mb, host);
                        }
                    }
                }
                to_str
            };

            let date_raw = envelope
                .and_then(|env| env.date.as_ref())
                .map(|d| String::from_utf8_lossy(d).to_string())
                .unwrap_or_default();

            // Parse date to ISO format for proper sorting
            let date_iso = parse_rfc2822_to_iso(&date_raw);

            // Parse the full RFC822 body with mailparse
            let (body_html, body_plain) = msg.body()
                .map(|raw| extract_bodies(raw))
                .unwrap_or_default();

            // Use HTML for body (to render as sent), plain text for snippet
            let body = if !body_html.is_empty() { &body_html } else { &body_plain };
            let snippet_source = if !body_plain.is_empty() { &body_plain } else { &strip_html_tags(&body_html) };
            let snippet: String = snippet_source.chars().take(150).collect();

            let email_id = format!("{}_{}", acct_id, uid);

            emails.push(serde_json::json!({
                "id": email_id,
                "uid": uid,
                "subject": subject,
                "sender": sender,
                "sender_email": sender_email,
                "to_email": to_email,
                "date": date_iso,
                "snippet": snippet,
                "body": body,
                "folder": folder_for_thread,
                "account_id": acct_id,
                "is_html": !body_html.is_empty()
            }));
        }

        session.logout().ok();

        // Sort by UID descending (highest UID = newest email)
        emails.sort_by(|a, b| {
            let uid_b = b["uid"].as_u64().unwrap_or(0);
            let uid_a = a["uid"].as_u64().unwrap_or(0);
            uid_b.cmp(&uid_a)
        });

        Ok(emails)
    })
    .await
    .map_err(|e| format!("Thread error: {}", e))??;

    // 3. Save all fetched emails to local SQLite
    for email in &fetched_emails {
        let _ = sqlx::query(
            r#"INSERT INTO emails (id, uid, account_id, folder, subject, sender, sender_email, to_email, date, snippet, body, read)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0)
               ON CONFLICT(id) DO UPDATE SET
                   uid = excluded.uid,
                   folder = excluded.folder,
                   subject = excluded.subject,
                   sender = excluded.sender,
                   sender_email = excluded.sender_email,
                   to_email = excluded.to_email,
                   date = excluded.date,
                   snippet = excluded.snippet,
                   body = excluded.body"#
        )
        .bind(email["id"].as_str().unwrap_or(""))
        .bind(email["uid"].as_i64().unwrap_or(0))
        .bind(&account_id)
        .bind(&folder_for_db)
        .bind(email["subject"].as_str().unwrap_or(""))
        .bind(email["sender"].as_str().unwrap_or(""))
        .bind(email["sender_email"].as_str().unwrap_or(""))
        .bind(email["to_email"].as_str().unwrap_or(""))
        .bind(email["date"].as_str().unwrap_or(""))
        .bind(email["snippet"].as_str().unwrap_or(""))
        .bind(email["body"].as_str().unwrap_or(""))
        .execute(&pool)
        .await;
    }

    log::info!("Synced {} emails from IMAP for {}", fetched_emails.len(), account.email);
    Ok(fetched_emails)
}

/// Extract both HTML and plain text bodies from a parsed email
fn extract_bodies(raw: &[u8]) -> (String, String) {
    match parse_mail(raw) {
        Ok(parsed) => {
            let html = find_mime_part(&parsed, "text/html").unwrap_or_default();
            let plain = find_mime_part(&parsed, "text/plain").unwrap_or_default();
            (html, plain)
        }
        Err(_) => {
            let fallback = String::from_utf8_lossy(raw).to_string();
            (String::new(), fallback)
        }
    }
}

/// Recursively search for a MIME part by content type
fn find_mime_part(mail: &mailparse::ParsedMail, target_type: &str) -> Option<String> {
    if mail.subparts.is_empty() {
        if mail.ctype.mimetype.starts_with(target_type) {
            return mail.get_body().ok();
        }
        return None;
    }
    for part in &mail.subparts {
        if let Some(body) = find_mime_part(part, target_type) {
            return Some(body);
        }
    }
    None
}

/// Strip HTML tags for snippet generation
fn strip_html_tags(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    let mut in_style = false;
    let mut in_script = false;

    let lower = html.to_lowercase();
    let chars: Vec<char> = html.chars().collect();
    let lower_chars: Vec<char> = lower.chars().collect();

    let mut i = 0;
    while i < chars.len() {
        if !in_tag && chars[i] == '<' {
            in_tag = true;
            // Check if entering <style> or <script>
            let remaining: String = lower_chars[i..].iter().take(10).collect();
            if remaining.starts_with("<style") {
                in_style = true;
            } else if remaining.starts_with("<script") {
                in_script = true;
            } else if remaining.starts_with("</style") {
                in_style = false;
            } else if remaining.starts_with("</script") {
                in_script = false;
            }
        } else if in_tag && chars[i] == '>' {
            in_tag = false;
        } else if !in_tag && !in_style && !in_script {
            result.push(chars[i]);
        }
        i += 1;
    }

    result
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
}

/// Parse RFC 2822 date to ISO 8601 for proper sorting
fn parse_rfc2822_to_iso(date_str: &str) -> String {
    // Try chrono parsing
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(date_str) {
        return dt.format("%Y-%m-%dT%H:%M:%S%z").to_string();
    }
    // Fallback: clean up common issues and try again
    let cleaned = date_str.trim().replace("  ", " ");
    if let Ok(dt) = chrono::DateTime::parse_from_rfc2822(&cleaned) {
        return dt.format("%Y-%m-%dT%H:%M:%S%z").to_string();
    }
    // Last resort: return original
    date_str.to_string()
}

#[tauri::command]
pub async fn save_draft(
    app: AppHandle,
    account_id: String,
    to: String,
    subject: String,
    body: String,
) -> Result<String, String> {
    let state = app.state::<DbState>();
    let pool = state.pool.clone();

    let account = sqlx::query_as::<_, crate::db::Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = $1"
    )
    .bind(&account_id)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or_else(|| "Account not found".to_string())?;

    let imap_host = account.imap_host.clone().ok_or("IMAP host not configured")?;
    let imap_port = account.imap_port.unwrap_or(993) as u16;
    let email_addr = account.email.clone();
    let password = account.password.clone().ok_or("Password not configured")?;
    let from_name = account.full_name.clone().unwrap_or_else(|| email_addr.clone());

    // Build RFC822 message
    let date_str = chrono::Utc::now().to_rfc2822();
    let message = format!(
        "From: {} <{}>\r\nTo: {}\r\nSubject: {}\r\nDate: {}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n{}",
        from_name, email_addr, to, subject, date_str, body
    );

    log::info!("Saving draft to IMAP Drafts folder for {}", email_addr);

    // 🧹 Dedup: remove existing local drafts with the same subject before creating new one
    let dedup_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM emails WHERE account_id = $1 AND folder = 'Drafts' AND subject = $2 AND id LIKE 'draft_%'"
    )
    .bind(&account_id)
    .bind(&subject)
    .fetch_one(&pool)
    .await
    .unwrap_or(0);

    if dedup_count > 0 {
        log::info!("[DRAFT] Dedup: removing {} existing local drafts for subject \"{}\"", dedup_count, subject);
        let _ = sqlx::query(
            "DELETE FROM emails WHERE account_id = $1 AND folder = 'Drafts' AND subject = $2 AND id LIKE 'draft_%'"
        )
        .bind(&account_id)
        .bind(&subject)
        .execute(&pool)
        .await;
    }

    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS error: {}", e))?;

        let client = imap::connect(
            (imap_host.as_str(), imap_port),
            &imap_host,
            &tls,
        ).map_err(|e| format!("IMAP connect error: {}", e))?;

        let mut session = client
            .login(&email_addr, &password)
            .map_err(|e| format!("IMAP login error: {}", e.0))?;

        // Try common draft folder names
        let draft_folders = ["Drafts", "INBOX.Drafts", "Draft", "INBOX.Draft", "[Gmail]/Drafts"];
        let mut saved = false;

        for folder in &draft_folders {
            match session.append(folder, message.as_bytes()) {
                Ok(_) => {
                    log::info!("Draft saved to folder: {}", folder);
                    saved = true;
                    break;
                }
                Err(_) => continue,
            }
        }

        if !saved {
            // If no draft folder found, try creating one
            let _ = session.create("Drafts");
            session.append("Drafts", message.as_bytes())
                .map_err(|e| format!("Failed to save draft: {}", e))?;
        }

        session.logout().ok();
        Ok("Draft saved".to_string())
    })
    .await
    .map_err(|e| format!("Thread error: {}", e))??;

    // Also save to local DB so it appears immediately! (must be done outside spawn_blocking because it's async)
    let state = app.state::<crate::db::DbState>();
    let new_id = format!("draft_{}", chrono::Utc::now().timestamp_millis());
    let _ = sqlx::query(
        r#"INSERT OR IGNORE INTO emails (id, uid, account_id, folder, subject, sender, sender_email, date, snippet, body, read)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1)"#
    )
    .bind(&new_id)
    .bind(9999999_i64) // High UID for local drafts until synced
    .bind(&account_id)
    .bind("Drafts")
    .bind(&subject)
    .bind("Me (Draft)")
    .bind("")
    .bind(&date_str)
    .bind(body.chars().take(200).collect::<String>())
    .bind(&body)
    .execute(&state.pool)
    .await;

    Ok("Draft saved".to_string())
}

#[tauri::command]
pub async fn imap_delete_email(
    app: AppHandle,
    account_id: String,
    email_id: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();

    // Get email UID and folder from local DB
    let email = sqlx::query_as::<_, (i64, String)>(
        "SELECT uid, folder FROM emails WHERE id = $1"
    )
    .bind(&email_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or("Email not found")?;

    let (uid, folder) = email;

    // Get account credentials
    let account = sqlx::query_as::<_, crate::db::Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = $1"
    )
    .bind(&account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or("Account not found")?;

    let imap_host = account.imap_host.clone().ok_or("IMAP host not configured")?;
    let imap_port = account.imap_port.unwrap_or(993) as u16;
    let email_addr = account.email.clone();
    let password = account.password.clone().ok_or("Password not configured")?;
    let uid_val = uid as u32;
    let folder_clone = folder.clone();

    // Delete from IMAP server
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS error: {}", e))?;

        let client = imap::connect(
            (imap_host.as_str(), imap_port),
            &imap_host,
            &tls,
        ).map_err(|e| format!("IMAP connect error: {}", e))?;

        let mut session = client
            .login(&email_addr, &password)
            .map_err(|e| format!("IMAP login error: {}", e.0))?;

        // Map folder names
        let imap_folders: Vec<String> = match folder_clone.as_str() {
            "INBOX" => vec!["INBOX".to_string()],
            "Drafts" => vec!["Drafts", "INBOX.Drafts", "Draft", "INBOX.Draft"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Sent" => vec!["Sent", "INBOX.Sent", "Sent Messages"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Trash" => vec!["Trash", "INBOX.Trash"]
                .into_iter().map(|s| s.to_string()).collect(),
            other => vec![other.to_string()],
        };

        let mut selected = false;
        for f in &imap_folders {
            if session.select(f).is_ok() {
                selected = true;
                break;
            }
        }
        if !selected {
            session.logout().ok();
            return Err(format!("Could not select folder: {}", folder_clone));
        }

        // Flag as \Deleted and expunge
        let uid_set = format!("{}", uid_val);
        session.uid_store(&uid_set, "+FLAGS (\\Deleted)")
            .map_err(|e| format!("IMAP store error: {}", e))?;
        session.expunge()
            .map_err(|e| format!("IMAP expunge error: {}", e))?;

        log::info!("[IMAP] Deleted email UID {} from folder {}", uid_val, folder_clone);
        session.logout().ok();
        Ok(())
    }).await.map_err(|e| format!("Task error: {}", e))??;

    // Also delete from local DB
    sqlx::query("DELETE FROM emails WHERE id = $1")
        .bind(&email_id)
        .execute(&state.pool)
        .await
        .map_err(|e| format!("DB delete error: {}", e))?;

    // Clean up triage log for this email
    let _ = sqlx::query("DELETE FROM ai_triage_log WHERE email_id = $1")
        .bind(&email_id)
        .execute(&state.pool)
        .await;

    Ok(())
}

#[tauri::command]
pub async fn imap_bulk_delete(
    app: AppHandle,
    account_id: String,
    folder: String,
) -> Result<i64, String> {
    let state = app.state::<DbState>();

    // Get all UIDs from local DB for this folder
    let uids = sqlx::query_as::<_, (i64,)>(
        "SELECT uid FROM emails WHERE account_id = $1 AND folder = $2"
    )
    .bind(&account_id)
    .bind(&folder)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?;

    if uids.is_empty() {
        return Ok(0);
    }

    let uid_list: Vec<u32> = uids.iter().map(|(u,)| *u as u32).collect();
    let count = uid_list.len() as i64;
    log::info!("[IMAP] Bulk deleting {} emails from {}", count, folder);

    let account = sqlx::query_as::<_, crate::db::Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = $1"
    )
    .bind(&account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or("Account not found")?;

    let imap_host = account.imap_host.clone().ok_or("IMAP host not configured")?;
    let imap_port = account.imap_port.unwrap_or(993) as u16;
    let email_addr = account.email.clone();
    let password = account.password.clone().ok_or("Password not configured")?;
    let folder_clone = folder.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let tls = native_tls::TlsConnector::builder()
            .build()
            .map_err(|e| format!("TLS error: {}", e))?;

        let client = imap::connect(
            (imap_host.as_str(), imap_port),
            &imap_host,
            &tls,
        ).map_err(|e| format!("IMAP connect error: {}", e))?;

        let mut session = client
            .login(&email_addr, &password)
            .map_err(|e| format!("IMAP login error: {}", e.0))?;

        let imap_folders: Vec<String> = match folder_clone.as_str() {
            "INBOX" => vec!["INBOX".to_string()],
            "Drafts" => vec!["Drafts", "INBOX.Drafts", "Draft", "INBOX.Draft"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Sent" => vec!["Sent", "INBOX.Sent", "Sent Messages"]
                .into_iter().map(|s| s.to_string()).collect(),
            "Trash" => vec!["Trash", "INBOX.Trash"]
                .into_iter().map(|s| s.to_string()).collect(),
            other => vec![other.to_string()],
        };

        let mut selected = false;
        for f in &imap_folders {
            if session.select(f).is_ok() { selected = true; break; }
        }
        if !selected {
            session.logout().ok();
            return Err(format!("Could not select folder: {}", folder_clone));
        }

        // Flag ALL UIDs as \Deleted in ONE call
        let uid_set = uid_list.iter().map(|u| u.to_string()).collect::<Vec<_>>().join(",");
        session.uid_store(&uid_set, "+FLAGS (\\Deleted)")
            .map_err(|e| format!("IMAP store error: {}", e))?;
        session.expunge()
            .map_err(|e| format!("IMAP expunge error: {}", e))?;

        log::info!("[IMAP] ✅ Bulk deleted {} emails from {}", uid_list.len(), folder_clone);
        session.logout().ok();
        Ok(())
    }).await.map_err(|e| format!("Task error: {}", e))??;

    // Bulk delete from local DB
    sqlx::query("DELETE FROM emails WHERE account_id = $1 AND folder = $2")
        .bind(&account_id)
        .bind(&folder)
        .execute(&state.pool)
        .await
        .map_err(|e| format!("DB delete error: {}", e))?;

    Ok(count)
}
