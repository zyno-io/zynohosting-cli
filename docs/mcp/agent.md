# Install instructions for agents

This page is addressed to the AI agent that fetched it. The person you are working for reads https://zyno-io.github.io/zynohosting-cli/mcp/setup instead.

It covers one thing: installing the local ZynoHosting MCP server. Everything that applies afterward—deployment-domain policy, sign-in, form editing—is delivered by the server itself as MCP instructions and tool descriptions once it is connected. Do not look for that guidance here.

## Install

1. Identify which agent you are, then run exactly one of these:

    ```bash
    # Codex — writes ./.codex/config.toml
    npx -y @zyno-io/zynohosting mcp install --project . --agent codex

    # Claude Code — writes ./.mcp.json
    npx -y @zyno-io/zynohosting mcp install --project . --agent claude
    ```

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

## When it fails

- The package requires Node.js 24. An `npx` failure that mentions the Node version or an unsupported engine means the user needs Node.js 24 installed.
- Codex’s entry pins this project’s absolute path, so re-run the installer after the project directory is moved or renamed.
- If the installer reports that it could not parse an existing `.mcp.json` or `.codex/config.toml`, report that to the user and stop. Do not hand-edit or replace their configuration file to work around it.

## Editing this page

Agents fetch it raw from GitHub, so keep it plain Markdown: no VitePress `:::` containers, and no relative links, which do not resolve on `raw.githubusercontent.com`. Use full `https://zyno-io.github.io/zynohosting-cli/...` URLs.

Keep it install-only. Anything an agent needs after the server is connected belongs in `SERVER_INSTRUCTIONS` or a tool description in `src/mcp/server.ts` or `src/mcp/forms.ts`, where it reaches every session instead of only the one that happened to fetch this file.
