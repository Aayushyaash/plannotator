<p align="center">
  <img src="https://d17ygohy796f9l.cloudfront.net/vscode/icon.png" alt="Plannotator for VS Code" width="128" />
</p>

<h1 align="center">Plannotator</h1>

<p align="center">
  Interactive plan review and code review for AI coding agents — inside VS Code.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=backnotprop.plannotator-webview"><img src="https://img.shields.io/visual-studio-marketplace/v/backnotprop.plannotator-webview?label=Marketplace&logo=visualstudiocode" alt="VS Code Marketplace" /></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-^1.85.0-blue?logo=visualstudiocode" alt="VS Code" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Opens [Plannotator](https://plannotator.ai) plan reviews and code reviews inside VS Code tabs instead of an external browser. Works with Claude Code, OpenCode, and other AI agents running in the integrated terminal.

![Plannotator in VS Code](https://d17ygohy796f9l.cloudfront.net/vscode/plannotator-vscode.gif)

## Plan Review

Review, annotate, and approve AI-generated plans without leaving your editor. Add comments, mark deletions, compare versions with plan diffs, and send structured feedback back to the agent.

![Plan Review](https://d17ygohy796f9l.cloudfront.net/vscode/plan-review.jpeg)

![Plan Diffs](https://d17ygohy796f9l.cloudfront.net/vscode/plan-diffs.jpeg)

## Code Review

Review code changes with a full diff viewer, file tree, inline annotations, and AI-assisted review — all in a VS Code tab.

![Code Review](https://d17ygohy796f9l.cloudfront.net/vscode/code-review.jpeg)

## Guided Reviews

The **Guides** view (its own icon in the activity bar) turns a change into a guided review: a title, an intent, an overview with a diagram, and a few chapters in reading order, each with the files it covers. Pick this branch's pull request, another open PR, or your local changes, then the agent that writes the guide, with your own setup and sign-in, and watch it build. Then read it chapter by chapter in VS Code's own diff editor, with go to definition on the real files and ticks per chapter and file.

The agent runs over the [Agent Client Protocol](https://agentclientprotocol.com). Guides finds these on your PATH and shows how to install the ones you don't have (it never installs anything itself):

| Agent | Started as | Install |
|---|---|---|
| Claude Code | `claude-agent-acp` | `npm install -g @agentclientprotocol/claude-agent-acp` |
| OpenCode | `opencode acp` | `curl -fsSL https://opencode.ai/install \| bash` |
| Codex | `codex-acp` | `npm install -g @agentclientprotocol/codex-acp` |
| GitHub Copilot CLI | `copilot --acp --stdio` | `npm install -g @github/copilot` |
| Cursor | `cursor-agent acp` (or `agent acp`) | `curl https://cursor.com/install -fsS \| bash` |
| Kiro CLI | `kiro-cli acp` | `curl -fsSL https://cli.kiro.dev/install \| bash` |
| Kilo Code | `kilo acp` (or `kilocode acp`) | `npm install -g @kilocode/cli` |
| Pi | `pi-acp` | `npm install -g pi-acp` |

Pi can't write guides yet: `pi-acp` does not pass MCP servers on to Pi, so Pi cannot reach the guide's tools. Any other ACP agent works through `plannotator.guides.customAgent.command` (and `.args`, `.label`). `plannotator.guides.agentCommands` overrides how a listed agent is started (`plannotator.guides.claudeCode.command` still works for Claude Code). These settings, `plannotator.guides.autoApprove` and `plannotator.guides.ghPath` can only be set in your user settings, never by a workspace.

**Guides runs your agent with your own configuration and permissions.** What the agent may do is governed by your agent's settings, exactly as when you run it yourself. Guides adds only what a guide needs: its own tool server (the guide's builder tools, which change nothing but the draft), the model and effort you pick, and the prompt.

- **Approvals.** When the agent asks before doing something, the request waits in the guide's view, with every option the agent offers ("allow once", "always allow", "reject", …), and in a notification. Your answer goes back to the agent as it is. The guide's own builder tools are approved without asking.
- **Approve automatically (opt-in).** You can let the agent work without asking: when you start a guide, at the first request ("Approve all for this run" or "Always approve during guides"), or with the `plannotator.guides.autoApprove` setting. Every request the agent asks about is then approved, and where the agent has a mode that does not ask, Guides switches to it and says so in the run's header (Claude Code: `acceptEdits`; Codex: `agent`). Off by default.
- **When your setup holds the run back,** the guide's view says so plainly and the run goes on. It names a request you turned down, a tool your agent's settings or sandbox blocked, and an agent that never reached the guide's tools. Where there is a way through, it offers it in one click: "Approve automatically for this run", or "Resume with automatic approval".
- **Pull requests** need the GitHub CLI (`gh`). Each PR opens in a git worktree of its own in the extension's storage, so your checkout is never touched. Like any checkout, it may carry its own agent config (hooks, allow rules, MCP servers), and your agent loads it as it would anywhere.
- **The agent inherits VS Code's environment,** including any credentials in it.
- Guides are saved where Plannotator's web app finds them: open and export them from either side.

## Features

- **In-editor plan review** — approve or deny plans with annotated feedback, directly in a VS Code tab
- **In-editor code review** — review git diffs and PR changes with inline comments and suggestions
- **Editor annotations** — select code directly in your editor and annotate it with `Cmd+Shift+.` — annotations appear in the Plannotator review UI alongside inline comments
- **Theme sync** — Plannotator adapts to your VS Code color theme automatically, and steps aside as soon as you pick a theme of your own in Plannotator's settings. A palette you chose is always used verbatim, and choosing Light or Dark pins the panel to that mode whatever the IDE is set to. Leave the mode on System to keep following the editor. Panels that predate theme sync stored Dark before the mode was ever a choice, so the first panel you open after upgrading resets that one stored Dark to System. It happens once: pick Dark again and it stays.
- **Cookie persistence** — your identity, settings, and preferences persist across sessions
- **Auto-close** — panels close automatically when you approve or send feedback

## How It Works

1. The extension injects a `PLANNOTATOR_BROWSER` env var into integrated terminals
2. When Plannotator opens a URL, a bundled router script sends it to the extension via a local IPC server
3. The extension opens the URL in a WebviewPanel with an embedded iframe
4. A reverse proxy handles cookie persistence transparently (VS Code webview iframes don't support cookies natively)

## Getting Started

1. Install this extension from the VS Code Marketplace
2. Install the [Plannotator Claude Code plugin](https://github.com/backnotprop/plannotator):
   ```
   /install-plugin backnotprop/plannotator
   ```
3. **Launch Claude Code from VS Code's integrated terminal** — this is required so the extension can intercept browser opens. Plan reviews, code reviews, and annotations will automatically open in VS Code tabs instead of an external browser.

> **Note:** Terminals opened before the extension activates won't have the required environment variables. If plans open in an external browser, open a new integrated terminal and try again.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `plannotatorWebview.injectBrowser` | `true` | Redirect Plannotator to open in VS Code instead of an external browser |

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| **Plannotator: Open URL** | — | Manually open a Plannotator URL in a panel |
| **Plannotator: Add Annotation** | `Cmd+Shift+.` | Annotate selected code in the editor |

## Troubleshooting

### URL opens in external browser instead of VS Code
- Ensure `plannotatorWebview.injectBrowser` is enabled
- Open a **new** terminal after installing the extension (existing terminals won't have the env var)

### Panel shows a blank page
- Check if Plannotator's server is still running
- Some network configurations may block localhost access from the webview

## Requirements

- [Plannotator](https://github.com/backnotprop/plannotator) Claude Code plugin installed
- VS Code 1.85.0+

## License

MIT
