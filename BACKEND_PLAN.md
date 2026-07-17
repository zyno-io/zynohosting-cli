# ZynoHosting automation backend contract

This document describes protocol version 1 used by `@zyno-io/zynohosting`. JSON control requests go to the Hosting Manager. File bytes, deployment archives, and download archives go directly between the client and the site’s cluster node.

## Manager routes

All manager routes are tenant-scoped and require normal Zyno/API-key authentication.

### `GET /v1/sites`

Requires `hosting.sitesRead`.

Returns authorized sites:

```json
[
    {
        "id": "11111111-1111-4111-8111-111111111111",
        "fqdn": "example.com",
        "status": "active",
        "phpVersion": null
    }
]
```

### `GET /v1/sites/{siteRef}`

Requires `hosting.sitesRead`. `siteRef` may be a site UUID, primary hostname, vanity hostname, or alias.

The response additionally includes the site’s hostnames.

### `POST /v1/sites/{siteRef}/access-sessions`

Issues a short-lived site- and cluster-bound Ed25519 capability.

Request:

```json
{
    "protocolVersion": 1,
    "scopes": ["files:list", "files:read"]
}
```

Response:

```json
{
    "protocolVersion": 1,
    "site": {
        "id": "11111111-1111-4111-8111-111111111111",
        "fqdn": "example.com",
        "status": "active",
        "phpVersion": null
    },
    "endpoints": {
        "deploy": "https://site.vanity.example/@zh/deploy/v1",
        "files": "https://site.vanity.example/@zh/files/v1"
    },
    "scopes": ["files:list", "files:read"],
    "accessToken": "...",
    "expiresAt": "2026-07-16T18:00:00.000Z"
}
```

The manager rejects any requested scope whose corresponding tenant permission is absent.

### `POST /v1/sites/{siteRef}/cache/purge`

Queues cache invalidation after an authorized full deployment or individual file mutation. It accepts `hosting.deploy`, `hosting.filesWrite`, or `hosting.filesDelete`.

## Agent capability scopes

| Token scope                                       | Required manager permission                        |
| ------------------------------------------------- | -------------------------------------------------- |
| `deploy:inventory`, `deploy:hash`, `deploy:apply` | `hosting.deploy`                                   |
| `files:list`, `files:read`                        | `hosting.filesRead`                                |
| `files:write`                                     | `hosting.filesWrite`                               |
| `files:delete`                                    | `hosting.filesDelete`                              |
| `download:deployable`                             | `hosting.download`                                 |
| `download:sensitive`                              | `hosting.download` and `hosting.downloadSensitive` |

Tokens contain the site ID, cluster ID, unique token ID, protocol version, exact scopes, upload limit, download limit, issued-at time, not-before time, and expiry.

Nginx injects the rendered site ID and a private hop token before proxying the public `@zh` routes to the node agent. The agent validates:

- the private hop token;
- Ed25519 signature and key ID from the cluster snapshot;
- issuer, audience, protocol, time bounds, and requested scope;
- token cluster ID against the local cluster;
- token site ID against the Nginx-injected site ID;
- site availability in the trusted agent snapshot.

## File protocol

Public base path: `/@zh/files/v1`.

All paths are UTF-8, relative to the site document root, slash-separated, and may not contain empty components, `.`, `..`, backslashes, control characters, or symbolic-link traversal.

### `GET /capabilities`

Requires `files:list`. Returns protocol version and configured entry, path, individual-file, and complete-download limits.

### `GET /entries?path={path}&recursive={boolean}`

Requires `files:list`. Returns regular files, directories, symbolic links, and other entry types as metadata. Listing never follows symbolic links.

Each entry contains:

```json
{
    "path": "index.html",
    "type": "file",
    "size": 1024,
    "modifiedAt": "2026-07-16T17:00:00.000Z",
    "etag": "\"opaque-value\""
}
```

### `GET /content?path={path}`

Requires `files:read`. Only regular files may be read. The agent opens with no-follow semantics, snapshots the file while running as the site UID/GID, verifies it did not change during the copy, and then streams the snapshot.

Response headers include `Content-Length`, `ETag`, and `Last-Modified`.

### `PUT /content?path={path}`

Requires `files:write`. The raw request body is bounded by both the configured file limit and token upload limit.

Optional preconditions:

- `If-Match: {etag}` — replace only the observed version;
- `If-None-Match: *` — create only.

The upload is staged, ownership is changed to the site UID/GID, safe parents are verified, and the staged file is atomically renamed into place.

### `DELETE /content?path={path}`

Requires `files:delete`. Deletes regular files only. `If-Match` is supported.

### `POST /archives`

Requires `download:deployable` or `download:sensitive`.

Request:

```json
{ "scope": "deployable" }
```

The response is a gzip-compressed tar stream. The worker runs as the site UID/GID, omits links and special files without following them, reports the skipped-entry count, enforces entry and uncompressed-byte limits, and applies mandatory deployment ignores for the deployable scope.

## Deployment protocol

Base path: `/@zh/deploy/v1`.

The existing manifest protocol remains:

- `GET /capabilities`
- `POST /inventory`
- `POST /plans/{planId}/hashes`
- `PUT /plans/{planId}/apply`

Plans are bound to the access token ID, site, cluster, remote inventory, local manifest, and expiry. Apply revalidates relevant remote metadata before mutation and extracts only the files explicitly required by the finalized plan.

## Filesystem isolation

Every node filesystem worker:

- is executed with the site UID/GID using `setpriv` when the agent runs as root;
- receives a minimal environment and no supplementary groups;
- confines normalized paths to the site document root;
- rejects symbolic-link parents and final symlink reads;
- uses staging directories inside the site home;
- performs conditional checks immediately before mutation;
- rejects unsupported entry types;
- returns bounded JSON metadata while file/archive bytes use streaming HTTP responses.

## Analytics authorization

Existing analytics read routes require `hosting.analyticsRead`; analytics creation, attachment, feature, retention, and configuration changes require `hosting.analyticsManage`. Tenant admins bypass the per-operation check through their normal admin grant.
