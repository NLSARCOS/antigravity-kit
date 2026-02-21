/// AI Triage Engine — Autonomous email classification + self-learning
/// Inspired by OpenClaw's: isolated-agent, internal-hooks, temporal-decay, and compaction patterns.
use tauri::{AppHandle, Manager, Emitter};
use crate::db::DbState;
use crate::ai::AiRequest;
use serde::{Serialize, Deserialize};

// ─── Triage result ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TriageResult {
    pub email_id: String,
    pub importance: String,  // "high" | "medium" | "low"
    pub reason: String,
    pub should_notify: bool,
}

#[derive(Clone, serde::Serialize)]
pub struct ImportantMailPayload {
    pub account_id: String,
    pub email_id: String,
    pub sender: String,
    pub subject: String,
    pub importance: String,
}

// ─── Core triage function ─────────────────────────────────────────────────────

/// Classify an email using the AI. Returns importance level and whether to notify.
/// OpenClaw pattern: isolated agent with its own system prompt, no conversation history.
pub async fn triage_email(
    app: &AppHandle,
    email_id: &str,
    sender: &str,
    sender_email: &str,
    subject: &str,
    snippet: &str,
    account_id: &str,
) -> TriageResult {
    // Load learned VIP senders from DB
    let vip_context = match get_vip_context(app, account_id).await {
        Ok(ctx) => ctx,
        Err(_) => String::new(),
    };

    // Load self-generated skills from DB
    let skills_context = get_skills_context(app).await;

    // Load AI config from DB
    let (endpoint, api_key, model) = get_ai_config(app).await;

    let vip_note = if vip_context.is_empty() {
        String::new()
    } else {
        format!("\n\nRemitentes VIP aprendidos (siempre marcar como high):\n{}", vip_context)
    };

    let prompt = format!(
        r#"Clasifica este correo electrónico según su importancia. Responde SOLO con JSON válido, sin explicación extra.

Correo:
De: {} <{}>
Asunto: {}
Contenido: {}{}{}

Responde con este formato exacto:
{{"importance": "high|medium|low", "reason": "una frase corta", "should_notify": true|false}}

Reglas ESTRICTAS (aplica en orden):
1. Si el contenido contiene palabras como "urgente", "asap", "inmediato", "cuanto antes", "necesito ya", "prioridad", pide algo con urgencia → SIEMPRE high + notify=true
2. Si es de un remitente VIP → high + notify=true
3. Si es una respuesta en un hilo de conversación (Re:, asunto con Re:) y el contenido pide algo → high + notify=true
4. Correos de jefes/clientes, facturas, contratos, accesos, credenciales → high + notify=true
5. Newsletters útiles, respuestas informativas, reuniones → medium + notify=false
6. Newsletters promocionales, spam, notificaciones automáticas del sistema, bounces, errores de entrega → low + notify=false

IMPORTANTE: Lee el CONTENIDO completo del correo, no solo el asunto. Si una persona te pide algo urgente, es HIGH."#,
        sender, sender_email, subject,
        &snippet[..snippet.len().min(500)],
        vip_note,
        skills_context
    );

    let request = AiRequest {
        prompt,
        system_prompt: Some("Eres un clasificador de correos experto. Lee el CONTENIDO del correo cuidadosamente. Responde SOLO con JSON.".to_string()),
        endpoint: endpoint.clone(),
        api_key: api_key.clone(),
        model: model.clone(),
        context: None,
    };

    match crate::ai::call_ai(&request).await {
        Ok(text) => {
            // Parse JSON response from AI
            let clean = text.trim()
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();

            if let Ok(val) = serde_json::from_str::<serde_json::Value>(clean) {
                let importance = val["importance"].as_str().unwrap_or("low").to_string();
                let reason = val["reason"].as_str().unwrap_or("").to_string();
                let should_notify = val["should_notify"].as_bool().unwrap_or(false);
                return TriageResult { email_id: email_id.to_string(), importance, reason, should_notify };
            }

            // Fallback if JSON parse fails
            TriageResult {
                email_id: email_id.to_string(),
                importance: "low".to_string(),
                reason: "No se pudo clasificar".to_string(),
                should_notify: false,
            }
        }
        Err(_) => TriageResult {
            email_id: email_id.to_string(),
            importance: "low".to_string(),
            reason: "AI no disponible".to_string(),
            should_notify: false,
        }
    }
}

// ─── Behavior learning ────────────────────────────────────────────────────────

/// Record what the user did with an email. OpenClaw pattern: learn from every interaction.
/// action: "opened" | "replied" | "deleted" | "ignored" | "starred"
#[tauri::command]
pub async fn record_user_action(
    app: AppHandle,
    email_id: String,
    action: String,
    sender_email: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let id = format!("action_{}", chrono::Utc::now().timestamp_millis());
    let now = chrono::Utc::now().to_rfc3339();

    sqlx::query(
        "INSERT OR IGNORE INTO ai_triage_log (id, email_id, user_action, sender_email, created_at) VALUES ($1, $2, $3, $4, $5)"
    )
    .bind(&id)
    .bind(&email_id)
    .bind(&action)
    .bind(&sender_email)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    // If user replied or starred → this sender becomes VIP
    if action == "replied" || action == "starred" {
        promote_to_vip(&app, &sender_email).await.ok();
    }

    Ok(())
}

/// Promote a sender to VIP — they always get high importance
async fn promote_to_vip(app: &AppHandle, sender_email: &str) -> Result<(), String> {
    let state = app.state::<DbState>();
    let id = format!("vip_{}", chrono::Utc::now().timestamp_millis());
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO ai_vip_senders (id, sender_email, reason, created_at) VALUES ($1, $2, 'auto-learned', $3)"
    )
    .bind(&id)
    .bind(sender_email)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    log::info!("[TRIAGE] 🌟 Promoted to VIP: {}", sender_email);
    Ok(())
}

/// Get learned VIP senders as context string for the triage prompt
async fn get_vip_context(app: &AppHandle, _account_id: &str) -> Result<String, String> {
    let state = app.state::<DbState>();
    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT sender_email FROM ai_vip_senders LIMIT 20"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|(e,)| format!("- {}", e)).collect::<Vec<_>>().join("\n"))
}

// ─── Tauri commands for frontend ──────────────────────────────────────────────

/// Get importance badge for an email (checks DB triage log)
#[tauri::command]
pub async fn get_email_importance(
    app: AppHandle,
    email_id: String,
) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT importance FROM ai_triage_log WHERE email_id = $1 ORDER BY created_at DESC LIMIT 1"
    )
    .bind(&email_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(i,)| i))
}

/// Get bulk importance map for multiple emails
#[tauri::command]
pub async fn get_importance_map(
    app: AppHandle,
    account_id: String,
) -> Result<Vec<(String, String)>, String> {
    let state = app.state::<DbState>();
    let rows = sqlx::query_as::<_, (String, String)>(
        r#"SELECT t.email_id, t.importance
           FROM ai_triage_log t
           INNER JOIN emails e ON e.id = t.email_id
           WHERE e.account_id = $1
           ORDER BY t.created_at DESC"#
    )
    .bind(&account_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Get list of VIP senders (manually added or auto-learned)
#[tauri::command]
pub async fn get_vip_senders(
    app: AppHandle,
) -> Result<Vec<String>, String> {
    let state = app.state::<DbState>();
    let rows = sqlx::query_as::<_, (String,)>(
        "SELECT sender_email FROM ai_vip_senders ORDER BY created_at DESC"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|(e,)| e).collect())
}

/// Manually add a VIP sender
#[tauri::command]
pub async fn add_vip_sender(
    app: AppHandle,
    sender_email: String,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let id = format!("vip_{}", chrono::Utc::now().timestamp_millis());
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT OR IGNORE INTO ai_vip_senders (id, sender_email, reason, created_at) VALUES ($1, $2, 'manual', $3)"
    )
    .bind(&id)
    .bind(&sender_email)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Conversation compaction (OpenClaw pattern) ───────────────────────────────

/// Save a compressed summary of chat history to avoid token overflow.
/// OpenClaw pattern: rolling compaction — old messages → summary → injected into next prompt.
#[tauri::command]
pub async fn save_conversation_summary(
    app: AppHandle,
    account_id: String,
    summary: String,
    message_count: i64,
) -> Result<(), String> {
    let state = app.state::<DbState>();
    let id = "conv_summary_main".to_string();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query(
        r#"INSERT INTO ai_conversation_summary (id, account_id, summary, message_count, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT(id) DO UPDATE SET summary = excluded.summary, message_count = excluded.message_count, updated_at = excluded.updated_at"#
    )
    .bind(&id)
    .bind(&account_id)
    .bind(&summary)
    .bind(&message_count)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Load the rolling conversation summary
#[tauri::command]
pub async fn get_conversation_summary(
    app: AppHandle,
    account_id: String,
) -> Result<Option<String>, String> {
    let state = app.state::<DbState>();
    let row = sqlx::query_as::<_, (String,)>(
        "SELECT summary FROM ai_conversation_summary WHERE account_id = $1 LIMIT 1"
    )
    .bind(&account_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(row.map(|(s,)| s))
}

// ─── Triage trigger (called after IMAP IDLE detects new mail) ────────────────

/// Called by imap_idle after syncing new emails. Triages the N newest in INBOX.
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering as AtomicOrdering};

/// Prevent concurrent triage runs
static TRIAGE_RUNNING: AtomicBool = AtomicBool::new(false);
/// Track last successful AI call timestamp for rate limiting
static LAST_AI_CALL_TS: AtomicI64 = AtomicI64::new(0);
/// Minimum seconds between AI calls
const MIN_AI_INTERVAL_SECS: i64 = 5;

pub async fn run_triage_on_new_emails(app: &AppHandle, account_id: &str) {
    // Prevent concurrent runs — only one triage at a time
    if TRIAGE_RUNNING.compare_exchange(false, true, AtomicOrdering::SeqCst, AtomicOrdering::Relaxed).is_err() {
        log::info!("[TRIAGE] Already running, skipping.");
        return;
    }

    let state = app.state::<DbState>();

    // Count unprocessed emails
    let unprocessed_count = sqlx::query_scalar::<_, i64>(
        r#"SELECT COUNT(*) FROM emails e
           LEFT JOIN ai_triage_log t ON t.email_id = e.id
           WHERE e.account_id = $1 AND e.folder = 'INBOX' AND t.email_id IS NULL"#
    )
    .bind(account_id)
    .fetch_one(&state.pool)
    .await
    .unwrap_or(0);

    if unprocessed_count == 0 {
        log::info!("[TRIAGE] No new emails to classify.");
        TRIAGE_RUNNING.store(false, AtomicOrdering::SeqCst);
        return;
    }

    log::info!("[TRIAGE] 🚀 Starting triage of {} unprocessed emails", unprocessed_count);
    let _ = app.emit("triage-progress", serde_json::json!({
        "total": unprocessed_count,
        "processed": 0,
        "status": "started"
    }));

    let mut processed = 0i64;

    // Process up to 10 emails per run to avoid overwhelming AI
    let max_per_run = 10;

    loop {
        if processed >= max_per_run {
            log::info!("[TRIAGE] Reached max {} per run, remaining will be processed next trigger.", max_per_run);
            break;
        }

        // Rate limit: wait if last AI call was too recent
        let now = chrono::Utc::now().timestamp();
        let last_call = LAST_AI_CALL_TS.load(AtomicOrdering::Relaxed);
        if now - last_call < MIN_AI_INTERVAL_SECS {
            let wait = (MIN_AI_INTERVAL_SECS - (now - last_call)) as u64;
            log::info!("[TRIAGE] Rate limit: waiting {}s before next call", wait);
            tokio::time::sleep(tokio::time::Duration::from_secs(wait)).await;
        }

        // Get the next unprocessed email
        let email = match sqlx::query_as::<_, (String, String, String, String, String)>(
            r#"SELECT e.id, COALESCE(e.sender, ''), COALESCE(e.sender_email, ''), COALESCE(e.subject, ''), COALESCE(e.snippet, '')
               FROM emails e
               LEFT JOIN ai_triage_log t ON t.email_id = e.id
               WHERE e.account_id = $1 AND e.folder = 'INBOX' AND t.email_id IS NULL
               ORDER BY e.uid DESC LIMIT 1"#
        )
        .bind(account_id)
        .fetch_optional(&state.pool)
        .await {
            Ok(Some(row)) => row,
            Ok(None) => break, // No more unprocessed emails
            Err(e) => {
                log::warn!("[TRIAGE] DB error: {}", e);
                break;
            }
        };

        let (email_id, sender, sender_email, subject, snippet) = email;
        log::info!("[TRIAGE] [{}/{}] Classifying: \"{}\" from {} <{}>", processed + 1, unprocessed_count.min(max_per_run), subject, sender, sender_email);

        // Emit progress to frontend
        let _ = app.emit("triage-progress", serde_json::json!({
            "total": unprocessed_count.min(max_per_run),
            "processed": processed,
            "current_subject": subject,
            "status": "classifying"
        }));

        // Mark the timestamp BEFORE the AI call
        LAST_AI_CALL_TS.store(chrono::Utc::now().timestamp(), AtomicOrdering::Relaxed);

        let result = triage_email(app, &email_id, &sender, &sender_email, &subject, &snippet, account_id).await;

        // ⚠️ KEY FIX: Do NOT save to DB if AI was unavailable — leave for retry
        if result.reason == "AI no disponible" || result.reason == "No se pudo clasificar" {
            log::warn!("[TRIAGE] ⏳ AI unavailable for \"{}\", will retry on next trigger.", subject);
            break; // Stop processing — AI is down
        }

        // AI succeeded — save result to DB
        let id = format!("triage_{}", chrono::Utc::now().timestamp_millis());
        let ts = chrono::Utc::now().to_rfc3339();
        let _ = sqlx::query(
            "INSERT OR IGNORE INTO ai_triage_log (id, email_id, importance, reason, user_action, sender_email, created_at) VALUES ($1, $2, $3, $4, NULL, $5, $6)"
        )
        .bind(&id)
        .bind(&result.email_id)
        .bind(&result.importance)
        .bind(&result.reason)
        .bind(&sender_email)
        .bind(&ts)
        .execute(&state.pool)
        .await;

        processed += 1;
        log::info!("[TRIAGE] ✅ {} ({}): {}", result.importance.to_uppercase(), if result.should_notify { "🔔" } else { "🔕" }, result.reason);

        // Emit importance event to frontend
        let _ = app.emit("email-classified", serde_json::json!({
            "email_id": result.email_id,
            "importance": result.importance.clone(),
            "reason": result.reason.clone(),
        }));

        // Emit important-mail event for high priority
        if result.importance == "high" && result.should_notify {
            let _ = app.emit("important-mail", ImportantMailPayload {
                account_id: account_id.to_string(),
                email_id: result.email_id.clone(),
                sender: sender.clone(),
                subject: subject.clone(),
                importance: result.importance.clone(),
            });

            // 🚀 Auto-generate draft for urgent emails
            log::info!("[TRIAGE] ✍️ Generating proactive draft for urgent email: \"{}\"", subject);
            let draft_app = app.clone();
            let draft_sender = sender.clone();
            let draft_sender_email = sender_email.clone();
            let draft_subject = subject.clone();
            let draft_snippet = snippet.to_string();
            let draft_email_id = email_id.clone();
            tokio::spawn(async move {
                match proactive_draft(
                    draft_app.clone(),
                    draft_email_id.clone(),
                    draft_sender.clone(),
                    draft_subject.clone(),
                    draft_snippet,
                ).await {
                    Ok(draft_body) => {
                        log::info!("[TRIAGE] ✅ Draft generated for \"{}\"", draft_subject);
                        let _ = draft_app.emit("proactive-draft", serde_json::json!({
                            "email_id": draft_email_id,
                            "to": draft_sender_email,
                            "subject": format!("Re: {}", draft_subject),
                            "body": draft_body,
                            "sender": draft_sender,
                        }));
                    }
                    Err(e) => {
                        log::warn!("[TRIAGE] ⚠️ Failed to generate draft: {}", e);
                    }
                }
            });
        }
    }

    // Emit done
    let _ = app.emit("triage-progress", serde_json::json!({
        "total": unprocessed_count,
        "processed": processed,
        "status": "done"
    }));

    log::info!("[TRIAGE] ✅ Done. Processed {} emails.", processed);
    TRIAGE_RUNNING.store(false, AtomicOrdering::SeqCst);
}

/// Tauri command: trigger triage from frontend after sync
#[tauri::command]
pub async fn trigger_triage(app: AppHandle, account_id: String) -> Result<(), String> {
    let app_clone = app.clone();
    tokio::spawn(async move {
        run_triage_on_new_emails(&app_clone, &account_id).await;
    });
    Ok(())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async fn get_ai_config(app: &AppHandle) -> (Option<String>, Option<String>, Option<String>) {
    let state = app.state::<DbState>();
    // Read from ai_config table if available, otherwise use env
    match sqlx::query_as::<_, (String, String)>(
        "SELECT key, value FROM ai_config"
    )
    .fetch_all(&state.pool)
    .await {
        Ok(rows) => {
            let mut endpoint = None;
            let mut api_key = None;
            let mut model = None;
            for (key, value) in rows {
                match key.as_str() {
                    "endpoint" => endpoint = Some(value),
                    "api_key" => api_key = Some(value),
                    "model" => model = Some(value),
                    _ => {}
                }
            }
            (endpoint, api_key, model)
        }
        Err(_) => (None, None, None)
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHASE 3: SELF-IMPROVING SKILLS ENGINE
// OpenClaw pattern: the AI creates its own rules from observed patterns
// ═══════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiSkill {
    pub id: String,
    pub skill_type: String,
    pub description: String,
    pub rule_json: String,
    pub confidence: f64,
    pub times_applied: i64,
    pub times_correct: i64,
    pub active: bool,
    pub created_at: String,
}

/// 🧠 SKILL GENERATION: Analyze user behavior and discover patterns → create rules.
/// OpenClaw pattern: autonomous skill creation — the AI teaches itself.
/// Runs periodically (e.g. once every 24 hours) or on demand.
#[tauri::command]
pub async fn generate_skills(app: AppHandle) -> Result<Vec<String>, String> {
    let state = app.state::<DbState>();
    let (endpoint, api_key, model) = get_ai_config(&app).await;
    let mut created_skills: Vec<String> = vec![];

    // 1. Gather behavior data: which senders the user opens/replies most
    let behavior = sqlx::query_as::<_, (String, String, i64)>(
        r#"SELECT sender_email, user_action, COUNT(*) as cnt
           FROM ai_triage_log
           WHERE user_action IS NOT NULL AND sender_email != ''
           GROUP BY sender_email, user_action
           ORDER BY cnt DESC LIMIT 30"#
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    if behavior.is_empty() {
        return Ok(vec!["No hay suficientes datos de comportamiento aún.".to_string()]);
    }

    // 2. Gather existing skills to avoid duplicates
    let existing = sqlx::query_as::<_, (String,)>(
        "SELECT rule_json FROM ai_skills WHERE active = 1"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;
    let existing_rules: Vec<String> = existing.into_iter().map(|(r,)| r).collect();

    // 3. Ask AI to discover patterns and generate rules
    let behavior_text = behavior.iter()
        .map(|(sender, action, count)| format!("  {} → {} ({} veces)", sender, action, count))
        .collect::<Vec<_>>().join("\n");

    let existing_text = if existing_rules.is_empty() {
        "Ninguna regla existente.".to_string()
    } else {
        existing_rules.join("\n")
    };

    let prompt = format!(
        r#"Analiza estos patrones de comportamiento de correo y genera reglas inteligentes.

COMPORTAMIENTO DEL USUARIO:
{}

REGLAS YA EXISTENTES (NO duplicar):
{}

Genera 1-3 reglas nuevas basadas en los patrones. Cada regla DEBE ser JSON válido.
Responde SOLO con un array JSON, sin explicación:

[
  {{
    "skill_type": "sender_rule|keyword_rule|time_rule",
    "description": "frase corta explicando la regla",
    "rule_json": "{{"match\":\"sender_contains\",\"value\":\"...\",\"action\":\"high|medium|low\"}}",
    "confidence": 0.6
  }}
]

Reglas inteligentes posibles:
- Si user siempre abre correos de X → sender_rule: marcar X como high
- Si user ignora correos de Y → sender_rule: marcar Y como low
- Si user responde rápido a Z → sender_rule: Z es VIP, high + notify"#,
        behavior_text, existing_text
    );

    let request = AiRequest {
        prompt,
        system_prompt: Some("Eres un motor de auto-mejora para un agente de correo. Genera SOLO JSON.".to_string()),
        endpoint, api_key, model,
        context: None,
    };

    match crate::ai::call_ai(&request).await {
        Ok(text) => {
            let clean = text.trim()
                .trim_start_matches("```json")
                .trim_start_matches("```")
                .trim_end_matches("```")
                .trim();

            if let Ok(skills) = serde_json::from_str::<Vec<serde_json::Value>>(clean) {
                let now = chrono::Utc::now().to_rfc3339();
                for skill in skills {
                    let id = format!("skill_{}", chrono::Utc::now().timestamp_millis());
                    let skill_type = skill["skill_type"].as_str().unwrap_or("sender_rule");
                    let description = skill["description"].as_str().unwrap_or("Regla auto-generada");
                    let rule_json = skill["rule_json"].as_str().unwrap_or("{}");
                    let confidence = skill["confidence"].as_f64().unwrap_or(0.5);

                    // Skip if duplicate rule_json
                    if existing_rules.contains(&rule_json.to_string()) { continue; }

                    let _ = sqlx::query(
                        "INSERT OR IGNORE INTO ai_skills (id, skill_type, description, rule_json, confidence, times_applied, times_correct, active, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,0,0,1,$6,$7)"
                    )
                    .bind(&id).bind(skill_type).bind(description).bind(rule_json)
                    .bind(confidence).bind(&now).bind(&now)
                    .execute(&state.pool)
                    .await;

                    let msg = format!("✨ Nueva skill: {}", description);
                    log::info!("[SKILLS] {}", msg);
                    created_skills.push(msg);

                    // Small delay for unique IDs
                    tokio::time::sleep(tokio::time::Duration::from_millis(5)).await;
                }
            }
        }
        Err(e) => {
            log::warn!("[SKILLS] AI error generating skills: {}", e);
            return Ok(vec![format!("Error generando skills: {}", e)]);
        }
    }

    if created_skills.is_empty() {
        created_skills.push("No se descubrieron patrones nuevos.".to_string());
    }
    Ok(created_skills)
}

/// 🔄 SELF-EVALUATION: Compare triage predictions vs user actions → adjust confidence.
/// OpenClaw pattern: feedback loop — the agent knows when it was right or wrong.
#[tauri::command]
pub async fn evaluate_skills(app: AppHandle) -> Result<String, String> {
    let state = app.state::<DbState>();

    // Find triage predictions that the user later acted on
    let feedback = sqlx::query_as::<_, (String, String, String)>(
        r#"SELECT t1.email_id, t1.importance, t2.user_action
           FROM ai_triage_log t1
           INNER JOIN ai_triage_log t2 ON t1.email_id = t2.email_id
           WHERE t1.importance IS NOT NULL AND t1.user_action IS NULL
             AND t2.user_action IS NOT NULL
           ORDER BY t1.created_at DESC LIMIT 50"#
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    let mut correct = 0;
    let mut incorrect = 0;

    for (_email_id, importance, action) in &feedback {
        let was_correct = match (importance.as_str(), action.as_str()) {
            ("high", "replied") | ("high", "opened") | ("high", "starred") => true,
            ("low", "ignored") | ("low", "deleted") => true,
            ("medium", "opened") => true,
            ("high", "ignored") | ("high", "deleted") => false,
            ("low", "replied") | ("low", "starred") => false,
            _ => true, // neutral
        };
        if was_correct { correct += 1; } else { incorrect += 1; }
    }

    // Update skill confidence based on overall accuracy
    let accuracy = if correct + incorrect > 0 {
        correct as f64 / (correct + incorrect) as f64
    } else { 0.5 };

    // Boost confidence of all active skills proportionally
    let now = chrono::Utc::now().to_rfc3339();
    let _ = sqlx::query(
        "UPDATE ai_skills SET confidence = MIN(0.95, confidence + $1), updated_at = $2 WHERE active = 1"
    )
    .bind(if accuracy > 0.7 { 0.05 } else { -0.05 })
    .bind(&now)
    .execute(&state.pool)
    .await;

    // Deactivate skills with very low confidence
    let _ = sqlx::query(
        "UPDATE ai_skills SET active = 0 WHERE confidence < 0.2"
    )
    .execute(&state.pool)
    .await;

    let report = format!(
        "📊 Evaluación: {} correctas, {} incorrectas. Precisión: {:.0}%. Skills ajustados.",
        correct, incorrect, accuracy * 100.0
    );
    log::info!("[SKILLS] {}", report);
    Ok(report)
}

/// Get all active skills (for injection into the triage prompt)
#[tauri::command]
pub async fn get_active_skills(app: AppHandle) -> Result<Vec<AiSkill>, String> {
    let state = app.state::<DbState>();
    let rows = sqlx::query_as::<_, (String, String, String, String, f64, i64, i64, i64, String)>(
        "SELECT id, skill_type, description, rule_json, confidence, times_applied, times_correct, active, created_at FROM ai_skills WHERE active = 1 ORDER BY confidence DESC"
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(rows.into_iter().map(|(id, skill_type, description, rule_json, confidence, times_applied, times_correct, active, created_at)| {
        AiSkill { id, skill_type, description, rule_json, confidence, times_applied, times_correct, active: active == 1, created_at }
    }).collect())
}

/// Toggle a skill on/off (user can disable bad rules)
#[tauri::command]
pub async fn toggle_skill(app: AppHandle, skill_id: String, active: bool) -> Result<(), String> {
    let state = app.state::<DbState>();
    let now = chrono::Utc::now().to_rfc3339();
    sqlx::query("UPDATE ai_skills SET active = $1, updated_at = $2 WHERE id = $3")
        .bind(if active { 1 } else { 0 })
        .bind(&now)
        .bind(&skill_id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Delete a skill entirely
#[tauri::command]
pub async fn delete_skill(app: AppHandle, skill_id: String) -> Result<(), String> {
    let state = app.state::<DbState>();
    sqlx::query("DELETE FROM ai_skills WHERE id = $1")
        .bind(&skill_id)
        .execute(&state.pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Get skills as context string to inject into the triage prompt
pub async fn get_skills_context(app: &AppHandle) -> String {
    let state = app.state::<DbState>();
    let rows = sqlx::query_as::<_, (String, String, f64)>(
        "SELECT description, rule_json, confidence FROM ai_skills WHERE active = 1 AND confidence > 0.4 ORDER BY confidence DESC LIMIT 10"
    )
    .fetch_all(&state.pool)
    .await
    .unwrap_or_default();

    if rows.is_empty() { return String::new(); }

    let rules: Vec<String> = rows.iter()
        .map(|(desc, rule, conf)| format!("- {} (confianza: {:.0}%) — {}", desc, conf * 100.0, rule))
        .collect();

    format!("\n\nReglas auto-aprendidas (USAR para clasificar):\n{}", rules.join("\n"))
}

/// 🤖 PROACTIVE DRAFT: Auto-suggest a reply draft for high-importance VIP emails.
/// OpenClaw pattern: the agent acts autonomously, not just classifies.
#[tauri::command]
pub async fn proactive_draft(
    app: AppHandle,
    email_id: String,
    sender: String,
    subject: String,
    body: String,
) -> Result<String, String> {
    let (endpoint, api_key, model) = get_ai_config(&app).await;

    let prompt = format!(
        r#"Genera una respuesta profesional y breve para este correo:

De: {}
Asunto: {}
Contenido: {}

Instrucciones:
- Responde en el mismo idioma del correo
- Sé profesional pero amigable
- Máximo 3-4 oraciones
- Solo el texto de la respuesta, sin "Estimado/a" ni firma"#,
        sender, subject, &body[..body.len().min(500)]
    );

    let request = AiRequest {
        prompt,
        system_prompt: Some("Eres un asistente de correo profesional. Genera solo el texto de respuesta.".to_string()),
        endpoint, api_key, model,
        context: None,
    };

    crate::ai::call_ai(&request).await
}

/// 🧠 FULL SELF-IMPROVEMENT CYCLE: Called periodically to evolve the agent.
/// 1. Evaluate past predictions → adjust confidence
/// 2. Discover new patterns → generate skills
/// 3. Deactivate bad skills
pub async fn run_self_improvement_cycle(app: &AppHandle) {
    log::info!("[SKILLS] 🔄 Starting self-improvement cycle...");

    // Step 1: Evaluate accuracy
    let state = app.state::<DbState>();
    let count = sqlx::query_as::<_, (i64,)>(
        "SELECT COUNT(*) FROM ai_triage_log WHERE user_action IS NOT NULL"
    )
    .fetch_one(&state.pool)
    .await
    .unwrap_or((0,));

    if count.0 < 5 {
        log::info!("[SKILLS] Not enough data for self-improvement (need 5+ interactions, have {})", count.0);
        return;
    }

    // Step 2: Evaluate existing skills
    evaluate_skills(app.clone()).await.ok();

    // Step 3: Generate new skills
    generate_skills(app.clone()).await.ok();

    log::info!("[SKILLS] ✅ Self-improvement cycle complete");
}
