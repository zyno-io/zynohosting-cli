# Install instructions for agents

This page is addressed to the AI agent that fetched it. The person you are working for reads https://zyno-io.github.io/zynohosting-cli/agents/ instead.

## Check whether you need the MCP server

Agents that can run shell commands now use ZynoHosting through its CLI and a skill file, not the MCP server. The CLI covers sites, files, deployments, preview, promotion, downloads, and ZynoForms. Nothing loads into your sessions until a task needs it, and no restart is required.

- Normally, follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md instead of this page. Tell the user you set up the CLI skill rather than the MCP server, because it stays out of the way until needed.
- Continue below only if the user explicitly asks for the MCP server rather than the CLI. The older setup prompt (“Set up ZynoHosting MCP for this project if it's not already configured”) predates the CLI skill and does not count as that request on its own. Installing the skill as well is fine.
- If you cannot run shell commands, see “Agents without a shell” below.

The rest of this page covers one thing: installing the local ZynoHosting MCP server. Everything that applies afterward—deployment-domain policy, sign-in, form editing—is delivered by the server itself as MCP instructions and tool descriptions once it is connected. Do not look for that guidance here.

## Install

1. Identify which agent you are, then run exactly one of these:

    ```bash
    # Codex — writes ./.codex/config.toml
    npx -y @zyno-io/zynohosting mcp install --project . --agent codex

    # Claude Code — writes ./.mcp.json
    npx -y @zyno-io/zynohosting mcp install --project . --agent claude
    ```

    `--agent claude` covers every Claude Code surface: the terminal CLI, the IDE extensions, and the Code tab of the Claude desktop app. They are one client reading one project file. If you cannot run shell commands at all, you are not in Claude Code—see “Agents without a shell” below and do not run the installer.

2. Always pass `--agent` explicitly. Without it, the installer identifies the caller only when `CLAUDECODE=1` or `CODEX_HOME` is set, and otherwise fails rather than guessing.
3. Never configure the other agent’s project file. One agent, one file.
4. You do not need to check whether it is already configured. The installer merges a single `zynohosting` entry, leaves an existing entry untouched, writes no credentials, and reports which paths it configured versus which were already configured.
5. Then tell the user to restart this agent. Do not claim the ZynoHosting tools are available in the current session—they are not. MCP servers are loaded at session start, so the session that ran the installer cannot use them.
6. On Claude Code, tell the user to expect a one-time approval prompt for the project MCP server on next start.

## What the installer writes

| Agent       | File                   | Entry                                                                                      |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------ |
| Claude Code | `./.mcp.json`          | `npx -y @zyno-io/zynohosting mcp --root ${CLAUDE_PROJECT_DIR:-.}`                          |
| Codex       | `./.codex/config.toml` | `[mcp_servers.zynohosting]` with this project’s absolute path and `tool_timeout_sec = 330` |

Neither file holds an API key or any other credential, so both are safe to commit.

Codex gets the raised tool timeout because browser sign-in waits up to five minutes for the user to complete multi-factor or single sign-on, which is longer than Codex’s default MCP tool timeout.

## Agents without a shell

The Chat and Cowork tabs of the Claude desktop app cannot run this installer, and nothing said inside a conversation can add an MCP server to them. If that is where you are, do not run the install, do not write a configuration file through any other tool, and do not report success. Tell the user to install the desktop extension instead:

1. Download https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb
2. Double-click the downloaded file. Claude opens an install window; they click Install.
3. The install window offers to limit ZynoHosting to particular folders. Tell them to leave it empty unless they specifically want to confine it, because an empty list lets them publish any folder and add new sites later without changing settings.
4. Confirm the result with them: the **+** button beside the message box, then Connectors, then Manage connectors, should list ZynoHosting.

They install nothing else. The extension carries the server and runs on the runtime inside Claude Desktop, so Node.js is not required for this path, and the extension keeps itself up to date after that.

If they also use the Code tab, mention it as an alternative: open the project there and ask it to set up ZynoHosting, and it installs the CLI skill per https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md. That path does require Node.js 24 on their computer.

The extension is available in the Code tab as well, so a user who installs it does not strictly need anything else there.

## When it fails

- The package requires Node.js 24. An `npx` failure that mentions the Node version or an unsupported engine means the user needs Node.js 24 installed.
- Codex’s entry pins this project’s absolute path, so re-run the installer after the project directory is moved or renamed.
- If the installer reports that it could not parse an existing `.mcp.json` or `.codex/config.toml`, report that to the user and stop. Do not hand-edit or replace their configuration file to work around it.

## Editing this page

Agents fetch it raw from GitHub, so keep it plain Markdown: no VitePress `:::` containers, and no relative links, which do not resolve on `raw.githubusercontent.com`. Use full `https://zyno-io.github.io/zynohosting-cli/...` URLs.

Keep it install-only. Anything an agent needs after the server is connected belongs in `SERVER_INSTRUCTIONS` or a tool description in `src/mcp/server.ts` or `src/mcp/forms.ts`, where it reaches every session instead of only the one that happened to fetch this file.

Earlier setup prompts point agents at this URL, so keep it working and keep the CLI-skill redirect at the top.
