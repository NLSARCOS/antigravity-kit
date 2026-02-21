use tauri::Manager;

pub mod db;
pub mod imap;
pub mod smtp;
pub mod ai;
pub mod imap_idle;
pub mod ai_triage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      #[cfg(debug_assertions)]
      {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let window = app.get_webview_window("main").unwrap();

      #[cfg(target_os = "macos")]
      window_vibrancy::apply_vibrancy(&window, window_vibrancy::NSVisualEffectMaterial::HudWindow, None, None)
        .expect("Unsupported platform! 'apply_vibrancy' is only supported on macOS");

      #[cfg(target_os = "windows")]
      window_vibrancy::apply_blur(&window, Some((18, 18, 18, 125)))
        .expect("Unsupported platform! 'apply_blur' is only supported on Windows");
      
      let handle = app.handle().clone();
      tauri::async_runtime::block_on(async move {
          match db::init_db(&handle).await {
              Ok(pool) => {
                  handle.manage(db::DbState { pool });
                  log::info!("Database initialized successfully");
                  // 🚀 Start IMAP IDLE real-time push watcher in background
                  imap_idle::start_idle_task(handle.clone());
              },
              Err(e) => {
                  log::error!("Failed to initialize database: {}", e);
              }
          }
      });
      
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        db::save_account,
        db::get_accounts,
        db::get_emails,
        db::save_ai_metadata,
        db::save_ai_prompt_history,
        db::get_ai_prompt_history,
        db::delete_email,
        db::save_ai_config,
        imap::sync_emails,
        imap::save_draft,
        smtp::send_email,
        ai::ai_generate,
        // 🧠 Autonomous triage engine
        ai_triage::record_user_action,
        ai_triage::get_email_importance,
        ai_triage::get_importance_map,
        ai_triage::get_vip_senders,
        ai_triage::add_vip_sender,
        ai_triage::save_conversation_summary,
        ai_triage::get_conversation_summary,
        // 🧠 Self-improving skills engine
        ai_triage::generate_skills,
        ai_triage::evaluate_skills,
        ai_triage::get_active_skills,
        ai_triage::toggle_skill,
        ai_triage::delete_skill,
        ai_triage::proactive_draft,
        ai_triage::trigger_triage,
        imap::imap_delete_email,
        imap::imap_bulk_delete,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
