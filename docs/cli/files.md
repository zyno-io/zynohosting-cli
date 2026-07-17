# Individual files

File commands operate on regular files relative to a site’s document root. They are useful for targeted inspection and small changes that do not need a full directory synchronization.

## List files

List one directory:

```bash
zynohosting files list example.com
zynohosting files list example.com wp-content/themes
```

List a complete subtree:

```bash
zynohosting files list example.com wp-content/themes --recursive
```

Options:

| Option                | Purpose                                 |
| --------------------- | --------------------------------------- |
| `-r`, `--recursive`   | Include the complete subtree.           |
| `--json`              | Emit one JSON document.                 |
| `--timeout <seconds>` | Set the request timeout; default `600`. |

Listings report regular files, directories, symbolic links, and other entry types as metadata. The agent never follows symbolic links.

## Download one file

```bash
zynohosting files get example.com index.html --output ./index.html
```

Use `--force` to replace an existing local destination. Use `--output -` to stream bytes to standard output; `--json` cannot be combined with standard-output file bytes.

The download accepts regular files only and is written atomically to the local destination.

## Create or replace a file

```bash
zynohosting files put example.com ./index.html index.html
```

Require a new remote path:

```bash
zynohosting files put example.com ./robots.txt robots.txt --create
```

`--create` maps to a create-only precondition. The command fails instead of replacing an existing file.

## Use ETag preconditions

Every file listing and successful write returns an ETag. Use it to ensure the remote file has not changed since you inspected it:

```bash
zynohosting files put example.com ./index.html index.html \
  --etag '"etag-from-list"'
```

A stale ETag fails with `precondition_failed`; the newer remote file remains untouched.

## Delete a file

Interactive deletion asks for confirmation:

```bash
zynohosting files rm example.com obsolete.html
```

For reviewed automation, use `--yes` and preferably an ETag:

```bash
zynohosting files rm example.com obsolete.html \
  --etag '"etag-from-list"' \
  --yes
```

`files delete` is an alias for `files rm`.

## Cache invalidation

After a successful upload or deletion, the CLI asks the Hosting Manager to invalidate the site cache. A mutation is reported separately if it applied but cache invalidation could not be queued.

## Path rules

Remote paths are UTF-8 and relative to the site document root. The client and node agent reject:

- absolute paths;
- empty path components, `.` and `..`;
- backslashes and control characters;
- symbolic-link traversal;
- non-regular-file reads, writes, and deletes.

See the [Safety model](../reference/safety) for the complete isolation design.

## Permissions

| Operation          | Permission            |
| ------------------ | --------------------- |
| List and download  | `hosting.filesRead`   |
| Create and replace | `hosting.filesWrite`  |
| Delete             | `hosting.filesDelete` |
