# Configure the local MCP server

The package includes a local stdio MCP server that exposes authorized ZynoHosting operations to agents. It does not open a network port and there is no hosted/cloud MCP endpoint.

## Set up Codex or Claude Code

For an end user, the easiest option is to paste this instruction into the agent:

> Set up ZynoHosting MCP for this project if it's not already configured. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/setup.md for details.

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

For the full agent instructions, browser login, and deployment-domain policy, see [Set up ZynoHosting for an agent](./setup).

## Start the server

Direct executable:

```bash
zynohosting-mcp --root /absolute/path/to/project
```

Registry-friendly package invocation:

```bash
npx -y @zyno-io/zynohosting mcp --root /absolute/path/to/project
```

Local roots are an optional allowlist for the filesystem of the computer running the MCP process. When `ZYNO_HOSTING_MCP_ROOTS` and `--root` are both omitted, local-file tools can use any absolute path that process user can access. Configure one or more existing roots to limit every local source, destination, deployment root, and ignore file to those directories after canonical path resolution.

## Generic client configuration

```json
{
    "mcpServers": {
        "zynohosting": {
            "command": "npx",
            "args": ["-y", "@zyno-io/zynohosting", "mcp"],
            "env": {
                "ZYNO_HOSTING_MCP_ROOTS": "/absolute/path/to/project"
            }
        }
    }
}
```

The MCP process inherits the normal saved login unless the client replaces `HOME` or `ZYNO_HOSTING_CONFIG`. It can also start without a saved login: after the MCP is connected, the agent can call the `login` tool to launch Zyno’s browser sign-in flow. The tool returns the one-time URL as content, then the agent calls `login` with `action: "status"` after the browser callback completes. For a personal, long-running MCP, authorize only its required permissions and opt into secure renewal:

```bash
zynohosting login \
  --name "Claude MCP — work laptop" \
  --permission hosting.sitesRead \
  --permission hosting.deploy \
  --permission forms.create \
  --permission forms.edit \
  --renewable
```

The MCP automatically rotates the one-time renewal credential through the operating system credential store. It schedules renewal in the background before the access token expires even if no tools are called, and it checks again before every authenticated request. The background timer does not keep the MCP process alive after its host closes the stdio session. For unattended service agents, inject `ZYNO_HOSTING_API_KEY` through the client’s secret configuration instead.

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

Or use the platform path delimiter in `ZYNO_HOSTING_MCP_ROOTS`:

```bash
# macOS and Linux
export ZYNO_HOSTING_MCP_ROOTS='/srv/site-a:/srv/site-b'

# Windows PowerShell
$env:ZYNO_HOSTING_MCP_ROOTS='C:\sites\a;C:\sites\b'
```

Roots must already exist and must be real directories rather than symbolic links. Duplicate canonical roots are collapsed.

Omit both `--root` and `ZYNO_HOSTING_MCP_ROOTS` to leave local-file tools unrestricted to the MCP process user's accessible filesystem. This is useful for a trusted personal MCP; use roots when the agent should be confined to specific projects.

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
| `--auth-api-url <url>`  | Override the Zyno Auth URL used for token renewal.     |
| `--environment <name>`  | Select `production`, `alpha`, or `dev`.                |
| `--api-key <key>`       | Supply a tenant API key. Prefer environment injection. |

It also honors the normal [configuration environment variables](../reference/configuration#environment-variables).

## Security boundary

When local roots are configured, the server canonicalizes existing paths with `realpath`. For a new destination, it finds the nearest existing parent, verifies that parent is a real directory inside an allowed root, and then resolves the remaining suffix. Symbolic-link destinations and escapes are rejected. With no configured roots, there is no root containment boundary: local-file tools use any absolute path accessible to the MCP process user.

Remote access remains independently constrained by tenant permissions and the short-lived site capability issued for each operation.

## Plan and apply lifecycle

Full deployments and downloads use separate planning and apply tools:

1. the agent calls `plan_deploy` or `plan_download`;
2. the MCP process stores the authorized plan in memory;
3. the agent presents the plan for review;
4. the agent calls the matching apply tool with the returned `planId`.

Plans:

- contain no exposed bearer token in the tool result;
- expire with their short-lived access session;
- are removed after a successful apply;
- do not survive an MCP server restart;
- are limited to 16 pending plans per server process.

## Choose a deployment domain explicitly

Agents must never infer a deployment domain from the repository, site content, organization name, or a similar available site. If the project does not explicitly name a deployment domain, the agent must ask the user before it calls `plan_deploy` or `apply_deploy`.

After the user names a domain, the agent verifies it with `list_sites` or `get_site`. If it is unavailable in the current context, it must not substitute another domain. It should offer the `login` tool so the user can sign in again and switch context.

## Available tools

The server exposes eighteen tools:

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
- `plan_download`
- `apply_download`

See the [MCP tool reference](./tools) for arguments, effects, and permissions.

It also publishes the `zynoforms://guides/embedding` resource. Agents can read it for a compact description of direct links, iframes, the height message a framed form posts to its host page, public submission formats, alias-keyed fields, versioned endpoints, body limits, and CORS.
