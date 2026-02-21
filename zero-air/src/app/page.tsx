"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Maximize2, Minimize2, MoreHorizontal, MessageSquare, Send, Inbox, FileText, Reply, Sparkles, Wand2, Archive, Trash2, ShieldAlert, LayoutDashboard, Settings, User, AlertCircle, RefreshCw, XCircle, Search, CornerUpLeft, ThumbsDown, Loader2, Paperclip, MessageSquareText, Mail, X, PenSquare, BrainCircuit, RotateCw, History, BarChart3, Eye, EyeOff } from "lucide-react";

type ViewState = 'onboarding' | 'inbox' | 'settings' | 'compose' | 'assistant';
type FolderType = 'INBOX' | 'Sent' | 'Drafts' | 'Archive' | 'Trash';

interface EmailItem {
  id: string;
  uid: number;
  subject: string;
  sender: string;
  sender_email?: string;
  to_email?: string;
  date: string;
  snippet: string;
  body: string;
  folder: string;
  read?: boolean;
  is_html?: boolean;
  priority?: string;
  ai_priority?: string;
  ai_labels?: string;
  ai_summary?: string;
}

interface AccountData {
  id: string;
  full_name?: string;
  email: string;
  password?: string;
  imap_host?: string;
  imap_port?: number;
  smtp_host?: string;
  smtp_port?: number;
}

function SidebarItem({ icon, label, badge, active, onClick }: { icon: React.ReactNode; label: string; badge?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all ${active
        ? 'bg-primary/10 text-primary'
        : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
        }`}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {badge && (
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}>
          {badge}
        </span>
      )}
    </button>
  );
}

export default function MailApp() {
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<ViewState>(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('zero_onboarding_done')) return 'inbox';
    return 'onboarding';
  });
  const [currentFolder, setCurrentFolder] = useState<FolderType>('INBOX');
  const [isComposing, setIsComposing] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');
  const [account, setAccount] = useState<AccountData | null>(null);
  const [emails, setEmails] = useState<EmailItem[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [syncError, setSyncError] = useState('');

  // Compose state
  const [composeTo, setComposeTo] = useState('');
  const [composeSubject, setComposeSubject] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [scheduledAt, setScheduledAt] = useState('');
  type ScheduledEmail = { id: string; to: string; subject: string; body: string; sendAt: string; accountId: string };
  const [scheduledEmails, setScheduledEmails] = useState<ScheduledEmail[]>([]);
  // Load scheduled emails from localStorage only on client (avoids SSR hydration mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('zero_scheduled_emails');
      if (saved) setScheduledEmails(JSON.parse(saved));
    } catch { /* ignore */ }
  }, []);

  // AI state
  const [aiSummaryMap, setAiSummaryMap] = useState<Record<string, string>>({});
  const [summaryExpanded, setSummaryExpanded] = useState<Record<string, boolean>>({});
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [isSmartReplying, setIsSmartReplying] = useState(false);
  const [priorityMap, setPriorityMap] = useState<Record<string, string>>({});
  const [labelMap, setLabelMap] = useState<Record<string, string[]>>({});
  const [isCategorizing, setIsCategorizing] = useState(false);
  const [isAgentProcessing, setIsAgentProcessing] = useState(false);
  const [priorityFilter, setPriorityFilter] = useState<string>('todos');
  // 🧠 Autonomous triage: importance from the triage agent (high/medium/low)
  const [importanceMap, setImportanceMap] = useState<Record<string, string>>({});
  // OpenClaw compaction: rolling chat summary
  const [convSummary, setConvSummary] = useState<string>('');
  // 🧠 Self-generated skills from AI
  const [learnedSkills, setLearnedSkills] = useState<any[]>([]);
  const [settingsTab, setSettingsTab] = useState<'cuenta' | 'ia' | 'agente'>('cuenta');

  const [agentPerms, setAgentPerms] = useState({ canArchive: true, canTrash: false, canReply: false });
  const [agentDrafts, setAgentDrafts] = useState<Array<{ id: string; to: string; subject: string; body: string; createdAt: string }>>([]);
  const [agentLog, setAgentLog] = useState<Array<{ action: string; email: string; time: string }>>([]);
  const processedByAgent = useRef<Set<string>>(new Set(typeof window !== 'undefined' ? JSON.parse(localStorage.getItem('zero_agent_processed') || '[]') : []));
  const handleSyncRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'ai'; text: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatOpen, setChatOpen] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [draftEmailIds, setDraftEmailIds] = useState<Set<string>>(new Set());
  const [composeContext, setComposeContext] = useState<string | null>(null); // AI context summary for compose
  const [readEmails, setReadEmails] = useState<Set<string>>(new Set());
  const [isLearning, setIsLearning] = useState(false);
  const [isRollingBack, setIsRollingBack] = useState(false);

  // AI config (stored in localStorage)
  const [aiEndpoint, setAiEndpoint] = useState('http://127.0.0.1:8045/v1/chat/completions');
  const [aiApiKey, setAiApiKey] = useState('sk-2462fe963e7c42f3864242a467d3e426');
  const [aiModel, setAiModel] = useState('gemini-3-flash');
  const [aiInstructions, setAiInstructions] = useState('');
  const [triageStatus, setTriageStatus] = useState<{ total: number; processed: number; status: string; current_subject?: string } | null>(null);

  // Load AI config from localStorage on mount
  useEffect(() => {
    const saved = localStorage.getItem('zero_ai_config');
    if (saved) {
      try {
        const cfg = JSON.parse(saved);
        if (cfg.endpoint) setAiEndpoint(cfg.endpoint);
        if (cfg.apiKey) setAiApiKey(cfg.apiKey);
        if (cfg.model && cfg.model !== 'default') setAiModel(cfg.model);
        if (cfg.instructions) setAiInstructions(cfg.instructions);
        if (cfg.labels) setLabelMap(cfg.labels);
        if (cfg.summaries) setAiSummaryMap(cfg.summaries);
        if (cfg.perms) setAgentPerms(prev => ({ ...prev, ...cfg.perms }));
        if (cfg.aiEnabled !== undefined) setAiEnabled(cfg.aiEnabled);
      } catch { }
    }
    // Sync AI config to backend DB so triage uses the correct model/endpoint
    invoke('save_ai_config', {
      endpoint: 'http://127.0.0.1:8045/v1/chat/completions',
      apiKey: 'sk-2462fe963e7c42f3864242a467d3e426',
      model: 'gemini-3-flash',
    }).catch(() => { });
  }, []);

  // -- Load account on mount --
  useEffect(() => {
    async function checkAccounts() {
      try {
        const accounts = await invoke("get_accounts") as AccountData[];
        if (accounts && accounts.length > 0) {
          setAccount(accounts[0]);
          setCurrentView('inbox');
          localStorage.setItem('zero_onboarding_done', '1');
        } else {
          setCurrentView('onboarding');
        }
      } catch (e) {
        console.error("Failed to load accounts:", e);
      }
    }
    checkAccounts();
  }, []);

  // Load read emails from localStorage (client-only, avoids hydration mismatch)
  useEffect(() => {
    try {
      const saved = localStorage.getItem('zero_read_emails');
      if (saved) setReadEmails(new Set(JSON.parse(saved)));
    } catch { }
  }, []);

  const handleAiLearnMode = async () => {
    setIsLearning(true);
    setStatusMsg("🧠 Analizando correos enviados para aprender tu estilo...");
    try {
      // Get recent Sent emails from DB
      const sentEmails = await invoke("get_emails", { accountId: account?.id, folder: "Sent" }) as EmailItem[];
      // We only want emails sent by ME (not strictly necessary to filter since it's the Sent folder, but good to be sure)
      const recentSent = sentEmails.slice(0, 10).map(e => `Asunto: ${e.subject}\nCuerpo: ${e.body}`).join('\n\n---\n\n');

      if (!recentSent) {
        setStatusMsg("❌ No hay suficientes correos enviados para aprender.");
        setIsLearning(false);
        return;
      }

      const prompt = `Aquí están mis últimos correos enviados:\n\n${recentSent}\n\nInstrucciones actuales de la IA:\n"${aiInstructions}"\n\nAnaliza mi tono, vocabulario, formalidad y cómo respondo a los correos. Reescribe mis "Instrucciones de la IA" para que un agente pueda imitar mi estilo perfectamente al redactar borradores. \n\nResponde ÚNICAMENTE con el nuevo texto de las instrucciones, sin introducciones ni comillas extra. Mantén los comandos de acción que ya existen, pero añade las reglas de estilo de redacción.`;

      const result = await invoke("ai_generate", {
        request: {
          prompt,
          system_prompt: "Eres un experto en análisis de personalidad y estilo de redacción. Extrae patrones lingüísticos y crea instrucciones de sistema.",
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };

      const newInstructions = result.text.trim();

      // Save current instructions to history
      try {
        await invoke("save_ai_prompt_history", { promptText: aiInstructions });
      } catch (e) { console.error("Could not save history", e) }

      // Apply new instructions
      setAiInstructions(newInstructions);

      const saved = localStorage.getItem('zero_ai_config');
      const existing = saved ? JSON.parse(saved) : {};
      localStorage.setItem('zero_ai_config', JSON.stringify({
        ...existing,
        instructions: newInstructions,
        perms: agentPerms,
      }));

      setStatusMsg("✅ ¡Aprendizaje completado! Instrucciones actualizadas.");
    } catch (e: any) {
      setStatusMsg(`❌ Error en el aprendizaje: ${e}`);
    } finally {
      setIsLearning(false);
    }
  };

  const handleAiRollback = async () => {
    setIsRollingBack(true);
    setStatusMsg("🔄 Revertiendo instrucciones...");
    try {
      const history = await invoke("get_ai_prompt_history") as any[];
      if (history && history.length > 0) {
        // Find the most recent distinct prompt
        const previous = history.find(h => h.prompt_text !== aiInstructions);
        if (previous) {
          setAiInstructions(previous.prompt_text);
          // Auto save
          const saved = localStorage.getItem('zero_ai_config');
          const existing = saved ? JSON.parse(saved) : {};
          localStorage.setItem('zero_ai_config', JSON.stringify({
            ...existing,
            instructions: previous.prompt_text,
          }));
          setStatusMsg("✅ Instrucciones revertidas a la versión anterior.");
        } else {
          setStatusMsg("ℹ️ No se encontró un prompt anterior distinto.");
        }
      } else {
        setStatusMsg("ℹ️ No hay historial de aprendizaje.");
      }
    } catch (e) {
      setStatusMsg("❌ Error leyendo el historial.");
    } finally {
      setIsRollingBack(false);
    }
  };

  // -- Fetch emails from local DB --
  const loadEmails = useCallback(async (folder: string) => {
    if (!account) return;
    try {
      const result = await invoke("get_emails", { accountId: account.id, folder }) as EmailItem[];
      setEmails(result || []);

      // Populate AI Maps from DB (this restores AI decisions after app restart)
      if (result && result.length > 0) {
        setPriorityMap(prev => {
          const next = { ...prev };
          result.forEach(e => { if (e.ai_priority) next[e.id] = e.ai_priority; });
          return next;
        });
        setLabelMap(prev => {
          const next = { ...prev };
          result.forEach(e => {
            if (e.ai_labels) {
              try { next[e.id] = JSON.parse(e.ai_labels); } catch { }
            }
          });
          return next;
        });
        setAiSummaryMap(prev => {
          const next = { ...prev };
          result.forEach(e => { if (e.ai_summary) next[e.id] = e.ai_summary; });
          return next;
        });
      }
    } catch (e) {
      console.error("Failed to load emails:", e);
    }
  }, [account]);

  // Load emails when account or folder changes
  useEffect(() => {
    if (account && currentView === 'inbox') {
      loadEmails(currentFolder);
    }
  }, [account, currentFolder, currentView, loadEmails]);

  // -- Sync from IMAP server --
  const handleSync = async () => {
    if (!account) return;
    setIsSyncing(true);
    setSyncError('');
    try {
      await invoke("sync_emails", { accountId: account.id, folder: currentFolder });
      await loadEmails(currentFolder);
      setSyncError('');
      setStatusMsg("");
      // Auto-run AI agent after sync if enabled, instructions exist, AND we're syncing INBOX
      // 5-minute cooldown to prevent excessive API calls
      if (currentFolder === 'INBOX') {
        // 🧠 Trigger triage on INBOX emails
        invoke('trigger_triage', { accountId: account.id }).catch(() => { });

        const lastAgent = parseInt(localStorage.getItem('zero_last_agent_run') || '0');
        const now = Date.now();
        const AGENT_COOLDOWN = 5 * 60 * 1000; // 5 minutes
        if (now - lastAgent > AGENT_COOLDOWN) {
          setTimeout(() => {
            const saved = localStorage.getItem('zero_ai_config');
            if (saved) {
              try {
                const cfg = JSON.parse(saved);
                const isEnabled = cfg.aiEnabled !== false;
                if (isEnabled && cfg.instructions && cfg.instructions.trim()) {
                  localStorage.setItem('zero_last_agent_run', Date.now().toString());
                  handleAiAgent();

                  // Silent Auto-Learning Check (Runs only once every 24 hours)
                  const lastLearn = localStorage.getItem('zero_last_ai_learn');
                  const nowInner = Date.now();
                  if (!lastLearn || nowInner - parseInt(lastLearn) > 24 * 60 * 60 * 1000) {
                    console.log("Triggering scheduled background AI learning...");
                    localStorage.setItem('zero_last_ai_learn', nowInner.toString());
                    handleAiLearnMode().catch(console.error);
                  }
                }
              } catch { }
            }
          }, 500);
        }
      }
    } catch (e: any) {
      const errMsg = String(e);
      const isTransient = errMsg.includes('lookup address') || errMsg.includes('connect error') || errMsg.includes('timed out') || errMsg.includes('Connection refused');
      // If we already have emails loaded, transient errors are just retry noise → auto-dismiss
      if (isTransient && emails.length > 0) {
        console.warn('[Sync] Transient error (auto-dismissed):', errMsg);
        setStatusMsg('⚠️ Reconectando…');
        setTimeout(() => setStatusMsg(''), 3000);
      } else {
        setSyncError(errMsg);
        setStatusMsg(`Sync error: ${errMsg}`);
      }
    } finally {
      setIsSyncing(false);
    }
  };
  handleSyncRef.current = handleSync;

  // Auto-sync on first load + 90s fallback poll + IMAP IDLE real-time push
  useEffect(() => {
    if (!account || currentView !== 'inbox') return;

    // Initial sync on mount
    handleSyncRef.current?.();

    // Load importance map from triage DB
    invoke<[string, string][]>('get_importance_map', { accountId: account.id })
      .then((rows) => {
        const map: Record<string, string> = {};
        rows.forEach(([id, imp]) => { map[id] = imp; });
        setImportanceMap(map);
      }).catch(() => { });

    // Load rolling conversation summary (OpenClaw compaction)
    invoke<string | null>('get_conversation_summary', { accountId: account.id })
      .then((s) => { if (s) setConvSummary(s); })
      .catch(() => { });

    // Load learned AI skills
    invoke<any[]>('get_active_skills')
      .then((skills) => setLearnedSkills(skills))
      .catch(() => { });

    // Fallback: poll every 90s in case IDLE connection drops
    const interval = setInterval(() => {
      handleSyncRef.current?.();
    }, 90_000);

    // 🚀 Listen to IMAP IDLE push events from Rust backend
    let unlisten: (() => void) | undefined;
    let unlistenClassified: (() => void) | undefined;
    let unlistenImportant: (() => void) | undefined;

    listen<{ account_id: string; folder: string }>('new-mail', (event) => {
      if (event.payload.folder === 'INBOX' && currentFolder === 'INBOX') {
        handleSyncRef.current?.();
      }
    }).then((fn) => { unlisten = fn; });

    // 🧠 Triage: update importance badge when backend classifies an email
    listen<{ email_id: string; importance: string; reason: string }>('email-classified', (event) => {
      const { email_id, importance } = event.payload;
      setImportanceMap(prev => ({ ...prev, [email_id]: importance }));
    }).then((fn) => { unlistenClassified = fn; });

    // 🔔 High-priority: show a native-style alert for important emails
    listen<{ sender: string; subject: string; importance: string }>('important-mail', (event) => {
      const { sender, subject } = event.payload;
      setStatusMsg(`🔴 Correo importante de ${sender}: "${subject}"`);
      setTimeout(() => setStatusMsg(''), 8000);
    }).then((fn) => { unlistenImportant = fn; });

    // 🧠 Triage progress: show processing indicator
    let unlistenTriageProgress: (() => void) | undefined;
    listen<{ total: number; processed: number; status: string; current_subject?: string }>('triage-progress', (event) => {
      const p = event.payload;
      if (p.status === 'done') {
        setTriageStatus(null);
        // Refresh importance map after triage completes
        invoke<[string, string][]>('get_importance_map', { accountId: account.id })
          .then((rows) => {
            const map: Record<string, string> = {};
            rows.forEach(([id, imp]) => { map[id] = imp; });
            setImportanceMap(map);
          }).catch(() => { });
      } else {
        setTriageStatus(p);
      }
    }).then((fn) => { unlistenTriageProgress = fn; });

    // ✍️ Proactive drafts: auto-generated drafts for urgent emails
    let unlistenProactiveDraft: (() => void) | undefined;
    listen<{ email_id: string; to: string; subject: string; body: string; sender: string }>('proactive-draft', (event) => {
      const d = event.payload;
      const newDraft = {
        id: `draft_${Date.now()}`,
        to: d.to,
        subject: d.subject,
        body: d.body,
        createdAt: new Date().toISOString(),
      };
      setAgentDrafts(prev => [newDraft, ...prev]);
      setStatusMsg(`✍️ Borrador generado para "${d.sender}": ${d.subject}`);
      setTimeout(() => setStatusMsg(''), 6000);
    }).then((fn) => { unlistenProactiveDraft = fn; });

    return () => {
      clearInterval(interval);
      unlisten?.();
      unlistenClassified?.();
      unlistenImportant?.();
      unlistenTriageProgress?.();
      unlistenProactiveDraft?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  // -- Send email --
  const handleSendEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!account) return;
    setIsSending(true);
    try {
      if (scheduledAt) {
        // --- SCHEDULED SEND ---
        const schedId = `sched_${Date.now()}`;
        const newScheduled = {
          id: schedId,
          to: composeTo,
          subject: composeSubject,
          body: composeBody,
          sendAt: scheduledAt,
          accountId: account.id,
        };
        const updated = [...scheduledEmails, newScheduled];
        setScheduledEmails(updated);
        localStorage.setItem('zero_scheduled_emails', JSON.stringify(updated));

        // Insert a virtual row in the local DB so it shows up in Sent immediately
        // Body prefix "SCHEDULED:" lets the poller and badge logic identify it
        await invoke("save_draft", {
          accountId: account.id,
          to: composeTo,
          subject: `[Programado] ${composeSubject}`,
          body: `SCHEDULED:${scheduledAt}\n\n${composeBody}`,
        }).catch(() => {/* non-critical */ });

        // Also inject directly into emails state for instant UI update
        const now = new Date().toISOString();
        setEmails(prev => [{
          id: schedId,
          uid: 0,
          account_id: account.id,
          folder: 'Sent',
          subject: composeSubject,
          sender: account.full_name || account.email,
          sender_email: account.email,
          date: now,
          snippet: `📅 Programado para ${new Date(scheduledAt).toLocaleString('es', { dateStyle: 'short', timeStyle: 'short' })}`,
          body: composeBody,
          read: true,
        }, ...prev]);

        setStatusMsg(`✅ Correo programado para el ${new Date(scheduledAt).toLocaleString('es', { dateStyle: 'medium', timeStyle: 'short' })}`);
        setIsComposing(false);
        setComposeTo(''); setComposeSubject(''); setComposeBody(''); setAttachments([]); setScheduledAt('');
      } else {
        // --- IMMEDIATE SEND ---
        await invoke("send_email", {
          accountId: account.id,
          to: composeTo, subject: composeSubject, body: composeBody,
          attachments: null,
        });
        // 🧠 Learning: record reply → auto-promotes recipient to VIP sender
        invoke('record_user_action', {
          emailId: selectedMail || 'compose',
          action: 'replied',
          senderEmail: composeTo,
        }).catch(() => { });
        setStatusMsg("✅ Correo enviado!");
        // Remove matching agent drafts (sent = no longer a draft)
        setAgentDrafts(prev => prev.filter(d => d.to !== composeTo || d.subject !== composeSubject));
        setIsComposing(false);
        setComposeTo(''); setComposeSubject(''); setComposeBody(''); setAttachments([]); setScheduledAt('');
        await handleSync();
        await loadEmails(currentFolder);
      }
    } catch (e: any) {
      setStatusMsg(`Send error: ${e}`);
    } finally {
      setIsSending(false);
    }
  };

  // -- Scheduled email poller (checks every 30s if any queued email is due) --
  useEffect(() => {
    const interval = setInterval(async () => {
      const now = Date.now();
      const pending = scheduledEmails.filter(e => new Date(e.sendAt).getTime() <= now);
      if (pending.length === 0 || !account) return;

      for (const email of pending) {
        try {
          await invoke("send_email", {
            accountId: email.accountId, to: email.to, subject: email.subject, body: email.body, attachments: null,
          });
        } catch (err) { console.error("Scheduled send failed:", err); }
      }
      // Remove sent ones from queue
      const remaining = scheduledEmails.filter(e => new Date(e.sendAt).getTime() > now);
      setScheduledEmails(remaining);
      localStorage.setItem('zero_scheduled_emails', JSON.stringify(remaining));
      if (pending.length > 0) { await handleSync(); }
    }, 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduledEmails, account]);

  // -- AI: Summarize email --
  const handleAiSummarize = async () => {
    const email = emails.find(e => e.id === selectedMail);
    if (!email) return;
    setIsAiLoading(true);
    setAiSummaryMap(prev => ({ ...prev, [email.id]: '' }));
    try {
      const result = await invoke("ai_generate", {
        request: {
          prompt: `Resume este correo electrónico de forma concisa en 2-3 oraciones en español:\n\nAsunto: ${email.subject}\nDe: ${email.sender}\n\n${email.snippet || email.body}`,
          system_prompt: "Eres un asistente de correo electrónico. Responde SIEMPRE en español. Solo genera el resumen, sin encabezados ni etiquetas.",
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };
      setAiSummaryMap(prev => {
        const updated = { ...prev, [email.id]: result.text };

        // Persist to DB
        invoke("save_ai_metadata", {
          emailId: email.id,
          aiPriority: priorityMap[email.id] || null,
          aiLabels: labelMap[email.id] ? JSON.stringify(labelMap[email.id]) : null,
          aiSummary: result.text
        }).catch(e => console.error(e));

        // Persist to localStorage
        try {
          const saved = localStorage.getItem('zero_ai_config');
          const cfg = saved ? JSON.parse(saved) : {};
          cfg.summaries = updated;
          localStorage.setItem('zero_ai_config', JSON.stringify(cfg));
        } catch { }
        return updated;
      });
      setSummaryExpanded(prev => ({ ...prev, [email.id]: true }));
    } catch (e: any) {
      setAiSummaryMap(prev => ({ ...prev, [email.id]: `Error de IA: ${e}` }));
    } finally {
      setIsAiLoading(false);
    }
  };

  // -- AI: Smart Reply --
  const handleSmartReply = async () => {
    const email = emails.find(e => e.id === selectedMail);
    if (!email) return;
    setIsSmartReplying(true);
    try {
      const result = await invoke("ai_generate", {
        request: {
          prompt: `Escribe una respuesta profesional y amigable a este correo en español:\n\nAsunto: ${email.subject}\nDe: ${email.sender}\n\n${email.snippet || email.body}`,
          system_prompt: "Eres un asistente de correo electrónico. Responde SIEMPRE en español. Escribe solo el cuerpo de la respuesta, sin línea de asunto ni encabezados. Sé conciso y profesional.",
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };
      setComposeTo(email.sender_email || email.sender || '');
      setComposeSubject(`Re: ${email.subject || ''}`);
      setComposeBody(result.text);
      setComposeContext(`🤖 **Respuesta IA** para correo de **${email.sender}**\n• Asunto: ${email.subject}\n• Contenido: "${(email.snippet || email.body || '').replace(/<[^>]*>/g, '').slice(0, 150)}..."\n• La IA generó esta respuesta automáticamente. Revísala antes de enviar.`);
      setIsComposing(true);
    } catch (e: any) {
      setStatusMsg(`Error de IA: ${e}`);
    } finally {
      setIsSmartReplying(false);
    }
  };

  // -- AI: Auto-categorize emails by priority --
  const handleAutoCategorize = async () => {
    if (emails.length === 0 || isCategorizing) return;
    setIsCategorizing(true);
    try {
      const emailList = emails.slice(0, 10).map(e => `- ID: ${e.id} | Asunto: ${e.subject} | De: ${e.sender} | Fragmento: ${e.snippet?.slice(0, 80)}`).join('\n');
      const result = await invoke("ai_generate", {
        request: {
          prompt: `Clasifica cada correo por prioridad. Responde SOLO con líneas en formato: ID|PRIORIDAD\nDonde PRIORIDAD es: urgente, normal, o bajo.\n\nCorreos:\n${emailList}`,
          system_prompt: "Eres un clasificador de correos. Responde SOLO con el formato solicitado, una línea por correo. No agregues explicaciones.",
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };
      const newMap: Record<string, string> = {};
      result.text.split('\n').forEach(line => {
        const parts = line.split('|').map(s => s.trim());
        if (parts.length >= 2) {
          const id = parts[0];
          const priority = parts[1].toLowerCase();
          if (['urgente', 'normal', 'bajo'].includes(priority)) {
            newMap[id] = priority;
          }
        }
      });
      setPriorityMap(prev => ({ ...prev, ...newMap }));
      setStatusMsg(`${Object.keys(newMap).length} correos clasificados por IA`);
    } catch (e: any) {
      setStatusMsg(`Error de categorización: ${e}`);
    } finally {
      setIsCategorizing(false);
    }
  };

  // -- AI Agent: Autonomous email processor --
  const handleAiAgent = async () => {
    if (emails.length === 0 || isAgentProcessing || !aiInstructions.trim()) {
      if (!aiInstructions.trim()) setStatusMsg('⚠️ Configura las instrucciones del agente en Configuración > Agente IA');
      return;
    }
    setIsAgentProcessing(true);
    // Filter to only new/unprocessed emails
    const unprocessed = emails.filter(e => !processedByAgent.current.has(e.id));
    if (unprocessed.length === 0) {
      setIsAgentProcessing(false);
      return;
    }
    setStatusMsg(`🤖 Agente IA analizando ${unprocessed.length} correos nuevos...`);
    try {
      const emailList = unprocessed.slice(0, 15).map(e =>
        `{"id":"${e.id}","asunto":"${(e.subject || '').replace(/"/g, '\\"').slice(0, 80)}","de":"${(e.sender || '').replace(/"/g, '\\"')}","email_de":"${(e.sender_email || '').replace(/"/g, '\\"')}","fragmento":"${(e.snippet || '').slice(0, 120).replace(/"/g, '\\"')}"}`
      ).join(',\n');

      const permsDesc = [
        'etiquetar (siempre permitido)',
        agentPerms.canArchive ? 'archivar (permitido)' : 'archivar (NO permitido)',
        agentPerms.canTrash ? 'borrar (permitido)' : 'borrar (NO permitido)',
        agentPerms.canReply ? 'responder (permitido, necesita aprobación)' : 'responder (NO permitido)',
      ].join(', ');

      const result = await invoke("ai_generate", {
        request: {
          prompt: `Eres mi agente autónomo de correo electrónico. Mis instrucciones:\n\n"${aiInstructions}"\n\nPermisos: ${permsDesc}\n\nCorreos:\n[${emailList}]\n\nAnaliza cada correo y decide qué acciones tomar. Responde SOLO con un JSON array. Cada elemento:\n- "id": ID del correo\n- "prioridad": "urgente" | "normal" | "bajo"\n- "etiquetas": ["etiqueta1", "etiqueta2"]\n- "acciones": array de objetos de acción. Tipos posibles:\n  - {"tipo":"archivar"} → mover a archivo\n  - {"tipo":"borrar"} → mover a papelera\n  - {"tipo":"responder","para":"email@dest.com","asunto":"Re: ...","cuerpo":"texto de respuesta"}\n  - {"tipo":"nada"} → no hacer nada extra\n\nReglas:\n- Solo usa acciones que tengas PERMITIDO\n- Para "responder", escribe el cuerpo completo en español\n- Sé inteligente: no archives correos importantes, no respondas spam\n- Si no estás seguro, usa {"tipo":"nada"}\n\nEjemplo:\n[{"id":"abc","prioridad":"urgente","etiquetas":["cliente"],"acciones":[{"tipo":"nada"}]},{"id":"def","prioridad":"bajo","etiquetas":["spam"],"acciones":[{"tipo":"archivar"}]}]\n\nSOLO JSON, sin explicaciones.`,
          system_prompt: "Eres un agente autónomo de correo. Responde SOLO con JSON válido. No uses markdown. Piensa cuidadosamente qué acciones tomar.",
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };

      let cleaned = result.text.trim();
      cleaned = cleaned.replace(/```json?\s*/gi, '').replace(/```/g, '').trim();

      const parsed = JSON.parse(cleaned) as Array<{
        id: string;
        prioridad: string;
        etiquetas: string[];
        acciones: Array<{ tipo: string; para?: string; asunto?: string; cuerpo?: string }>;
      }>;

      const newPriority: Record<string, string> = {};
      const newLabels: Record<string, string[]> = {};
      const newLog: Array<{ action: string; email: string; time: string }> = [];
      const now = new Date().toLocaleTimeString('es');

      for (const item of parsed) {
        const emailRef = emails.find(e => e.id === item.id);
        const emailLabel = emailRef?.subject?.slice(0, 40) || item.id;

        if (item.prioridad) newPriority[item.id] = item.prioridad;
        if (item.etiquetas?.length) newLabels[item.id] = item.etiquetas;

        newLog.push({ action: `📋 Clasificado: ${item.prioridad} [${(item.etiquetas || []).join(', ')}]`, email: emailLabel, time: now });

        for (const action of (item.acciones || [])) {
          if (action.tipo === 'archivar' && agentPerms.canArchive) {
            try {
              await invoke("delete_email", { emailId: item.id }); // archive = remove from inbox
              setEmails(prev => prev.filter(e => e.id !== item.id));
              newLog.push({ action: '📦 Archivado', email: emailLabel, time: now });
            } catch { }
          } else if (action.tipo === 'borrar' && agentPerms.canTrash) {
            try {
              await invoke("delete_email", { emailId: item.id });
              setEmails(prev => prev.filter(e => e.id !== item.id));
              newLog.push({ action: '🗑️ Eliminado', email: emailLabel, time: now });
            } catch { }
          } else if (action.tipo === 'responder' && agentPerms.canReply && action.para && action.cuerpo) {
            try {
              await invoke("save_draft", {
                accountId: account?.id,
                to: action.para,
                subject: action.asunto || `Re: ${emailRef?.subject || ''}`,
                body: action.cuerpo,
              });
              // Track that this email has a draft
              setDraftEmailIds(prev => {
                const next = new Set(prev);
                next.add(item.id);
                return next;
              });
              newLog.push({ action: '✏️ Borrador guardado en Drafts', email: emailLabel, time: now });
            } catch (de: any) {
              newLog.push({ action: `❌ Error guardando borrador: ${de}`, email: emailLabel, time: now });
            }
          } else if (action.tipo === 'nada') {
            // No action needed
          }
        }
      }

      setPriorityMap(prev => ({ ...prev, ...newPriority }));
      setLabelMap(prev => ({ ...prev, ...newLabels }));
      setAgentLog(prev => [...newLog, ...prev].slice(0, 50));

      // Persist to DB
      for (const item of parsed) {
        try {
          // Keep existing summary if any
          const existingSummary = aiSummaryMap[item.id] || null;
          invoke("save_ai_metadata", {
            emailId: item.id,
            aiPriority: item.prioridad || null,
            aiLabels: item.etiquetas && item.etiquetas.length > 0 ? JSON.stringify(item.etiquetas) : null,
            aiSummary: existingSummary
          }).catch(e => console.error("Failed to save AI metadata to DB", e));
        } catch { }
      }

      // Persist labels to localStorage for preferences
      const saved = localStorage.getItem('zero_ai_config');
      const cfg = saved ? JSON.parse(saved) : {};
      cfg.labels = { ...cfg.labels, ...newLabels };
      localStorage.setItem('zero_ai_config', JSON.stringify(cfg));

      // Mark as processed
      for (const item of parsed) {
        processedByAgent.current.add(item.id);
        // Persist to localStorage (keep last 200 IDs)
        const ids = [...processedByAgent.current].slice(-200);
        localStorage.setItem('zero_agent_processed', JSON.stringify(ids));
      }

      const actionCount = newLog.filter(l => !l.action.includes('Clasificado')).length;
      const draftCount = newLog.filter(l => l.action.includes('Borrador guardado')).length;
      setStatusMsg(`🤖 Agente procesó ${parsed.length} correos — ${actionCount} acciones${draftCount > 0 ? ` (${draftCount} borradores en Drafts)` : ''}`);
    } catch (e: any) {
      setStatusMsg(`Error del agente: ${e}`);
    } finally {
      setIsAgentProcessing(false);
    }
  };

  const handleDeleteEmail = async (emailId: string) => {
    try {
      if (account) {
        // Delete from both IMAP server and local DB
        await invoke("imap_delete_email", { accountId: account.id, emailId });
      } else {
        // Fallback: DB only
        await invoke("delete_email", { emailId });
      }
      setEmails(prev => prev.filter(em => em.id !== emailId));
      if (selectedMail === emailId) setSelectedMail(null);
      setStatusMsg("🗑️ Correo eliminado");
    } catch (e) {
      // If IMAP delete fails, still try to remove from local DB
      await invoke("delete_email", { emailId }).catch(() => { });
      setEmails(prev => prev.filter(em => em.id !== emailId));
      if (selectedMail === emailId) setSelectedMail(null);
      setStatusMsg(`⚠️ Eliminado localmente (servidor: ${e})`);
    }
  };

  // -- Onboarding submit --
  const handleOnboardingSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const newAccount: AccountData = {
      id: "acc_" + Date.now(),
      full_name: formData.get("fullName") as string,
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      imap_host: formData.get("imapHost") as string,
      imap_port: 993,
      smtp_host: formData.get("smtpHost") as string,
      smtp_port: 465,
    };

    try {
      await invoke("save_account", { account: newAccount });
      setAccount(newAccount);
      setCurrentView('inbox');
    } catch (err) {
      alert("Failed to save account: " + err);
    }
  };

  // -- Settings submit --
  const handleSettingsSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const updatedAccount: AccountData = {
      id: account?.id || "acc_default",
      full_name: formData.get("fullName") as string,
      email: formData.get("email") as string,
      password: formData.get("password") as string,
      imap_host: formData.get("imapHost") as string,
      imap_port: 993,
      smtp_host: formData.get("smtpHost") as string,
      smtp_port: 465,
    };

    try {
      await invoke("save_account", { account: updatedAccount });
      setAccount(updatedAccount);
      setStatusMsg("Account settings saved successfully!");
    } catch (err) {
      setStatusMsg("Failed to save account: " + err);
    }
  };

  // -- Handle folder navigation --
  const navigateToFolder = async (folder: FolderType) => {
    setCurrentFolder(folder);
    setCurrentView('inbox');
    setSelectedMail(null);
    if (account) {
      setIsSyncing(true);
      try {
        await invoke("sync_emails", { accountId: account.id, folder });
      } catch (e: any) {
        // "Could not find folder" is expected for optional IMAP folders (Archive, Trash)
        // that may not exist on some servers — just show empty list silently
        const msg = String(e);
        if (!msg.includes("Could not find folder")) {
          console.error("Folder sync error:", e);
        }
      } finally {
        setIsSyncing(false);
      }
    }
  };

  // -- IMAP test --
  const handleTestImap = async () => {
    if (!account) return;
    setStatusMsg("Testing IMAP connection...");
    try {
      await invoke("sync_emails", { accountId: account.id });
      setStatusMsg("IMAP connection successful! Emails synced.");
    } catch (e) {
      setStatusMsg(`Connection error: ${e}`);
    }
  };

  const selectedEmail = emails.find(m => m.id === selectedMail);

  // ======== RENDER: ONBOARDING ========
  const renderOnboarding = () => (
    <div data-tauri-drag-region className="flex-1 flex flex-col items-center justify-center bg-background/50 backdrop-blur-xl animate-in fade-in duration-500 w-full h-full">
      <div className="max-w-md w-full p-8 bg-background border border-border/50 rounded-2xl shadow-2xl relative">
        <div className="text-center mb-8">
          <img src="/icon.png" alt="Simplex Mail" className="w-24 h-24 rounded-3xl mx-auto mb-4 object-cover shadow-2xl shadow-purple-500/30" />
          <h1 className="text-2xl font-semibold tracking-tight">Bienvenido a Simplex Mail</h1>
          <p className="text-muted-foreground text-sm mt-2">Conecta tu cuenta de correo para empezar.</p>
        </div>

        <form onSubmit={handleOnboardingSubmit} className="space-y-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Nombre Completo</label>
            <input type="text" name="fullName" className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary/50 outline-none transition-all" placeholder="Juan Pérez" required />
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">Correo Electrónico</label>
            <input type="email" name="email" className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary/50 outline-none transition-all" placeholder="juan@ejemplo.com" required />
          </div>
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="flex-1 flex flex-col gap-2">
              <label className="text-sm font-medium">Host IMAP</label>
              <input type="text" name="imapHost" className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary/50 outline-none transition-all w-full" placeholder="imap.gmail.com" required />
            </div>
            <div className="flex-1 flex flex-col gap-2">
              <label className="text-sm font-medium">Host SMTP</label>
              <input type="text" name="smtpHost" className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary/50 outline-none transition-all w-full" placeholder="smtp.gmail.com" required />
            </div>
          </div>
          <div className="grid gap-2">
            <label className="text-sm font-medium">Contraseña de Aplicación</label>
            <input type="password" name="password" className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm focus:ring-1 focus:ring-primary/50 outline-none transition-all" placeholder="••••••••••••" required />
            <p className="text-xs text-muted-foreground">Tu contraseña se guarda localmente en tu Mac. Nunca se envía a ningún lado.</p>
          </div>
          <button type="submit" className="w-full bg-primary text-primary-foreground hover:bg-primary/90 py-2.5 rounded-lg text-sm font-medium transition-all shadow-sm flex items-center justify-center gap-2">
            Conectar Cuenta
          </button>
        </form>
      </div>
    </div>
  );

  // ======== RENDER: SIDEBAR ========
  const renderSidebar = () => (
    <aside className="w-64 flex-shrink-0 flex flex-col border-r border-border/40 bg-background/50 backdrop-blur-xl">
      <div data-tauri-drag-region className="h-12 w-full cursor-default select-none pt-4 pl-4" />

      <div className="flex-1 overflow-y-auto no-scrollbar px-3 py-4 space-y-1 min-h-0 flex flex-col">
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-2">Folders</div>
        <SidebarItem icon={<Inbox size={16} />} label="Inbox" badge={String(currentFolder === 'INBOX' ? emails.length : '')} active={currentView === 'inbox' && currentFolder === 'INBOX'} onClick={() => navigateToFolder('INBOX')} />
        <SidebarItem icon={<FileText size={16} />} label="Drafts" active={currentView === 'inbox' && currentFolder === 'Drafts'} onClick={() => navigateToFolder('Drafts')} />
        <SidebarItem icon={<Send size={16} />} label="Sent" active={currentView === 'inbox' && currentFolder === 'Sent'} onClick={() => navigateToFolder('Sent')} />
        <SidebarItem icon={<Archive size={16} />} label="Archive" active={currentView === 'inbox' && currentFolder === 'Archive'} onClick={() => navigateToFolder('Archive')} />
        <SidebarItem icon={<Trash2 size={16} />} label="Trash" active={currentView === 'inbox' && currentFolder === 'Trash'} onClick={() => navigateToFolder('Trash')} />

        <div className="pt-6"></div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-2">IA</div>
        <button
          onClick={() => setChatOpen(prev => !prev)}
          className={`w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2.5 transition-colors ${chatOpen ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted/50'
            }`}
        >
          <MessageSquareText size={16} />
          <span className="flex-1">Chat IA</span>
          {agentDrafts.length > 0 && (
            <span className="bg-blue-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">{agentDrafts.length}</span>
          )}
        </button>
        {/* Inline Chat Panel */}
        {chatOpen && (
          <div className="mt-1 border border-border/40 rounded-lg bg-background overflow-hidden flex flex-col min-h-0 flex-1">
            {/* Messages */}
            <div className="flex-1 overflow-y-scroll no-scrollbar p-3 space-y-3 min-h-0">
              {chatMessages.length === 0 && (
                <div className="text-center text-muted-foreground py-6">
                  <Sparkles size={20} className="opacity-20 mx-auto mb-2" />
                  <p className="text-xs mb-3">Pregúntame sobre tus correos</p>
                  <div className="space-y-1">
                    {['¿Qué hay nuevo?', '¿Algo urgente?', '¿Borradores?'].map(q => (
                      <button key={q} onClick={() => { setChatInput(q); }} className="block w-full text-xs px-2 py-1 bg-muted/50 border border-border/30 rounded hover:bg-muted transition-colors">{q}</button>
                    ))}
                  </div>
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`${msg.role === 'user' ? 'text-right' : ''}`}>
                  <div className={`inline-block max-w-full px-3 py-2 rounded-xl text-xs leading-relaxed ${msg.role === 'user'
                    ? 'bg-primary text-primary-foreground rounded-br-sm'
                    : 'bg-muted/50 border border-border/30 rounded-bl-sm text-left'
                    }`}>
                    {msg.role === 'ai' ? (() => {
                      const actionRegex = /\[(VER|RESPONDER|DRAFT):([^\]]+)\]/g;
                      // Split by lines, each line gets its own buttons
                      const lines = msg.text.split('\n');
                      return (
                        <div className="space-y-2">
                          {lines.map((line, li) => {
                            const lineActions: Array<{ type: string; id: string }> = [];
                            let m;
                            const re = new RegExp(actionRegex.source, 'g');
                            while ((m = re.exec(line)) !== null) {
                              lineActions.push({ type: m[1], id: m[2] });
                            }
                            const cleanLine = line.replace(actionRegex, '').trim();
                            if (!cleanLine && lineActions.length === 0) return null;

                            const renderBtn = (act: { type: string; id: string }, j: number) => {
                              if (act.type === 'VER') {
                                return <button key={j} onClick={() => { setCurrentView('inbox'); setSelectedMail(act.id); }} className="px-2 py-0.5 bg-blue-500/15 text-blue-400 rounded text-[10px] font-medium hover:bg-blue-500/25 transition-colors">Ver correo</button>;
                              }
                              if (act.type === 'RESPONDER') {
                                const email = emails.find(e => e.id === act.id);
                                return <button key={j} onClick={() => {
                                  const to = email?.sender_email || email?.sender || '';
                                  const subject = `Re: ${email?.subject || ''}`;
                                  const context = email?.snippet || email?.body || '';
                                  setComposeTo(to);
                                  setComposeSubject(subject);
                                  setComposeBody(`\n\n--- Correo original ---\nDe: ${email?.sender || ''}\nAsunto: ${email?.subject || ''}\n\n${context}`);
                                  setIsComposing(true);
                                }} className="px-2 py-0.5 bg-green-500/15 text-green-400 rounded text-[10px] font-medium hover:bg-green-500/25 transition-colors">Responder</button>;
                              }
                              if (act.type === 'DRAFT') {
                                const draft = agentDrafts.find(d => d.id === act.id);
                                if (!draft) return null;
                                return <button key={j} onClick={() => { setComposeTo(draft.to); setComposeSubject(draft.subject); setComposeBody(draft.body); setIsComposing(true); }} className="px-2 py-0.5 bg-purple-500/15 text-purple-400 rounded text-[10px] font-medium hover:bg-purple-500/25 transition-colors">Ver borrador</button>;
                              }
                              return null;
                            };

                            return (
                              <div key={li}>
                                {cleanLine && <span dangerouslySetInnerHTML={{ __html: cleanLine.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`(.*?)`/g, '<code class="bg-black/10 px-1 rounded text-[11px]">$1</code>') }} />}
                                {lineActions.length > 0 && (
                                  <div className="flex gap-1.5 mt-1">
                                    {lineActions.map((act, j) => renderBtn(act, j))}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })() : (
                      <p>{msg.text}</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
            {/* Drafts mini-bar */}
            {agentDrafts.length > 0 && (
              <div className="border-t border-border/30 px-3 py-2">
                <p className="text-[10px] font-semibold text-muted-foreground uppercase mb-1.5">Borradores ({agentDrafts.length})</p>
                <div className="space-y-1.5">
                  {agentDrafts.slice(0, 3).map(draft => (
                    <div key={draft.id} className="flex items-center gap-1.5 text-xs">
                      <span className="truncate flex-1 text-muted-foreground">{draft.subject}</span>
                      <button onClick={() => {
                        setComposeTo(draft.to); setComposeSubject(draft.subject); setComposeBody(draft.body); setIsComposing(true);
                        setAgentDrafts(prev => prev.filter(d => d.id !== draft.id));
                      }} className="text-green-600 hover:text-green-700 font-medium whitespace-nowrap">Enviar</button>
                      <button onClick={() => setAgentDrafts(prev => prev.filter(d => d.id !== draft.id))} className="text-red-400 hover:text-red-500"><XCircle size={12} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Input */}
            <form onSubmit={(e) => { e.preventDefault(); handleChatSend(); }} className="border-t border-border/30 p-2.5 flex gap-2 items-center">
              <input
                type="text" value={chatInput} onChange={(e) => setChatInput(e.target.value)}
                placeholder="Pregunta..."
                className="flex-1 min-w-0 bg-muted/30 border border-border/30 rounded-md px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
              <button type="submit" className="flex-shrink-0 bg-primary text-primary-foreground w-7 h-7 rounded-md text-xs hover:bg-primary/90 flex items-center justify-center"><Send size={12} /></button>
            </form>
          </div>
        )}
        <div className="pt-3"></div>
        <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2 px-2">App</div>
        <SidebarItem icon={<Settings size={16} />} label="Settings" active={currentView === 'settings'} onClick={() => setCurrentView('settings')} />
      </div>

      <div className="p-4 border-t border-border/40 space-y-2">
        <button
          onClick={() => setIsComposing(true)}
          className="w-full bg-primary text-primary-foreground hover:bg-primary/90 rounded-lg py-2.5 text-sm font-medium flex items-center justify-center gap-2 transition-all shadow-sm"
        >
          <PenSquare size={16} /> Nuevo Mensaje
        </button>
        <button
          onClick={handleSync}
          disabled={isSyncing}
          className="w-full bg-secondary text-secondary-foreground hover:bg-secondary/80 rounded-lg py-2 text-xs font-medium flex items-center justify-center gap-2 transition-all disabled:opacity-50"
        >
          {isSyncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {isSyncing ? 'Sincronizando...' : 'Sincronizar'}
        </button>
      </div>
    </aside>
  );

  // ======== RENDER: EMAIL LIST ========
  const renderEmailList = () => (
    <>
      <section className="w-80 flex-shrink-0 flex flex-col border-r border-border/40 bg-background/80 backdrop-blur-md">
        <div data-tauri-drag-region className="h-14 flex items-center px-4 border-b border-border/40 cursor-default select-none gap-3">
          <div className="relative w-full">
            <Search className="absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
            <input
              type="text"
              placeholder="Buscar..."
              className="w-full bg-muted/50 border-none rounded-md pl-9 pr-3 py-1.5 text-sm outline-none focus:ring-1 focus:ring-primary/50 transition-shadow"
            />
          </div>
        </div>
        <div className="px-4 py-2 border-b border-border/20 flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">{currentFolder} — {emails.length} correo{emails.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            {currentFolder === 'Drafts' && emails.length > 0 && (
              <button
                onClick={async () => {
                  if (!account) return;
                  setStatusMsg(`🗑️ Eliminando ${emails.length} borradores...`);
                  try {
                    const deleted = await invoke<number>("imap_bulk_delete", { accountId: account.id, folder: currentFolder });
                    setEmails([]);
                    setSelectedMail(null);
                    setStatusMsg(`🗑️ ${deleted} borradores eliminados`);
                  } catch (e) {
                    setStatusMsg(`⚠️ Error: ${e}`);
                  }
                }}
                className="text-[10px] px-2 py-0.5 rounded-md bg-red-500/10 text-red-400 hover:bg-red-500/20 font-medium transition-colors"
              >
                Borrar todos
              </button>
            )}
            {(isAgentProcessing || isCategorizing) && <Loader2 size={12} className="animate-spin text-blue-400" />}
            <span className="text-xs text-muted-foreground">{aiEnabled ? 'IA activa' : 'IA inactiva'}</span>
            <button
              type="button"
              onClick={() => {
                const next = !aiEnabled;
                setAiEnabled(next);
                try {
                  const s = localStorage.getItem('zero_ai_config');
                  const c = s ? JSON.parse(s) : {};
                  c.aiEnabled = next;
                  localStorage.setItem('zero_ai_config', JSON.stringify(c));
                } catch { }
                if (next && !isAgentProcessing) handleAiAgent();
              }}
              className={`w-9 h-5 rounded-full transition-colors relative ${aiEnabled ? 'bg-green-500' : 'bg-gray-400'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${aiEnabled ? 'left-4' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
        {/* Priority Filter Tabs */}
        <div className="px-3 py-1.5 border-b border-border/20 flex gap-1">
          {['todos', 'urgente', 'normal', 'bajo'].map(f => (
            <button
              key={f}
              onClick={() => setPriorityFilter(f)}
              className={`text-[10px] px-2 py-1 rounded-full font-medium transition-colors capitalize ${priorityFilter === f
                ? f === 'urgente' ? 'bg-red-500/20 text-red-400'
                  : f === 'normal' ? 'bg-blue-500/20 text-blue-400'
                    : f === 'bajo' ? 'bg-gray-500/20 text-gray-400'
                      : 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:bg-muted/50'
                }`}
            >
              {f}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto no-scrollbar p-2 space-y-1">
          {syncError && (
            <div className="p-3 bg-red-500/10 text-red-400 rounded-lg text-xs border border-red-500/20 mb-2">
              {syncError}
            </div>
          )}
          {/* 🧠 Triage processing indicator */}
          {triageStatus && (
            <div className="mx-1 mb-2 p-2.5 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center gap-2 text-xs">
                <Loader2 size={12} className="animate-spin text-blue-400" />
                <span className="text-blue-300 font-medium">
                  IA clasificando {triageStatus.processed}/{triageStatus.total}
                </span>
              </div>
              {triageStatus.current_subject && (
                <p className="text-[10px] text-muted-foreground mt-1 truncate pl-5">
                  → {triageStatus.current_subject}
                </p>
              )}
              <div className="mt-1.5 h-1 bg-blue-500/10 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 rounded-full transition-all duration-500"
                  style={{ width: `${triageStatus.total > 0 ? (triageStatus.processed / triageStatus.total) * 100 : 0}%` }}
                />
              </div>
            </div>
          )}
          {isSyncing && emails.length === 0 && (
            <div className="flex-1 flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 size={24} className="animate-spin mr-2" /> Obteniendo correos...
            </div>
          )}
          {!isSyncing && emails.length === 0 && (
            <div className="flex-1 flex flex-col items-center justify-center py-12 text-muted-foreground text-center">
              <Inbox size={32} className="opacity-20 mb-2" />
              <p className="text-sm">Sin correos en {currentFolder}</p>
              <button onClick={handleSync} className="mt-3 text-xs text-primary hover:underline">Sincronizar del servidor</button>
            </div>
          )}
          {(() => {
            // Thread emails by normalized subject
            const normalizeSubject = (s: string) => s.replace(/^(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase();
            const filtered = emails.filter(mail => priorityFilter === 'todos' || priorityMap[mail.id] === priorityFilter);
            const threadMap = new Map<string, typeof filtered>();
            for (const mail of filtered) {
              const key = normalizeSubject(mail.subject || '');
              if (!threadMap.has(key)) threadMap.set(key, []);
              threadMap.get(key)!.push(mail);
            }
            // Sort threads by latest email date, show only latest per thread
            const threads = Array.from(threadMap.values()).map(group => ({
              latest: group[0],
              count: group.length,
            })).sort((a, b) => {
              // Sort newest first by date
              const dateA = new Date(a.latest.date || 0).getTime();
              const dateB = new Date(b.latest.date || 0).getTime();
              return dateB - dateA;
            });

            return threads.map(({ latest: mail, count }) => (
              <div
                key={mail.id}
                onClick={() => {
                  setSelectedMail(mail.id);
                  if (!readEmails.has(mail.id)) {
                    setReadEmails(prev => {
                      const next = new Set(prev);
                      next.add(mail.id);
                      localStorage.setItem('zero_read_emails', JSON.stringify([...next]));
                      return next;
                    });
                  }
                  // 🧠 Learning: tell triage engine user opened this email
                  invoke('record_user_action', {
                    emailId: mail.id,
                    action: 'opened',
                    senderEmail: mail.sender_email || '',
                  }).catch(() => { });
                }}
                className={`p-3 rounded-xl cursor-pointer transition-all ${selectedMail === mail.id ? 'bg-primary text-primary-foreground shadow-sm' : 'hover:bg-muted/50 text-foreground'}`}
              >
                <div className="flex justify-between items-center mb-1">
                  <div className="flex items-center gap-2 flex-1 min-w-0 pr-2">
                    <div className="relative flex items-center justify-center w-5 h-5 flex-shrink-0">
                      {count > 1 ? (
                        <span className="flex items-center justify-center w-5 h-5 text-[10px] rounded-full bg-blue-100 text-blue-700 font-bold">
                          {count}
                        </span>
                      ) : (
                        !readEmails.has(mail.id) && <span className="w-2.5 h-2.5 rounded-full bg-blue-500 shadow-sm" />
                      )}
                    </div>
                    <span className={`text-sm truncate ${!readEmails.has(mail.id) ? 'font-semibold' : 'font-normal opacity-80'}`}>{mail.sender || 'Desconocido'}</span>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Scheduled email clock badge */}
                    {(mail.id.startsWith('sched_') || scheduledEmails.some(s => s.id === mail.id && new Date(s.sendAt) > new Date())) && (
                      <span className="flex items-center gap-0.5 text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-500 font-semibold" title="Envío programado">
                        <RotateCw size={9} /> prog.
                      </span>
                    )}
                    {agentDrafts.some(d => d.subject?.includes(mail.subject?.replace('Re: ', '') || '') || d.to === mail.sender_email) && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-500/20 text-orange-400 font-semibold">borrador</span>
                    )}
                    {/* 🧠 AI Triage importance badge */}
                    {importanceMap[mail.id] === 'high' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400 font-semibold animate-pulse" title="Correo importante">🔴 urgente</span>
                    )}
                    {importanceMap[mail.id] === 'medium' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 font-semibold" title="Relevante">🟡 medio</span>
                    )}
                    {importanceMap[mail.id] === 'low' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-500/15 text-gray-400 font-medium" title="Baja prioridad">bajo</span>
                    )}
                    {!importanceMap[mail.id] && priorityMap[mail.id] && (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold uppercase tracking-wider ${priorityMap[mail.id] === 'urgente' ? 'bg-red-500/20 text-red-400' :
                        priorityMap[mail.id] === 'normal' ? 'bg-blue-500/20 text-blue-400' :
                          'bg-gray-500/20 text-gray-400'
                        }`}>{priorityMap[mail.id]}</span>
                    )}
                    <span className={`text-xs whitespace-nowrap ${selectedMail === mail.id ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>{mail.date?.slice(0, 16) || ''}</span>
                  </div>
                </div>
                <div className={`font-medium text-sm mb-1 truncate ${!readEmails.has(mail.id) ? 'font-semibold' : 'font-normal opacity-80'}`}>{mail.subject || '(Sin asunto)'}</div>
                {labelMap[mail.id] && labelMap[mail.id].length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-1">
                    {labelMap[mail.id].map((label, i) => (
                      <span key={i} className="text-[9px] px-1.5 py-0.5 rounded-full bg-cyan-500/15 text-cyan-400 font-medium">
                        {label}
                      </span>
                    ))}
                  </div>
                )}
                <div className={`text-xs line-clamp-2 ${selectedMail === mail.id ? 'text-primary-foreground/80' : 'text-muted-foreground'}`}>
                  {mail.snippet || ''}
                </div>
              </div>
            ));
          })()}
        </div>
      </section>

      {/* Email Detail */}
      <main className="flex-1 flex flex-col bg-white relative overflow-hidden">
        {selectedEmail ? (
          <>
            <div data-tauri-drag-region className="min-h-14 flex flex-wrap items-center px-6 py-2 border-b border-gray-200 justify-between gap-2 cursor-default">
              <div className="flex items-center gap-2">
                <button onClick={() => handleDeleteEmail(selectedEmail.id)} className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors" title="Delete">
                  <Trash2 size={16} />
                </button>
                {currentFolder !== 'Drafts' && currentFolder !== 'Sent' && (
                  <>
                    <div className="w-px h-4 bg-gray-200 mx-0.5"></div>
                    <button
                      onClick={() => {
                        setComposeTo(selectedEmail.sender_email || selectedEmail.sender || '');
                        setComposeSubject(`Re: ${selectedEmail.subject || ''}`);
                        setComposeBody(`\n\n---\nOn ${selectedEmail.date}, ${selectedEmail.sender} wrote:\n${selectedEmail.snippet || ''}`);
                        setComposeContext(null);
                        setIsComposing(true);
                      }}
                      className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors flex items-center gap-1 text-xs font-medium"
                      title="Reply"
                    >
                      <CornerUpLeft size={16} />
                      Responder
                    </button>
                  </>
                )}
                {currentFolder !== 'Drafts' && (
                  <button
                    onClick={() => {
                      setComposeTo('');
                      setComposeSubject(`Fwd: ${selectedEmail.subject || ''}`);
                      setComposeBody(`\n\n---\n---------- Correo Reenviado ----------\nDe: ${selectedEmail.sender}\nAsunto: ${selectedEmail.subject}\nFecha: ${selectedEmail.date}\n\n${selectedEmail.body || selectedEmail.snippet || ''}`);
                      setScheduledAt('');
                      setIsComposing(true);
                    }}
                    className="p-1.5 rounded-md hover:bg-gray-100 text-gray-500 transition-colors flex items-center gap-1 text-xs font-medium"
                    title="Reenviar"
                  >
                    <Send size={15} />
                    Reenviar
                  </button>
                )}
                {currentFolder === 'Drafts' && (
                  <button
                    onClick={() => {
                      // For drafts, use to_email (recipient from IMAP To header)
                      setComposeTo(selectedEmail.to_email || selectedEmail.sender_email || '');
                      setComposeSubject(selectedEmail.subject || '');
                      setComposeBody(selectedEmail.body || selectedEmail.snippet || '');
                      setScheduledAt('');
                      setIsComposing(true);
                    }}
                    className="p-1.5 rounded-md hover:bg-blue-50 text-blue-600 transition-colors flex items-center gap-1.5 text-xs font-medium"
                    title="Editar este borrador y enviarlo"
                  >
                    <PenSquare size={15} />
                    Editar y Enviar
                  </button>
                )}
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleAiSummarize}
                  disabled={isAiLoading}
                  className="px-3 py-1.5 rounded-lg hover:bg-blue-50 text-blue-600 transition-colors flex items-center gap-1.5 text-xs font-medium border border-blue-200/60 disabled:opacity-50"
                  title="Resumir con IA"
                >
                  {isAiLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                  Resumir
                </button>
                <button
                  onClick={handleSmartReply}
                  disabled={isSmartReplying}
                  className="px-3 py-1.5 rounded-lg hover:bg-purple-50 text-purple-600 transition-colors flex items-center gap-1.5 text-xs font-medium border border-purple-200/60 disabled:opacity-50"
                  title="Respuesta inteligente con IA"
                >
                  {isSmartReplying ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
                  Respuesta IA
                </button>
                {/* Ver borrador button — when this email has an associated draft */}
                {selectedEmail && agentDrafts.some(d => d.subject?.includes(selectedEmail?.subject?.replace('Re: ', '') || '') || d.to === selectedEmail?.sender_email) && (
                  <button
                    onClick={() => {
                      const draft = agentDrafts.find(d => d.subject?.includes(selectedEmail?.subject?.replace('Re: ', '') || '') || d.to === selectedEmail?.sender_email);
                      if (draft) {
                        setComposeTo(draft.to);
                        setComposeSubject(draft.subject);
                        setComposeBody(draft.body);
                        setComposeContext(`✍️ **Borrador IA** — generado automáticamente\n• Para: ${draft.to}\n• Asunto: ${draft.subject}\n• Este borrador fue creado por la IA al detectar un correo urgente. Revísalo y edita antes de enviar.`);
                        setIsComposing(true);
                        // Remove draft after opening compose
                        setAgentDrafts(prev => prev.filter(dd => dd.id !== draft.id));
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg hover:bg-orange-50 text-orange-600 transition-colors flex items-center gap-1.5 text-xs font-medium border border-orange-200/60"
                    title="Ver y enviar el borrador generado por el agente"
                  >
                    <PenSquare size={14} />
                    Ver borrador
                  </button>
                )}
              </div>
            </div>

            {/* AI Summary Panel - Collapsible */}
            {selectedMail && aiSummaryMap[selectedMail] && (
              summaryExpanded[selectedMail] ? (
                <div className="mx-8 mt-4 p-4 bg-blue-50 border border-blue-200/60 rounded-xl relative">
                  <div className="absolute top-2 right-2 flex gap-1">
                    <button onClick={() => setSummaryExpanded(prev => ({ ...prev, [selectedMail]: false }))} className="text-blue-400 hover:text-blue-600 text-xs">minimizar</button>
                    <button onClick={() => {
                      setAiSummaryMap(prev => { const n = { ...prev }; delete n[selectedMail]; return n; });
                      try { const s = localStorage.getItem('zero_ai_config'); if (s) { const c = JSON.parse(s); if (c.summaries) { delete c.summaries[selectedMail]; localStorage.setItem('zero_ai_config', JSON.stringify(c)); } } } catch { }
                    }} className="text-blue-400 hover:text-red-500"><XCircle size={14} /></button>
                  </div>
                  <div className="flex items-center gap-2 mb-2">
                    <Sparkles size={14} className="text-blue-500" />
                    <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Resumen IA</span>
                  </div>
                  <p className="text-sm text-blue-900 leading-relaxed">{aiSummaryMap[selectedMail]}</p>
                </div>
              ) : (
                <button
                  onClick={() => setSummaryExpanded(prev => ({ ...prev, [selectedMail]: true }))}
                  className="mx-8 mt-3 px-3 py-1.5 bg-blue-50 border border-blue-200/60 rounded-lg text-xs text-blue-600 font-medium flex items-center gap-1.5 hover:bg-blue-100 transition-colors"
                >
                  <Sparkles size={12} /> Ver resumen IA
                </button>
              )
            )}

            <div className="flex-1 overflow-y-auto no-scrollbar p-8 max-w-3xl mx-auto w-full">
              <h1 className="text-2xl font-semibold mb-6 text-gray-900">{selectedEmail.subject || '(Sin asunto)'}</h1>
              {(() => {
                const normalizeSubject = (s: string) => s.replace(/^(Re:\s*|Fwd:\s*|Fw:\s*)+/gi, '').trim().toLowerCase();
                const threadSubject = normalizeSubject(selectedEmail.subject || '');
                // Find all emails in thread, reversed so oldest is top, newest is at bottom
                const threadEmails = emails.filter(m => normalizeSubject(m.subject || '') === threadSubject).reverse();

                return threadEmails.map((msg, index) => {
                  const isLatest = index === threadEmails.length - 1;
                  const body = msg.body || '';
                  const isHtml = /<[a-z][\s\S]*>/i.test(body);

                  return (
                    <div key={msg.id} className={`mb-8 pb-8 ${!isLatest ? 'border-b border-gray-200/60' : ''}`}>
                      <div className="flex items-center gap-3 mb-6">
                        <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-blue-500 to-cyan-400 flex items-center justify-center text-white font-medium shadow-sm">
                          {(msg.sender || '?').charAt(0).toUpperCase()}
                        </div>
                        <div>
                          <div className="font-medium text-sm text-gray-900">{msg.sender}</div>
                          <div className="text-xs text-gray-500">{msg.sender_email} · {msg.date}</div>
                        </div>
                      </div>
                      {isHtml ? (
                        <iframe
                          srcDoc={body}
                          sandbox="allow-same-origin allow-popups"
                          className="w-full border-none bg-white rounded-none"
                          style={{ minHeight: isLatest ? '300px' : '150px' }}
                          title={`Email content from ${msg.sender}`}
                          onLoad={(e) => {
                            const iframe = e.target as HTMLIFrameElement;
                            try {
                              const doc = iframe.contentDocument;
                              if (doc?.body) {
                                iframe.style.height = doc.body.scrollHeight + 40 + 'px';
                              }
                            } catch { }
                          }}
                        />
                      ) : (
                        <div className="max-w-none text-sm leading-relaxed whitespace-pre-wrap text-gray-800">
                          {body || '(No content)'}
                        </div>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-center text-gray-400 flex-col gap-3">
            <Inbox size={48} className="opacity-20" />
            <p>Selecciona un mensaje para leer</p>
          </div>
        )}
      </main>
    </>
  );

  // -- Chat with AI about emails --
  const handleChatSend = async () => {
    if (!chatInput.trim()) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: userMsg }]);

    try {
      const emailContext = emails.slice(0, 10).map(e =>
        `• ID:${e.id} | [${priorityMap[e.id] || '?'}] "${e.subject}" de ${e.sender} — ${(e.snippet || '').slice(0, 80)}`
      ).join('\n');

      const draftsContext = agentDrafts.length > 0
        ? `\n\nBorradores pendientes (${agentDrafts.length}):\n${agentDrafts.map(d => `• DraftID:${d.id} | Para: ${d.to} — Asunto: ${d.subject}`).join('\n')}`
        : '';

      const logContext = agentLog.length > 0
        ? `\n\nÚltimas acciones del agente:\n${agentLog.slice(0, 8).map(l => `• ${l.action} — ${l.email}`).join('\n')}`
        : '';

      // 🧠 OpenClaw compaction: inject rolling summary if available
      const compactionCtx = convSummary
        ? `\n\n--- HISTORIAL COMPACTADO ---\n${convSummary}\n--- FIN HISTORIAL ---`
        : '';

      // 🧠 Triage: inject high-priority emails into context
      const urgentEmails = emails
        .filter(e => importanceMap[e.id] === 'high')
        .slice(0, 5);
      const urgencyCtx = urgentEmails.length > 0
        ? `\n\nCORREOS QUE REQUIEREN ATENCIÓN URGENTE (clasificados por IA):\n${urgentEmails.map(e => `• [URGENTE] ID:${e.id} De: ${e.sender} — "${e.subject}"`).join('\n')}`
        : '';

      const result = await invoke("ai_generate", {
        request: {
          prompt: `${userMsg}\n\n--- CONTEXTO DEL BUZÓN ---\nCorreos recientes:\n${emailContext}${draftsContext}${logContext}${urgencyCtx}${compactionCtx}`,
          system_prompt: `Eres un asistente de bandeja de entrada. Tu única función es ayudar con correos electrónicos.

LÍMITES ESTRICTOS — DEBES SEGUIRLOS SIN EXCEPCIÓN:
- Solo respondes preguntas sobre correos, redacción de emails, gestión de bandeja de entrada, remitentes, asuntos o adjuntos.
- Si el usuario pide CUALQUIER cosa que no sea sobre correos (código, scripts, recetas, matemáticas, trivia, etc.), responde educadamente: "Solo puedo ayudarte con tu bandeja de entrada y correos electrónicos. ¿Tienes alguna pregunta sobre tus mensajes?"
- No generes código, scripts ni instrucciones técnicas bajo ninguna circunstancia.
- No respondas preguntas de conocimiento general.

Responde SIEMPRE en español. Sé conciso y directo.

BOTONES DE ACCIÓN (cuando mencionas un correo específico):
- [VER:ID_DEL_CORREO] → para que vea el correo
- [RESPONDER:ID_DEL_CORREO] → para que responda
- [DRAFT:ID_DEL_DRAFT] → para borradores

Usa los IDs exactos del contexto. No inventes IDs.`,
          endpoint: aiEndpoint || undefined,
          api_key: aiApiKey || undefined,
          model: aiModel || undefined,
        }
      }) as { text: string };

      const newMessages = [...chatMessages, { role: 'ai' as const, text: result.text }];
      setChatMessages(newMessages);

      // 🧠 OpenClaw rolling compaction: if chat > 12 messages, ask AI to summarize old ones
      if (newMessages.length > 12 && account) {
        const oldMessages = newMessages.slice(0, newMessages.length - 6);
        const summaryPrompt = `Resume esta conversación en 3-5 frases clave preservando: decisiones tomadas, correos mencionados y sus IDs, preferencias del usuario:\n\n${oldMessages.map(m => `${m.role === 'user' ? 'Usuario' : 'IA'}: ${m.text}`).join('\n')}`;
        invoke("ai_generate", {
          request: {
            prompt: summaryPrompt,
            system_prompt: "Eres un resumidor. Responde SOLO con el resumen, sin introducción.",
            endpoint: aiEndpoint || undefined,
            api_key: aiApiKey || undefined,
            model: aiModel || undefined,
          }
        }).then((r: any) => {
          const summary = r.text;
          setConvSummary(summary);
          // Persist to DB
          invoke('save_conversation_summary', {
            accountId: account.id,
            summary,
            messageCount: newMessages.length,
          }).catch(() => { });
        }).catch(() => { });
      }
    } catch (e: any) {
      setChatMessages(prev => [...prev, { role: 'ai', text: `Error: ${e}` }]);
    }
  };

  // ======== RENDER: AI ASSISTANT ========
  const renderAssistant = () => (
    <main className="flex-1 flex flex-col bg-background relative overflow-hidden">
      <div data-tauri-drag-region className="h-14 flex items-center px-8 border-b border-border/40 cursor-default">
        <h2 className="font-medium flex items-center gap-2"><MessageSquareText size={18} /> Chat IA</h2>
      </div>
      <div className="flex-1 flex overflow-hidden">
        {/* Chat Panel */}
        <div className="flex-1 flex flex-col">
          <div className="flex-1 overflow-y-auto no-scrollbar p-6 space-y-4">
            {chatMessages.length === 0 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground py-16">
                <Sparkles size={32} className="opacity-20 mb-3" />
                <p className="text-sm">Pregúntame sobre tus correos</p>
                <div className="flex flex-wrap gap-2 mt-4 max-w-sm justify-center">
                  {['¿Qué correos nuevos tengo?', '¿Qué borradores me dejaste?', '¿Hay algo urgente?'].map(q => (
                    <button key={q} onClick={() => { setChatInput(q); }} className="text-xs px-3 py-1.5 bg-muted/50 border border-border/40 rounded-full hover:bg-muted transition-colors">{q}</button>
                  ))}
                </div>
              </div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed ${msg.role === 'user' ? 'bg-primary text-primary-foreground rounded-br-md' : 'bg-muted/50 border border-border/40 rounded-bl-md'}`}>
                  {msg.role === 'ai' ? (() => {
                    const actionRegex = /\[(VER|RESPONDER|DRAFT):([^\]]+)\]/g;
                    const lines = msg.text.split('\n');
                    return (
                      <div className="space-y-2">
                        {lines.map((line, li) => {
                          const lineActions: Array<{ type: string; id: string }> = [];
                          let m;
                          const re = new RegExp(actionRegex.source, 'g');
                          while ((m = re.exec(line)) !== null) {
                            lineActions.push({ type: m[1], id: m[2] });
                          }
                          const cleanLine = line.replace(actionRegex, '').trim();
                          if (!cleanLine && lineActions.length === 0) return null;

                          const renderBtn = (act: { type: string; id: string }, j: number) => {
                            if (act.type === 'VER') {
                              return <button key={j} onClick={() => { setCurrentView('inbox'); setSelectedMail(act.id); }} className="px-2.5 py-1 bg-blue-500/15 text-blue-500 rounded-lg text-xs font-medium hover:bg-blue-500/25 transition-colors">Ver correo</button>;
                            }
                            if (act.type === 'RESPONDER') {
                              const email = emails.find(e => e.id === act.id);
                              return <button key={j} onClick={() => {
                                setComposeTo(email?.sender_email || email?.sender || '');
                                setComposeSubject(`Re: ${email?.subject || ''}`);
                                setComposeBody(`\n\n--- Correo original ---\nDe: ${email?.sender || ''}\nAsunto: ${email?.subject || ''}\n\n${email?.snippet || email?.body || ''}`);
                                setIsComposing(true);
                              }} className="px-2.5 py-1 bg-green-500/15 text-green-500 rounded-lg text-xs font-medium hover:bg-green-500/25 transition-colors">Responder</button>;
                            }
                            if (act.type === 'DRAFT') {
                              const draft = agentDrafts.find(d => d.id === act.id);
                              if (!draft) return null;
                              return <button key={j} onClick={() => { setComposeTo(draft.to); setComposeSubject(draft.subject); setComposeBody(draft.body); setIsComposing(true); }} className="px-2.5 py-1 bg-purple-500/15 text-purple-500 rounded-lg text-xs font-medium hover:bg-purple-500/25 transition-colors">Ver borrador</button>;
                            }
                            return null;
                          };

                          return (
                            <div key={li}>
                              {cleanLine && <span className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: cleanLine.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/`(.*?)`/g, '<code class="bg-black/10 px-1 rounded text-xs">$1</code>') }} />}
                              {lineActions.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 mt-1.5">
                                  {lineActions.map((act, j) => renderBtn(act, j))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })() : (
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div className="border-t border-border/40 p-4">
            <form onSubmit={(e) => { e.preventDefault(); handleChatSend(); }} className="flex gap-2">
              <input
                type="text"
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Pregunta sobre tus correos..."
                className="flex-1 bg-muted/50 border border-border rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button type="submit" className="bg-primary text-primary-foreground px-4 py-2.5 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors">
                <Send size={16} />
              </button>
            </form>
          </div>
        </div>

        {/* Drafts Panel */}
        {agentDrafts.length > 0 && (
          <div className="w-80 flex-shrink-0 border-l border-border/40 flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b border-border/40">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <FileText size={14} /> Borradores ({agentDrafts.length})
              </h3>
            </div>
            <div className="flex-1 overflow-y-auto no-scrollbar p-3 space-y-2">
              {agentDrafts.map((draft) => (
                <div key={draft.id} className="border border-border/40 rounded-lg p-3 space-y-2">
                  <p className="text-xs text-muted-foreground"><span className="font-medium text-foreground">Para:</span> {draft.to}</p>
                  <p className="text-xs font-medium truncate">{draft.subject}</p>
                  <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">{draft.body}</p>
                  <div className="flex gap-1.5 pt-1">
                    <button
                      onClick={() => {
                        setComposeTo(draft.to);
                        setComposeSubject(draft.subject);
                        setComposeBody(draft.body);
                        setIsComposing(true);
                        setAgentDrafts(prev => prev.filter(d => d.id !== draft.id));
                        setAgentLog(prev => [{ action: '✅ Borrador aprobado → componer', email: draft.subject.slice(0, 40), time: new Date().toLocaleTimeString('es') }, ...prev]);
                      }}
                      className="text-xs px-2.5 py-1 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium"
                    >
                      Editar y Enviar
                    </button>
                    <button
                      onClick={() => {
                        setAgentDrafts(prev => prev.filter(d => d.id !== draft.id));
                        setAgentLog(prev => [{ action: '❌ Borrador descartado', email: draft.subject.slice(0, 40), time: new Date().toLocaleTimeString('es') }, ...prev]);
                      }}
                      className="text-xs px-2.5 py-1 bg-red-500/10 text-red-500 rounded-md hover:bg-red-500/20 font-medium"
                    >
                      Descartar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );

  // ======== RENDER: SETTINGS ========
  const renderSettings = () => (
    <main className="flex-1 flex flex-col bg-background relative overflow-hidden">
      <div data-tauri-drag-region className="h-14 flex items-center px-8 border-b border-border/40 cursor-default">
        <h2 className="font-medium">Configuración</h2>
      </div>
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation */}
        <div className="w-52 flex-shrink-0 border-r border-border/40 p-3 space-y-1">
          <button
            onClick={() => setSettingsTab('cuenta')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors ${settingsTab === 'cuenta' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}
          >
            <Mail size={16} /> Cuenta de Correo
          </button>
          <button
            onClick={() => setSettingsTab('ia')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors ${settingsTab === 'ia' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}
          >
            <Sparkles size={16} /> Modelo IA
          </button>
          <button
            onClick={() => setSettingsTab('agente')}
            className={`w-full text-left px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2.5 transition-colors ${settingsTab === 'agente' ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted/50'}`}
          >
            <Wand2 size={16} /> Agente IA
          </button>
        </div>

        {/* Right Content */}
        <div className="flex-1 overflow-y-auto no-scrollbar p-8">
          <div className="max-w-xl space-y-6">

            {/* TAB: Cuenta */}
            {settingsTab === 'cuenta' && (
              <>
                <div>
                  <h3 className="text-lg font-semibold mb-1">Cuenta de Correo</h3>
                  <p className="text-sm text-muted-foreground mb-6">Configura tu conexión IMAP y SMTP para enviar y recibir correos.</p>
                </div>
                <form onSubmit={handleSettingsSubmit} className="grid gap-4">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Nombre Completo</label>
                    <input type="text" name="fullName" defaultValue={account?.full_name || ""} className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm" placeholder="John Doe" />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Correo Electrónico</label>
                    <input type="email" name="email" defaultValue={account?.email || ""} className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm" placeholder="john@example.com" />
                  </div>
                  <div className="flex gap-4">
                    <div className="flex-1 flex flex-col gap-2">
                      <label className="text-sm font-medium">IMAP Host</label>
                      <input type="text" name="imapHost" defaultValue={account?.imap_host || ""} className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm w-full" placeholder="imap.gmail.com" />
                    </div>
                    <div className="flex-1 flex flex-col gap-2">
                      <label className="text-sm font-medium">SMTP Host</label>
                      <input type="text" name="smtpHost" defaultValue={account?.smtp_host || ""} className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm w-full" placeholder="smtp.gmail.com" />
                    </div>
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Contraseña App</label>
                    <input type="password" name="password" defaultValue={account?.password || ""} className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm" placeholder="••••••••••••" />
                  </div>
                  <div className="flex items-center gap-3 pt-2">
                    <button type="submit" className="bg-primary text-primary-foreground hover:bg-primary/90 py-2 rounded-md text-sm font-medium transition-colors px-4">
                      Guardar Cuenta
                    </button>
                    <button type="button" onClick={handleTestImap} className="bg-secondary text-secondary-foreground hover:bg-secondary/80 py-2 rounded-md text-sm font-medium transition-colors px-4">
                      Probar Conexión
                    </button>
                  </div>
                </form>
              </>
            )}

            {/* TAB: IA Config */}
            {settingsTab === 'ia' && (
              <>
                <div>
                  <h3 className="text-lg font-semibold mb-1">Modelo de IA</h3>
                  <p className="text-sm text-muted-foreground mb-6">Configura el endpoint y credenciales de tu LLM para resúmenes, respuestas inteligentes y el agente.</p>
                </div>
                <div className="grid gap-4">
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">URL del Endpoint LLM</label>
                    <input
                      type="url"
                      value={aiEndpoint}
                      onChange={(e) => setAiEndpoint(e.target.value)}
                      className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                      placeholder="http://127.0.0.1:8045/v1/chat/completions"
                    />
                    <p className="text-xs text-muted-foreground">Endpoint compatible con OpenAI (local o remoto)</p>
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Clave API</label>
                    <input
                      type="password"
                      value={aiApiKey}
                      onChange={(e) => setAiApiKey(e.target.value)}
                      className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                      placeholder="sk-... o vacío para LLM local"
                    />
                  </div>
                  <div className="grid gap-2">
                    <label className="text-sm font-medium">Nombre del Modelo</label>
                    <input
                      type="text"
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      className="bg-muted/50 border border-border rounded-md px-3 py-2 text-sm"
                      placeholder="gemini-3-flash, gpt-4o, llama3"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const saved = localStorage.getItem('zero_ai_config');
                      const existing = saved ? JSON.parse(saved) : {};
                      localStorage.setItem('zero_ai_config', JSON.stringify({
                        ...existing,
                        endpoint: aiEndpoint,
                        apiKey: aiApiKey,
                        model: aiModel,
                      }));
                      // Also persist to backend DB so triage uses the correct config
                      invoke('save_ai_config', { endpoint: aiEndpoint, apiKey: aiApiKey, model: aiModel }).catch(() => { });
                      setStatusMsg('✅ Modelo IA guardado');
                    }}
                    className="bg-blue-600 text-white hover:bg-blue-700 py-2 rounded-md text-sm font-medium transition-colors w-fit px-4 flex items-center gap-2"
                  >
                    <Sparkles size={14} /> Guardar Modelo
                  </button>
                </div>
              </>
            )}

            {/* TAB: Agente IA */}
            {settingsTab === 'agente' && (
              <>
                <div>
                  <h3 className="text-lg font-semibold mb-1">Agente IA Autónomo</h3>
                  <p className="text-sm text-muted-foreground mb-6">Define instrucciones y permisos para que la IA gestione tus correos de forma autónoma.</p>
                </div>
                <div className="grid gap-5">
                  {/* Instructions */}
                  <div className="grid gap-2">
                    <label className="text-sm font-medium flex items-center gap-2">
                      <Wand2 size={14} className="text-purple-500" />
                      Instrucciones del Agente
                    </label>
                    <textarea
                      value={aiInstructions}
                      onChange={(e) => setAiInstructions(e.target.value)}
                      className="bg-muted/50 border border-border rounded-md px-3 py-3 text-sm min-h-[140px] resize-y leading-relaxed"
                      placeholder={`Ejemplo:\n- Los correos de clientes son urgentes, responde agradeciendo\n- Las newsletters archívalas\n- Los bounce y errores de entrega, bórralos\n- Los correos con "factura" etiquétalos como "finanzas"\n- Si alguien pide información, responde amablemente`}
                    />
                    <p className="text-xs text-muted-foreground">
                      Escríbele a la IA qué hacer con tus correos. Se ejecuta automáticamente al sincronizar.
                    </p>
                  </div>

                  {/* Permissions */}
                  <div className="border border-border/40 rounded-lg p-4 space-y-3">
                    <h4 className="text-sm font-semibold mb-2">Permisos del Agente</h4>
                    {[
                      { key: 'canArchive' as const, label: '📦 Puede Archivar', desc: 'Mover correos al archivo automáticamente' },
                      { key: 'canTrash' as const, label: '🗑️ Puede Eliminar', desc: 'Mover correos a la papelera' },
                      { key: 'canReply' as const, label: '✉️ Puede Responder', desc: 'Redactar respuestas (requiere tu aprobación antes de enviar)' },
                    ].map(perm => (
                      <div key={perm.key} className="flex items-center justify-between">
                        <div>
                          <p className="text-sm font-medium">{perm.label}</p>
                          <p className="text-xs text-muted-foreground">{perm.desc}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => setAgentPerms(prev => ({ ...prev, [perm.key]: !prev[perm.key] }))}
                          className={`w-10 h-6 rounded-full transition-colors relative ${agentPerms[perm.key] ? 'bg-green-500' : 'bg-gray-300'}`}
                        >
                          <span className={`absolute top-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${agentPerms[perm.key] ? 'left-5' : 'left-1'}`} />
                        </button>
                      </div>
                    ))}
                  </div>

                  {/* Save */}
                  <button
                    type="button"
                    onClick={() => {
                      const saved = localStorage.getItem('zero_ai_config');
                      const existing = saved ? JSON.parse(saved) : {};
                      localStorage.setItem('zero_ai_config', JSON.stringify({
                        ...existing,
                        instructions: aiInstructions,
                        perms: agentPerms,
                      }));
                      setStatusMsg('✅ Agente IA guardado');
                    }}
                    className="bg-purple-600 text-white hover:bg-purple-700 py-2 rounded-md text-sm font-medium transition-colors w-fit px-4 flex items-center gap-2"
                  >
                    <Wand2 size={14} /> Guardar Agente
                  </button>

                  {/* Auto-Learning Controls */}
                  <div className="border border-border/40 rounded-lg p-4 space-y-4 bg-muted/20">
                    <div>
                      <h4 className="text-sm font-semibold flex items-center gap-2">
                        <BrainCircuit size={16} className="text-indigo-500" />
                        Auto-Aprendizaje de Tono
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        La IA puede analizar tus correos enviados para imitar tu estilo de redacción y actualizar sus propias instrucciones.
                      </p>
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={handleAiLearnMode}
                        disabled={isLearning}
                        className="bg-indigo-600/10 text-indigo-600 hover:bg-indigo-600/20 py-2 rounded-md text-sm font-medium transition-colors w-fit px-4 flex items-center gap-2 disabled:opacity-50"
                      >
                        {isLearning ? <RotateCw size={14} className="animate-spin" /> : <BrainCircuit size={14} />}
                        {isLearning ? 'Analizando...' : 'Forzar Aprendizaje Ahora'}
                      </button>

                      <button
                        type="button"
                        onClick={handleAiRollback}
                        disabled={isRollingBack}
                        className="bg-red-600/10 text-red-600 hover:bg-red-600/20 py-2 rounded-md text-sm font-medium transition-colors w-fit px-4 flex items-center gap-2 disabled:opacity-50"
                        title="Revertir a las instrucciones anteriores si el aprendizaje falló"
                      >
                        {isRollingBack ? <RotateCw size={14} className="animate-spin" /> : <History size={14} />}
                      </button>
                    </div>
                  </div>
                  {/* Agent Log */}
                  {agentLog.length > 0 && (
                    <div className="border border-border/40 rounded-lg p-4">
                      <h4 className="text-sm font-semibold mb-3 flex items-center justify-between">
                        Historial de Acciones
                        <button onClick={() => setAgentLog([])} className="text-xs text-muted-foreground hover:text-foreground">Limpiar</button>
                      </h4>
                      <div className="space-y-1.5 max-h-48 overflow-y-auto">
                        {agentLog.map((log, i) => (
                          <div key={i} className="flex items-start gap-2 text-xs">
                            <span className="text-muted-foreground whitespace-nowrap">{log.time}</span>
                            <span className="font-medium">{log.action}</span>
                            <span className="text-muted-foreground truncate">— {log.email}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* 🧠 Self-Generated Skills Panel */}
                  <div className="border border-border/40 rounded-lg p-4 space-y-4 bg-muted/20">
                    <div>
                      <h4 className="text-sm font-semibold flex items-center gap-2">
                        <Sparkles size={16} className="text-amber-500" />
                        Skills Auto-Generadas
                      </h4>
                      <p className="text-xs text-muted-foreground mt-1">
                        Reglas que la IA descubrió sola observando cómo usas tu correo. Se aplican automáticamente al clasificar nuevos emails.
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={async () => {
                          setStatusMsg('🧠 Generando skills...');
                          try {
                            const result = await invoke<string[]>('generate_skills');
                            setStatusMsg(result.join(' | '));
                            // Reload skills list
                            const skills = await invoke<any[]>('get_active_skills');
                            setLearnedSkills(skills);
                          } catch (e: any) { setStatusMsg(`Error: ${e}`); }
                        }}
                        className="bg-amber-600/10 text-amber-600 hover:bg-amber-600/20 py-1.5 rounded-md text-xs font-medium transition-colors px-3 flex items-center gap-1.5"
                      >
                        <Sparkles size={12} /> Generar Skills
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const result = await invoke<string>('evaluate_skills');
                            setStatusMsg(result);
                          } catch (e: any) { setStatusMsg(`Error: ${e}`); }
                        }}
                        className="bg-blue-600/10 text-blue-600 hover:bg-blue-600/20 py-1.5 rounded-md text-xs font-medium transition-colors px-3 flex items-center gap-1.5"
                      >
                        <BarChart3 size={12} /> Evaluar Precisión
                      </button>
                    </div>

                    {/* Learned skills list */}
                    {learnedSkills.length > 0 && (
                      <div className="space-y-1.5 max-h-52 overflow-y-auto">
                        {learnedSkills.map((skill: any) => (
                          <div key={skill.id} className="flex items-center gap-2 text-xs p-2 rounded-lg bg-background/50 border border-border/20">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${skill.confidence > 0.7 ? 'bg-green-500' : skill.confidence > 0.4 ? 'bg-amber-500' : 'bg-red-500'}`} />
                                <span className="font-medium truncate">{skill.description}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5 ml-3.5">
                                <span className="text-muted-foreground">{skill.skill_type}</span>
                                <span className="text-muted-foreground">•</span>
                                <span className="text-muted-foreground">Confianza: {Math.round(skill.confidence * 100)}%</span>
                              </div>
                            </div>
                            <button
                              onClick={async () => {
                                await invoke('toggle_skill', { skillId: skill.id, active: !skill.active });
                                const skills = await invoke<any[]>('get_active_skills');
                                setLearnedSkills(skills);
                              }}
                              className="text-muted-foreground hover:text-foreground"
                              title={skill.active ? 'Desactivar' : 'Activar'}
                            >
                              {skill.active ? <Eye size={12} /> : <EyeOff size={12} />}
                            </button>
                            <button
                              onClick={async () => {
                                await invoke('delete_skill', { skillId: skill.id });
                                setLearnedSkills(prev => prev.filter((s: any) => s.id !== skill.id));
                              }}
                              className="text-muted-foreground hover:text-red-500"
                              title="Eliminar skill"
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {learnedSkills.length === 0 && (
                      <p className="text-xs text-muted-foreground italic">No hay skills generadas aún. Usa tu correo normalmente y la IA descubrirá patrones.</p>
                    )}
                  </div>
                </div>
              </>
            )}

            {/* Status message */}
            {statusMsg && (
              <div className={`p-3 rounded-md text-sm border ${statusMsg.includes('error') || statusMsg.includes('Error') || statusMsg.includes('Failed') ? 'bg-red-500/10 text-red-400 border-red-500/20' : 'bg-primary/10 text-primary border-primary/20'}`}>
                {statusMsg}
              </div>
            )}
          </div>
        </div>
      </div>
    </main>
  );

  // ======== MAIN RETURN ========
  return (
    <div className="flex h-screen w-full bg-transparent text-foreground font-sans selection:bg-primary/30 overflow-hidden">
      {currentView === 'onboarding' ? (
        renderOnboarding()
      ) : (
        <>
          {renderSidebar()}
          {currentView === 'inbox' && renderEmailList()}
          {currentView === 'settings' && renderSettings()}




          {isComposing && (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 backdrop-blur-sm">
              <div className="bg-background border border-border rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4 border-b border-border/40">
                  <h3 className="font-medium">
                    {composeSubject.startsWith('Re:') ? 'Responder' : composeSubject.startsWith('Fwd:') ? 'Reenviar' : 'Nuevo Mensaje'}
                  </h3>
                  <button type="button" onClick={() => { setIsComposing(false); setScheduledAt(''); setComposeContext(null); }} className="p-1 rounded-md hover:bg-muted transition-colors text-muted-foreground">
                    <X size={18} />
                  </button>
                </div>
                {/* AI context: only shown when compose was triggered from AI (Respuesta IA, Ver borrador) */}
                {composeContext && (
                  <div className="px-6 py-3 bg-gradient-to-r from-purple-500/5 to-blue-500/5 border-b border-purple-200/20 text-xs text-muted-foreground space-y-1">
                    <div className="flex items-center gap-1.5 mb-1">
                      <Sparkles size={12} className="text-purple-400" />
                      <span className="font-semibold text-purple-400 text-[10px] uppercase tracking-wide">Contexto IA</span>
                    </div>
                    {composeContext.split('\n').map((line, i) => (
                      <p key={i} className={line.startsWith('•') ? 'pl-2' : 'font-medium text-foreground/70'}>
                        {line.replace(/\*\*(.*?)\*\*/g, '$1')}
                      </p>
                    ))}
                  </div>
                )}
                <form onSubmit={handleSendEmail} className="flex-1 flex flex-col">
                  <div className="px-6 py-3 border-b border-border/20 flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Para:</span>
                    <input
                      type="email"
                      value={composeTo}
                      onChange={(e) => setComposeTo(e.target.value.toLowerCase())}
                      className="flex-1 bg-transparent outline-none text-sm lowercase"
                      placeholder="recipient@example.com"
                      autoCapitalize="off"
                      autoCorrect="off"
                      spellCheck={false}
                      required
                    />
                  </div>
                  <div className="px-6 py-3 border-b border-border/20 flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Asunto:</span>
                    <input
                      type="text"
                      value={composeSubject}
                      onChange={(e) => setComposeSubject(e.target.value)}
                      className="flex-1 bg-transparent outline-none text-sm"
                      placeholder="Subject..."
                    />
                  </div>
                  <textarea
                    value={composeBody}
                    onChange={(e) => setComposeBody(e.target.value)}
                    className="flex-1 p-6 bg-transparent outline-none resize-none text-sm leading-relaxed min-h-[200px]"
                    placeholder="Escribe tu mensaje..."
                    required
                  />
                  {/* Attachment pills */}
                  {attachments.length > 0 && (
                    <div className="px-6 py-2 border-b border-border/20 flex flex-wrap gap-2">
                      {attachments.map((file, i) => (
                        <span key={i} className="inline-flex items-center gap-1 px-2 py-1 bg-muted rounded-md text-xs">
                          <Paperclip size={12} />
                          {file.name}
                          <button type="button" onClick={() => setAttachments(prev => prev.filter((_, idx) => idx !== i))} className="ml-1 text-muted-foreground hover:text-foreground">
                            <XCircle size={12} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="px-6 py-4 border-t border-border/40 flex justify-between items-center">
                    <div className="flex items-center gap-3">
                      <label className="cursor-pointer p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors" title="Adjuntar archivos">
                        <Paperclip size={18} />
                        <input
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            setAttachments(prev => [...prev, ...files]);
                            e.target.value = '';
                          }}
                        />
                      </label>
                      <button type="button" onClick={async () => {
                        const originalBody = composeBody;
                        setComposeBody('Generando respuesta con IA...');
                        try {
                          // Extract context from body (after --- Correo original ---)
                          const contextMatch = originalBody.match(/--- Correo original ---([\s\S]*)/);
                          const context = contextMatch ? contextMatch[1].trim() : originalBody;
                          const aiResult = await invoke("ai_generate", {
                            request: {
                              prompt: `Genera una respuesta profesional y amigable para este correo:\n\nAsunto: ${composeSubject}\nContenido: ${context}\n\nEscribe SOLO el cuerpo de la respuesta, sin saludos formales ni firmas. Directo al punto. En español.`,
                              system_prompt: "Eres un asistente de correo. Genera respuestas concisas, profesionales y amigables en español. Solo el texto de la respuesta, sin formato extra.",
                              endpoint: aiEndpoint || undefined,
                              api_key: aiApiKey || undefined,
                              model: aiModel || undefined,
                            }
                          }) as { text: string };
                          // Keep original context below the AI response
                          const contextPart = contextMatch ? `\n\n--- Correo original ---${contextMatch[1]}` : '';
                          setComposeBody(`${aiResult.text}${contextPart}`);
                        } catch {
                          setComposeBody(originalBody);
                        }
                      }} className="p-1.5 rounded-md hover:bg-muted text-muted-foreground transition-colors flex items-center gap-1 text-xs" title="Generar respuesta con IA">
                        <Wand2 size={16} />
                        <span className="text-[10px]">IA</span>
                      </button>
                      <span className="text-xs text-muted-foreground">
                        Enviando como {account?.full_name || account?.email}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Schedule datetime picker */}
                      <div className="flex items-center gap-1.5">
                        <label className="text-muted-foreground cursor-pointer" title="Programar envío">
                          <RotateCw size={16} className={scheduledAt ? 'text-amber-500' : ''} />
                        </label>
                        <input
                          type="datetime-local"
                          value={scheduledAt}
                          onChange={(e) => setScheduledAt(e.target.value)}
                          min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
                          className={`text-xs rounded-md px-2 py-1 border transition-colors outline-none ${scheduledAt ? 'border-amber-400 text-amber-600 bg-amber-50' : 'border-border bg-transparent text-muted-foreground'}`}
                          title="Programar envío"
                        />
                        {scheduledAt && (
                          <button type="button" onClick={() => setScheduledAt('')} className="text-muted-foreground hover:text-foreground" title="Cancelar programación">
                            <XCircle size={14} />
                          </button>
                        )}
                      </div>
                      {/* Descartar borrador button — only when compose has a matching draft */}
                      {agentDrafts.some(d => d.subject === composeSubject || d.to === composeTo) && (
                        <button
                          type="button"
                          onClick={() => {
                            setAgentDrafts(prev => prev.filter(d => d.subject !== composeSubject && d.to !== composeTo));
                            setComposeTo(''); setComposeSubject(''); setComposeBody('');
                            setIsComposing(false);
                            setStatusMsg('🗑️ Borrador descartado');
                          }}
                          className="rounded-lg px-4 py-2 text-sm font-medium bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all flex items-center gap-1.5"
                        >
                          <Trash2 size={14} />
                          Descartar
                        </button>
                      )}
                      <button
                        type="submit"
                        disabled={isSending}
                        className={`rounded-lg px-6 py-2 text-sm font-medium transition-all shadow-sm flex items-center gap-2 disabled:opacity-50 ${scheduledAt ? 'bg-amber-500 hover:bg-amber-600 text-white' : 'bg-primary text-primary-foreground hover:bg-primary/90'}`}
                      >
                        {isSending
                          ? <Loader2 size={16} className="animate-spin" />
                          : scheduledAt ? <RotateCw size={16} /> : <Send size={16} />}
                        {isSending ? 'Guardando...' : scheduledAt ? 'Programar' : 'Enviar'}
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
