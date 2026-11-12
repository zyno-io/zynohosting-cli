# Configure the local MCP server

The package includes a local stdio MCP server that exposes authorized ZynoHosting operations to agents. It does not open a network port and there is no hosted/cloud MCP endpoint.

::: tip Most coding agents don't need this
Codex and Claude Code should use the [CLI with the ZynoHosting skill](../agents/interfaces) for hosting work. It costs nothing until a task needs it and requires no restart. The MCP server is for the [Claude desktop app's Chat and Cowork tabs](#set-up-the-claude-desktop-app), which cannot run a CLI.
:::

## Set up Codex or Claude Code

Do this only when the team prefers MCP tools to shell commands. Otherwise [install the skill](../agents/install).

Claude Code here means every surface of that client—the terminal CLI, the IDE extensions, and the Code tab of the Claude desktop app. All three read the same project `.mcp.json`, so the instruction below is the whole setup for any of them. The desktop app's Chat and Cowork tabs are a separate client with separate configuration; see [Set up the Claude desktop app](#set-up-the-claude-desktop-app).

For an end user, the easiest option is to paste this instruction into the agent:

> Set up the ZynoHosting MCP server for this project. I want the MCP server, not the CLI skill. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/agent.md for details.

The agent runs the installer for itself; the user does not need to use a terminal:

```bash
npx -y @zyno-io/zynohosting mcp install --project . --agent codex
# or, for Claude Code:
npx -y @zyno-io/zynohosting mcp install --project . --agent claude
```

The installer merges a `zynohosting` server entry into only the selected agent’s project file: Claude Code’s `.mcp.json` or Codex’s trusted-project `.codex/config.toml`. It does not store API keys or browser credentials and leaves an existing ZynoHosting entry unchanged.

::: warning
Restart Codex or Claude Code after the installer completes. The current agent session cannot discover MCP tools that were configured after it started.
:::

Copy-and-paste prompts for the whole workflow—setup, browser login, publishing, preview, and forms—are on [Set up an agent](../agents/), written for a non-technical user. What the agent itself does during installation is on [MCP install instructions for agents](./agent).

Deployment-domain policy and form-editing policy are not documented for agents here: the server supplies them as MCP instructions and tool descriptions on every connection, so they reach every session rather than only the one that fetched a page.

## Set up the Claude desktop app

The desktop app's Chat and Cowork tabs do not read a project `.mcp.json`, and no conversation in them can run the installer, so `mcp install` has no target there. They install [the desktop extension](https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb) instead: a signed `.mcpb` bundle the user opens, which Claude Desktop installs in one step.

The bundle carries the server and its dependencies as a single generated file and runs on the Node runtime that ships inside Claude Desktop, so the user installs no toolchain. That is the substantive difference from a `claude_desktop_config.json` entry naming `npx`, which resolves against the PATH the app inherits from the desktop session and therefore needs Node 24 installed system-wide — and the app does not source a login shell, which makes nvm, fnm, and some Homebrew layouts invisible to it even when `npx` works in the user's terminal.

Local roots are optional and multi-valued. The extension's install dialog offers a directory picker backed by `user_config.project_roots`, and an empty selection passes no root at all, matching the unrestricted default everywhere else. Requiring a root here would be the wrong default: people add sites over time and cannot name those folders when they install.

The bundle's `mcp_config.args` passes roots as bare arguments rather than `--root` pairs, because the host expands a configured list only when an argument is exactly `${user_config.key}`. A `--root` flag in front would keep the first folder and silently drop every other. `zynohosting-mcp` accepts both forms.

An extension keeps itself current: it verifies and stages newer signed releases and adopts them on the next launch. A `claude_desktop_config.json` entry using `npx` also tracks the newest published version, but a hand-installed bundle without the launcher would not, which is why the update path exists. See [Releasing](../reference/releasing) for how the release assets are produced.

Connection failures are logged to `~/Library/Logs/Claude/mcp-server-zynohosting.log` or `%APPDATA%\Claude\logs`, and the launcher writes its own diagnostics there, including any staged runtime it refused.

## Start the server

Direct executable:

```bash
zynohosting-mcp --root /absolute/path/to/project
```

Registry-friendly package invocation:

```bash
npx -y @zyno-io/zynohosting mcp --root /absolute/path/to/project
```

Local roots are an optional allowlist for the filesystem of the computer running the MCP process. When `ZYNOHOSTING_MCP_ROOTS` and `--root` are both omitted, local-file tools can use any absolute path that process user can access. Configure one or more existing roots to limit every local source, destination, deployment root, and ignore file to those directories after canonical path resolution.

## Generic client configuration

```json
{
    "mcpServers": {
        "zynohosting": {
            "command": "npx",
            "args": ["-y", "@zyno-io/zynohosting", "mcp"],
            "env": {
                "ZYNOHOSTING_MCP_ROOTS": "/absolute/path/to/project"
            }
        }
    }
}
```

The MCP process inherits the normal saved login unless the client replaces `HOME` or `ZYNOHOSTING_CONFIG`. It can also start without a saved login: after the MCP is connected, the agent can call the `login` tool to launch Zyno’s browser sign-in flow. The tool returns the one-time URL as content, then the agent calls `login` with `action: "status"` after the browser callback completes. For a personal, long-running MCP, authorize only its required permissions and opt into secure renewal:

```bash
zynohosting login \
  --name "Claude MCP — work laptop" \
  --permission hosting.sitesRead \
  --permission hosting.deploy \
  --permission forms.create \
  --permission forms.edit \
  --renewable
```

The MCP automatically rotates the one-time renewal credential through the operating system credential store. It schedules renewal in the background before the access token expires even if no tools are called, and it checks again before every authenticated request. The background timer does not keep the MCP process alive after its host closes the stdio session. For unattended service agents, inject `ZYNOHOSTING_API_KEY` through the client’s secret configuration instead.

::: warning
MCP client configuration frequently lives in a user profile. Do not commit API keys or access tokens in project configuration.
:::

## Allow multiple local roots

Repeat `--root`:

```bash
zynohosting-mcp \
  --root /absolute/path/to/site-a \
  --root /absolute/path/to/site-b
```

Or use the platform path delimiter in `ZYNOHOSTING_MCP_ROOTS`:

```bash
# macOS and Linux
export ZYNOHOSTING_MCP_ROOTS='/srv/site-a:/srv/site-b'

# Windows PowerShell
$env:ZYNOHOSTING_MCP_ROOTS='C:\sites\a;C:\sites\b'
```

Roots must already exist and must be real directories rather than symbolic links. Duplicate canonical roots are collapsed.

Omit both `--root` and `ZYNOHOSTING_MCP_ROOTS` to leave local-file tools unrestricted to the MCP process user's accessible filesystem. This is useful for a trusted personal MCP; use roots when the agent should be confined to specific projects.

## Select an environment

```bash
zynohosting-mcp --environment alpha --root /absolute/path/to/project
```

The MCP binary accepts:

| Option                  | Purpose                                                |
| ----------------------- | ------------------------------------------------------ |
| `--root <path>`         | Restrict local-file tools to this root; repeatable.    |
| `--api-url <url>`       | Override the Hosting Manager URL.                      |
| `--suite-api-url <url>` | Override the ZynoSuite API URL used by form tools.     |
| `--auth-api-url <url>`  | Override the ZynoAuth URL used for token renewal.      |
| `--environment <name>`  | Select `production`, `alpha`, or `dev`.                |
| `--api-key <key>`       | Supply a tenant API key. Prefer environment injection. |

It also honors the normal [configuration environment variables](../reference/configuration#environment-variables).

## Security boundary

When local roots are configured, the server canonicalizes existing paths with `realpath`. For a new destination, it finds the nearest existing parent, verifies that parent is a real directory inside an allowed root, and then resolves the remaining suffix. Symbolic-link destinations and escapes are rejected. With no configured roots, there is no root containment boundary: local-file tools use any absolute path accessible to the MCP process user.

Remote access remains independently constrained by tenant permissions and the short-lived site capability issued for each operation.

## Plan and apply lifecycle

Full deployments, downloads, and preview promotions use separate planning and apply tools:

1. the agent calls `plan_deploy`, `plan_download`, or `plan_promote`;
2. the MCP process stores the authorized plan in memory;
3. the agent presents the plan for review;
4. the agent calls the matching apply tool with the returned `planId`.

Plans:

- contain no exposed bearer token in the tool result;
- expire with their short-lived access session (promotion plans after 15 minutes);
- are removed after a successful apply;
- do not survive an MCP server restart;
- are limited to 16 pending plans per server process.

## Choose a deployment domain explicitly

Agents must never infer a deployment domain from the repository, site content, organization name, or a similar available site. If the project does not explicitly name a deployment domain, the agent must ask the user before it calls `plan_deploy` or `apply_deploy`.

After the user names a domain, the agent verifies it with `list_sites` or `get_site`. If it is unavailable in the current context, it must not substitute another domain. It should offer the `login` tool so the user can sign in again and switch context.

## Available tools

The server exposes twenty-one tools:

- `login`
- `list_sites`
- `get_site`
- `list_forms`
- `get_form_integration`
- `describe_form`
- `create_basic_form`
- `update_form`
- `update_form_bot_protection`
- `update_form_origins`
- `list_files`
- `get_file`
- `put_file`
- `delete_file`
- `plan_deploy`
- `apply_deploy`
- `plan_promote`
- `apply_promote`
- `set_not_found_handling`
- `plan_download`
- `apply_download`

See the [MCP tool reference](./tools) for arguments, effects, and permissions.

It also publishes the `zynoforms://guides/embedding` resource. Agents can read it for a compact description of direct links, iframes, the height message a framed form posts to its host page, public submission formats, alias-keyed fields, versioned endpoints, body limits, and CORS.
