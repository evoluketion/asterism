<p align="center">
  <img src="build/icon.png" width="128" height="128" alt="Asterism icon">
</p>

<h1 align="center">Asterism</h1>

<p align="center">
  A tiled terminal for running many Claude Code sessions at once,<br>
  with a status light on every pane so you always know which one needs you.
</p>

<p align="center">
  <img src="docs/images/screenshot.png" alt="Four Claude Code panes in a grid: one working (blue), one needing permission (amber), one finished (green) and one idle" width="900">
</p>

## Why

Running four or more Claude Code sessions in separate terminal windows means constantly checking
each one to see if it has finished or is stuck on a prompt. Other multi-agent tools hide sessions
behind tabs or replace Claude Code with their own agent. Asterism keeps the real `claude` CLI in a
real terminal and puts every session on screen at once, built for a big monitor.

## Features

- **A status light on every pane**, driven by Claude Code's own hooks rather than guessing from the
  screen:

  | Border | Meaning |
  |---|---|
  | **Solid green** | Claude finished and is waiting for you. It stays green until you type in that pane. |
  | **Pulsing amber** | Blocked: a permission prompt, a question, or plan approval. |
  | **Red** | An API error ended the turn. |
  | **Blue** | Working. The title bar shows the current tool and prompt. |
  | Dashed amber | No hook events yet, e.g. Claude is showing its "trust this folder?" prompt. |
  | Grey | Idle, a plain shell, or still starting. |

- **Jump to whoever's waiting.** `Ctrl+Shift+Space` goes to the pane that has waited longest, blocked
  panes first. Press again to cycle. When the window isn't focused you can get a desktop
  notification and a sound.
- **Panes can see each other.** Ask a pane *"what are the other panes doing?"* and Claude uses
  Asterism's built-in, read-only MCP tools: `list_panes`, `get_pane_transcript` and
  `read_pane_screen`. Panes can't type into each other.
- **Git at a glance.** Each title bar shows the pane's folder and git branch, and `±` opens the
  git diff of the repo the pane is working in, so every worktree shows its own changes.
- **Pull requests without leaving the pane.** `⇄` lists the open pull requests for the pane's
  branch, or every open one in the repo. Each shows draft, review and CI status, and **Diff** shows
  its changes right there. **Merge…** takes a
  PR out of draft, approves it and merges it in one go. This uses the [GitHub CLI](https://cli.github.com).
- **Layouts:** grid (four panes = four corners), columns, rows, main + stack and main + row. Drag
  dividers to resize, and drag title bars to swap panes.
- **Projects:** a project is a name, a folder and its panes. Inside a project, `Ctrl+Shift+N` opens
  Claude in the project folder straight away. The layout saves as you work, so switching projects
  and back restores every pane with its conversation resumed. Tick *Reopen the last project at
  startup* in ⚙ Settings to have that happen when Asterism opens, too.
- **12 themes**, 9 dark and 3 light, with live preview. Each theme recolours both the window and
  the terminals.
- **Works with your setup.** Your shell, your startup files and your `~/.claude/settings.json` are
  left as they are. A `claude` you type yourself in any pane is tracked too.

<p align="center">
  <img src="docs/images/themes.png" alt="Settings window showing the theme picker with Tokyo Night previewed" width="700">
</p>

## Install

Download the AppImage (Linux) or the portable `.exe` (Windows) from
[Releases](https://github.com/evoluketion/asterism/releases). On Linux, make it executable first:
`chmod +x Asterism-*.AppImage`. You can also build it yourself:

### Linux (AppImage)

```bash
npm install
npm run dist:linux
./dist/Asterism-0.1.0.AppImage
```

Copy the AppImage anywhere you like, e.g. `~/Applications`. The first build needs a C++ toolchain
(`gcc-c++ make python3`) for node-pty.

### Windows

```powershell
npm install
npm run dist:win
```

This builds a portable `Asterism-<version>.exe` in `dist/`: no install, just run it, like the
AppImage. Windows uses node-pty's prebuilt ConPTY binaries, so no build tools are needed. *The Windows build hasn't been tested yet.*

### Issue builds

Building or running from an issue branch (`feat/42-dark-mode`) labels the app with the issue
number: the file is `Asterism-<version>-issue-42`, the window says "Asterism #42", and it keeps its
own settings and projects. That lets it run next to your everyday Asterism instead of focusing it.
`ASTERISM_VARIANT=` (empty) builds a plain one.

### From source

Requirements: Node 20+, npm, and `claude` on your PATH.

```bash
npm install
npm start
```

## Using it

1. Click **No project ▾** at the top right and create a project: pick a folder and give it a name.
2. Press `Ctrl+Shift+N` a few times. Each press opens a Claude pane in the project folder.
3. Work as normal. When a border turns green or amber, that pane wants you, and
   `Ctrl+Shift+Space` takes you there.

Outside a project, `Ctrl+Shift+N` asks for a folder each time. `Ctrl+Shift+O` (or **+ Claude**)
always opens the folder picker, with recent folders, an optional pane name and extra `claude`
arguments such as `--model opus`.

You can `/exit`, `cd` somewhere else and run `claude` again in any pane; the pane keeps its status
light and renames itself after the new folder. When a pane's process exits, press Enter to restart
it, and a Claude pane resumes its conversation.

To rename a pane, right-click its title bar, double-click its name or press `Ctrl+Shift+R`. The
name is saved with the project. Clear the name to go back to the folder name.

To open a pane's folder in your file manager, click the folder in its title bar or press
`Ctrl+Shift+E`. A plain shell pane opens the folder it started in, even after a `cd`.

To land a pull request, click `⇄` in a pane's title bar or press `Ctrl+Shift+P`. The panel opens
inside the pane on **This branch**, which lists the open PRs from the branch the pane is on.
**All open** lists every open PR in the repo. Click a PR's number or title to open it on GitHub.
**Diff** opens the PR's changes under its row, with the same file list and folding as the `±` diff.
**Merge…** shows the steps it will run and asks first. It marks a draft ready for review, approves
the PR, then merges it with the method set in ⚙. GitHub doesn't let you approve your own pull request, so that
step is skipped for yours. If anything was pushed to the PR after the list loaded, nothing runs;
refresh and look again. The branch is not deleted, because a worktree may still have it checked
out. If a step fails, for example because of branch protection or failing checks, the panel shows
GitHub's message and stops there.

When a Claude pane's work is finished, click **✓** in its title bar instead of **✕**. ✕ closes the
pane without a trace. ✓ closes it and records it in the project's completed history. By default
that record is just the pane's name and folder. Turn on **Summarise completed panes with Claude**
in ⚙ and Claude also writes a handoff summary of the conversation in the background. This uses
tokens. The summary prompt and model can be changed in ⚙ as well. The summary is made from a fork
of the conversation, so the original session is left as it was.

Open the history from **✓ Completed panes** in the projects menu or on the empty screen. **Reopen**
starts a new Claude session in the same folder with the summary as context. Claude reads it and
waits for your first prompt. The entry stays in the history afterwards. Entries recorded without a
summary only show the name and folder and can't be reopened. **✕** removes an entry, and deleting
a project removes its entries.

### Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+Space` | Jump to the pane that has waited longest |
| `Ctrl+Shift+N` | New Claude pane in the project folder (asks for a folder outside a project) |
| `Ctrl+Shift+O` | New Claude pane in a folder you pick |
| `Ctrl+Shift+T` | New shell pane in the focused pane's folder |
| `Ctrl+Shift+W` | Close pane |
| `Ctrl+Shift+Enter` | Zoom / unzoom |
| `Ctrl+Shift+Arrows` | Move focus |
| `Ctrl+Shift+1…9` | Focus pane by number |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous pane |
| `Ctrl+Shift+L` | Cycle layout |
| `Ctrl+Shift+R` | Rename pane |
| `Ctrl+Shift+F` | Search scrollback |
| `Ctrl+Shift+E` | Open the pane's folder in the file manager |
| `Ctrl+Shift+D` | Git diff of the repo the pane is working in (the `±` button does the same). It opens inside the pane; ⛶ expands it over the whole window and back |
| `Ctrl+Shift+P` | Open pull requests for the pane's repo (the `⇄` button does the same), with Merge… on each |
| `Ctrl+Shift+C` / `V`, right-click | Copy / paste |
| `Ctrl+Shift+=` / `-` | Font size |
| `Shift+Enter` | Newline in the Claude prompt |
| `Ctrl+Shift+H` | Hide / show the toolbar. When it's hidden, hover the top edge to slide it down. |
| Drag a title bar | Swap two panes |
| Double-click a title bar | Zoom / unzoom (double-clicking the name renames instead) |
| Double-click a divider | Even out the panes on either side |
| `F11` | Fullscreen |
| `F12` | Developer tools |

Shortcuts use `Ctrl+Shift` so they never take a key a program in the pane might need.

### Themes

Asterism, Tokyo Night, Catppuccin Mocha, Dracula, Nord, Gruvbox Dark, One Dark, Rosé Pine,
Solarized Dark, Solarized Light, GitHub Light and Catppuccin Latte. Pick one in ⚙ Settings. With a
light theme, also run `/theme` in Claude Code and choose a light option, so Claude's own text
colours stay readable.

### Settings

Everything in ⚙ Settings:

| Setting | What it does |
|---|---|
| Theme | Window and terminal colours. Click a theme to preview it, and Cancel puts the old one back. |
| Claude command | What a pane runs as `claude`. The default is `claude`. Set a program path, or a command line such as `claude --model opus`. |
| Shell | The shell panes start in. Blank uses `$SHELL`, or `pwsh` (falling back to Windows PowerShell) on Windows. |
| Font size / Font family | Terminal font. A blank family uses the built-in default. |
| Background work timeout | Minutes of hook silence before a pane with background work running is marked ready. The default is 10, and 0 waits indefinitely. |
| Pull request merge method | How **Merge…** in the pull request panel merges: a merge commit (the default), squash or rebase. |
| Desktop notification | Notify when a pane needs you and Asterism isn't focused. On by default. |
| Reopen the last project at startup | Restore the last project's panes and resume their conversations when Asterism opens. Off by default. |
| Sound | Play a sound when a pane you aren't looking at needs you. On by default. |
| Summarise completed panes with Claude | Write a handoff summary when you close a pane with ✓, so it can be reopened later. Uses tokens. Off by default. When it's on, you can also edit the **summary prompt** (Reset to default restores it) and choose a **summary model** (blank uses Claude's default). |

The bottom of the dialog lists every shortcut and shows which version you're running.

## How it works

- **Hooks, not screen scraping.** Each pane gets a small `claude` wrapper first on its PATH, which
  runs the real CLI as `claude --settings <pane>/settings.json --mcp-config <pane>/mcp.json`. Those
  settings add Claude Code [hooks](https://code.claude.com/docs/en/hooks) that report each event
  to a small HTTP server inside Asterism. The events are prompt submitted, tool use, permission
  request, stop, error and so on.
- **Local only.** The server listens on `127.0.0.1` on a random port. It checks a per-pane token on
  every request and rejects browser requests.
- **Keeping the wrapper first.** Shells are started through a small init step that loads your
  normal startup files first (`.bashrc`, `.zshrc`, `config.fish`, PowerShell profile), then puts the
  wrapper in front. That way a startup file that adds `~/.local/bin` to PATH can't hide it.
- **Fallbacks** for things Claude doesn't report:
  - Esc or Ctrl+C in a busy pane, followed by 1.5 s of quiet, marks the pane idle.
  - A working pane with 30 s of silence is marked ready. Claude's spinner repaints about every
    250 ms, so silence means it has stopped. This is skipped while Claude has finished its reply
    but background tasks (subagents, background shells) are still running; the pane stays working
    until they finish.
  - Background work that sends no hook events for 10 minutes (for example a background dev server)
    marks the pane ready. Change the time, or set 0 to wait indefinitely, under *Background work
    timeout* in ⚙ Settings.

More detail is in [docs/DESIGN.md](docs/DESIGN.md).

## Troubleshooting

**The pull request panel says gh is missing or not logged in.** Install the
[GitHub CLI](https://cli.github.com) and run `gh auth login` once. Asterism finds `gh` on the same
PATH your shell uses. A repo with several GitHub remotes may also need `gh repo set-default`.

**A pane stays on dashed amber ("Check pane").** Look at the pane first; Claude may be showing a
first-run prompt. If nothing is showing, no hook events are reaching Asterism. Hooks may be turned
off by `disableAllHooks` or `allowManagedHooksOnly`, or an `allowedHttpHookUrls` policy may be
blocking `http://127.0.0.1`.

**Coming from the old name.** Settings and projects from when the app was called Alpha are copied
across automatically the first time Asterism starts.

## Development

```bash
npm test     # unit tests: layout, status rules, server and MCP, settings store, pane names,
             # session resume, git, pull requests, completed-pane archive, shell PATH, issue-build variants
npm run icon # re-render build/icon.png and src/assets/icon.png from build/icon.svg

# The whole app with stand-in Claude panes (test/fake-claude.js fires hooks like Claude Code does)
ASTERISM_TEST=demo ASTERISM_USER_DATA=/tmp/asterism-test npx electron .

# One real Claude turn, end to end
ASTERISM_TEST=real ASTERISM_REAL_ARGS="--model haiku" ASTERISM_USER_DATA=/tmp/asterism-test npx electron .

# Regenerate the README screenshots
ASTERISM_TEST=shots ASTERISM_SIZE=1600x900 ASTERISM_USER_DATA=/tmp/asterism-shots ASTERISM_TEST_OUT=/tmp/shots npx electron .
```

The self-tests take screenshots into `$ASTERISM_TEST_OUT`.

### Releasing

1. On GitHub, go to **Releases → Draft a new release**.
2. Pick a tag, or type a new one starting with `v` (e.g. `v1.0.0`) and choose **Create new tag on
   publish**.
3. Write the notes (or click **Generate release notes**) and publish.

Publishing creates the tag, and the tag starts the **Build** workflow. It runs the unit tests,
builds the Linux AppImage and the portable Windows `.exe`, and attaches both to your release. The version
number comes from the tag, so `package.json` doesn't need bumping. ⚙ Settings shows which version
you're running.

Tick **Set as a pre-release** for tags like `v1.0.0-beta.1`. If you push a tag without creating a
release first, the workflow creates the release itself, marked as a pre-release when the tag has a
hyphen.

### Project layout

```
src/
  main/
    main.js           window, IPC, app lifecycle
    panes.js          pane processes (node-pty)
    status.js         the state machine behind each status light
    server.js         local hook + MCP server
    claude-config.js  per-pane hook settings, MCP config and the claude wrapper
    shell.js          shell detection and startup (bash, zsh, fish, pwsh, cmd)
    mcp-tools.js      list_panes, get_pane_transcript, read_pane_screen
    transcript.js     reading Claude's conversation transcripts
    git.js            branch and diff for a pane's folder
    github.js         pull requests via the gh CLI: list, ready, approve, merge
    archive.js        completed-pane history and handoff summaries
    variant.js        issue-build labelling from the branch name
    store.js          settings, projects and completed history
    selftest.js       demo / real / screenshot self-tests
  renderer/
    app.js            panes, layouts, projects, shortcuts, settings
    layout.js         split-tree layouts
    themes.js         colour themes
  preload.js          the bridge between window and main process
scripts/              packaging (dist.js), icon rendering, postinstall
test/                 unit tests and the fake claude
build/                icon source (icon.svg) and packaging icon
docs/                 design notes and README images
```

## Status

Version 0.1, a personal tool. Tested on Linux (Fedora, Wayland) with bash and real Claude Code. The
Windows build and the zsh, fish, PowerShell and cmd startup paths are written but untested. macOS
isn't packaged.
