# Preview and production

Every ZynoHosting site has two content slots: **production**, which the live site serves, and **preview**, a separate directory served at its own hostname. You deploy to preview, check it, then **promote** it to production in one step.

Preview is not a staging environment. It has its own files but shares everything else with production, including the database.

## The model

| Slot       | Directory on the node | Served at                                      | Written by                                                                                                                    |
| ---------- | --------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Production | `public_html`         | The primary hostname, aliases, and vanity host | `deploy`, every `files` command, SFTP, `promote`                                                                              |
| Preview    | `preview_html`        | The preview hostname only                      | `deploy --preview` (MCP: `plan_deploy` with `target: "preview"`), `promote`, SFTP by navigating to the sibling `preview_html` |

Shared between the two slots:

- **One database.** Preview has no database of its own. A form submission, login, plugin setting, or migration on the preview hostname changes the live site's data.
- **One storage quota.** Preview files, and production archives awaiting cleanup, count against the same limit.
- **Everything else:** PHP version and settings, sessions, the Unix user, and SFTP credentials.

Nothing is copied into preview. It starts empty and stays empty until you deploy to it. It is not a copy of production.

## Hostnames

A site has three kinds of hostname. Only one of them serves preview.

| Kind             | Example                                     | Serves     | Use it for                                                                |
| ---------------- | ------------------------------------------- | ---------- | ------------------------------------------------------------------------- |
| Custom (primary) | `example.com`                               | Production | The real site. `deployments.production.url` always points here.           |
| Vanity           | `example-com.aspen.zynohosting.net`         | Production | Reaching production before the custom domain's DNS points at ZynoHosting. |
| Preview          | `example-com-preview.aspen.zynohosting.net` | Preview    | Checking preview content. Always `deployments.preview.url`.               |

The vanity hostname is **not** a preview. It shows the live site under a platform name. The primary hostname is always the custom domain, so `deployments.production.url` points there even before its DNS reaches ZynoHosting. Until it does, the vanity hostname is the only working production address.

Never construct the preview hostname from the vanity one. Older sites whose `-preview` name was already taken use `--preview` instead. Read the URL from the site:

```bash
zynohosting sites get example.com
```

```text
example.com
ID: 11111111-1111-4111-8111-111111111111
Status: active
PHP: static
Production: https://example.com
Preview: https://example-com-preview.aspen.zynohosting.net
Hostnames:
  example-com-preview.aspen.zynohosting.net (preview)
  example-com.aspen.zynohosting.net (vanity)
  example.com (custom)
```

With `--json`, the same values are `deployments.production.url` and `deployments.preview.url`. `deployments.production.deploymentId` stays `null` until the first promotion, then changes with every promotion.

## What each operation touches

| Operation                                                | Production                                           | Preview                          |
| -------------------------------------------------------- | ---------------------------------------------------- | -------------------------------- |
| `deploy` / `plan_deploy` (default)                       | Synchronized                                         | Unchanged                        |
| `deploy --preview` / `plan_deploy` `target: "preview"`   | Unchanged                                            | Synchronized                     |
| `files list\|get\|put\|rm` and the MCP file tools        | Read or changed                                      | **Cannot reach it**              |
| `download` / `plan_download`                             | Downloaded                                           | **Cannot reach it**              |
| `promote` / `apply_promote`                              | Replaced by preview; old copy archived, then deleted | Reset to empty                   |
| SFTP                                                     | Default working directory                            | Sibling `preview_html` directory |
| Anything that writes to the database, on either hostname | **Changed**                                          | **Changed**                      |

## Deploy, check, promote

The preview workflow, end to end:

```bash
# 1. Read both URLs and confirm the site.
zynohosting sites get example.com

# 2. Plan, then apply, a preview deployment.
zynohosting deploy example.com ./dist --preview --dry-run
zynohosting deploy example.com ./dist --preview --yes

# 3. Open the preview URL and check it.

# 4. Plan, then apply, the promotion.
zynohosting promote example.com --dry-run
zynohosting promote example.com --yes
```

Promotion is a directory swap, not a copy:

1. Production `public_html` is renamed to an archive.
2. Preview `preview_html` is renamed to `public_html` and goes live.
3. A new, empty `preview_html` is created.
4. A background job deletes the archive once the site has reconciled.

`promote` waits for the site to finish reconciling and reports the new production deployment ID. If it times out, it reports `promotion_pending` with the operation ID. The promotion is still going ahead. Do not run `promote` again to "retry" it.

Never promote twice in a row. After a promotion, preview is empty. Promoting it again replaces the live site with an empty directory, and nothing checks for that. Deploy to preview again before the next promotion.

There is no rollback. The archive is not restorable through the CLI, the MCP server, or the portal. To undo a promotion, deploy the previous build to production.

A dry run does not freeze preview. Whatever is in preview when the promotion runs is what goes live. A single `promote` run records the production deployment ID when it plans and sends it with the request, so the manager rejects it if another promotion landed in between. A separate `--dry-run` saves nothing, and the later `--yes` run plans again from scratch. If someone else may have promoted since your dry run, check that preview still holds your deployment before promoting. (`plan_promote` and `apply_promote` in the MCP server do carry the plan across.)

## When not to use preview

Promotion replaces production with exactly what is in preview. Preview only ever contains what `deploy --preview` uploaded, and `deploy` never uploads [platform-managed paths](../reference/safety#mandatory-deployment-exclusions). Anything in production outside the deployable scope is therefore missing from preview and is removed from the live site on promotion.

Deploy straight to production instead, and skip preview, when production holds anything your project does not build:

- **WordPress.** `wp-config.php` and `wp-content/uploads/` are never deployed, and the CLI and MCP file tools cannot write to preview, so a WordPress preview built with them never holds its configuration or media. Promotion is blocked when production has `wp-config.php` and preview does not. `--force` overrides that block and takes the configuration and media out of the live site. Without `wp-config.php`, the preview hostname shows the WordPress installer rather than the site.
- **User or runtime content.** Uploaded files, generated files, caches, or logs that the application writes into its document root.
- **Hand edits.** Files added to production with `files put`, SFTP, or a plugin, and not committed to the project.

Preview and promotion fit sites whose entire document root comes from a build: static sites, and PHP sites that keep their state in the database.

Even then, remember that preview uses the live database. Don't use it to test a schema migration, an import, or anything else that writes data you would not write to production.

## Similar words, different things

| You see                                                      | It means                                                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `deploy --dry-run` (older docs: "preview a deployment")      | Show a deployment plan without uploading. Works with either slot. Unrelated to the preview slot.            |
| `--preview`, `target: "preview"`                             | Write to the preview slot.                                                                                  |
| Portal **Open production** (older portal builds: **Launch**) | Open production in a browser. Uses the primary hostname, or the vanity hostname when the domain isn't live. |
| WordPress **Launch preview** (older portal builds)           | Open _production_ on the vanity hostname. Not the preview slot.                                             |
| Portal **Preview:** link on the site header                  | Open the preview slot.                                                                                      |
| "Go live", "publish", "launch" in a request                  | Ambiguous. Ask whether to deploy to production or promote preview.                                          |

The portal shows the preview URL and the shared-database notice. It does not yet upload to preview or promote. Use the CLI, the MCP tools, or the API.

## Permissions

Preview deployments and promotion use `hosting.deploy`. Inspecting URLs uses `hosting.sitesRead`. No other permission exists for them.

## See also

- [Full deployments](../cli/deploy#preview-sites-and-promotion): every flag, the WordPress guard, and the API calls.
- [MCP tools](../mcp/tools#preview-promotion): `plan_promote` and `apply_promote`.
- [JSON and errors](../reference/json-and-errors#promotion-output): `promotion_pending`, `promotion_failed`, and `preview_unavailable`.
