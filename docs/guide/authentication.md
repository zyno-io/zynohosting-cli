# Authentication

The CLI and MCP server support scoped CLI tokens and tenant API keys. Credentials authenticate to the Hosting Manager and ZynoSuite; individual site operations then use short-lived, site-bound capabilities.

## Interactive login

Run:

```bash
zynohosting login
```

The CLI opens Zyno’s CLI authorization page and starts an ephemeral callback listener on literal `127.0.0.1`. The browser sends the result as a top-level `application/x-www-form-urlencoded` navigation, keeping credentials out of URLs and avoiding browser CORS and Private Network Access preflights. The CLI verifies a cryptographically random `state` value before accepting it.

The default request is read-only site discovery:

```bash
zynohosting login --permission hosting.sitesRead
```

Repeat `--permission` for a larger, explicit scope and give the grant a recognizable name:

```bash
zynohosting login \
  --name "Claude MCP — work laptop" \
  --permission hosting.sitesRead \
  --permission hosting.deploy
```

The authorization page rejects the complete request if a permission is unknown, unavailable to the user, malformed, or non-delegable. It never silently filters the list. `msp.login`, `msp.impersonate`, `core.changePassword`, and `core.manageFingerprints` cannot be delegated.

If a browser cannot be opened automatically:

```bash
zynohosting login --no-open
```

The command prints a one-time URL and waits for the same loopback callback. The default timeout is 300 seconds so password, SSO, and MFA flows have time to finish; change it with `--timeout <seconds>`.

::: warning
Scoped access tokens have a fixed 60-minute lifetime. There is no duration or scope-edit operation. Revoke and log in again to change permissions.
:::

## Renewable login

Long-running MCP processes can opt into one-time renewal-token rotation:

```bash
zynohosting login \
  --permission hosting.sitesRead \
  --permission hosting.deploy \
  --renewable
```

The renewal token is the long-lived secret. The CLI stores it in macOS Keychain, the Linux Secret Service (`secret-tool`), or Windows Credential Locker. Only an opaque UUID reference is written to the JSON config. A running MCP schedules renewal shortly before expiration even while idle, and every authenticated request retains the same freshness check as a backstop. The replacement renewal token is committed to the credential store before the new access token and expiration are atomically written to config. A per-config lock prevents two local CLI processes from consuming the same one-time token. The background timer is unreferenced, so it never keeps the process alive after the MCP host disconnects.

If renewal is forbidden because tenant policy changed, the current access token remains usable until its normal expiration. An invalid or already-used renewal token requires a new login. Non-renewable tokens simply report `login_expired` after 60 minutes.

::: danger
Never copy a renewal token into a dotfile, MCP config, log, shell history, or crash report. It is equivalent to a persistent credential for the approved permissions.
:::

## Logout and revocation

```bash
zynohosting logout
```

For a saved scoped token, logout calls `POST /identity/scoped-tokens/revoke` with the scoped access token. That revokes only its own grant and clears the server-side renewal token. Local config and credential-store entries are removed only after revocation succeeds or the access/renewal credential is already unusable. Tenant API keys are only removed locally.

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

| Environment  | Hosting API                          | ZynoSuite API                      | Zyno Auth API                     |
| ------------ | ------------------------------------ | ---------------------------------- | --------------------------------- |
| `production` | `https://hosting.api.zyno.app`       | `https://suite.api.zyno.app`       | `https://auth.api.zyno.app`       |
| `alpha`      | `https://hosting.api-alpha.zyno.dev` | `https://suite.api-alpha.zyno.dev` | `https://auth.api-alpha.zyno.dev` |
| `dev`        | `http://localhost:39840`             | `http://localhost:39874`           | `http://localhost:39827`          |

An explicit `--api-url` or `ZYNO_HOSTING_API_URL` overrides the Hosting API. Form tools also accept `--suite-api-url` or `ZYNO_SUITE_API_URL`; renewal accepts `--auth-api-url` or `ZYNO_AUTH_API_URL`. Standard environments and recognized standard Hosting API URLs select matching companion endpoints automatically. Custom remote URLs must use HTTPS; HTTP is accepted only for localhost.

## Environment-based user tokens

Advanced integrations may inject a scoped Zyno access token directly:

```bash
export ZYNO_HOSTING_ACCESS_TOKEN='...'
export ZYNO_HOSTING_TOKEN_EXPIRES_AT='1784246400000'
```

`ZYNO_HOSTING_TOKEN_EXPIRES_AT` is an epoch-millisecond timestamp. `ZYNO_HOSTING_TENANT_ID` is optional metadata and is never sent as `x-zs-tid`; the scoped JWT is already tenant-bound. Injected tokens cannot auto-renew because the CLI has no renewal credential. Most users should use `zynohosting login` instead.

The CLI sends scoped JWTs only as `Authorization: Bearer <jwt>`. It never sends masquerade headers. If another client elects to send `x-zs-tid`, it must match the JWT’s bound tenant.

## Authorization failures

Authentication proves who the caller is; [hosting permissions](../reference/permissions) determine which operations are allowed. A valid credential may list sites but still be unable to deploy, delete files, or request a sensitive download.
