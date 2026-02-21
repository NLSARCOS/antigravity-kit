use serde::{Deserialize, Serialize};

#[derive(Deserialize, Clone)]
pub struct AiRequest {
    pub prompt: String,
    pub model: Option<String>,
    pub system_prompt: Option<String>,
    pub endpoint: Option<String>,
    pub api_key: Option<String>,
    // extra context injected before user prompt (for triage, chatbot etc.)
    #[serde(skip_deserializing)]
    pub context: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
struct ChatMessage {
    role: String,
    content: String,
}

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<ChatMessage>,
}

#[derive(Deserialize, Debug)]
struct ChatCompletionChoice {
    message: ChatMessage,
}

#[derive(Deserialize, Debug)]
struct ChatCompletionResponse {
    choices: Vec<ChatCompletionChoice>,
}

#[derive(Serialize)]
pub struct AiResponse {
    pub text: String,
    pub error: Option<String>,
}

const DEFAULT_LLM_URL: &str = "http://127.0.0.1:8045/v1/chat/completions";

#[tauri::command]
pub async fn ai_generate(request: AiRequest) -> Result<AiResponse, String> {
    let model = request.model.unwrap_or_else(|| "default".to_string());
    let endpoint = request.endpoint.unwrap_or_else(|| DEFAULT_LLM_URL.to_string());
    let api_key = request.api_key.unwrap_or_default();

    log::info!("AI request to {}, model: {}", endpoint, model);

    let system = request.system_prompt.unwrap_or_else(|| {
        "You are a helpful email assistant. Be concise and clear.".to_string()
    });

    let body = ChatCompletionRequest {
        model,
        messages: vec![
            ChatMessage {
                role: "system".to_string(),
                content: system,
            },
            ChatMessage {
                role: "user".to_string(),
                content: request.prompt,
            },
        ],
    };

    let client = reqwest::Client::new();
    let mut req = client.post(&endpoint).json(&body);
    
    if !api_key.is_empty() {
        req = req.header("Authorization", format!("Bearer {}", api_key));
    }

    let response = req
        .send()
        .await
        .map_err(|e| format!("LLM request failed: {}. Check your endpoint in Settings.", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        return Err(format!("LLM returned {}: {}", status, text));
    }

    let parsed: ChatCompletionResponse = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse LLM response: {}", e))?;

    let text = parsed
        .choices
        .first()
        .map(|c| c.message.content.clone())
        .unwrap_or_else(|| "No response from AI".to_string());

    Ok(AiResponse {
        text,
        error: None,
    })
}

/// Public helper for internal (non-command) AI calls (e.g. triage agent)
pub async fn call_ai(request: &AiRequest) -> Result<String, String> {
    let result = ai_generate(request.clone()).await?;
    Ok(result.text)
}
