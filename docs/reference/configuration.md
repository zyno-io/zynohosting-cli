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

The saved login (profile) is always the one for that URL, so an explicit `--api-url` is never overridden by an environment. There is no sticky current environment: logging in to alpha does not change what a command without options uses.

Form tools resolve the ZynoSuite API URL from `--suite-api-url` or `ZYNO_SUITE_API_URL`; token renewal resolves ZynoAuth from `--auth-api-url` or `ZYNO_AUTH_API_URL`. Standard environments and recognized Hosting API URLs select matching companion endpoints. When `--api-url` or `--environment` chose the Hosting URL, the companion endpoint is `--suite-api-url` / `--auth-api-url`, else the known environment's defaults for that Hosting URL, else the selected login's saved URL; `ZYNO_SUITE_API_URL`, `ZYNO_AUTH_API_URL`, and `ZYNOHOSTING_ENVIRONMENT` are ignored, so they can never redirect a login chosen by a flag (for example, a production renewal token is never sent to alpha's auth server). Otherwise the order is the flag, then `ZYNO_SUITE_API_URL` / `ZYNO_AUTH_API_URL`, then the `ZYNOHOSTING_ENVIRONMENT` defaults, then the saved login's URL, then the URL inferred from the Hosting API.

## Environment variables

| Variable                       | Sensitive | Purpose                                                                                                                    |
| ------------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| `ZYNOHOSTING_API_KEY`          | yes       | Tenant API key for CLI, CI, or MCP.                                                                                        |
| `ZYNOHOSTING_ACCESS_TOKEN`     | yes       | Advanced user bearer-token injection.                                                                                      |
| `ZYNOHOSTING_TENANT_ID`        | no        | Optional tenant metadata for an injected scoped token.                                                                     |
| `ZYNOHOSTING_TOKEN_EXPIRES_AT` | no        | Optional bearer expiry as epoch milliseconds.                                                                              |
| `ZYNOHOSTING_API_URL`          | no        | Override the Hosting Manager base URL.                                                                                     |
| `ZYNO_SUITE_API_URL`           | no        | Override the ZynoSuite base URL used by form commands and tools.                                                           |
| `ZYNO_AUTH_API_URL`            | no        | Override the ZynoAuth base URL used for renew and revoke.                                                                  |
| `ZYNOHOSTING_ENVIRONMENT`      | no        | Select `production`, `alpha`, or `dev`.                                                                                    |
| `ZYNOHOSTING_CONFIG`           | no        | Override the saved configuration path.                                                                                     |
| `ZYNOHOSTING_LOGIN_URL`        | no        | Override the browser-login SPA URL.                                                                                        |
| `ZYNOHOSTING_MCP_ROOTS`        | no        | Optional platform-delimited local-path allowlist for the MCP process. Omit it to allow any accessible absolute local path. |

## API endpoint validation

A custom API URL:

- must be a valid absolute URL;
- may not contain credentials, query parameters, or a fragment;
- must use HTTPS unless its host is `localhost`, `127.0.0.1`, or `::1`.

Trailing slashes are normalized away.

## Saved configuration schema

The file is JSON, version 2, with one profile per saved login:

```json
{
    "version": 2,
    "profiles": {
        "production": {
            "apiUrl": "https://hosting.api.zyno.app",
            "suiteApiUrl": "https://suite.api.zyno.app",
            "authApiUrl": "https://auth.api.zyno.app",
            "accessToken": "...",
            "tenantId": "...",
            "expiresAt": 1784246400000,
            "scopedToken": true,
            "renewalKey": "11111111-1111-4111-8111-111111111111"
        },
        "alpha": {
            "apiUrl": "https://hosting.api-alpha.zyno.dev",
            "apiKey": "..."
        },
        "url:https://hosting.example.com": {
            "apiUrl": "https://hosting.example.com",
            "apiKey": "..."
        }
    }
}
```

The profile key is `production`, `alpha`, or `dev` when the Hosting API URL is that environment's URL, otherwise `url:` followed by the normalized Hosting API URL. `login` writes only the selected profile, `logout` removes only the selected profile (`logout --all` removes every profile), and token renewal rewrites only its own profile, re-reading the file under the config lock so profiles saved meanwhile are kept. `login`, `logout`, and renewal all take that same lock around each write.

If the selected profile has no credential but others do, the command fails with `missing_config` (exit 2) and lists the saved logins.

### Migration

A file without `"version": 2` that has top-level fields (`apiUrl`, `apiKey`, ...) is read as a single profile, keyed from its stored `apiUrl` (production when absent). A legacy login to alpha is therefore found with `--environment alpha`, not by a command without options. The v2 file is created the next time anything is saved (for an explicit `ZYNOHOSTING_CONFIG` holding a flat object, that file is rewritten in place); the legacy credential is never dropped.

Within a profile, do not combine `apiKey` and `accessToken`. `tenantId` records the tenant resolved by the authorization page, but request authentication relies on the tenant-bound JWT and does not send that value as a header.

`renewalKey` is only an opaque reference. The renewal token itself is stored in the operating system credential store and must never appear in this file. Removing or copying the JSON file does not copy the renewable credential. On Linux, renewable login requires a working Secret Service and the `secret-tool` command.

## Paths

| Platform        | Default configuration path                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------- |
| macOS and Linux | `$XDG_CONFIG_HOME/zyno/hosting-cli-profiles.json`, then `~/.config/zyno/hosting-cli-profiles.json` |
| Windows         | `%APPDATA%\Zyno\hosting-cli-profiles.json`                                                         |

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
