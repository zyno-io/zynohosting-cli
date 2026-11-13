# Configuration reference

The CLI and MCP server resolve their API endpoint and credential independently for each process.

## Resolution order

Credentials are selected in this order:

1. command options;
2. environment variables;
3. the saved configuration file.

The effective Hosting API URL is chosen in this order, flags before environment variables:

1. `--api-url`;
2. `--environment`;
3. `ZYNOHOSTING_API_URL`;
4. `ZYNOHOSTING_ENVIRONMENT`;
5. the `production` default.

The saved profile is always the one for that URL, so an explicit `--api-url` is never overridden by an environment. There is no sticky current environment: logging in to alpha does not change what a command without options uses.

Form tools resolve the ZynoSuite API URL from `--suite-api-url` or `ZYNO_SUITE_API_URL`; token renewal resolves ZynoAuth from `--auth-api-url` or `ZYNO_AUTH_API_URL`. Standard environments and recognized Hosting API URLs select matching companion endpoints. When `--api-url` or `--environment` chose the Hosting URL, the companion endpoint is `--suite-api-url` / `--auth-api-url`, else the known environment's defaults for that Hosting URL, else the selected login's saved URL; `ZYNO_SUITE_API_URL`, `ZYNO_AUTH_API_URL`, and `ZYNOHOSTING_ENVIRONMENT` are ignored, so they can never redirect a login chosen by a flag (for example, a production renewal token is never sent to alpha's auth server). Otherwise the order is the flag, then `ZYNO_SUITE_API_URL` / `ZYNO_AUTH_API_URL`, then the `ZYNOHOSTING_ENVIRONMENT` defaults, then the saved login's URL, then the URL inferred from the Hosting API.

## Environment variables

| Variable                       | Sensitive | Purpose                                                                                                                        |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ZYNOHOSTING_API_KEY`          | yes       | Tenant API key for CLI, CI, or MCP.                                                                                            |
| `ZYNOHOSTING_ACCESS_TOKEN`     | yes       | Advanced user bearer-token injection.                                                                                          |
| `ZYNOHOSTING_TENANT_ID`        | no        | Optional tenant metadata for an injected scoped token.                                                                         |
| `ZYNOHOSTING_TOKEN_EXPIRES_AT` | no        | Optional bearer expiry as epoch milliseconds.                                                                                  |
| `ZYNOHOSTING_API_URL`          | no        | Override the Hosting Manager base URL.                                                                                         |
| `ZYNO_SUITE_API_URL`           | no        | Override the ZynoSuite base URL used by form commands and tools.                                                               |
| `ZYNO_AUTH_API_URL`            | no        | Override the ZynoAuth base URL used for renew and revoke.                                                                      |
| `ZYNOHOSTING_ENVIRONMENT`      | no        | Select `production`, `alpha`, or `dev`.                                                                                        |
| `ZYNOHOSTING_CONFIG`           | no        | Override the saved configuration path.                                                                                         |
| `ZYNOHOSTING_TENANT`           | no        | Tenant name or id of the saved login to use, like `--tenant`. The flag wins.                                                   |
| `ZYNOHOSTING_ACCOUNT`          | no        | Account email or id that narrows `ZYNOHOSTING_TENANT`, like `--account`. The flag wins.                                        |
| `ZYNOHOSTING_CREDENTIAL_STORE` | no        | `system` (default) or `file`: where a renewable login keeps its renewal token. `--credential-store` wins. Needs `--renewable`. |
| `ZYNOHOSTING_LOGIN_URL`        | no        | Override the browser-login SPA URL.                                                                                            |
| `ZYNOHOSTING_MCP_ROOTS`        | no        | Optional platform-delimited local-path allowlist for the MCP process. Omit it to allow any accessible absolute local path.     |

## API endpoint validation

A custom API URL:

- must be a valid absolute URL;
- may not contain credentials, query parameters, or a fragment;
- must use HTTPS unless its host is `localhost`, `127.0.0.1`, or `::1`.

Trailing slashes are normalized away.

## Saved configuration schema

The file is JSON, version 3, with one profile per environment. A profile holds one login per account and tenant, keyed `<accountId>:<tenantId>`, and the id of the active one:

```json
{
    "version": 3,
    "profiles": {
        "production": {
            "apiUrl": "https://hosting.api.zyno.app",
            "suiteApiUrl": "https://suite.api.zyno.app",
            "authApiUrl": "https://auth.api.zyno.app",
            "logins": {
                "aaaaaaaa-0000-4000-8000-00000000000a:00000000-0000-0000-0000-0000000000a1": {
                    "accountId": "aaaaaaaa-0000-4000-8000-00000000000a",
                    "tenantId": "00000000-0000-0000-0000-0000000000a1",
                    "tenantName": "Acme Co",
                    "accountEmail": "owner@example.com",
                    "grantExpiresAt": 1784851200000,
                    "accessToken": "...",
                    "expiresAt": 1784246400000,
                    "renewalKey": "11111111-1111-4111-8111-111111111111",
                    "renewalStore": "file",
                    "scopedToken": true,
                    "permissionKeys": ["hosting.sitesRead", "hosting.deploy"],
                    "createdAt": 1784242800000
                },
                "bbbbbbbb-0000-4000-8000-00000000000b:00000000-0000-0000-0000-0000000000a1": {
                    "accountId": "bbbbbbbb-0000-4000-8000-00000000000b",
                    "tenantId": "00000000-0000-0000-0000-0000000000a1",
                    "tenantName": "Acme Co",
                    "accountEmail": "bob@example.com",
                    "accessToken": "...",
                    "expiresAt": 1784246400000,
                    "scopedToken": true
                },
                "aaaaaaaa-0000-4000-8000-00000000000a:00000000-0000-0000-0000-0000000000b2": {
                    "accountId": "aaaaaaaa-0000-4000-8000-00000000000a",
                    "tenantId": "00000000-0000-0000-0000-0000000000b2",
                    "tenantName": "Globex",
                    "accessToken": "...",
                    "expiresAt": 1784246400000,
                    "scopedToken": true
                }
            },
            "activeLogin": "aaaaaaaa-0000-4000-8000-00000000000a:00000000-0000-0000-0000-0000000000a1"
        },
        "alpha": {
            "apiUrl": "https://hosting.api-alpha.zyno.dev",
            "apiKey": "...",
            "activeLogin": "api-key"
        },
        "url:https://hosting.example.com": {
            "apiUrl": "https://hosting.example.com",
            "apiKey": "..."
        }
    }
}
```

The profile key is `production`, `alpha`, or `dev` when the Hosting API URL is that environment's URL, otherwise `url:` followed by the normalized Hosting API URL.

| Login field                     | Meaning                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `accountId`, `tenantId`         | The account that approved the login and the tenant it is bound to. Together they are its key in `logins`: `<accountId>:<tenantId>`. |
| `tenantName`, `accountEmail`    | Shown by `logins` and `whoami`. Newer servers send them; older ones do not, and the tenant id is shown instead.                     |
| `grantExpiresAt`                | Epoch milliseconds. The end of the lifetime the approver chose. Renewal stops there. Absent when the server did not say.            |
| `accessToken`, `expiresAt`      | The current 60-minute access token and its expiry (epoch milliseconds).                                                             |
| `renewalKey`, `renewalStore`    | Reference to the renewal token. `renewalStore` is `"file"` for the file store and absent for the system credential store.           |
| `scopedToken`, `permissionKeys` | Marks a scoped CLI token, and the permissions it was approved for.                                                                  |

A profile may also hold one `apiKey`, which `logins` lists as `API key` (id `api-key`), and a `pendingDeviceLogin` while a `login --device --no-wait` sign-in is waiting for `--resume`. The pending record holds the device code, so treat the file as secret, as before.

`login` writes only the selected profile, adding the login for the approved account and tenant (replacing only a login for that same pair) and making it active. `logout` removes one login, or with `--all` every login in every profile. Token renewal rewrites only its own login. The profiles lock covers the whole profile: each write re-reads the file under the lock, so logins saved meanwhile are kept. A renewal holds the whole-profile lock for its duration (taking the legacy file's lock first when that file holds the same login), so two processes never consume the same one-time renewal token. The file store takes its own lock after the profiles lock, never the reverse.

If the selected profile has no credential but others do, the command fails with `missing_config` (exit 2) and lists the saved logins. If it has several logins and none is active, the command fails with `login_selection_required`.

### Migration

The profiles file is version 3. A build that knows only version 2 refuses a version 3 file with an `invalid_config` error ("unsupported config version 3") and leaves it untouched, so no login is lost. This CLI reads version 2 files, migrates them in memory, and writes version 3 the next time anything is saved.

A profile from version 2 holds one credential directly (`accessToken`, `tenantId`, `expiresAt`, `renewalKey`, `scopedToken`), and the flat `hosting-cli.json` holds the same. Either is read as a single login and made active. Any login keyed by tenant id alone is re-keyed to `<accountId>:<tenantId>`: the account comes from the stored `accountId`, else from the `sub` claim of the access token (the account id for a scoped token), and a login whose account cannot be read stays usable under `unknown:<tenantId>`. If two stored entries would get the same key, the newer one is kept and the other is retired: its grant is revoked on a best-effort basis and its renewal token removed. The tenant name is filled in the next time a login renews.

A file without a `version` that has top-level fields (`apiUrl`, `apiKey`, ...) is read as a single profile, keyed from its stored `apiUrl` (production when absent). A legacy login to alpha is therefore found with `--environment alpha`, not by a command without options. The v3 file is created the next time anything is saved; for an explicit `ZYNOHOSTING_CONFIG` holding a flat object, that file is rewritten in place, and the legacy credential is never dropped.

Released builds up to 0.5.0 read only the flat `hosting-cli.json` at the default location and are unaffected by the new file there. The exception is an explicit `ZYNOHOSTING_CONFIG`: this build rewrites a flat file there as version 3, and 0.5.0 reads a version 3 file as empty and would overwrite it. Do not point 0.5.0 and newer builds at the same `ZYNOHOSTING_CONFIG` file.

`tenantId` records the tenant resolved by the authorization page, but request authentication relies on the tenant-bound JWT and does not send that value as a header.

`renewalKey` is only an opaque reference. With the system credential store the renewal token lives in the operating system and must never appear in this file. With `renewalStore: "file"` it lives in the token file described below. Removing or copying the JSON file does not copy a system-stored renewable credential. On Linux, a system-stored renewable login requires a working Secret Service and the `secret-tool` command.

## Paths

| Platform        | Default configuration path                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| macOS and Linux | `$XDG_CONFIG_HOME/zyno/hosting-cli-profiles.json`, then `~/.config/zyno/hosting-cli-profiles.json` |
| Windows         | `%APPDATA%\Zyno\hosting-cli-profiles.json`                                                         |

The file store keeps renewal tokens in `<name>.renewal-tokens.json` next to the profiles file (`hosting-cli-profiles.renewal-tokens.json` by default), as `{"version":1,"tokens":{"<renewalKey>":{"token":"zrt_…","updatedAt":<ms>}}}`. It is created only by `--credential-store file`, with mode `0600` in a `0700` directory.

Earlier versions wrote a flat `hosting-cli.json` in the same directory. Older builds read a v2 file as empty and would overwrite it, so v2 lives in the new file and `hosting-cli.json` is only a read-only migration source: it is read as one profile while the new file does not exist, never written, and ignored once the new file exists. A logout that removes a login also deletes `hosting-cli.json` if it holds that same credential, so an older build cannot keep using it. `ZYNOHOSTING_CONFIG` is the v2 path and has no legacy sibling.
Use `ZYNOHOSTING_CONFIG` to isolate credentials by environment or automation context.

## Non-interactive checklist

For CI and unattended MCP processes:

1. store a tenant API key in the platform secret manager;
2. inject it as `ZYNOHOSTING_API_KEY`;
3. set `ZYNOHOSTING_ENVIRONMENT` explicitly;
4. grant only the permissions required by the workflow;
5. avoid `--api-key` because command-line arguments may be observable;
6. use `--json` and check the process exit code.
