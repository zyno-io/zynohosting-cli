# Full deployments

A full deployment synchronizes the deployable portion of a local directory to a hosted site. It always creates an exact plan before any remote mutation.

## Inspect a deployment plan

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

## Preview sites and promotion

The default target is production, preserving existing scripts. Add `--preview` to synchronize
the separate preview slot instead:

```bash
zynohosting deploy example.com ./dist --preview --dry-run
zynohosting deploy example.com ./dist --preview --yes
zynohosting sites get example.com
```

The plan and result identify the target and its URL. Preview keeps the site's separate stable
`<username>-preview.<cluster>.<vanity>` URL, backed by wildcard DNS/TLS. Its files start empty when the
manager enables this feature. Uploading or editing them leaves production content unchanged.
An older manager that does not explicitly grant the preview target is rejected before upload.

To publish the current preview files to the production hostname:

```bash
zynohosting promote example.com --dry-run
zynohosting promote example.com
zynohosting promote example.com --yes --json
```

Promotion displays both URLs and asks for confirmation unless `--yes` or `--dry-run` is supplied.
`--json` requires either of those options. `--timeout <seconds>` defaults to `900` for promotion and
waiting for serving reconciliation. The command reports success only when reconciliation succeeds;
a failed or pending operation reports its ID. Inspect pending operations before submitting another
promotion.

Promotion is blocked when production has `wp-config.php` and preview does not. The manager
checks before queuing and again on the node immediately before rotation. To deliberately replace
WordPress production with that preview, pass `--force`:

```sh
zynohosting promote example.com --force
# Noninteractive: add --yes (and optionally --json).
```

`--force` bypasses only this missing-configuration check and is displayed in the plan with a warning.
`--yes` alone does not force promotion. Files and uploaded media are not copied or preserved by the
override; production still moves to an archive that is later purged. Ensure preview contains the
files you intend to publish.

Promotion renames the preview directory that exists at apply time into production. A dry run or MCP plan does not
freeze preview files. The manager checks that production still matches the deployment observed
when planning; if it changed, create a fresh plan. A new empty preview directory is created after promotion. Old production is archived and
purged by a background job. There is no deployment-history or rollback API.

Preview has no separate database and uses the main site’s database. It shares the main site’s
storage quota, PHP settings, sessions, and identity. Database changes from preview can affect the
live site. Archived production files count toward that same quota until the cleanup job purges them.

The CLI uses the manager's existing access-session protocol with `target: "preview"`, then
`POST /v1/sites/{siteRef}/promote` with `expectedProductionDeploymentId` for promotion. It polls
the returned `/reconciliations/{operationId}` operation. Individual-file and download commands
continue to target production.

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
| `--preview`                  | Synchronize the separate preview slot instead of production.          |
| `--json`                     | Emit newline-delimited JSON events.                                   |
| `--allow-empty`              | Permit an empty local sync scope to delete remote deployable content. |
| `--ignore <pattern>`         | Add a gitignore-style exclusion; repeatable.                          |
| `--ignore-file <path>`       | Replace `.zynohostingignore` with another file.                       |
| `--timeout <seconds>`        | Set inventory, hash, and apply request timeouts; default `600`.       |
| `--hash-concurrency <count>` | Set concurrent local hash reads; default `8`.                         |

## CI example

```bash
set -euo pipefail
export ZYNOHOSTING_API_KEY="$HOSTING_DEPLOY_KEY"

zynohosting --environment production deploy example.com ./dist \
  --dry-run \
  --json

zynohosting --environment production deploy example.com ./dist \
  --yes \
  --json
```

Deploy JSON is an event stream rather than one final document. See [JSON and errors](../reference/json-and-errors#deployment-event-stream).

## Permission

Production deployments, preview deployments, and promotion require `hosting.deploy`. Promotion
planning also reads site metadata with `hosting.sitesRead`. No additional login permission is needed.
