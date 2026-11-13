---
name: zynohosting
description: Publish, update, inspect, back up, and preview websites hosted on ZynoHosting, and create, edit, and embed ZynoForms, using the `zynohosting` CLI. Use when the user wants to build a new website to host on ZynoHosting, deploy or publish a site to ZynoHosting, deploy to a preview site, promote preview to production (go live), change how a site handles missing pages (single-page-app fallback), check which sites they can access, edit, upload, or delete individual hosted files, download a hosted site, sign in to ZynoHosting, or add, change, or connect a ZynoForms form.
---

# ZynoHosting CLI

Drive ZynoHosting through its CLI. Every command below runs in your shell. You do not need an MCP server, and nothing has to be restarted.

## Run the CLI

Requires Node.js 24. Use `zynohosting` if it is on `PATH`. Otherwise prefix every command with `npx -y @zyno-io/zynohosting`. That always runs the latest release.

```bash
npx -y @zyno-io/zynohosting --version
npx -y @zyno-io/zynohosting <command> --help   # authoritative options for the installed release
```

The examples below write `zynohosting`. Substitute the `npx` form if needed.

There is no TTY in an agent shell, so the CLI never prompts you. `deploy`, `promote`, and `sites set` need `--dry-run` or `--yes`, and `download` and `files rm` need `--yes`. Without them they exit with `confirmation_required`. `files put` has no confirmation and no dry run: it uploads the moment you run it.

## Rules

1. **Never guess the site.** Use only a domain the user stated or the project explicitly names. Don't infer one from the repository, the site content, the company name, or a similar entry in `sites list`. If none is stated, ask.
2. **Never substitute another site.** If `sites get <domain>` fails, say that this login cannot reach it. Before suggesting a new sign-in, check the other saved logins (`zynohosting logins --json`) and try one with `--tenant`. Only if none reaches it, offer to sign in again, since they may need another account or organization.
3. **Plan, show, wait, apply.** Run the `--dry-run` first and show the user the target slot, URL, and the create/replace/delete counts. Run with `--yes` only after they approve. Get approval before `files put` and `files rm` too, since they have no dry run. Re-run the dry run if anything changed in between. The `--yes` run plans again and applies at once.
4. **Never add `--force`, `--allow-empty`, or `--sensitive` on your own.** Each needs the user's explicit request for that specific effect.
5. **Exit code 8 means the change already happened.** Do not retry as if it failed.

Exit codes: `0` success; `1` unexpected failure (including an unsupported Node version); `2` invalid input, unsafe path, configuration, or missing confirmation; `3` authentication or authorization (expired login, missing permission); `4` remote API failure or failed precondition; `5` an invalid or unsafe response from the service; `6` unknown or expired plan; `7` the node agent could not apply a deployment; `8` applied, but cache invalidation could not be queued.

## Sign in

`login` picks how the user signs in. On a computer with a browser it opens the browser and waits up to 300 seconds. Over SSH, or on a machine with no display (including your own cloud computer), it uses a **link and a short code** that the user opens on any device. `--device` forces the link and code; `--no-device` forces the browser.

Logins are saved per environment; production is the default. For alpha or dev, pass `--environment alpha` on `login` and on every later command. Plain `logout` removes only the default login of the selected environment; to sign out completely, run `zynohosting logout --all`.

Request the narrowest complete permission set for the task. `hosting.sitesRead` is always needed. Add `--renewable` so the 60-minute token renews itself.

| Task                                                                | Add these permissions                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Look at sites only                                                  | none                                                                    |
| Deploy, deploy to preview, promote, or change missing-page handling | `hosting.deploy`                                                        |
| Read individual files                                               | `hosting.filesRead`                                                     |
| Upload or replace individual files                                  | `hosting.filesRead`, `hosting.filesWrite`                               |
| Delete individual files                                             | `hosting.filesDelete` as well                                           |
| Create forms                                                        | `forms.create`                                                          |
| Edit forms, their origins, or bot protection                        | `forms.edit`                                                            |
| Back up the site                                                    | `hosting.download` (`hosting.downloadSensitive` for uploads and config) |

### Sign in with a link and code (use this unless you are on the user's own computer with a browser)

This works in every agent shell, including ones that show a command's output only when it exits.

1. Start it. It prints JSON and exits at once:

    ```bash
    zynohosting login --device --no-wait --json --name "<agent> — <project>" --renewable \
      --permission hosting.sitesRead --permission hosting.deploy
    ```

    Read `verificationUriComplete` (or `verificationUri`) and `userCode` from the `login_started` line. Never print or ask for anything else from it.

2. Give the user the link and the code exactly as printed. Tell them to open the link on any device, check that the code on the page matches, choose how long the access lasts, tick the confirmation box, and approve. Tell them to approve only a code you just asked for, and never one someone else sent them.

3. Wait for them. Run this as a long-running command with a timeout above 300 seconds (it waits up to 300 seconds by itself; if your shell has a shorter limit, add `--timeout <seconds>` below it, and run the command again on `login_pending`):

    ```bash
    zynohosting login --resume --json
    ```

    It waits up to 300 seconds. If it exits with `login_pending` (exit 3), the user has not approved yet: run it again. When the `result` line appears, it is done. If the code expired, start again from step 1.

4. Say "Signed in as `<account>` (`<tenant>`)" using `account` and `tenantName` from the `result` line, and ask the user to confirm it is their account and organization. If it is not, run `zynohosting logout` and start again. Then run `zynohosting sites list` to check that it works.

After sign-in, check `permissionKeys` and `deniedPermissionKeys` in the `result` line (or the printed "Not granted" text). If any were not granted, tell the user exactly which ones and what that means: the approver does not hold them in that organization, so anything that needs them will fail with a 403. Do not request them again unless the user asks you to. If they do, someone who holds those permissions has to approve the new sign-in.

`--lifetime 1h|1d|7d|30d` only suggests how long the access lasts; the user decides on the approval page. Anything above `1h` needs `--renewable`.

On a computer where a browser can open and the user is present, `zynohosting login --name "<agent> — <project>" --renewable --permission hosting.sitesRead --permission <the others the task needs>` opens the page directly. Run it as a long-running command with a timeout above 300 seconds. If the user says nothing opened, stop it and use the link-and-code steps above.

### Credential storage on your own cloud computer

A renewable login keeps its renewal token in the system credential store. A cloud computer usually has none, and `login` stops with `credential_store_unavailable` before anything is approved. On a computer that only you use, add `--credential-store file` (or set `ZYNOHOSTING_CREDENTIAL_STORE=file`). The token is then kept in a private file next to the saved logins. Never read, print, copy, or upload that file or the saved logins file, and never use the file store on the user's own computer.

### Several logins

A person can belong to several organizations (tenants). A login is one account in one organization, and the CLI keeps each one. Before you change anything, run `zynohosting logins --json`. If there is more than one login, ask the user which organization they mean, then pass `--tenant "<name or id>"` on every command, for example `zynohosting sites list --tenant "Acme Co"`. If two accounts are signed in to that organization the command fails with `login_ambiguous` and lists them; ask the user which account, then add `--account <email>`. Do not rely on the default login, and do not run `logins use` unless the user asks to change the default. Signing in again as the same account to the same organization replaces that login; signing in as another account or to another organization adds a login. `zynohosting logout --tenant "<name or id>" [--account <email>]` removes one login.

### Sign-in errors

| Code                                                             | What to do                                                                                                                                                                                             |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `login_denied`                                                   | The user denied it. Ask whether to try again.                                                                                                                                                          |
| `device_code_expired`                                            | The code ran out or was already used. Start again from step 1.                                                                                                                                         |
| `device_credential_lost`                                         | The connection dropped as it was approved. Start again from step 1.                                                                                                                                    |
| `device_flow_unavailable`                                        | This server does not offer link-and-code sign-in. Use the browser flow on a computer with one.                                                                                                         |
| `login_pending`                                                  | Not approved yet. Run `login --resume --json` again.                                                                                                                                                   |
| `no_pending_login`                                               | Nothing to resume. Start from step 1.                                                                                                                                                                  |
| `grant_expired`                                                  | The approved time ran out. Sign in again and ask the user for a longer time.                                                                                                                           |
| `credential_store_unavailable`                                   | See the credential storage section above.                                                                                                                                                              |
| `credential_store_insecure`                                      | The token file is a symlink or readable by others. On your own cloud computer only, and with the user's OK, set the file to mode 0600 and its directory to 0700, or delete the file and sign in again. |
| `invalid_lifetime`                                               | Use 1h, 1d, 7d or 30d, and `--renewable` for anything above 1h.                                                                                                                                        |
| `login_selection_required`, `login_not_found`, `login_ambiguous` | Ask the user which organization (and account), then pass `--tenant` and `--account`.                                                                                                                   |

A token cannot gain permissions later. On `login_expired`, a permission error (exit 3), or a need for more scope, run `zynohosting logout` and then `login` with the complete set. `zynohosting login --help` lists every valid permission. Invented keys are rejected.

In CI, set `ZYNOHOSTING_API_KEY` instead of logging in.

## Inspect a site

```bash
zynohosting sites list
zynohosting sites get example.com            # Production URL, Preview URL, hostnames
zynohosting sites get example.com --json     # deployments.production.url, deployments.preview.url
```

## Build a new site

ZynoHosting serves static files, plus PHP 7.4–8.5 on sites that have PHP turned on. It runs no Node.js, Python, Ruby, or other server process. Server-side rendering, API routes, server functions, and background workers are unavailable. Deploy finished files only.

- **Recommend Astro** for a new site unless the user wants something else. Keep its default static output and add no server adapter (`@astrojs/node`, Vercel, Netlify, and so on). Run `npm run build` and deploy `dist/`, never the project root. Other static builds follow the same rule: deploy only the build output (Vite `dist/`, Eleventy `_site/`, Hugo `public/`, Next.js with `output: 'export'` gives `out/`).
- **Without a build tool,** write plain HTML, CSS, and JavaScript files and deploy that folder.
- **Use PHP only for real server-side code.** Contact and signup forms don't need it; use [ZynoForms](#zynoforms).
- **Check the site type.** `sites get <domain>` shows `PHP: static` (JSON `phpVersion: null`) when PHP is off. Such a site answers 404 for every `.php` file. The user can turn PHP on in the ZynoHosting portal under the site's **Settings → Runtime**.
- **Routing.** A static site serves `/path`, then `/path/index.html`, then `/404.html` with status 404, so a client-side router's deep links 404 on reload. Prefer pre-rendering every route, as Astro does. If a client-side router really needs a fallback, ask the user first, then run `zynohosting sites set <domain> --not-found single-page-application --dry-run` and, once they approve, the same with `--yes`. Static sites only (it is rejected on PHP). It takes effect on production and preview immediately, and serves `/index.html` with status 200 for any unknown path unless it ends in a listed asset extension (`.js`, `.css`, images, fonts, `.json`, `.txt`, ...); a missing `/app.js` still 404s. `sites get` shows the setting only on static sites. `sites get <domain>` shows `Not found:` (JSON `notFoundHandling`); `--not-found 404-page` turns it off. A PHP site sends unknown paths to `/index.php`, so a front controller works. nginx serves the site, so `.htaccess` files are ignored.
- **Everything deployed is public.** The deployed folder is the web root, and anything in it that isn't PHP can be downloaded. Never deploy `.env` files, credentials, or private source.
- **The CLI cannot create sites.** Build and check the site locally first (`npm run preview` for Astro). Deploy only to an existing site the user names. If they don't have one yet, tell them to ask ZynoHosting support to set up a site for their domain.

## Deploy to production

```bash
zynohosting deploy example.com ./dist --dry-run
# show the plan, get approval
zynohosting deploy example.com ./dist --yes
```

`deploy` makes the remote deployable scope match the local directory exactly, so remote files that are missing locally are deleted. It never uploads or deletes platform-managed paths: `wp-config.php`, `wp-content/uploads/`, caches, logs, VCS data, and `node_modules/`. Add project exclusions in `.zynohostingignore` or with `--ignore <pattern>`. An empty source needs `--allow-empty` and the user's explicit approval, because it deletes the site's content.

## Preview sites

A site has two slots. **Production** is what the live site serves. **Preview** is a separate directory at its own hostname. You deploy to preview, the user checks it, then you **promote** preview to production.

```bash
zynohosting sites get example.com                          # read the Preview URL; never construct it
zynohosting deploy example.com ./dist --preview --dry-run
zynohosting deploy example.com ./dist --preview --yes      # production is untouched
# user checks the Preview URL
zynohosting promote example.com --dry-run
zynohosting promote example.com --yes
```

Know these before you use preview:

- **The database is shared.** Preview has no database of its own. Anything that writes data on the preview hostname, such as forms, logins, admin changes, or migrations, changes the live site. Say so when you hand the user a preview URL.
- **Preview is not a copy of production.** It starts empty and holds only what `deploy --preview` uploaded.
- **Only `deploy` reaches preview.** `files` commands and `download` act on production only. You cannot edit one preview file. Change the local project and redeploy to preview.
- **Promotion is a swap, not a merge.** Production is replaced by preview wholesale, and anything in production that preview lacks leaves the live site. The old production is archived and then deleted. There is no rollback. To undo, deploy the previous build to production.
- **After promotion, preview is empty.** Never promote twice in a row: the second promotion publishes an empty site. Deploy to preview again first.
- **Don't promote WordPress, or any site with content outside the build.** `deploy` never sends `wp-config.php` or `wp-content/uploads/` to preview, so promotion is blocked. `--force` would remove the configuration and media from the live site. Without `wp-config.php`, the preview hostname shows the WordPress installer rather than the site. The same loss applies to user uploads, runtime-generated files, and files added by hand to production. For these sites, deploy straight to production.
- **The vanity hostname is not preview.** `<name>.<cluster>.zynohosting.net` (kind `vanity`) serves production. Only the `preview` hostname serves preview.
- **"Go live", "launch", or "publish" is ambiguous** once a preview exists. Ask whether they mean deploy to production or promote preview.
- **`promotion_pending` means it is still running.** Do not re-run `promote`. `sites get` cannot tell you whether it finished, because the new deployment ID appears as soon as the promotion is accepted. Report the operation ID to the user.

Full model and hostname table: https://cli.zyno.host/guide/preview

## Individual files (production only)

```bash
zynohosting files list example.com [dir] [--recursive] --json
zynohosting files get example.com path/in/site --output ./local-file
zynohosting files put example.com ./local-file path/in/site --etag '<etag>'
zynohosting files put example.com ./new-file path/in/site --create
zynohosting files rm example.com path/in/site --etag '<etag>' --yes
```

Paths are relative to the document root. Pass the ETag exactly as `files list` prints it, including its double quotes (for example `--etag '"5f2c-1a"'`), so you never overwrite a file that changed since you looked. Both `files put` and `files rm` change the live site immediately.

## Download a site (production only)

```bash
zynohosting download example.com ./site-copy --yes --json
```

The destination must be new or empty. `--sensitive` also includes `wp-config.php` and user uploads. Use it only when the user asks for a complete backup and the destination is appropriate for secrets.

## Machine-readable output

Add `--json` to any command. `deploy`, `promote`, and `sites set` emit one JSON event per line: `progress`, `plan` or `promotion_plan` or `site_settings_plan`, then `dry_run_complete`, `result`, `promotion_result`, or `site_settings_result`. Errors go to stderr as `{"type":"error","code":...}`.

| Exit | Meaning                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2    | Bad input, not signed in (`missing_config`), or missing `--yes`/`--dry-run`                                                                            |
| 3    | Login expired or missing permission                                                                                                                    |
| 4    | Remote failure, ETag precondition failed, or promotion refused (production changed, WordPress guard, site still reconciling)                           |
| 6    | Plan or session expired, or a precondition no longer holds: re-plan                                                                                    |
| 7    | Node could not apply, or promotion or a site-settings change failed/still pending (`reconciliation_failed`/`_pending`: re-run `sites set`, it resumes) |
| 8    | Change applied but cache invalidation failed: don't retry                                                                                              |

## ZynoForms

`zynohosting forms <command>` reads one JSON object from `--input` and prints one JSON document. Errors go to stderr as JSON. Pass input inline (`--input '{"form":"contact-us"}'`), from a file (`--input @edit.json`), or on stdin (`--input -`). Prefer a file for anything longer than a line.

| Command          | Does                                                                 | Permission                                                |
| ---------------- | -------------------------------------------------------------------- | --------------------------------------------------------- |
| `list`           | List the tenant's forms with links and iframe snippets (no input)    | sign-in only                                              |
| `describe`       | Fields, keys, types, what is editable, and any blocking draft        | sign-in only                                              |
| `integration`    | Live field aliases, endpoints, iframe, and JSON/HTML/script examples | sign-in only                                              |
| `create`         | Create **and publish** a one-page form                               | `forms.create` (+ `hosting.sitesRead` for `origin_sites`) |
| `update`         | Edit name, wording, emails, and add/update/move/remove fields        | `forms.edit`                                              |
| `bot-protection` | Set Cap protection: `interactive`, `invisible`, or `disabled`        | `forms.edit`                                              |
| `origins`        | Add or remove allowed browser origins, or a site's hostnames         | `forms.edit` (+ `hosting.sitesRead` for sites)            |
| `guide`          | The embedding guide as Markdown in JSON (no input, no sign-in)       | none                                                      |

```bash
zynohosting forms list
zynohosting forms describe --input '{"form":"contact-us"}'
zynohosting forms create --input @form.json
#   {"name":"Contact","origin_sites":["example.com"],
#    "fields":[{"type":"text","key":"name","label":"Name"},{"type":"email","key":"email","label":"Email"}]}
zynohosting forms update --input @edit.json
#   {"form":"contact-us","expected_definition_id":"<live.definitionId from describe>",
#    "operations":[{"op":"add_field","field":{"type":"phone","key":"phone","label":"Phone","required":false}}]}
```

Input fields and results are identical to the MCP tools of the same purpose (`list_forms`, `describe_form`, `get_form_integration`, `create_basic_form`, `update_form`, `update_form_bot_protection`, `update_form_origins`). The full argument reference, including every field type and operation, is at https://cli.zyno.host/mcp/tools. Unknown keys are rejected.

Rules for forms:

- **Ask before `create`, `update`, `bot-protection`, or `origins`.** They change live forms at once, and `create` publishes immediately. Show the user the planned fields or changes first.
- **Connecting a page:** read the existing page first and keep its markup, layout, and styling. Don't replace it with a generic form. Allow that page's exact origin, and follow the response contract and the `jsonScript` or `capScript` the command returns.
- **Editing:** run `describe` first, edit the existing form in place, and never create a second one. Pass `expected_definition_id` from `describe`. If the form has an unpublished draft, `update` refuses. Tell the user rather than reaching for `"on_existing_draft":"extend"`, unless they ask to build on the draft.
- **When something can't be represented** (a field type, validation rule, choice, or bot protection), explain the limit and ask how to proceed. Never drop it silently.
- Removing or renaming a field key breaks integrations that post that key. Say so before doing it.

## Working with non-technical users

Run every command yourself. Don't ask them to use a terminal. Explain plans in plain terms: which address, what changes, what gets removed. Always give them the URL to check after a deploy or promotion.
