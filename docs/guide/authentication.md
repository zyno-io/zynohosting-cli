# Authentication

The CLI and MCP server support interactive Zyno sessions and tenant API keys. Credentials authenticate to the Hosting Manager; individual site operations then use short-lived, site-bound capabilities.

## Interactive login

Run:

```bash
zynohosting login
```

The CLI opens a Zyno sign-in page and starts a loopback callback listener on `127.0.0.1`. After authentication, it saves the access token, tenant ID, expiration, and API URL in the local configuration file.

If a browser cannot be opened automatically:

```bash
zynohosting login --no-open
```

The command prints a one-time URL and waits for the same loopback callback. The default timeout is 300 seconds; change it with `--timeout <seconds>`.

::: warning
An interactive access token expires. Run `zynohosting login` again when the CLI reports `login_expired`.
:::

## Tenant API keys

Use an environment variable in CI:

```bash
export ZYNO_HOSTING_API_KEY='your-tenant-api-key'
zynohosting sites list
```

You may save an API key for local use:

```bash
zynohosting login --api-key 'your-tenant-api-key'
```

Do not put API keys in command histories, MCP configuration committed to source control, workflow files, or logs. Prefer your CI secret store and environment injection.

## Credential precedence

The first complete credential found wins:

1. command options;
2. environment variables;
3. saved configuration.

Supplying both an API key and a user access token at the same precedence level is rejected as invalid configuration.

## Saved configuration

The default path is:

| Platform        | Path                                                                           |
| --------------- | ------------------------------------------------------------------------------ |
| macOS and Linux | `$XDG_CONFIG_HOME/zyno/hosting-cli.json`, or `~/.config/zyno/hosting-cli.json` |
| Windows         | `%APPDATA%\Zyno\hosting-cli.json`                                              |

Set `ZYNO_HOSTING_CONFIG` to use a different file. On POSIX systems, the CLI creates the directory with mode `0700` and the file with mode `0600`.

## Environments

Select an environment with a command option:

```bash
zynohosting --environment production sites list
zynohosting --environment alpha sites list
```

Or set it once for the process:

```bash
export ZYNO_HOSTING_ENVIRONMENT=alpha
```

| Environment  | API URL                              |
| ------------ | ------------------------------------ |
| `production` | `https://hosting.api.zyno.app`       |
| `alpha`      | `https://hosting.api-alpha.zyno.dev` |
| `dev`        | `http://localhost:39840`             |

An explicit `--api-url` or `ZYNO_HOSTING_API_URL` overrides these defaults. Custom remote URLs must use HTTPS; HTTP is accepted only for localhost.

## Environment-based user tokens

Advanced integrations may inject a Zyno access token directly. A tenant ID is required with it:

```bash
export ZYNO_HOSTING_ACCESS_TOKEN='...'
export ZYNO_HOSTING_TENANT_ID='...'
export ZYNO_HOSTING_TOKEN_EXPIRES_AT='1784246400000'
```

`ZYNO_HOSTING_TOKEN_EXPIRES_AT` is an epoch-millisecond timestamp. Most users should use `zynohosting login` instead.

## Authorization failures

Authentication proves who the caller is; [hosting permissions](../reference/permissions) determine which operations are allowed. A valid credential may list sites but still be unable to deploy, delete files, or request a sensitive download.
