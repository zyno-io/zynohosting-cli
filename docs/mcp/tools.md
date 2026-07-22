# MCP tool reference

All tools return JSON as structured content and as a text content block. Argument names use snake case.

## Site discovery

### `list_sites`

Lists sites authorized for the current credential.

- Arguments: none
- Mutates remote state: no
- Permission: `hosting.sitesRead`

### `get_site`

Gets one authorized site by UUID or hostname.

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

- direct and iframe embed code;
- stable form-UUID public definition and submission URLs, version-pinned to the live definition, plus the current-definition URL;
- the live definition ID, version, and revision;
- the response contract keyed by stable field alias;
- JSON, URL-encoded, multipart-text, and native HTML examples;
- accepted content types and the 5 MiB body limit;
- a warning when an unpublished draft exists.

JSON is the recommended and OpenAPI-advertised submission format. The runtime also accepts `application/x-www-form-urlencoded` and multipart text fields using names such as `responses[email]` and `responses[contact][firstName]`. Public definition and submission endpoints require no credential.

The native HTML example posts successfully without JavaScript, then navigates to the API’s JSON success response. Intercept the submit event and render an in-page confirmation when that user experience is preferred; cross-origin `fetch` requires the page’s exact origin to be allowed.

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
    "fields": [
        { "key": "name", "label": "Name", "type": "text" },
        { "key": "email", "label": "Email", "type": "email" },
        { "key": "message", "label": "Message", "type": "textarea" }
    ]
}
```

`fields` accepts `text`, `textarea`, `email`, `phone`, `url`, `number`, `date`, `select`, `radio`, `checkbox`, and one `contact` field. Every field has a unique JavaScript-identifier `key`; that becomes its stable submission alias. `required` defaults to `true`.

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

Downloads one regular hosted file into an allowed local root.

```json
{
    "site": "example.com",
    "remote_path": "index.html",
    "local_path": "/absolute/project/index.html",
    "overwrite": false
}
```

| Argument      | Required | Default | Meaning                                    |
| ------------- | -------- | ------- | ------------------------------------------ |
| `site`        | yes      | —       | Site UUID or hostname.                     |
| `remote_path` | yes      | —       | Remote file relative to the document root. |
| `local_path`  | yes      | —       | Absolute destination inside an MCP root.   |
| `overwrite`   | no       | `false` | Replace an existing regular local file.    |

Permission: `hosting.filesRead`.

### `put_file`

Creates or replaces one regular hosted file from an allowed local source.

```json
{
    "site": "example.com",
    "local_path": "/absolute/project/index.html",
    "remote_path": "index.html",
    "etag": "\"etag-from-list\"",
    "create_only": false
}
```

| Argument      | Required | Default | Meaning                                           |
| ------------- | -------- | ------- | ------------------------------------------------- |
| `site`        | yes      | —       | Site UUID or hostname.                            |
| `local_path`  | yes      | —       | Existing regular file inside an MCP root.         |
| `remote_path` | yes      | —       | Remote destination relative to the document root. |
| `etag`        | no       | —       | Replace only if the current ETag matches.         |
| `create_only` | no       | `false` | Fail if the path already exists.                  |

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

Builds and stores an exact full-site synchronization plan without mutating the remote site.

```json
{
    "site": "example.com",
    "local_root": "/absolute/project/dist",
    "ignore": ["*.map"],
    "allow_empty": false
}
```

| Argument      | Required | Default              | Meaning                                                               |
| ------------- | -------- | -------------------- | --------------------------------------------------------------------- |
| `site`        | yes      | —                    | Site UUID or hostname.                                                |
| `local_root`  | yes      | —                    | Existing real directory inside an MCP root.                           |
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

| Category        | Tools                                                               | Review expectation                                      |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------- |
| Remote read     | `list_sites`, `get_site`, `list_forms`, `get_form_integration`      | Safe for routine discovery.                             |
| Local write     | `get_file`, `apply_download`                                        | Confirm the destination and overwrite behavior.         |
| Remote mutation | `create_basic_form`, `update_form_origins`, file/deploy apply tools | Review form/site, fields, origins, paths, and plans.    |
| Plan only       | `plan_deploy`, `plan_download`                                      | Inspect the returned scope and operations before apply. |

The MCP server enforces technical boundaries, but the calling agent or user remains responsible for choosing the intended site and reviewing destructive operations.
