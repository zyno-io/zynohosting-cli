# ZynoHosting agent guide

Use these prompts in Codex or Claude Code. You do not need to open a terminal—copy one prompt at a time into your agent.

## 1. Set up ZynoHosting for this project

> Set up ZynoHosting MCP for this project if it's not already configured. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/setup.md for details.

The agent configures only itself:

- Codex writes this project’s `.codex/config.toml`.
- Claude Code writes this project’s `.mcp.json`.

It never writes both files. The agent uses its own identity to run the installer with `--agent codex` or `--agent claude`; it does not need the user to run that command.

**Important:** Start a new Codex or Claude Code session after setup. MCP servers are loaded at session start, so the session that installed it cannot use the new tools.

Claude Code may also ask for its normal one-time approval before it enables a project MCP server.

## 2. Sign in

> Sign in to ZynoHosting for this project. Use the MCP `login` tool, open the browser sign-in page, and give me the one-time link if my browser does not open automatically. After I finish signing in, verify the login status before continuing.

The agent opens a secure browser sign-in flow—there is no CLI login command for you to run. It requests only the permissions needed for the task. For a later deployment, it needs `hosting.sitesRead` to verify the domain and `hosting.deploy` to publish.

Signing in again can switch to a different ZynoHosting account or organization. It cannot replace an API key or bearer token injected into the MCP process; in that situation, change the injected credential and restart the agent.

## 3. Publish a site

> Publish this project to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I cannot, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.

Replace `[your-domain.com]` with the exact domain you want to publish. The agent must not guess it from the repository, site content, organization name, or another available site.

If the exact domain is not available in the current login context, the agent must not pick a similar one. It should offer the Sign in prompt again so you can switch to an account or organization that has access.

## For the agent

Run one of these only when setup is required:

```bash
# Codex
npx -y @zyno-io/zynohosting mcp install --project . --agent codex

# Claude Code
npx -y @zyno-io/zynohosting mcp install --project . --agent claude
```

Do not configure the other agent’s project file. After installation, tell the user to restart the current agent before using ZynoHosting MCP tools.
