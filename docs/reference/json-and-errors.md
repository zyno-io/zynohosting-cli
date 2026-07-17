# JSON output and errors

Use machine-readable output and process exit codes for automation. Human-readable messages may evolve; JSON codes and structured results are the stable integration surface.

## Single-document output

Site, file, and download commands emit one JSON value with `--json`:

```bash
zynohosting sites list --json
zynohosting files list example.com --json
zynohosting download example.com ./copy --yes --json
```

Errors are written as one JSON object:

```json
{
    "type": "error",
    "code": "precondition_failed",
    "message": "file precondition failed",
    "details": {
        "code": "precondition_failed",
        "message": "file precondition failed"
    }
}
```

Do not assume `details` is always present.

## Deployment event stream

Deploy emits newline-delimited JSON because planning and applying have multiple stages:

```bash
zynohosting deploy example.com ./dist --dry-run --json
```

Event types are:

| Type               | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `progress`         | A current planning or apply stage.                                   |
| `plan`             | Exact operations, display groups, counts, ignores, and upload bytes. |
| `dry_run_complete` | Planning completed without mutation.                                 |
| `result`           | Apply result with create/replace/delete counts and duration.         |
| `cancelled`        | Interactive apply was declined.                                      |

Consume one JSON object per line rather than parsing the complete standard output as a single document.

## Exit codes

| Exit code | Category                                                                  |
| --------- | ------------------------------------------------------------------------- |
| `0`       | Success.                                                                  |
| `1`       | Unexpected CLI or runtime failure.                                        |
| `2`       | Invalid local input, unsafe path, configuration, or missing confirmation. |
| `3`       | Authentication or authorization failure, including expired login.         |
| `4`       | Remote API failure or failed ETag/create-only precondition.               |
| `5`       | Invalid, incompatible, or unsafe manager/agent response.                  |
| `6`       | Unknown or expired plan/session.                                          |
| `7`       | The node agent could not apply a deployment.                              |
| `8`       | Mutation applied, but cache invalidation could not be queued.             |

::: danger Exit code 8
The remote mutation already succeeded. Do not blindly retry the deployment as though nothing changed; inspect the site and retry cache invalidation through an approved operational path.
:::

## Common error codes

| Code                        | Typical resolution                                                |
| --------------------------- | ----------------------------------------------------------------- |
| `missing_config`            | Run `zynohosting login` or provide an API key.                    |
| `login_expired`             | Run interactive login again.                                      |
| `invalid_environment`       | Use `production`, `alpha`, or `dev`.                              |
| `confirmation_required`     | Use a terminal, `--dry-run`, or reviewed `--yes`.                 |
| `precondition_failed`       | Refresh the file listing and review the new ETag/content.         |
| `plan_expired`              | Create and review a new plan.                                     |
| `unsafe_local_path`         | Choose an absolute destination inside an allowed MCP root.        |
| `unsupported_protocol`      | Upgrade the CLI or resolve cluster version skew.                  |
| `cache_invalidation_failed` | Treat the mutation as applied and investigate cache invalidation. |

## Shell example

```bash
set +e
zynohosting files put example.com ./index.html index.html --json >result.json
status=$?
set -e

if [ "${status}" -ne 0 ]; then
  echo "ZynoHosting operation failed with exit code ${status}" >&2
  exit "${status}"
fi
```

When file content is streamed with `files get --output -`, standard output contains bytes and cannot also contain JSON.
