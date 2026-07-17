# Configure the local MCP server

The package includes a local stdio MCP server that exposes authorized ZynoHosting operations to agents. It does not open a network port and there is no hosted/cloud MCP endpoint.

## Start the server

Direct executable:

```bash
zynohosting-mcp --root /absolute/path/to/project
```

Registry-friendly package invocation:

```bash
npx -y @zyno-io/zynohosting mcp --root /absolute/path/to/project
```

At least one existing local directory is required. Every local source, destination, deployment root, and ignore file used by a tool must remain inside an allowed root after canonical path resolution.

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

The MCP process inherits the normal saved login unless the client replaces `HOME` or `ZYNO_HOSTING_CONFIG`. For unattended agents, inject `ZYNO_HOSTING_API_KEY` through the client’s secret configuration.

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

## Select an environment

```bash
zynohosting-mcp --environment alpha --root /absolute/path/to/project
```

The MCP binary accepts:

| Option                 | Purpose                                                |
| ---------------------- | ------------------------------------------------------ |
| `--root <path>`        | Add an allowed local root; repeatable.                 |
| `--api-url <url>`      | Override the Hosting Manager URL.                      |
| `--environment <name>` | Select `production`, `alpha`, or `dev`.                |
| `--api-key <key>`      | Supply a tenant API key. Prefer environment injection. |

It also honors the normal [configuration environment variables](../reference/configuration#environment-variables).

## Security boundary

The server canonicalizes existing paths with `realpath`. For a new destination, it finds the nearest existing parent, verifies that parent is a real directory inside an allowed root, and then resolves the remaining suffix. Symbolic-link destinations and escapes are rejected.

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

## Available tools

The server exposes ten tools:

- `list_sites`
- `get_site`
- `list_files`
- `get_file`
- `put_file`
- `delete_file`
- `plan_deploy`
- `apply_deploy`
- `plan_download`
- `apply_download`

See the [MCP tool reference](./tools) for arguments, effects, and permissions.
