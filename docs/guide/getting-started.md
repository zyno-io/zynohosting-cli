# Getting started

::: tip Not a developer?
If you use an AI agent such as Claude, Codex, Grok Bot, or ChatGPT dots, start with [Set up an agent](../agents/) instead. This page is for using the command line directly.
:::

`@zyno-io/zynohosting` provides two executables:

- `zynohosting` for people, coding agents, and CI jobs;
- `zynohosting-mcp` for local stdio MCP clients, mainly the Claude desktop app.

Both clients use the same Hosting Manager API, permission model, and short-lived site capabilities.

## Requirements

- Node.js 24
- a ZynoSuite account or tenant API key
- access to at least one ZynoHosting site

## Install the CLI

Install it globally when you use it regularly:

```bash
npm install --global @zyno-io/zynohosting
zynohosting --version
```

Or run the published package without a global install:

```bash
npx -y @zyno-io/zynohosting sites list
```

## Sign in

Interactive users can sign in through ZynoSuite:

```bash
zynohosting login --permission hosting.sitesRead
```

CI jobs should inject a tenant API key rather than save a browser session:

```bash
export ZYNOHOSTING_API_KEY='your-tenant-api-key'
```

See [Authentication](./authentication) for credential precedence, environments, and non-interactive setup.

## Confirm site access

List the sites granted to the current tenant credential:

```bash
zynohosting sites list
```

Then inspect one site by UUID or hostname:

```bash
zynohosting sites get example.com
```

## Choose a workflow

### Work with individual files

```bash
zynohosting files list example.com
zynohosting files get example.com index.html --output ./index.html
```

Continue with [Individual files](../cli/files).

### Deploy a directory

Always inspect the exact synchronization plan first:

```bash
zynohosting deploy example.com ./dist --dry-run
zynohosting deploy example.com ./dist
```

Continue with [Full deployments](../cli/deploy).

### Try a change on preview, then promote it

Every site has a separate preview slot at its own hostname:

```bash
zynohosting deploy example.com ./dist --preview --dry-run
zynohosting deploy example.com ./dist --preview
zynohosting promote example.com
```

Preview shares the live site's database, and promotion replaces production wholesale. Read [Preview and production](./preview) before you use it, especially for WordPress.

### Connect an agent

For Codex or Claude Code, paste this into the agent:

> Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md

The agent installs a skill file that teaches it this CLI, then carries on in the same session. The desktop app's Chat and Cowork tabs cannot run a CLI; they install the signed desktop extension instead. See [CLI, skill, or MCP](../agents/interfaces) for the reasoning and [Set up an agent](../agents/) for per-agent steps and copy-and-paste prompts.

## Global options

These options apply to the CLI and may be placed before a command:

| Option                  | Purpose                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `-V`, `--version`       | Print the installed package version.                                                |
| `--api-url <url>`       | Override the Hosting Manager API URL.                                               |
| `--suite-api-url <url>` | Override the ZynoSuite API URL.                                                     |
| `--auth-api-url <url>`  | Override the ZynoAuth API URL.                                                      |
| `--environment <name>`  | Select `production`, `alpha`, or `dev`.                                             |
| `--api-key <key>`       | Supply a tenant API key. Prefer the environment variable in automation.             |
| `--tenant <name\|id>`   | Use this saved login (a login id, tenant id, or tenant name) for this command only. |
| `--account <email\|id>` | Narrow `--tenant` when several accounts are signed in to one tenant.                |
| `--json`                | Emit machine-readable output where the command supports it.                         |

::: tip
Run `zynohosting <command> --help` to see command-specific options for the installed release.
:::

## Next steps

- Starting from scratch? See [Building a site](./building-a-site) for what ZynoHosting can run and why Astro is the recommended starting point.
- Learn how [credentials and environments](./authentication) are resolved.
- Review the [safety model](../reference/safety) before granting an agent write access.
- Check [permissions](../reference/permissions) when an operation is forbidden.
- Use [JSON output and exit codes](../reference/json-and-errors) in CI.
