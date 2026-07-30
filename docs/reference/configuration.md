# Configuration reference

The CLI and MCP server resolve their API endpoint and credential independently for each process.

## Resolution order

Credentials are selected in this order:

1. command options;
2. environment variables;
3. the saved configuration file.

The Hosting API URL is selected from an explicit option, environment variable, selected environment, saved URL, or the production default. Form tools resolve the ZynoSuite API URL from `--suite-api-url` or `ZYNO_SUITE_API_URL`; token renewal resolves Zyno Auth from `--auth-api-url` or `ZYNO_AUTH_API_URL`. Standard environments and recognized Hosting API URLs select matching companion endpoints.

## Environment variables

| Variable                        | Sensitive | Purpose                                                                                                       |
| ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `ZYNO_HOSTING_API_KEY`          | yes       | Tenant API key for CLI, CI, or MCP.                                                                           |
| `ZYNO_HOSTING_ACCESS_TOKEN`     | yes       | Advanced user bearer-token injection.                                                                         |
| `ZYNO_HOSTING_TENANT_ID`        | no        | Optional tenant metadata for an injected scoped token.                                                        |
| `ZYNO_HOSTING_TOKEN_EXPIRES_AT` | no        | Optional bearer expiry as epoch milliseconds.                                                                 |
| `ZYNO_HOSTING_API_URL`          | no        | Override the Hosting Manager base URL.                                                                        |
| `ZYNO_SUITE_API_URL`            | no        | Override the ZynoSuite base URL used by MCP form tools.                                                       |
| `ZYNO_AUTH_API_URL`             | no        | Override the Zyno Auth base URL used for renew and revoke.                                                    |
| `ZYNO_HOSTING_ENVIRONMENT`      | no        | Select `production`, `alpha`, or `dev`.                                                                       |
| `ZYNO_HOSTING_CONFIG`           | no        | Override the saved configuration path.                                                                        |
| `ZYNO_HOSTING_LOGIN_URL`        | no        | Override the browser-login SPA URL.                                                                           |
| `ZYNO_HOSTING_MCP_ROOTS`        | no        | Optional platform-delimited absolute roots for MCP local I/O; required only by tools that access local files. |

## API endpoint validation

A custom API URL:

- must be a valid absolute URL;
- may not contain credentials, query parameters, or a fragment;
- must use HTTPS unless its host is `localhost`, `127.0.0.1`, or `::1`.

Trailing slashes are normalized away.

## Saved configuration schema

The file is JSON and contains one credential form:

```json
{
    "apiUrl": "https://hosting.api.zyno.app",
    "suiteApiUrl": "https://suite.api.zyno.app",
    "authApiUrl": "https://auth.api.zyno.app",
    "accessToken": "...",
    "tenantId": "...",
    "expiresAt": 1784246400000,
    "scopedToken": true,
    "renewalKey": "11111111-1111-4111-8111-111111111111"
}
```

Or:

```json
{
    "apiUrl": "https://hosting.api.zyno.app",
    "suiteApiUrl": "https://suite.api.zyno.app",
    "authApiUrl": "https://auth.api.zyno.app",
    "apiKey": "..."
}
```

Do not combine `apiKey` and `accessToken`. `tenantId` records the tenant resolved by the authorization page, but request authentication relies on the tenant-bound JWT and does not send that value as a header.

`renewalKey` is only an opaque reference. The renewal token itself is stored in the operating system credential store and must never appear in this file. Removing or copying the JSON file does not copy the renewable credential. On Linux, renewable login requires a working Secret Service and the `secret-tool` command.

## Paths

| Platform        | Default configuration path                                                       |
| --------------- | -------------------------------------------------------------------------------- |
| macOS and Linux | `$XDG_CONFIG_HOME/zyno/hosting-cli.json`, then `~/.config/zyno/hosting-cli.json` |
| Windows         | `%APPDATA%\Zyno\hosting-cli.json`                                                |

Use `ZYNO_HOSTING_CONFIG` to isolate credentials by environment or automation context.

## Non-interactive checklist

For CI and unattended MCP processes:

1. store a tenant API key in the platform secret manager;
2. inject it as `ZYNO_HOSTING_API_KEY`;
3. set `ZYNO_HOSTING_ENVIRONMENT` explicitly;
4. grant only the permissions required by the workflow;
5. avoid `--api-key` because command-line arguments may be observable;
6. use `--json` and check the process exit code.
