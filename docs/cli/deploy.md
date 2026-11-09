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

The plan and result identify the target and its URL. Preview is served at the site's separate
`<username>-preview.<cluster>.<vanity>` hostname (backed by wildcard DNS/TLS); use the URL shown in
the plan or `sites get`, because some older sites use a different suffix. Preview starts empty, and
uploading or editing it leaves production unchanged. If the manager does not confirm the preview
target, the CLI stops before uploading.

To publish the current preview files to the production hostname:

```bash
zynohosting promote example.com --dry-run
zynohosting promote example.com
zynohosting promote example.com --yes --json
```

Promotion displays both URLs and asks for confirmation unless `--yes` or `--dry-run` is supplied.
`--json` requires either of those options. `--timeout <seconds>` (default `900`) covers the
request and waiting for serving reconciliation. The command reports success only when
reconciliation succeeds; a failed or pending operation reports its ID. Inspect a pending operation
before submitting another promotion.

Promotion renames production to an archive, renames preview into production, and creates a new
empty preview. Nothing is copied, including configuration and uploaded media. A background job
purges the archive after reconciliation; until then it counts toward the site's quota. There is no
deployment-history or rollback API.

A dry run does not freeze preview: whatever is in preview when the node applies the promotion
becomes production. The manager rejects the promotion if another promotion changed the production generation since
planning; create a fresh plan in that case. Ordinary file edits do not advance that generation.

### WordPress configuration guard

Promotion is blocked when production has `wp-config.php` and preview does not. The manager checks
before queuing and the node checks again immediately before rotating directories. To deliberately
replace WordPress production with that preview, pass `--force`:

```sh
zynohosting promote example.com --force
# Noninteractive: add --yes (and optionally --json).
```

`--force` bypasses only this check; the plan shows it with a warning. `--yes` only skips the
confirmation prompt and never forces promotion.

### Shared resources

Preview has no separate database and uses the main site’s database. It also shares the main
site’s storage quota, PHP settings, sessions, and Unix identity. Database changes from preview can
affect the live site.

The CLI uses the manager's existing access-session protocol with `target: "preview"`, then
`POST /v1/sites/{siteRef}/promote` with `expectedProductionDeploymentId` (and `force` when
selected). It polls the returned `/reconciliations/{operationId}` operation. Individual-file and
download commands continue to target production.

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
