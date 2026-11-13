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

## Promotion output

`promote --yes --json` emits `promotion_plan`, progress events, then `promotion_result` only after
serving reconciliation succeeds. The plan contains both URLs, the expected production deployment
ID, `force`, and a `forceWarning` when `--force` was given. The result contains `deploymentId`,
`operationId`, and `status: "succeeded"`. `promote --dry-run --json` emits the plan and
`dry_run_complete` without a mutation.

Deployment plan/result events include `target` (`production` or `preview`) and the URL when
advertised by the manager. Preview events also include `resourceNotice`.

Promotion errors include `preview_unavailable` for an older manager, `promotion_failed` for a
failed serving reconciliation, and `promotion_pending` when an accepted operation is still pending.
The latter includes its operation ID and status path; inspect that operation before resubmitting.

## Login output

`zynohosting login --json` writes one event per line to stdout and human text to stderr. The device code, access token and renewal token never appear.

| Event                                                                                                                                                            | When                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `{"type":"login_started","flow":"device","reason","verificationUri","verificationUriComplete","userCode","expiresAt","interval"}`                                | A code was issued. `reason` is `explicit`, `ssh`, `no_display` or `loopback_unavailable`. |
| `{"type":"login_started","flow":"browser","reason","url"}`                                                                                                       | The browser flow started.                                                                 |
| `{"type":"login_pending","resume":"zynohosting login --resume"}`                                                                                                 | `--no-wait` saved a pending sign-in, or `--resume` timed out.                             |
| `{"type":"login_resuming","userCode"}`                                                                                                                           | `--resume` began waiting.                                                                 |
| `{"type":"result","status":"authenticated","flow","profile","tenantId","tenantName","account","renewable","credentialStore","accessExpiresAt","grantExpiresAt"}` | The login was saved. Times are ISO strings; the last four fields can be absent.           |
| `{"type":"result","status":"api_key_saved","profile"}`                                                                                                           | `--api-key` was saved.                                                                    |

`zynohosting logins --json` prints `{"profile","logins":[{"id","kind","tenantId","tenantName","account","active","renewable","credentialStore","accessExpiresAt","grantExpiresAt","expired"}]}`, and `zynohosting whoami --json` prints `{"profile","login":{…}}`. Tokens are never listed.

## Exit codes

| Exit code | Category                                                                   |
| --------- | -------------------------------------------------------------------------- |
| `0`       | Success.                                                                   |
| `1`       | Unexpected CLI or runtime failure.                                         |
| `2`       | Invalid local input, unsafe path, configuration, or missing confirmation.  |
| `3`       | Authentication or authorization failure, including expired login.          |
| `4`       | Remote API failure or failed ETag/create-only precondition.                |
| `5`       | Invalid, incompatible, or unsafe manager/agent response.                   |
| `6`       | Unknown or expired plan/session, or a stated precondition no longer holds. |
| `7`       | The node agent could not apply a deployment.                               |
| `8`       | Mutation applied, but cache invalidation could not be queued.              |

::: danger Exit code 8
The remote mutation already succeeded. Do not blindly retry the deployment as though nothing changed; inspect the site and retry cache invalidation through an approved operational path.
:::

## Common error codes

| Code                           | Typical resolution                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `missing_config`               | Run `zynohosting login` or provide an API key.                                                                     |
| `login_expired`                | Log in again, or use `--renewable` for a long-running client.                                                      |
| `renewal_invalid`              | The one-time renewal token is invalid/used; log in again.                                                          |
| `renewal_forbidden`            | Tenant policy prohibits renewal; contact a tenant administrator.                                                   |
| `renewal_missing`              | The OS credential entry is unavailable; log in again.                                                              |
| `credential_store_failed`      | Unlock or repair the operating system credential store.                                                            |
| `credential_store_unavailable` | No system credential service. Use a non-renewable login, or on a computer only you use, `--credential-store file`. |
| `credential_store_insecure`    | The token file is a symlink or readable by others; fix or delete it, then log in again.                            |
| `invalid_credential_store`     | Use `system` or `file`, and only with `--renewable`.                                                               |
| `invalid_lifetime`             | Use `1h`, `1d`, `7d` or `30d`; anything above `1h` needs `--renewable`.                                            |
| `grant_expired`                | The approved lifetime ended (exit 3). Log in again.                                                                |
| `login_denied`                 | The person denied the sign-in (exit 3).                                                                            |
| `device_code_expired`          | The code ran out or was already used (exit 3). Log in again.                                                       |
| `device_credential_lost`       | The connection dropped while the approval was delivered (exit 3). Log in again.                                    |
| `login_pending`                | `login --resume` timed out with nobody approving (exit 3). Run it again.                                           |
| `no_pending_login`             | `login --resume` with nothing started (exit 2). Start with `--device --no-wait`.                                   |
| `device_flow_unavailable`      | The server does not offer the link-and-code sign-in (exit 4). Use the browser flow.                                |
| `login_selection_required`     | Several logins and none is the default (exit 2). Pass `--tenant`.                                                  |
| `login_not_found`              | No saved login matches `--tenant` (exit 2). See `zynohosting logins`.                                              |
| `login_ambiguous`              | More than one login has that tenant name (exit 2). Use the tenant id.                                              |
| `invalid_environment`          | Use `production`, `alpha`, or `dev`.                                                                               |
| `confirmation_required`        | Use a terminal, `--dry-run`, or reviewed `--yes`.                                                                  |
| `precondition_failed`          | Refresh the file listing and review the new ETag/content.                                                          |
| `plan_expired`                 | Create and review a new plan.                                                                                      |
| `unsafe_local_path`            | Choose an absolute destination inside an allowed MCP root.                                                         |
| `unsupported_protocol`         | Upgrade the CLI or resolve cluster version skew.                                                                   |
| `cache_invalidation_failed`    | Treat the mutation as applied and investigate cache invalidation.                                                  |

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
