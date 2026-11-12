'use strict';

// Per-pane status machine. Driven by Claude Code hook events, plus two output-quiescence
// fallbacks for the cases where Claude Code fires no hook (interrupts).

const NEEDS_YOU = new Set(['ready', 'permission', 'question', 'error']);
const BUSY = new Set(['working', 'permission', 'question']);
const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode']);

const INTERRUPT_QUIET_MS = 1500;
const STALL_QUIET_MS = 30000;
const BACKGROUND_QUIET_MS = 10 * 60000;

const FINISHED_TASK = new Set(['completed', 'failed', 'killed']);

/** Background tasks that keep a pane working after Stop. Monitors wait on a condition indefinitely, so they don't count. */
function hasBackgroundTasks(tasks) {
  return Array.isArray(tasks) && tasks.some((t) =>
    !FINISHED_TASK.has(t?.status) && !String(t?.type ?? '').startsWith('monitor'));
}

class PaneStatus {
  constructor(kind, now = Date.now()) {
    this.kind = kind; // 'claude' | 'shell'
    this.state = kind === 'claude' ? 'starting' : 'shell';
    this.since = now;
    this.inferred = false;
    this.lastPrompt = null;
    this.lastReply = null;
    this.currentTool = null;
    this.sessionId = null;
    this.transcriptPath = null;
    this.claudeCwd = null;
    this.startCwd = null; // folder the current Claude session started in (where --resume works)
    this.lastOutputAt = now;
    this.interruptAt = 0;
    this.hooksSeen = false;
    this.error = null;
    this.backgroundRunning = false; // still running after the main thread's last Stop
    this.lastHookAt = now;
  }

  // inferred: null for hook-driven states, otherwise a short human-readable reason.
  set(state, now, inferred = null) {
    if (this.state === state && this.inferred === inferred) return false;
    this.state = state;
    this.since = now;
    this.inferred = inferred;
    this.interruptAt = 0;
    if (state !== 'error') this.error = null;
    if (!BUSY.has(state)) this.backgroundRunning = false;
    return true;
  }

  // Returns true if anything observable changed.
  applyHook(event, body = {}, now = Date.now()) {
    // Hooks only arrive from claude started through this pane's shim, so a shell pane where the
    // user typed `claude` becomes a Claude pane.
    if (this.kind !== 'claude') this.kind = 'claude';
    const first = !this.hooksSeen;
    this.hooksSeen = true;
    return this.reduce(event, body, now) || first;
  }

  reduce(event, body, now) {
    this.lastHookAt = now;
    if (body.session_id) this.sessionId = body.session_id;
    if (body.transcript_path) this.transcriptPath = body.transcript_path;
    if (body.cwd) this.claudeCwd = body.cwd;

    switch (event) {
      case 'SessionStart':
        // "compact" fires mid-turn during auto-compaction; Claude keeps working.
        if (body.source === 'compact') return this.set('working', now);
        if (body.cwd) this.startCwd = body.cwd;
        this.currentTool = null;
        this.set('idle', now);
        return true;
      case 'UserPromptSubmit':
        this.lastPrompt = typeof body.prompt === 'string' ? body.prompt : this.lastPrompt;
        this.currentTool = null;
        this.backgroundRunning = false;
        this.set('working', now);
        return true;
      case 'PreToolUse':
        this.currentTool = body.tool_name || null;
        this.set(QUESTION_TOOLS.has(body.tool_name) ? 'question' : 'working', now);
        return true;
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionDenied':
        this.set('working', now);
        return true;
      case 'PermissionRequest':
        return this.set('permission', now);
      case 'Notification':
        switch (body.notification_type) {
          case 'permission_prompt':
          case 'worker_permission_prompt':
          case 'agent_needs_input':
            return this.set('permission', now);
          case 'elicitation_dialog':
          case 'elicitation_url_dialog':
            return this.set('question', now);
          case 'idle_prompt':
            // Backup only: never re-light a pane the user has already seen.
            if (this.backgroundRunning) return false;
            return this.state === 'working' || this.inferred ? this.set('ready', now) : false;
          default: return false;
        }
      case 'Stop':
        this.currentTool = null;
        if (typeof body.last_assistant_message === 'string') this.lastReply = body.last_assistant_message;
        // When background work finishes, Claude Code wakes the main thread and sends another Stop.
        this.backgroundRunning = hasBackgroundTasks(body.background_tasks);
        this.set(this.backgroundRunning ? 'working' : 'ready', now);
        return true;
      case 'StopFailure':
        this.currentTool = null;
        this.set('error', now);
        this.error = body.error || body.message || 'API error';
        return true;
      case 'SessionEnd':
        this.currentTool = null;
        return this.set('shell', now);
      default:
        return false;
    }
  }

  // Keystrokes typed into the pane.
  onInput(data, now = Date.now()) {
    // Focus reports and mouse events are not the user looking at the pane's answer.
    if (/^\x1b\[(I|O|<|M)/.test(data)) return false;
    let changed = false;
    if (this.state === 'ready' || this.state === 'error') changed = this.set('idle', now);
    // Esc / Ctrl+C while busy: Claude may abort without firing Stop. Arm the quiet-check.
    // With only background work left the main thread is already at its prompt, so there is nothing to abort.
    if (BUSY.has(this.state) && !this.backgroundRunning && (data === '\x1b' || data === '\x03')) this.interruptAt = now;
    return changed;
  }

  onOutput(now = Date.now()) {
    this.lastOutputAt = now;
  }

  onExit(now = Date.now()) {
    this.currentTool = null;
    return this.set('exited', now);
  }

  /**
   * Periodic check for the fallbacks. backgroundQuietMs bounds how long background work may go
   * without any hook event before the pane is called ready; 0 waits indefinitely.
   */
  tick(now = Date.now(), backgroundQuietMs = BACKGROUND_QUIET_MS) {
    if (!BUSY.has(this.state)) return false;
    const quiet = now - this.lastOutputAt;
    if (this.interruptAt && now - this.interruptAt >= INTERRUPT_QUIET_MS && quiet >= INTERRUPT_QUIET_MS) {
      this.currentTool = null;
      return this.set('idle', now, 'interrupted');
    }
    // Background subagents write almost nothing to the terminal but keep firing tool hooks, so hook
    // silence is the signal. A task that never ends, like a dev server, fires none.
    if (this.state === 'working' && this.backgroundRunning) {
      if (backgroundQuietMs > 0 && now - this.lastHookAt >= backgroundQuietMs) {
        return this.set('ready', now, `background tasks quiet for ${Math.round(backgroundQuietMs / 60000)} min`);
      }
      return false;
    }
    if (this.state === 'working' && quiet >= STALL_QUIET_MS) return this.set('ready', now, 'no output for 30s');
    return false;
  }

  get needsYou() {
    return NEEDS_YOU.has(this.state);
  }

  toJSON() {
    return {
      kind: this.kind,
      state: this.state,
      since: this.since,
      inferred: this.inferred,
      needsYou: this.needsYou,
      lastPrompt: this.lastPrompt,
      lastReply: this.lastReply,
      currentTool: this.currentTool,
      sessionId: this.sessionId,
      claudeCwd: this.claudeCwd,
      startCwd: this.startCwd,
      hooksSeen: this.hooksSeen,
      error: this.error,
    };
  }
}

module.exports = { PaneStatus, NEEDS_YOU, INTERRUPT_QUIET_MS, STALL_QUIET_MS, BACKGROUND_QUIET_MS };
