use sqlx::{sqlite::{SqliteConnectOptions, SqlitePoolOptions}, SqlitePool};
use std::str::FromStr;
use tauri::{AppHandle, Manager};
use std::fs;
use serde::{Serialize, Deserialize};

pub struct DbState {
    pub pool: SqlitePool,
}

#[derive(Serialize, Deserialize, Debug, sqlx::FromRow)]
pub struct Account {
    pub id: String,
    pub full_name: Option<String>,
    pub email: String,
    pub password: Option<String>,
    pub imap_host: Option<String>,
    pub imap_port: Option<i32>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<i32>,
}

#[tauri::command]
pub async fn save_account(
    app: AppHandle,
    account: Account,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    sqlx::query(
        r#"
        INSERT INTO accounts (id, email, password, imap_host, imap_port, smtp_host, smtp_port, full_name)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(email) DO UPDATE SET
            password = excluded.password,
            imap_host = excluded.imap_host,
            imap_port = excluded.imap_port,
            smtp_host = excluded.smtp_host,
            smtp_port = excluded.smtp_port,
            full_name = excluded.full_name
        "#
    )
    .bind(&account.id)
    .bind(&account.email)
    .bind(&account.password)
    .bind(&account.imap_host)
    .bind(&account.imap_port)
    .bind(&account.smtp_host)
    .bind(&account.smtp_port)
    .bind(&account.full_name)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub async fn get_accounts(
    app: AppHandle,
) -> Result<Vec<Account>, String> {
    let state = app.state::<DbState>();
    let accounts = sqlx::query_as::<_, Account>(
        "SELECT id, full_name, email, password, imap_host, imap_port, smtp_host, smtp_port FROM accounts"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e: sqlx::Error| e.to_string())?;

    Ok(accounts)
}

#[derive(Serialize, Deserialize, Debug, sqlx::FromRow)]
pub struct Email {
    pub id: String,
    pub uid: i64,
    pub account_id: String,
    pub folder: String,
    pub subject: Option<String>,
    pub sender: Option<String>,
    pub sender_email: Option<String>,
    pub to_email: Option<String>,
    pub date: Option<String>,
    pub snippet: Option<String>,
    pub body: Option<String>,
    pub read: Option<bool>,
    pub ai_priority: Option<String>,
    pub ai_labels: Option<String>,
    pub ai_summary: Option<String>,
}

#[tauri::command]
pub async fn save_ai_config(
    app: AppHandle,
    endpoint: String,
    api_key: String,
    model: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    for (key, value) in [("endpoint", &endpoint), ("api_key", &api_key), ("model", &model)] {
        sqlx::query("INSERT INTO ai_config (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(&state.pool)
            .await
            .map_err(|e| format!("Failed to save ai_config: {}", e))?;
    }
    log::info!("[AI_CONFIG] Saved: endpoint={}, model={}", endpoint, model);
    Ok(())
}

#[tauri::command]
pub async fn get_emails(
    app: AppHandle,
    account_id: String,
    folder: String,
) -> Result<Vec<Email>, String> {
    let state = app.state::<DbState>();
    let emails = sqlx::query_as::<_, Email>(
        "SELECT id, uid, account_id, folder, subject, sender, sender_email, to_email, date, snippet, body, read, ai_priority, ai_labels, ai_summary FROM emails WHERE account_id = $1 AND folder = $2 ORDER BY uid DESC"
    )
    .bind(&account_id)
    .bind(&folder)
    .fetch_all(&state.pool)
    .await
    .map_err(|e: sqlx::Error| e.to_string())?;

    Ok(emails)
}

#[tauri::command]
pub async fn save_ai_metadata(
    app: AppHandle,
    email_id: String,
    ai_priority: Option<String>,
    ai_labels: Option<String>,
    ai_summary: Option<String>,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    sqlx::query(
        "UPDATE emails SET ai_priority = $1, ai_labels = $2, ai_summary = $3 WHERE id = $4"
    )
    .bind(&ai_priority)
    .bind(&ai_labels)
    .bind(&ai_summary)
    .bind(&email_id)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_email(
    app: AppHandle,
    email_id: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    sqlx::query("DELETE FROM emails WHERE id = $1")
        .bind(&email_id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Serialize, Deserialize, Debug, sqlx::FromRow)]
pub struct PromptHistory {
    pub id: String,
    pub prompt_text: String,
    pub created_at: String, // ISO date string
}

#[tauri::command]
pub async fn save_ai_prompt_history(
    app: AppHandle,
    prompt_text: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let id = format!("ph_{}", chrono::Utc::now().timestamp_millis());
    let date = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO ai_prompt_history (id, prompt_text, created_at) VALUES ($1, $2, $3)"
    )
    .bind(&id)
    .bind(&prompt_text)
    .bind(&date)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn get_ai_prompt_history(
    app: AppHandle,
) -> Result<Vec<PromptHistory>, String> {
    let state = app.state::<DbState>();
    let history = sqlx::query_as::<_, PromptHistory>(
        "SELECT id, prompt_text, created_at FROM ai_prompt_history ORDER BY created_at DESC LIMIT 10"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e: sqlx::Error| e.to_string())?;

    Ok(history)
}

pub async fn init_db(app: &AppHandle) -> Result<SqlitePool, sqlx::Error> {
    let app_dir = app.path().app_data_dir().expect("Failed to get app data dir");
    if !app_dir.exists() {
        fs::create_dir_all(&app_dir).expect("Failed to create app data dir");
    }
    
    let db_path = app_dir.join("zero_air.db");
    // Ensure the database file exists or is handled properly by SQLite
    let database_url = format!("sqlite://{}", db_path.to_string_lossy());
    
    let options = SqliteConnectOptions::from_str(&database_url)?
        .create_if_missing(true);
        
    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;
        
    // Create initial tables for the offline-first email client
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            full_name TEXT,
            email TEXT NOT NULL UNIQUE,
            password TEXT,
            imap_host TEXT,
            imap_port INTEGER,
            smtp_host TEXT,
            smtp_port INTEGER
        );
        CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY,
            uid INTEGER NOT NULL,
            account_id TEXT NOT NULL,
            folder TEXT NOT NULL,
            subject TEXT,
            sender TEXT,
            sender_email TEXT,
            date TEXT,
            snippet TEXT,
            body TEXT,
            read BOOLEAN DEFAULT 0,
            ai_priority TEXT,
            ai_labels TEXT,
            ai_summary TEXT,
            FOREIGN KEY(account_id) REFERENCES accounts(id)
        );
        CREATE INDEX IF NOT EXISTS idx_emails_date ON emails(date DESC);
        CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder);
        
        CREATE TABLE IF NOT EXISTS ai_prompt_history (
            id TEXT PRIMARY KEY,
            prompt_text TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        -- Autonomous triage: stores per-email classification decisions
        CREATE TABLE IF NOT EXISTS ai_triage_log (
            id TEXT PRIMARY KEY,
            email_id TEXT NOT NULL,
            importance TEXT NOT NULL DEFAULT 'low',
            reason TEXT,
            user_action TEXT,
            sender_email TEXT,
            created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_triage_email ON ai_triage_log(email_id);

        -- Auto-learned VIP senders: always classified as high importance
        CREATE TABLE IF NOT EXISTS ai_vip_senders (
            id TEXT PRIMARY KEY,
            sender_email TEXT NOT NULL UNIQUE,
            reason TEXT DEFAULT 'auto-learned',
            created_at TEXT NOT NULL
        );

        -- Rolling conversation compaction (OpenClaw pattern)
        CREATE TABLE IF NOT EXISTS ai_conversation_summary (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            summary TEXT NOT NULL,
            message_count INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        -- AI endpoint/key/model config
        CREATE TABLE IF NOT EXISTS ai_config (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- Self-generated skills: rules the AI creates from behavior patterns
        CREATE TABLE IF NOT EXISTS ai_skills (
            id TEXT PRIMARY KEY,
            skill_type TEXT NOT NULL,       -- 'sender_rule' | 'keyword_rule' | 'time_rule' | 'style_pref'
            description TEXT NOT NULL,      -- human-readable explanation
            rule_json TEXT NOT NULL,         -- machine-readable rule: {"match":"sender_contains","value":"banco","action":"high"}
            confidence REAL DEFAULT 0.5,    -- 0.0 to 1.0, increases with correct predictions
            times_applied INTEGER DEFAULT 0,
            times_correct INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1,       -- 0=disabled by user, 1=active
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        "#
    ).execute(&pool).await?;
    
    // Add columns if they don't exist (primitive migration)
    let _ = sqlx::query("ALTER TABLE accounts ADD COLUMN full_name TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE emails ADD COLUMN sender_email TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE emails ADD COLUMN ai_priority TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE emails ADD COLUMN ai_labels TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE emails ADD COLUMN ai_summary TEXT").execute(&pool).await;
    let _ = sqlx::query("ALTER TABLE emails ADD COLUMN to_email TEXT").execute(&pool).await;
    
    // Clean up failed triage entries so they get retried
    let _ = sqlx::query("DELETE FROM ai_triage_log WHERE reason = 'AI no disponible' OR reason = 'No se pudo clasificar'").execute(&pool).await;

    // One-time reset: reclassify all emails with improved prompt v2
    let version = sqlx::query_scalar::<_, String>("SELECT value FROM ai_config WHERE key = 'triage_prompt_version'")
        .fetch_optional(&pool).await.unwrap_or(None);
    if version.as_deref() != Some("v2") {
        log::info!("[DB] Resetting triage log for improved prompt v2");
        let _ = sqlx::query("DELETE FROM ai_triage_log").execute(&pool).await;
        let _ = sqlx::query("INSERT INTO ai_config (key, value) VALUES ('triage_prompt_version', 'v2') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .execute(&pool).await;
    }

    Ok(pool)
}
