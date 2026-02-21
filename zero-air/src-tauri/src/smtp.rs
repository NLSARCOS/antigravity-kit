use tauri::{AppHandle, Manager};
use crate::db::DbState;
use lettre::{Message, SmtpTransport, Transport};
use lettre::transport::smtp::authentication::Credentials;
use lettre::message::{header::ContentType, MultiPart, SinglePart, Attachment};

#[tauri::command]
pub async fn send_email(
    app: AppHandle,
    account_id: String,
    to: String,
    subject: String,
    body: String,
    attachments: Option<Vec<String>>,
) -> Result<(), String> {
    let state = app.state::<DbState>();

    let account = sqlx::query_as::<_, crate::db::Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts WHERE id = $1"
    )
    .bind(&account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| format!("DB error: {}", e))?
    .ok_or_else(|| "Account not found".to_string())?;

    let smtp_host = account.smtp_host.as_deref().ok_or("SMTP host not configured")?;
    let from_email = &account.email;
    let password = account.password.as_deref().ok_or("Password not configured")?;
    let full_name = account.full_name.as_deref().unwrap_or(from_email);

    log::info!("Sending email from {} to {} via {} (attachments: {})", 
        from_email, to, smtp_host, 
        attachments.as_ref().map(|a| a.len()).unwrap_or(0));

    let from_formatted = format!("{} <{}>", full_name, from_email);
    let from_addr = from_formatted.parse().map_err(|e| format!("Invalid from: {}", e))?;
    let to_addr = to.parse().map_err(|e| format!("Invalid to: {}", e))?;

    let attachment_paths = attachments.unwrap_or_default();

    let email = if attachment_paths.is_empty() {
        // Simple text email
        Message::builder()
            .from(from_addr)
            .to(to_addr)
            .subject(&subject)
            .header(ContentType::TEXT_PLAIN)
            .body(body.clone())
            .map_err(|e| format!("Failed to build email: {}", e))?
    } else {
        // Multipart with attachments
        let mut multipart = MultiPart::mixed()
            .singlepart(
                SinglePart::builder()
                    .header(ContentType::TEXT_PLAIN)
                    .body(body.clone())
            );

        for path_str in &attachment_paths {
            let path = std::path::Path::new(path_str);
            let filename = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("attachment")
                .to_string();
            
            let file_bytes = std::fs::read(path)
                .map_err(|e| format!("Failed to read {}: {}", path_str, e))?;

            let content_type = ContentType::parse(
                mime_guess::from_path(path)
                    .first_or_octet_stream()
                    .as_ref()
            ).unwrap_or(ContentType::parse("application/octet-stream").unwrap());

            let attachment = Attachment::new(filename)
                .body(file_bytes, content_type);

            multipart = multipart.singlepart(attachment);
        }

        Message::builder()
            .from(from_addr)
            .to(to_addr)
            .subject(&subject)
            .multipart(multipart)
            .map_err(|e| format!("Failed to build email: {}", e))?
    };

    let creds = Credentials::new(from_email.clone(), password.to_string());

    let mailer = SmtpTransport::relay(smtp_host)
        .map_err(|e| format!("SMTP relay error: {}", e))?
        .credentials(creds)
        .build();

    let result = tokio::task::spawn_blocking(move || {
        mailer.send(&email)
    }).await.map_err(|e| format!("Thread error: {}", e))?;

    match result {
        Ok(_) => {
            log::info!("Email sent successfully to {}", to);
            let email_id = format!("sent_{}", chrono::Utc::now().timestamp_millis());
            let _ = sqlx::query(
                r#"INSERT OR REPLACE INTO emails (id, uid, account_id, folder, subject, sender, sender_email, date, snippet, body, read)
                   VALUES ($1, 0, $2, 'Sent', $3, $4, $5, $6, $7, $8, 1)"#
            )
            .bind(&email_id)
            .bind(&account_id)
            .bind(&subject)
            .bind(&to)
            .bind(&to)
            .bind(chrono::Utc::now().to_rfc2822())
            .bind(&body.chars().take(120).collect::<String>())
            .bind(&body)
            .execute(&state.pool)
            .await;

            Ok(())
        },
        Err(e) => {
            log::error!("Failed to send email: {}", e);
            Err(format!("Failed to send email: {}", e))
        }
    }
}
