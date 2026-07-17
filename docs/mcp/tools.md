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

| Category        | Tools                                     | Review expectation                                      |
| --------------- | ----------------------------------------- | ------------------------------------------------------- |
| Remote read     | `list_sites`, `get_site`, `list_files`    | Safe for routine discovery.                             |
| Local write     | `get_file`, `apply_download`              | Confirm the destination and overwrite behavior.         |
| Remote mutation | `put_file`, `delete_file`, `apply_deploy` | Review path, site, preconditions, and exact plan.       |
| Plan only       | `plan_deploy`, `plan_download`            | Inspect the returned scope and operations before apply. |

The MCP server enforces technical boundaries, but the calling agent or user remains responsible for choosing the intended site and reviewing destructive operations.
