# Asterism — a multi-pane terminal wrapper for Claude Code

## Goal
One window, N terminal panes in a chosen layout (columns / rows / grid / main+stack),
each pane typically running its own `claude` instance. Every pane shows a persistent,
unmissable status (working / ready for you / needs permission / exited). Any Claude can
ask the wrapper for the status of the other panes. Linux + Windows.

## Stack
- Electron 44.9.3 (main + one renderer), node-pty 1.1.0 (ConPTY on Windows),
  @xterm/xterm 6 + fit + webgl + web-links addons. No bundler; renderer is plain ES modules,
  xterm loaded from its UMD build.
- No runtime dependency on Node, Python, bash, etc. on the user's machine.

## State detection — Claude Code hooks, never screen scraping
Each pane gets a generated settings file passed via `claude --settings <file>` (merged with the
user's own settings; their global config is never touched). Hook commands are:

    curl -s -m 2 -X POST --data-binary @- -H "Authorization: Bearer <tok>" "http://127.0.0.1:<port>/hook/<paneId>/<Event>" || exit 0

- curl ships with Windows 10+ and every Linux, works from bash, cmd, or pwsh.
- port/pane/token are baked into the file — no env expansion needed (shell-agnostic).
- server replies 204 with empty body so curl prints nothing (stdout could be parsed as hook output).
- `|| exit 0` guarantees we never return exit code 2 (which would block Claude).

Event → state:
| Event | State |
|---|---|
| SessionStart | idle |
| UserPromptSubmit | working (record prompt) |
| PreToolUse | working (record tool) — except AskUserQuestion / ExitPlanMode → `question` |
| PostToolUse | working |
| PermissionRequest, Notification(permission_prompt) | `permission` (amber pulse) |
| Notification(elicitation_dialog) | `question` |
| Notification(idle_prompt) | ready (backup) |
| Stop | `ready` (green, persistent) — read last assistant msg from transcript. Stays `working` while `background_tasks` lists unfinished non-monitor tasks; Claude Code sends another Stop when they finish |
| SessionEnd | `shell` (claude exited, shell still alive) |
| PTY exit | `exited` (red) |

`ready` is "unseen": it stays solid green until you type a key in that pane, then drops to `idle`.
Interrupt fallback: Stop does not fire on Esc/Ctrl+C. If the user presses Esc/Ctrl+C in a
`working` pane and PTY output then goes quiet for 1.5 s → `idle`. Generic fallback: `working` with
no PTY output for 30 s → `ready` flagged `inferred` (Claude's spinner normally repaints constantly).
Both fallbacks, and the idle_prompt backup, are skipped while only background tasks are running:
the main thread is at its prompt and background subagents write almost nothing to the PTY. Instead,
background work that fires no hook event for `backgroundQuietMin` minutes (default 10, 0 = never)
→ `ready` flagged `inferred`. Working subagents keep firing tool hooks; a background dev server
fires none, so this is what releases a pane left running one.

## Pane-to-pane awareness — MCP over HTTP
Main process hosts a minimal Streamable-HTTP MCP endpoint at `/mcp/<paneId>`; each claude gets
`--mcp-config` pointing at it (type http, bearer header). Tools:
- `list_panes` — id, name, state, since, cwd, git branch, last prompt, last reply (truncated),
  current tool, which pane is "you".
- `get_pane_transcript(pane, messages)` — recent user/assistant turns from the transcript JSONL.
- `read_pane_screen(pane, lines)` — visible xterm buffer text (asks the renderer).
No send-to-pane in v1 (deliberate: avoids invisible agent-to-agent chatter).

## Layout
A split tree: `{type:'split', dir:'row'|'col', children, sizes}` / `{type:'pane', id}`.
Presets (columns, rows, grid, main-left, main-top) just rebuild the tree from the pane list.
Drag dividers to resize. Zoom toggles one pane to fill the window.

## UX
- Pane chrome: thin title bar (name, cwd, branch, state chip, last reply one-liner), coloured border.
- Git diff: `±` / Ctrl+Shift+D overlays the pane with `git diff HEAD` (staged + unstaged, untracked by
  name) for the repo containing the pane's cwd, so worktrees each show their own. Read-only, refreshed on
  demand. Opens over the whole window; ⛶ docks it into the pane.
- Toolbar: + Claude pane, + shell pane, layout picker, project menu, waiting counter.
- Hotkeys (app-level, so they never collide with Claude's TUI):
  Ctrl+Shift+Space jump to longest-waiting pane · Ctrl+Shift+N new Claude pane ·
  Ctrl+Shift+T new shell pane · Ctrl+Shift+W close pane · Ctrl+Shift+Enter zoom ·
  Ctrl+Shift+Arrows move focus · Ctrl+Shift+1..9 focus pane n · Ctrl+Shift+L cycle layout ·
  Ctrl+Shift+C / V copy / paste.
- Shift+Enter sends ESC CR so it inserts a newline in Claude's prompt.
- Optional desktop notification + sound when a pane needs you and the window is unfocused.
- Projects: {name, folder, layout}, saved in userData. One project is active per window. Inside it,
  Ctrl+Shift+N opens Claude in the project folder; outside one it asks for a folder. The layout
  (panes, tree, preset, session ids) is saved into the active project as you work, so switching
  projects restores each one's panes and resumes their Claude sessions (`--resume <session_id>`).
  Saved workspaces from earlier versions are converted to projects (folder = the most common pane
  folder). The old global default folder and first-run prompt are gone.

## Process model
Each pane spawns the user's shell (bash/zsh from $SHELL on Linux; pwsh → powershell on Windows)
in the pane's cwd, then for Claude panes writes the `claude ...` command line once. When Claude
exits you keep a usable shell.
