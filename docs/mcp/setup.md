# Set up ZynoHosting for an agent

Copy and paste this into Codex or Claude Code:

> Set up ZynoHosting MCP for this project if it's not already configured. See https://zyno-io.github.io/zynohosting-cli/mcp/setup for details.

The agent can run the installer itself. You do not need to open a terminal.

## What the agent does

The agent runs:

```bash
npx -y @zyno-io/zynohosting mcp install --project .
```

The installer adds the local stdio server without adding credentials:

- Claude Code: `.mcp.json`
- Codex: `.codex/config.toml`

It preserves other MCP servers and leaves an existing `zynohosting` entry unchanged. The Codex entry contains the absolute project root so local-file tools remain restricted to that project; do not commit that generated file if the project is shared across computers.

::: warning
Restart Codex or Claude Code after installation. MCP servers are loaded when the agent session starts, so the same session cannot use the newly installed tools.
:::

Claude Code may also ask for its normal one-time approval before enabling a project MCP server.

## Sign in from the agent

After restart, ask the agent to use the `login` tool. It starts Zyno’s sign-in page in your browser and returns the one-time sign-in URL in its tool result, so you can still open it if your browser does not launch automatically. Once you finish sign-in, the agent checks `login` with `action: "status"` before using authenticated tools. Start with only the permissions needed for the task; `hosting.sitesRead` is the default discovery permission. For a long-lived MCP, explicitly request a renewable login.

The login tool can switch the saved browser-login context. It cannot replace an API key or bearer token that was injected through the MCP command or environment. In that case, change the injected credential and restart the agent.

## Deployment-domain rule

An agent must never infer the deployment domain from the repository, site content, organization name, or another available site. If the project does not explicitly name a target domain, it must ask you before planning or applying a deployment.

Once you name a domain, the agent verifies that it is available through `list_sites` or `get_site`. If it is unavailable, it must not choose another domain. It should explain that the current login context lacks access and offer to run `login` again so you can switch context.
