# Safety model

The CLI, Hosting Manager, edge proxy, and node agent each enforce a separate part of the boundary. No single client-supplied path, URL, or plan is trusted on its own.

## Site-bound capabilities

The manager issues short-lived Ed25519 capabilities containing the site ID, cluster ID, protocol version, exact scopes, limits, unique token ID, and time bounds.

At the node, the edge and agent validate:

- the private edge-to-agent hop token;
- signature, key ID, issuer, audience, protocol, and time bounds;
- the requested operation against the exact token scope;
- the token cluster against the local cluster;
- the token site against the edge-injected site ID;
- current site availability in the trusted cluster snapshot.

## Remote path confinement

Remote paths are normalized relative to the site document root. Absolute paths, traversal, backslashes, control characters, empty components, and symbolic-link parents are rejected.

Filesystem workers run as the site UID/GID, receive a minimal environment, and have no supplementary groups. Writes use same-filesystem staging and atomic replacement.

## Local MCP roots

MCP local paths must be absolute. Existing paths are canonicalized; new destinations are resolved from a canonical existing parent. The operation is rejected if the result falls outside every configured root.

Allowed roots themselves must be existing real directories. A symbolic link cannot be used as a root or destination escape.

## Deployment plan integrity

A full deployment plan binds:

- the access token ID;
- the site and cluster;
- the local manifest and selected hash algorithm;
- the observed remote inventory;
- an expiration time.

Apply accepts only the files requested by the finalized plan and revalidates relevant remote metadata before mutation. Local file snapshots are checked so content cannot silently change between inventory and archive creation.

## Mandatory deployment exclusions

The client has a fallback set of platform-managed exclusions, and the cluster may add rules. Current fallback patterns include:

```text
.git/
.hg/
.svn/
.zyno/
.zynohostingignore
.DS_Store
Thumbs.db
node_modules/
wp-config.php
wp-content/uploads/
wp-content/mu-plugins/zynohosting-vanity-preview.php
wp-content/mu-plugins/zynohosting.php
wp-content/mu-plugins/zynohosting/
wp-content/cache/
wp-content/et-cache/
wp-content/upgrade/
wp-content/wflogs/
wp-content/ai1wm-backups/
wp-content/updraft/
*.log
```

Custom `.zynohostingignore` and `--ignore` rules may exclude more content but cannot re-include mandatory paths.

## Empty deployment protection

An empty local deployable tree cannot delete the remote deployable scope unless `--allow-empty` or `allow_empty: true` is explicitly supplied. The exact delete plan is still returned for review.

## Archive extraction

Complete downloads are extracted into a temporary sibling directory. The CLI rejects traversal, absolute paths, links, devices, special entries, and duplicates before moving the staged tree into the requested destination.

## Cache invalidation

Successful writes, deletes, and full deployments queue cache invalidation. If the remote mutation succeeds but invalidation cannot be queued after retries, the client reports a distinct exit code so automation does not mistake the operation for an unapplied deployment.

## Operator responsibilities

Technical controls do not choose the intended site or approve business impact. Before a mutation:

- confirm the tenant, environment, and site hostname;
- review full deployment creates, replacements, and deletions;
- use ETags for targeted changes;
- protect sensitive download destinations;
- grant agents the smallest local roots and tenant permissions possible.
