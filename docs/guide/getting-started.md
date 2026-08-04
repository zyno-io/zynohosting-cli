# Getting started

`@zyno-io/zynohosting` provides two executables:

- `zynohosting` for people and CI jobs;
- `zynohosting-mcp` for local stdio MCP clients.

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

Interactive users can sign in through Zyno:

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

Always preview the exact synchronization plan first:

```bash
zynohosting deploy example.com ./dist --dry-run
zynohosting deploy example.com ./dist
```

Continue with [Full deployments](../cli/deploy).

### Connect an agent

The easiest setup for Codex or Claude Code is to paste this into the agent:

> Set up ZynoHosting MCP for this project if it's not already configured. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/agent.md for details.

The agent performs the installation and then asks the user to restart it. See [Set up and use ZynoHosting in your agent](../mcp/setup) for the copy-and-paste prompts that cover signing in, publishing, and forms.

Restrict local-file access to a project root when the agent should not use the MCP process user's entire accessible filesystem:

```bash
npx -y @zyno-io/zynohosting mcp --root /absolute/path/to/project
```

Continue with [Configure MCP](../mcp/).

## Global options

These options apply to the CLI and may be placed before a command:

| Option                  | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| `-V`, `--version`       | Print the installed package version.                                    |
| `--api-url <url>`       | Override the Hosting Manager API URL.                                   |
| `--suite-api-url <url>` | Override the ZynoSuite API URL.                                         |
| `--auth-api-url <url>`  | Override the ZynoAuth API URL.                                          |
| `--environment <name>`  | Select `production`, `alpha`, or `dev`.                                 |
| `--api-key <key>`       | Supply a tenant API key. Prefer the environment variable in automation. |
| `--json`                | Emit machine-readable output where the command supports it.             |

::: tip
Run `zynohosting <command> --help` to see command-specific options for the installed release.
:::

## Next steps

- Learn how [credentials and environments](./authentication) are resolved.
- Review the [safety model](../reference/safety) before granting an agent write access.
- Check [permissions](../reference/permissions) when an operation is forbidden.
- Use [JSON output and exit codes](../reference/json-and-errors) in CI.
