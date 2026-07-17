# Full deployments

A full deployment synchronizes the deployable portion of a local directory to a hosted site. It always creates an exact plan before any remote mutation.

## Preview a deployment

```bash
zynohosting deploy example.com ./dist --dry-run
```

The plan shows every create, replacement, and deletion plus the number of bytes that must be uploaded. A dry run never applies the plan.

## Apply a deployment

Review the displayed plan and confirm interactively:

```bash
zynohosting deploy example.com ./dist
```

For reviewed, non-interactive automation:

```bash
zynohosting deploy example.com ./dist --yes
```

`deploy-site` is an alias for `deploy`.

## How planning works

The CLI and cluster agent:

1. negotiate protocol limits, hash algorithms, and mandatory ignores;
2. inventory the local and remote deployable trees;
3. identify same-size candidates and hash only those files;
4. finalize the exact create, replace, and delete operations;
5. upload only changed files in the plan;
6. revalidate the remote snapshot before applying it;
7. invalidate the site cache after a successful apply.

Plans are short-lived and bound to the site, cluster, access token, local manifest, and observed remote state. If either side changes incompatibly, create a new plan.

## Ignore rules

Put project-specific patterns in `.zynohostingignore` at the deployment root:

```text
.env*
coverage/
tests/
*.map
```

Use a different file or add rules on the command line:

```bash
zynohosting deploy example.com ./dist \
  --ignore-file ./deploy.ignore \
  --ignore '*.map' \
  --dry-run
```

Patterns use gitignore-style matching. Mandatory platform exclusions cannot be negated by custom rules. See [Mandatory deployment exclusions](../reference/safety#mandatory-deployment-exclusions).

## Empty sources

An empty local deployable scope could delete all remote deployable files. The CLI refuses that operation unless it is explicitly approved:

```bash
zynohosting deploy example.com ./empty-directory --allow-empty --dry-run
zynohosting deploy example.com ./empty-directory --allow-empty
```

Always inspect the dry-run plan before using `--allow-empty`.

## Options

| Option                       | Purpose                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `-y`, `--yes`                | Apply without prompting after displaying the plan.                    |
| `--dry-run`                  | Display the exact plan without applying it.                           |
| `--json`                     | Emit newline-delimited JSON events.                                   |
| `--allow-empty`              | Permit an empty local sync scope to delete remote deployable content. |
| `--ignore <pattern>`         | Add a gitignore-style exclusion; repeatable.                          |
| `--ignore-file <path>`       | Replace `.zynohostingignore` with another file.                       |
| `--timeout <seconds>`        | Set inventory, hash, and apply request timeouts; default `600`.       |
| `--hash-concurrency <count>` | Set concurrent local hash reads; default `8`.                         |

## CI example

```bash
set -euo pipefail
export ZYNO_HOSTING_API_KEY="$HOSTING_DEPLOY_KEY"

zynohosting --environment production deploy example.com ./dist \
  --dry-run \
  --json

zynohosting --environment production deploy example.com ./dist \
  --yes \
  --json
```

Deploy JSON is an event stream rather than one final document. See [JSON and errors](../reference/json-and-errors#deployment-event-stream).

## Permission

Planning and applying require `hosting.deploy`.
