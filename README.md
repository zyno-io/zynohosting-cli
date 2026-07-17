# ZynoHosting CLI and MCP server

`@zyno-io/zynohosting` is the public command-line and local MCP client for ZynoHosting. It can:

- list sites authorized for the current tenant credential;
- inspect, download, upload, and delete individual files;
- preview and apply complete manifest-driven deployments;
- download a complete deployable snapshot or, with the extra permission, all user content;
- expose the same operations to agents through a local stdio MCP server.

The package requires Node.js 24.

Full CLI and MCP documentation is available at [zyno-io.github.io/zynohosting-cli](https://zyno-io.github.io/zynohosting-cli/).

## Install

```bash
npm install --global @zyno-io/zynohosting
zynohosting --help
```

It installs two executables:

- `zynohosting` — the human and CI command-line interface;
- `zynohosting-mcp` — the local stdio MCP server.

You can also run commands without a global install:

```bash
npx -y @zyno-io/zynohosting sites list
```

## Authenticate

For an interactive user:

```bash
zynohosting login
```

For CI or another non-interactive environment, inject a tenant API key:

```bash
export ZYNO_HOSTING_API_KEY='...'
```

The CLI also accepts `--environment production|alpha|dev` and `--api-url`. Credentials are resolved in this order:

1. command options;
2. environment variables;
3. the saved login file.

Relevant environment variables are:

- `ZYNO_HOSTING_API_KEY`
- `ZYNO_HOSTING_ACCESS_TOKEN`
- `ZYNO_HOSTING_TENANT_ID`
- `ZYNO_HOSTING_TOKEN_EXPIRES_AT`
- `ZYNO_HOSTING_API_URL`
- `ZYNO_HOSTING_ENVIRONMENT`
- `ZYNO_HOSTING_CONFIG`
- `ZYNO_HOSTING_LOGIN_URL`

## Sites

```bash
zynohosting sites list
zynohosting sites get example.com
zynohosting sites get 11111111-1111-4111-8111-111111111111 --json
```

A site may be addressed by its UUID, primary hostname, vanity hostname, or authorized alias.

## Individual files

Remote paths are relative to the site document root. Absolute paths, `..`, control characters, backslashes, and symbolic-link traversal are rejected.

```bash
zynohosting files list example.com
zynohosting files list example.com wp-content/themes --recursive

zynohosting files get example.com index.html --output ./index.html
zynohosting files put example.com ./index.html index.html
zynohosting files rm example.com obsolete.html --yes
```

Use ETags to prevent overwriting a file that changed since it was inspected:

```bash
zynohosting files put example.com ./index.html index.html --etag '"etag-from-list"'
zynohosting files rm example.com obsolete.html --etag '"etag-from-list"' --yes
```

Use `--create` to require that an uploaded path does not already exist.

## Full deployment

```bash
zynohosting deploy example.com ./dist
zynohosting deploy example.com ./dist --dry-run
zynohosting deploy example.com ./dist --yes
```

Deployment is always planned before it is applied. The client and node agent:

1. agree on protocol limits and mandatory ignores;
2. inventory local and remote content;
3. hash only same-size candidates;
4. return the exact create, replace, and delete plan;
5. upload only changed files;
6. revalidate the remote snapshot before mutation;
7. invalidate the site cache after a successful apply.

The mandatory deployment scope excludes platform-managed configuration, uploads, caches, logs, VCS data, and dependencies. Add project exclusions in `.zynohostingignore` or with `--ignore`.

An empty local deployment requires `--allow-empty` before it may delete the remote deployable scope.

## Complete download

The default snapshot mirrors the deployable scope:

```bash
zynohosting download example.com ./site-copy
```

Downloading protected configuration and user-generated content requires the separate `hosting.downloadSensitive` permission:

```bash
zynohosting download example.com ./complete-copy --sensitive
```

The destination must be new or empty. Archives are extracted through a staging directory and reject absolute paths, traversal, links, devices, and other unsupported entries.

## Local MCP server

The MCP server is local stdio only. It does not open a port or provide a hosted/cloud MCP endpoint.

Every invocation must have at least one allowed local root. Agent file reads, file writes, deploy sources, ignore files, and download destinations are constrained to those roots after canonical path resolution.

Direct invocation:

```bash
zynohosting-mcp --root /absolute/path/to/project
```

The package’s main binary also exposes the registry-friendly form:

```bash
npx -y @zyno-io/zynohosting mcp --root /absolute/path/to/project
```

Example client configuration:

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

On macOS and Linux, multiple `ZYNO_HOSTING_MCP_ROOTS` use `:` as the delimiter. Windows uses `;`. Repeated `--root` arguments are also supported.

The MCP tools are:

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

Full deploys and downloads intentionally use separate plan/apply calls. Plans are held only in the local MCP process, contain no exposed bearer token, expire with their short-lived access session, and cannot be applied after the server restarts.

## Permissions

The manager maps every access session to explicit hosting permissions:

| Permission                  | Capability                                   |
| --------------------------- | -------------------------------------------- |
| `hosting.sitesRead`         | List and inspect sites                       |
| `hosting.filesRead`         | List files and download individual files     |
| `hosting.filesWrite`        | Create and replace individual files          |
| `hosting.filesDelete`       | Delete individual files                      |
| `hosting.deploy`            | Plan and apply full deployments              |
| `hosting.download`          | Download the deployable snapshot             |
| `hosting.downloadSensitive` | Include protected and user-generated content |
| `hosting.analyticsRead`     | Read hosting analytics                       |
| `hosting.analyticsManage`   | Change analytics configuration               |

Tenant admins receive all hosting permissions by default. Non-admin credentials receive only the operations explicitly granted to them.

## JSON output

Most CLI commands accept `--json`. Deploy emits newline-delimited progress, plan, and result events; list and file commands emit a single JSON document.

## Public API and release process

The [public documentation site](https://zyno-io.github.io/zynohosting-cli/) covers CLI commands, MCP tools, configuration, permissions, and safety. The manager and node-agent contract is documented in [BACKEND_PLAN.md](./BACKEND_PLAN.md). Maintainer release setup and the tag-only mirror design are documented in [RELEASING.md](./RELEASING.md).
