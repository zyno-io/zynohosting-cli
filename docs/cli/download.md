# Complete downloads

Complete downloads stream a gzip-compressed site archive directly from the hosting node and safely extract it into a new or empty local directory without staging a second archive on either side.

## Download the deployable scope

```bash
zynohosting download example.com ./site-copy
```

The default scope mirrors what a full deployment manages. Platform configuration, generated caches, user uploads, logs, VCS data, dependencies, links, and special files are not included.

For non-interactive use:

```bash
zynohosting download example.com ./site-copy --yes --json
```

## Include sensitive content

Protected configuration and user-generated content require a separate permission and explicit option:

```bash
zynohosting download example.com ./complete-copy --sensitive
```

::: danger
A sensitive snapshot may contain secrets, customer data, uploaded content, and application credentials. Protect its destination and do not commit it to source control.
:::

## Destination requirements

The destination must be either:

- a path that does not exist; or
- an empty directory.

Extraction happens in a temporary sibling directory. The CLI requires a complete transport, gzip stream, tar stream, and server completion marker before atomically moving the staged tree into place. Existing non-empty directories are never overlaid.

## Archive safety

The downloader rejects:

- absolute and traversal paths;
- duplicate or invalid archive destinations;
- symbolic links and hard links;
- devices and other special entries;
- entries outside protocol size and count limits.

The node agent also omits links and special files without following them and reports how many entries were skipped.

## Options

| Option                | Purpose                                                     |
| --------------------- | ----------------------------------------------------------- |
| `--sensitive`         | Include protected configuration and user-generated content. |
| `-y`, `--yes`         | Download without prompting.                                 |
| `--json`              | Emit one JSON result; requires `--yes`.                     |
| `--timeout <seconds>` | Set the streamed-body inactivity timeout; default `600`.    |

## Permissions

| Scope               | Required permission                                |
| ------------------- | -------------------------------------------------- |
| Deployable snapshot | `hosting.download`                                 |
| Sensitive snapshot  | `hosting.download` and `hosting.downloadSensitive` |

## Verify a backup

A completed command proves transport and safe extraction, not application-level recoverability. For important backups, compare an inventory or hash manifest and test restoration in an isolated environment.
