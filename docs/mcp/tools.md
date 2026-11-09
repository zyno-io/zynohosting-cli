# MCP tool reference

All tools return JSON as structured content and as a text content block. Argument names use snake case.

## Site discovery

### `login`

Starts Zyno’s browser login flow from the MCP process and returns its one-time URL in the tool result, then saves the resulting scoped credential for subsequent MCP calls. Use it when no login is saved or when the explicitly requested domain is unavailable in the current login context. After the browser callback completes, call it with `action: "status"` to confirm the login is ready.

| Input             | Required | Default             | Meaning                                                           |
| ----------------- | -------- | ------------------- | ----------------------------------------------------------------- |
| `action`          | no       | `start`             | `start`, `status` to check completion, or `cancel` to abandon it. |
| `permissions`     | no       | `hosting.sitesRead` | Explicit permissions to request, from the list below.             |
| `name`            | no       | host-based CLI name | Name shown on the authorization page.                             |
| `renewable`       | no       | `false`             | Store a rotating renewal credential in the system key store.      |
| `timeout_seconds` | no       | `300`               | Time to wait for browser sign-in to complete.                     |

`permissions` is an enumeration. These are the only valid values; a plausible-looking key such as `hosting.sitesWrite` does not exist, and one invalid entry rejects the whole request rather than granting the remainder:

| Permission                  | Capability                                                    |
| --------------------------- | ------------------------------------------------------------- |
| `hosting.sitesRead`         | List and inspect sites (required by every hosting operation). |
| `hosting.filesRead`         | List files and read individual files.                         |
| `hosting.filesWrite`        | Create and replace individual files.                          |
| `hosting.filesDelete`       | Delete individual files.                                      |
| `hosting.deploy`            | Deploy production/preview content and promote preview.        |
| `hosting.download`          | Download the deployable snapshot.                             |
| `hosting.downloadSensitive` | Include protected and user-generated content in a download.   |
| `hosting.analyticsRead`     | Read hosting analytics.                                       |
| `hosting.analyticsManage`   | Change analytics configuration.                               |
| `forms.create`              | Create and publish a basic form.                              |
| `forms.edit`                | Edit a form, its bot protection, and its allowed origins.     |

Request the narrowest complete set for the stated task, always including `hosting.sitesRead` for hosting work:

| Task                  | Permissions                                                                   |
| --------------------- | ----------------------------------------------------------------------------- |
| Inspect a site        | `hosting.sitesRead`                                                           |
| Read files            | `hosting.sitesRead`, `hosting.filesRead`                                      |
| Edit individual files | `hosting.sitesRead`, `hosting.filesRead`, `hosting.filesWrite`                |
| Remove files          | add `hosting.filesDelete`                                                     |
| Deploy a directory    | `hosting.sitesRead`, `hosting.deploy`                                         |
| Download a snapshot   | `hosting.sitesRead`, `hosting.download`                                       |
| Include user content  | add `hosting.downloadSensitive`                                               |
| Build or edit a form  | `forms.create`, `forms.edit`, and `hosting.sitesRead` to add a site’s origins |

A token’s scope is fixed for its lifetime; a missing permission means logging out and signing in again.

Only one browser flow runs at a time, and the result says which one you received:

- `start` with the same `permissions`, `name`, and `renewable` as the flow already in flight returns that same URL with `"reused": true`.
- `start` with any different request cancels the in-flight flow—closing its loopback listener and invalidating its URL—and returns a new URL with `"reused": false`. The requested scope is never silently replaced by the earlier one.
- `cancel` ends the in-flight flow and reports `cancelled`; it reports `not_pending` when nothing is in flight, and the normal authenticated status when the browser completed sign-in first.

`status` echoes the pending request’s `permissions` so a long-running flow can be checked against what was asked for. The tool cannot replace an API key or bearer token injected into the MCP process. Change that injected credential and restart the MCP host instead.

### `list_sites`

Lists sites authorized for the current credential.

- Arguments: none
- Mutates remote state: no
- Permission: `hosting.sitesRead`

### `get_site`

Gets one explicitly intended, authorized site by UUID or hostname. Do not use this as a way to select a likely deployment domain—ask the user whenever the project does not name one.

```json
{ "site": "example.com" }
```

- `site` — required site UUID, primary hostname, vanity hostname, or alias
- Mutates remote state: no
- Permission: `hosting.sitesRead`

## ZynoForms

### `list_forms`

Lists the tenant’s existing forms. Each item includes form metadata, the customer-facing direct URL, and a ready-to-use iframe snippet.

- Arguments: none
- Mutates remote state: no
- Permission: authenticated tenant access

### `get_form_integration`

Returns everything needed to connect a site to the current live version of one form:

```json
{ "form": "contact-us" }
```

`form` is a form UUID or exact slug; names are intentionally not accepted. The result includes:

- direct and iframe embed code, including an `iframeAutoHeight` variant that resizes the frame to the form;
- stable form-UUID public definition and submission URLs, version-pinned to the live definition, plus the current-definition URL;
- the live definition ID, version, and revision;
- the response contract keyed by stable field alias;
- JSON, URL-encoded, multipart-text, and native HTML examples, plus an instance-scoped `jsonScript` submit helper for a site's own themed form (replaced by `capScript` when the form is Cap-protected);
- the optional public Cap.js `botProtection` configuration and a mode-specific `capScript` example that submits with a Cap proof;
- accepted content types and the 5 MiB body limit;
- a warning when an unpublished draft exists.

JSON is the recommended and OpenAPI-advertised submission format. The runtime also accepts `application/x-www-form-urlencoded` and multipart text fields using names such as `responses[email]` and `responses[contact][firstName]`. Public definition and submission endpoints require no credential.

A site that renders its own themed form posts `{ "responses": { … } }` to the submission endpoint with `POST` and `Content-Type: application/json`. A stored submission answers `200` with `{ "ok": true }`; failures answer `{ "error": "<message>" }` with `400` (rejected value, duplicate field, unpublished definition, failed verification), `404` (unknown tenant, form, or definition), or `413` (body over 5 MiB).

With interactive Cap protection, the native HTML example pins `cap-widget@0.1.56`, renders `<cap-widget>` with the returned `apiEndpoint`, and names its hidden token field `capToken`, so the widget posts the proof as part of the form and the page needs no script of its own. The widget is form-associated and carries `required`, so the browser blocks submission until the visitor solves it. The returned `capScript` example shows how a custom JSON integration can take the solved token from that widget and include it in the payload without rendering an official ZynoForm.

With invisible protection there is no markup-only path: the generated `capScript` takes over the HTML example's submit event, solves Cap with `new Cap({ apiEndpoint }).solve()` from the pinned `cap-widget@0.1.56` script, and posts the answers as JSON with the token under the returned `tokenField` (currently `capToken`). The markup keeps its `action` so a page whose script never loads fails loudly on the API instead of navigating with every answer in the query string, and the result carries a warning saying it cannot post by itself. Disabled protection omits Cap entirely, so legacy HTML and JSON integrations remain valid.

For a `hidden` form field, the response contract identifies its `source` as `urlQueryParameter` and includes its `urlParameter`. It is not a secret: the public form reads that query parameter from its own URL, and generated native HTML enables its hidden control only when the parameter is present. Treat the value as visitor-controlled in every integration.

Use `apiEndpoint` exactly as returned, trailing slash included—the widget appends its own `challenge` and `redeem` paths. Beyond the pinned script, the widget fetches its WebAssembly and pako from `cdn.jsdelivr.net` and calls the Cap endpoint at runtime, so a page with a strict Content-Security-Policy needs both hosts in `script-src` and `connect-src`. A proof is single-use, so each submission needs its own. The API validates the responses before it consumes the proof, so a rejection for a bad field value leaves a solved widget usable; only a spent or expired proof requires verifying again. Cap's endpoint answers any origin, so solving needs no configuration—allowed origins govern the ZynoSuite endpoints only. Both generated scripts post JSON on purpose: a URL-encoded `fetch` skips the CORS preflight, and the submission endpoint withholds only response headers, so an unlisted origin would have its submissions stored and merely hidden. A native `<form>` post is a navigation and is unaffected.

- Mutates remote state: no
- Permission: authenticated tenant access

### `create_basic_form`

Creates a one-page form and immediately publishes version 1. This is deliberately a simple creator rather than the complete ZynoForms authoring model.

```json
{
    "name": "Request a quote",
    "slug": "request-quote",
    "title": "Tell us about your project",
    "submit_label": "Send request",
    "success_message": "Thanks—we’ll be in touch.",
    "notification_emails": ["sales@example.com"],
    "origins": ["https://www.example.com"],
    "origin_sites": ["example.com"],
    "bot_protection": "interactive",
    "fields": [
        { "key": "name", "label": "Name", "type": "text" },
        { "key": "email", "label": "Email", "type": "email" },
        { "key": "message", "label": "Message", "type": "textarea" }
    ]
}
```

- `name` and `fields` are required; `fields` takes 1–100 entries.
- `slug` and `title` are optional.
- `submit_label` defaults to `Submit`; `success_message` defaults to `Thank you. Your response has been submitted.`
- `notification_emails`, `origins`, and `origin_sites` are optional and default to `[]`; each caps at 100 entries.
- `bot_protection` defaults to `interactive`. Choose `invisible` for a programmatic Cap solve after local validation, or `disabled` for a legacy integration that submits no token.
- `notification_emails` lists the To: recipients who receive submission notifications—not a sender or From address—and has no bearing on the recipient domain’s SPF, DKIM, or DMARC records.
- The input schema is strict; unrecognized keys are rejected rather than ignored.

On a Suite deployment that predates Cap, the API can create the form while ignoring the requested protection setting. In that case this tool returns an error that names the already-created form rather than claiming it is protected. Use `disabled` explicitly for a legacy deployment, or upgrade the Suite before creating a protected form.

`fields` accepts `text`, `textarea`, `email`, `phone`, `url`, `hidden`, `number`, `date`, `select`, `radio`, `checkbox`, and one `contact` field. Every field has a unique JavaScript-identifier `key`; that becomes its stable submission alias. `required` defaults to `true` except for `hidden` fields.

A `hidden` field accepts only `key` and `label`. Its key is its public form URL query-parameter name: for example, `?campaign=spring` submits `campaign: "spring"`. It never renders a visible input and is always visitor-controlled; do not use it for secrets or trusted data.

The rendered form and generated HTML enforce required fields in the browser. Custom JavaScript integrations should enforce the returned `required` contract before submitting; the public API cannot generally require conditionally visible fields.

For `select`, supply string `options`. Radio options may be strings or `{ "title": "Shown label", "value": "submitted-value" }`. A contact field has no overall label—the selected details label themselves—and uses this shape:

```json
{
    "key": "contact",
    "type": "contact",
    "fields": ["first_name", "last_name", "email", "phone_cell", "address"]
}
```

Its `fields` may contain `display_name`, `first_name`, `last_name`, `company`, `birthdate`, `phone_cell`, `email`, `address`, and `zip`. Use `zip` for ZIP-only collection; `address` already includes street, ZIP, city, and state.

Exact `origins` are normalized and deduplicated. Each `origin_sites` reference expands through `get_site` to HTTPS origins for its current primary, alias, and vanity hostnames. The result contains the same integration package as `get_form_integration`.

- Mutates remote state: yes; creates and publishes
- Idempotent: no
- Permission: `forms.create`; `hosting.sitesRead` when `origin_sites` is used

### `describe_form`

Describes a form the way it is authored, rather than the way it is submitted to. Read this before editing one.

```json
{ "form": "contact-us", "include_draft": true }
```

`form` is a form UUID or exact slug. The result contains:

- the form summary, its current notification emails, and its public Cap `botProtection` configuration (`null` when protection is disabled);
- the live definition’s id, version, revision, heading, submit label, and success message;
- `pages[].fields[]` in document order—each with the `key` that addresses it, its type in the same vocabulary `create_basic_form` speaks, its label, whether it is required, its constraints, and its enclosing section when it has one;
- `editable` per field, plus `preservedProperties` for stored detail outside this vocabulary and `lockedProperties` for detail that cannot be rewritten without loss (rich radio options, per-part contact configuration);
- `advanced`—the constructs the form holds that these tools preserve but cannot author: sections, conditional rules, multiple pages, themes, translations, CRM contact rules, and review, signature, or display fields;
- `draft`—the same structure for the unpublished draft, when there is one, because a draft blocks editing;
- `editable` and `blockedReason` for the form as a whole.

A stored `text` field carrying `inputType: email` is reported as `email`, and one carrying `format: large` as `textarea`—the words that produced it.

- Mutates remote state: no
- Permission: authenticated tenant access

### `update_form`

Changes an existing form in place, publishing a new version by default:

```json
{
    "form": "contact-us",
    "name": "Contact sales",
    "notification_emails": ["sales@example.com"],
    "operations": [
        { "op": "add_field", "after": "email", "field": { "key": "budget", "type": "number", "label": "Budget", "min": 0 } },
        { "op": "update_field", "key": "message", "label": "How can we help?", "required": false },
        { "op": "move_field", "key": "terms", "page": 2 },
        { "op": "remove_field", "key": "fax" }
    ]
}
```

Metadata arguments—`name`, `slug`, `title`, `submit_label`, `success_message`, `notification_emails`—are each optional and applied only when they differ from what the form already holds. `notification_emails` replaces the list; `[]` clears it. `slug` accepts `null` to remove the public link name.

`operations` apply in order, each addressing a field by its `key` (or its UUID when it has none):

- `add_field` takes the same field shape as `create_basic_form`. Position it with `before`, `after`, or `page`; the default is the end of the last page. An anchor inside a section inserts into that section.
- `update_field` changes only the properties it names: `label`, `required`, `placeholder`, `options`, `enable_other`, `min`, `max`, `step`, `min_length`, `max_length`, `fields` (contact parts), and `new_key` to rename the submission key. A `hidden` field permits only `label` and `new_key`. `null` clears an optional constraint. Changing a field’s type is rejected—remove it and add its replacement, since the field’s identity carries its submission history.
- `remove_field` removes a field, and a section removes the fields inside it.
- `move_field` repositions a field, including into or out of a section.

Fields no operation names keep their UUIDs and every stored property, so an edit never disturbs the rest of the form. Content this vocabulary cannot express—sections, conditions, themes, translations, per-field styling—is carried through untouched. An edit that produces no change writes nothing.

Refused rather than half-applied:

- a field named by a conditional rule cannot be renamed or removed, and neither can one a review field summarizes;
- a field whose type is outside the basic vocabulary cannot be updated, only moved or removed;
- a rich radio option list or a contact field with per-part configuration cannot be replaced, though the rest of that field stays editable;
- adding a second contact field, a duplicate key, or a bound that contradicts its counterpart.

A form has one shared draft, also used by the ZynoForms builder. While an unpublished draft exists `update_form` refuses, rather than overwrite work in progress; pass `on_existing_draft: "extend"` to build on that draft instead. A save quotes the draft revision it was based on—`0` when there was none—so a concurrent save is rejected by the API rather than clobbered. Pass `expected_definition_id` from `describe_form` to have the edit refused if a different version has gone live in the meantime; it is re-checked immediately before the write, though the API offers no atomic compare-and-publish, so a publish landing in that last instant cannot be detected.

`publish` defaults to `true`. With `publish: false` the result is saved as an unpublished draft and the live form is unchanged. The result is the same integration package as `get_form_integration`, plus `applied` (`metadata`, and `definition` as `published`, `draft`, or `unchanged`) and a `changes` list. Metadata is applied before the definition; if the definition step then fails, the error says so.

Removing a field does not affect existing submissions—each is pinned to the definition version it was made against. Renaming a key does break integrations posting the old one.

- Mutates remote state: yes; publishes a new version unless `publish` is false
- Idempotent: no
- Permission: `forms.edit`

### `update_form_bot_protection`

Idempotently configures the form’s public Cap.js protection without changing fields or definitions:

```json
{ "form": "contact-us", "bot_protection": "invisible" }
```

`bot_protection` is one of `interactive`, `invisible`, or `disabled`. The tool returns the same integration package as `get_form_integration`, including the public `botProtection` config and an appropriate `capScript` example, plus `botProtectionChanged` and `botProtectionSetting` — the setting echoed back in this tri-state vocabulary, where the Suite's own `form.botProtectionMode` is `null` for disabled. Repeating the current setting performs no update request. Use `disabled` only for a legacy integration that must continue submitting without a Cap token.

- Mutates remote state: yes; only when the requested setting differs
- Idempotent: yes
- Permission: `forms.edit`

### `update_form_origins`

Idempotently adds or removes exact form CORS origins:

```json
{
    "form": "contact-us",
    "add_origins": ["https://app.example.org"],
    "remove_origins": ["https://old.example.org"],
    "add_sites": ["example.com"],
    "remove_sites": []
}
```

At least one add/remove list must be non-empty. An origin contains only an HTTP(S) scheme, host, and optional port. Site references expand to all current HTTPS hostnames. Adding and removing the same normalized origin in one request is rejected. A request that produces no change skips the update call.

- Mutates remote state: yes; additions and removals apply immediately
- Idempotent: yes
- Permission: `forms.edit`; `hosting.sitesRead` when a site reference is used

A framed form posts `{ type: "zcx:embed:form-height", formId, height }` to its parent on load and on every later height change. `iframeAutoHeight` already listens for it; a hand-written listener must check `event.origin` and, when a page embeds more than one form, identify the frame with `event.source === frame.contentWindow` rather than by `formId`.

For a static integration overview, read the MCP resource `zynoforms://guides/embedding`.

## Individual files

### `list_files`

Lists one hosted directory or subtree without following symbolic links.

```json
{
    "site": "example.com",
    "path": "wp-content/themes",
    "recursive": true
}
```

| Argument    | Required | Default | Meaning                                         |
| ----------- | -------- | ------- | ----------------------------------------------- |
| `site`      | yes      | —       | Site UUID or hostname.                          |
| `path`      | no       | `""`    | Remote directory relative to the document root. |
| `recursive` | no       | `false` | Include the complete subtree.                   |

Permission: `hosting.filesRead`.

### `get_file`

Downloads one regular hosted file to the filesystem of the computer running the MCP process.

When one or more local roots are configured, this tool, `put_file`, `plan_deploy`, and `plan_download` constrain their local paths to those roots. When no roots are configured, they can use any absolute path accessible to the MCP process user.

```json
{
    "site": "example.com",
    "remote_path": "index.html",
    "local_path": "/absolute/project/index.html",
    "overwrite": false
}
```

| Argument      | Required | Default | Meaning                                                   |
| ------------- | -------- | ------- | --------------------------------------------------------- |
| `site`        | yes      | —       | Site UUID or hostname.                                    |
| `remote_path` | yes      | —       | Remote file relative to the document root.                |
| `local_path`  | yes      | —       | Absolute destination; inside an MCP root when configured. |
| `overwrite`   | no       | `false` | Replace an existing regular local file.                   |

Permission: `hosting.filesRead`.

### `put_file`

Creates or replaces one regular hosted file from the MCP process filesystem.

```json
{
    "site": "example.com",
    "local_path": "/absolute/project/index.html",
    "remote_path": "index.html",
    "etag": "\"etag-from-list\"",
    "create_only": false
}
```

| Argument      | Required | Default | Meaning                                                    |
| ------------- | -------- | ------- | ---------------------------------------------------------- |
| `site`        | yes      | —       | Site UUID or hostname.                                     |
| `local_path`  | yes      | —       | Existing regular file; inside an MCP root when configured. |
| `remote_path` | yes      | —       | Remote destination relative to the document root.          |
| `etag`        | no       | —       | Replace only if the current ETag matches.                  |
| `create_only` | no       | `false` | Fail if the path already exists.                           |

The manager queues cache invalidation after a successful write. Permission: `hosting.filesWrite`.

### `delete_file`

Deletes one regular hosted file.

```json
{
    "site": "example.com",
    "remote_path": "obsolete.html",
    "etag": "\"etag-from-list\""
}
```

`etag` is optional but recommended. The manager queues cache invalidation after success. Permission: `hosting.filesDelete`.

## Full deployments

### `plan_deploy`

Builds and stores an exact full-site synchronization plan without mutating the remote site. The site must be the domain the user explicitly chose; never infer it from the project or choose a similar authorized domain.

The optional `target` is `production` by default. Choose `preview` to deploy only the independent
preview slot; the plan and apply result include the selected target and its stable URL. A preview
apply never promotes automatically.

```json
{
    "site": "example.com",
    "local_root": "/absolute/project/dist",
    "target": "preview",
    "ignore": ["*.map"],
    "allow_empty": false
}
```

| Argument      | Required | Default              | Meaning                                                               |
| ------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `site`        | yes      | —                    | Site UUID or hostname.                                                |
| `local_root`  | yes      | —                    | Existing real directory inside an MCP root.                           |
| `target`      | no       | `production`         | `production` or the separate `preview` slot.                          |
| `ignore`      | no       | `[]`                 | Additional gitignore-style patterns.                                  |
| `ignore_file` | no       | `.zynohostingignore` | Absolute path to an alternate ignore file inside an allowed MCP root. |
| `allow_empty` | no       | `false`              | Permit an empty deployable scope to delete remote content.            |

The result includes `planId`, expiry, exact operations, upload bytes, and ignore sources. Permission: `hosting.deploy`.

### `apply_deploy`

Applies an in-memory deployment plan:

```json
{ "plan_id": "019f0000-0000-7000-8000-000000000000" }
```

The plan must come from `plan_deploy` in the same MCP process and must still be valid. A successful apply consumes it and queues cache invalidation. Permission: `hosting.deploy`.

## Preview promotion

### `plan_promote`

```json
{ "site": "example.com" }
```

Reads the explicitly chosen site's current production deployment and both URLs, then stores a
plan for up to 15 minutes in this MCP process. It does not change either slot. The result includes
`planId`, `siteId`, `productionUrl`, `previewUrl`, `expectedProductionDeploymentId`, and expiry.
Present both URLs and the shared-resource notice before applying. The preview directory becomes
production at apply time; planning does not freeze preview files. Permission: `hosting.sitesRead`.

### `apply_promote`

```json
{ "plan_id": "c1224591-e7c0-4c44-b1ee-b8afc5676542" }
```

Renames production to archive and preview into production through the manager's promote API,
creates an empty preview directory, and waits for serving reconciliation. A background job purges the archive. The manager rejects production
changes since planning. Later preview edits leave the promoted files unchanged. A failed
reconciliation is reported as a tool error; an accepted operation can be polled again by retrying
the same plan for up to an hour. Successful apply consumes the plan. Unknown, expired, consumed,
or other-process plan IDs are rejected. Permission: `hosting.deploy`.

Preview has no separate database and uses the main site’s database. It shares the main site’s
storage quota. Database changes from preview can affect the live site. There is no history/rollback API. See
[the CLI feature details](../cli/deploy#preview-sites-and-promotion).

## Complete downloads

### `plan_download`

Authorizes a deployable or sensitive site snapshot into an allowed local destination.

```json
{
    "site": "example.com",
    "local_root": "/absolute/project/site-copy",
    "include_sensitive": false
}
```

| Argument            | Required | Default | Meaning                                               |
| ------------------- | -------- | ------- | ----------------------------------------------------- |
| `site`              | yes      | —       | Site UUID or hostname.                                |
| `local_root`        | yes      | —       | Absolute new or empty destination inside an MCP root. |
| `include_sensitive` | no       | `false` | Include protected and user-generated content.         |

Permissions: `hosting.download`, plus `hosting.downloadSensitive` when `include_sensitive` is true.

### `apply_download`

Downloads and safely extracts a planned snapshot:

```json
{ "plan_id": "c1224591-e7c0-4c44-b1ee-b8afc5676542" }
```

The plan must come from `plan_download` in the same MCP process. A successful apply consumes it.

## Review guidance for agents

Treat these tools as follows:

| Category        | Tools                                                                                                            | Review expectation                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Remote read     | `list_sites`, `get_site`, `list_forms`, `get_form_integration`, `describe_form`                                  | Safe for routine discovery.                                |
| Local write     | `get_file`, `apply_download`                                                                                     | Confirm the destination and overwrite behavior.            |
| Remote mutation | `create_basic_form`, `update_form`, `update_form_bot_protection`, `update_form_origins`, file/deploy apply tools | Review form/site, fields, origins, paths, and plans.       |
| Plan only       | `plan_deploy`, `plan_download`, `plan_promote`                                                                   | Inspect the returned target, scope, and URLs before apply. |

The MCP server enforces technical boundaries, but the calling agent or user remains responsible for choosing the intended site and reviewing destructive operations. Never infer a deployment domain. If an explicitly named domain is unavailable, do not substitute another site; offer `login` so the user can switch contexts.

`plan_promote` accepts `force` (default `false`). Select `force: true` only when deliberately
promoting a preview missing `wp-config.php` over production that has it. The plan displays the
override and a warning; `apply_promote` uses the choice saved in that plan. The override bypasses
only the missing-configuration guard. The manager rechecks files immediately before rotation.
