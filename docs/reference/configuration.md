# Configuration reference

The CLI and MCP server resolve their API endpoint and credential independently for each process.

## Resolution order

Credentials are selected in this order:

1. command options;
2. environment variables;
3. the saved configuration file.

The API URL is selected from an explicit option, environment variable, selected environment, saved URL, or the production default.

## Environment variables

| Variable                        | Sensitive | Purpose                                                      |
| ------------------------------- | --------- | ------------------------------------------------------------ |
| `ZYNO_HOSTING_API_KEY`          | yes       | Tenant API key for CLI, CI, or MCP.                          |
| `ZYNO_HOSTING_ACCESS_TOKEN`     | yes       | Advanced user bearer-token injection.                        |
| `ZYNO_HOSTING_TENANT_ID`        | no        | Required with an injected user access token.                 |
| `ZYNO_HOSTING_TOKEN_EXPIRES_AT` | no        | Optional bearer expiry as epoch milliseconds.                |
| `ZYNO_HOSTING_API_URL`          | no        | Override the Hosting Manager base URL.                       |
| `ZYNO_HOSTING_ENVIRONMENT`      | no        | Select `production`, `alpha`, or `dev`.                      |
| `ZYNO_HOSTING_CONFIG`           | no        | Override the saved configuration path.                       |
| `ZYNO_HOSTING_LOGIN_URL`        | no        | Override the browser-login SPA URL.                          |
| `ZYNO_HOSTING_MCP_ROOTS`        | no        | Platform-delimited absolute roots allowed for MCP local I/O. |

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
    "accessToken": "...",
    "tenantId": "...",
    "expiresAt": 1784246400000
}
```

Or:

```json
{
    "apiUrl": "https://hosting.api.zyno.app",
    "apiKey": "..."
}
```

Do not combine `apiKey` and `accessToken`. User access tokens also require `tenantId`.

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
