# ZynoHosting CLI and MCP server

`@zyno-io/zynohosting` is the public command-line and local MCP client for ZynoHosting. It can:

- list sites authorized for the current tenant credential;
- inspect, download, upload, and delete individual files;
- plan and apply complete deployments to production or an isolated preview slot;
- promote current preview content to production;
- download a complete deployable snapshot or, with the extra permission, all user content;
- discover, create, inspect, edit, embed, and configure published ZynoForms (MCP only);
- teach coding agents to drive the CLI through one [skill file](./skills/zynohosting/SKILL.md);
- expose the same operations through a local stdio MCP server, packaged as a Claude desktop extension.

The package requires Node.js 24.

Full CLI and MCP documentation is available at [zyno-io.github.io/zynohosting-cli](https://zyno-io.github.io/zynohosting-cli/).

## Install

```bash
npm install --global @zyno-io/zynohosting
zynohosting --help
```

It installs two executables:

- `zynohosting` — the command-line interface for people, coding agents, and CI;
- `zynohosting-mcp` — the local stdio MCP server, mainly for the Claude desktop app and ZynoForms.

You can also run commands without a global install:

```bash
npx -y @zyno-io/zynohosting sites list
```

## Authenticate

For an interactive user:

```bash
zynohosting login --permission hosting.sitesRead
zynohosting login \
  --name "Claude MCP — work laptop" \
  --permission hosting.sitesRead \
  --permission hosting.deploy \
  --permission forms.create \
  --permission forms.edit \
  --renewable
```

Browser login creates a tenant-bound scoped CLI token. `hosting.sitesRead` is requested when no `--permission` is supplied; repeat the option to request the narrowest complete set for your workflow. Access tokens always expire after 60 minutes. `--renewable` stores the rotating renewal credential in the operating system credential store and lets long-running CLI/MCP processes refresh automatically. While MCP remains alive, it renews in the background even when no tools are being called; each request also checks freshness as a backstop. The renewal secret is never written to the JSON config file.

Revoke the saved scoped grant and remove its local credentials with `zynohosting logout`.

For CI or another non-interactive environment, inject a tenant API key:

```bash
export ZYNOHOSTING_API_KEY='...'
```

The CLI also accepts `--environment production|alpha|dev` and `--api-url`. Credentials are resolved in this order:

1. command options;
2. environment variables;
3. the saved login file.

Relevant environment variables are:

- `ZYNOHOSTING_API_KEY`
- `ZYNOHOSTING_ACCESS_TOKEN`
- `ZYNOHOSTING_TENANT_ID`
- `ZYNOHOSTING_TOKEN_EXPIRES_AT`
- `ZYNOHOSTING_API_URL`
- `ZYNO_SUITE_API_URL`
- `ZYNO_AUTH_API_URL`
- `ZYNOHOSTING_ENVIRONMENT`
- `ZYNOHOSTING_CONFIG`
- `ZYNOHOSTING_LOGIN_URL`

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

## Preview and promote

```bash
zynohosting deploy example.com ./dist --preview --dry-run
zynohosting deploy example.com ./dist --preview --yes
zynohosting sites get example.com
zynohosting promote example.com --dry-run
zynohosting promote example.com --yes
```

`deploy` still targets production by default. `--preview` writes only the preview slot, served at
the URL shown in the plan and site details. Preview uploads never promote automatically.

`promote` renames production to an archive and preview into production, then creates an empty
preview. It waits for serving reconciliation; a background job purges the archive. Nothing is
copied. Promotion is blocked if production has `wp-config.php` and preview does not; `--force`
explicitly bypasses only that check, and `--yes` only skips the confirmation prompt.

Preview is served only at the site's `preview` hostname; the vanity hostname serves production.
Only `deploy --preview` writes to preview; `files` and `download` always act on production.
After a promotion preview is empty, so promoting again would publish an empty site. Because
`wp-config.php` and `wp-content/uploads/` are never deployed, WordPress sites should deploy
straight to production rather than promote. See
[Preview and production](https://zyno-io.github.io/zynohosting-cli/guide/preview).

Preview has no separate database and uses the main site’s database. It shares the main site’s
storage quota. Database changes from preview can affect the live site. Both operations use the
existing `hosting.deploy` permission, alongside `hosting.sitesRead` for site inspection. See
[preview and promotion details](docs/cli/deploy.md#preview-sites-and-promotion).

## Complete download

The default snapshot mirrors the deployable scope:

```bash
zynohosting download example.com ./site-copy
```

Downloading protected configuration and user-generated content requires the separate `hosting.downloadSensitive` permission:

```bash
zynohosting download example.com ./complete-copy --sensitive
```

The destination must be new or empty. Archive bytes are extracted as the hosting node generates them; the CLI validates the transport completion, gzip stream, and tar entries before atomically installing the staged tree. Absolute paths, traversal, links, devices, and other unsupported entries are rejected.

## AI agents

Agents with a shell (Claude Code, Codex) use the CLI, guided by the [ZynoHosting skill](./skills/zynohosting/SKILL.md). For a non-technical user, paste this into the agent:

> Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md

The agent writes the skill to `.claude/skills/zynohosting/SKILL.md` or `.agents/skills/zynohosting/SKILL.md` and carries on in the same session: no MCP server, no restart, and nothing in the agent's context until a hosting task comes up. The skill covers sign-in, the domain policy, plan-then-apply, preview and promotion, files, and downloads.

The local MCP server remains for clients without a shell and for ZynoForms:

- **Claude desktop app, Chat and Cowork tabs.** These cannot run a CLI or install anything from a conversation. The user opens the signed desktop extension, [`zynohosting.mcpb`](https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb). It carries the server as a single bundled file, runs on the Node runtime inside Claude Desktop so nothing else has to be installed, and stages newer signed releases so installs do not go stale.
- **ZynoForms in any agent.** The CLI has no forms commands. Codex and Claude Code add the MCP server with [these agent instructions](./docs/mcp/agent.md), then restart.

See [CLI, skill, or MCP](https://zyno-io.github.io/zynohosting-cli/agents/interfaces) for the reasoning, and [Set up and use ZynoHosting in your agent](https://zyno-io.github.io/zynohosting-cli/agents/) for copy-and-paste prompts.

## Local MCP server

The MCP server is local stdio only. It does not open a port or provide a hosted/cloud MCP endpoint. See [Configure the local MCP server](https://zyno-io.github.io/zynohosting-cli/mcp/).

`ZYNOHOSTING_MCP_ROOTS` is an optional local-computer allowlist for the MCP process. When it is unset, local-file tools can use any absolute path the MCP process user can access. When roots are configured, local file reads, writes, deploy sources, ignore files, and download destinations are constrained to them after canonical path resolution.

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
                "ZYNOHOSTING_MCP_ROOTS": "/absolute/path/to/project"
            }
        }
    }
}
```

On macOS and Linux, multiple `ZYNOHOSTING_MCP_ROOTS` use `:` as the delimiter. Windows uses `;`. Repeated `--root` arguments are also supported.

The MCP tools are:

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
- `plan_download`
- `apply_download`

Full deploys and downloads intentionally use separate plan/apply calls. Plans are held only in the local MCP process, contain no exposed bearer token, expire with their short-lived access session, and cannot be applied after the server restarts.

The MCP can start without a saved login. The agent calls `login` to open the ZynoSuite browser sign-in flow and receives the one-time URL in its tool result; after the browser callback, it calls `login` with `action: "status"` to confirm the login. It must never infer a deployment domain from the project or select a similar authorized site; it asks when the project does not state the target domain. If the stated domain is unavailable in the current login context, it must not substitute another one and should offer `login` again to switch contexts.

## Permissions

The tenant credential is limited by explicit Hosting and Forms permissions:

| Permission                  | Capability                                                |
| --------------------------- | --------------------------------------------------------- |
| `hosting.sitesRead`         | List and inspect sites                                    |
| `hosting.filesRead`         | List files and download individual files                  |
| `hosting.filesWrite`        | Create and replace individual files                       |
| `hosting.filesDelete`       | Delete individual files                                   |
| `hosting.deploy`            | Deploy production/preview content and promote preview     |
| `hosting.download`          | Download the deployable snapshot                          |
| `hosting.downloadSensitive` | Include protected and user-generated content              |
| `hosting.analyticsRead`     | Read hosting analytics                                    |
| `hosting.analyticsManage`   | Change analytics configuration                            |
| `forms.create`              | Create and immediately publish a basic form               |
| `forms.edit`                | Edit a form, its Cap protection, and allowed CORS origins |

The form discovery and integration tools use the same tenant credential against the ZynoSuite API. Adding origins from a hosting-site reference also requires `hosting.sitesRead`.

Tenant admins receive the normal administrative defaults. Non-admin credentials receive only the operations explicitly granted to them.

That table is the complete set. `zynohosting login --help` prints it, and the MCP `login` tool enumerates it in its schema, so an invented key such as `hosting.sitesWrite` is rejected locally—naming the closest valid key—before a browser opens. CLI-token requests cannot include `msp.login`, `msp.impersonate`, `core.changePassword`, or `core.manageFingerprints`. The browser also refuses unknown permissions and permissions the current user does not possess; it never partially grants a request.

Only one MCP browser flow runs at a time. Repeating `login` with the same request returns the same one-time URL (`"reused": true`); requesting different permissions cancels the in-flight flow and issues a new URL rather than handing back the earlier scope. `action: "cancel"` abandons a flow and closes its loopback listener.

## JSON output

Most CLI commands accept `--json`. Deploy emits newline-delimited progress, plan, and result events; list and file commands emit a single JSON document.

## Public API and release process

The [public documentation site](https://zyno-io.github.io/zynohosting-cli/) covers CLI commands, MCP tools, configuration, permissions, and safety. The manager and node-agent contract is documented in [BACKEND_PLAN.md](./BACKEND_PLAN.md). Maintainer release setup and the tag-only mirror design are documented in [RELEASING.md](./RELEASING.md).

## License

MIT. See [LICENSE](./LICENSE). ZynoHosting and ZynoForms are services of Signal24 LLC dba Zyno Consulting; the license covers this client, not the services it connects to.
