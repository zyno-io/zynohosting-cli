# Authentication

The CLI and MCP server support scoped CLI tokens and tenant API keys. Credentials authenticate to the Hosting Manager and ZynoSuite; individual site operations then use short-lived, site-bound capabilities.

## Interactive login

On a computer with a browser, run:

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

`zynohosting login --help` lists every requestable permission with its capability; [Permissions](../reference/permissions) explains the model and gives least-privilege sets. Only those keys exist—an invented one such as `hosting.sitesWrite` is rejected locally, before a browser opens, with the closest valid key named. The authorization page likewise rejects the complete request if a permission is unknown, unavailable to the user, malformed, or non-delegable. Neither silently filters the list. `msp.login`, `msp.impersonate`, `core.changePassword`, and `core.manageFingerprints` cannot be delegated.

If a browser cannot be opened automatically:

```bash
zynohosting login --no-open
```

The command prints a one-time URL and waits for the same loopback callback. The default timeout is 300 seconds so password, SSO, and MFA flows have time to finish; change it with `--timeout <seconds>`.

::: warning
Scoped access tokens last 60 minutes. A login without `--renewable` simply ends after that hour. A renewable login renews itself until the lifetime the approver chose runs out; see [How long a login lasts](#how-long-a-login-lasts). There is no scope-edit operation. Revoke and log in again to change permissions.
:::

## Device sign-in (link and code)

Where no browser can open, such as over SSH, on a cloud computer, or on a machine with no display, the CLI shows a link and a short code instead. The person opens the link on any device, checks the code, and approves. The credential goes straight from ZynoAuth to the CLI. It never passes through the browser.

```bash
zynohosting login --device
```

`login` chooses this by itself when `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` is set, or on Linux with no `DISPLAY` or `WAYLAND_DISPLAY` (not under WSL). If it cannot start its local listener it falls back to this flow too. `--device` forces it and `--no-device` forces the browser. It never falls back from the code flow to the browser.

The output looks like this:

```text
To sign in to ZynoHosting, open this link on any device:

    https://zyno.app/cli/device?code=ABCD-EFGH

Or go to https://zyno.app/cli/device and type this code: ABCD-EFGH
```

On the approval page the person checks that the code matches, picks how long the access lasts, ticks a box confirming they started this sign-in themselves, and approves. The code works for about ten minutes. Ctrl+C, `--timeout`, or an expired code cancels it on the server. Anyone who sends you a link and code is asking you to hand over access to your account, so approve only a code you just started.

The CLI prints `Signed in as <account> (<tenant>)` when it is done. Check it. Someone who tricked you into approving with their own account would show up here.

### Two steps for agents

Some agent shells only show a command's output when it exits. Split the sign-in in two:

```bash
zynohosting login --device --no-wait --json   # prints the link and code, saves the pending sign-in, exits 0
zynohosting login --resume --json             # waits up to 300 seconds for the approval
```

`--resume` exits with `login_pending` (exit 3) if nobody approved in time and keeps the pending sign-in, so it can simply be run again. A pending sign-in is saved in the selected environment's profile and is removed when it completes, is denied, or expires. Starting a new one cancels the old code.

With `--json`, stdout holds one JSON event per line and human text goes to stderr:

```json
{"type":"login_started","flow":"device","reason":"no_display","verificationUri":"https://zyno.app/cli/device","verificationUriComplete":"https://zyno.app/cli/device?code=ABCD-EFGH","userCode":"ABCD-EFGH","expiresAt":"2026-11-12T18:10:00.000Z","interval":5}
{"type":"login_pending","resume":"zynohosting login --resume"}
{"type":"result","status":"authenticated","flow":"device","profile":"production","loginId":"<accountId>:<tenantId>","accountId":"…","tenantId":"…","tenantName":"Acme Co","account":"owner@example.com","renewable":true,"credentialStore":"file","accessExpiresAt":"2026-11-12T19:00:00.000Z","grantExpiresAt":"2026-11-19T18:00:00.000Z"}
```

The device code, the access token and the renewal token are never printed. The browser flow prints a `login_started` event with `"flow":"browser"` and the one-time `url`.

## How long a login lasts

An approver picks the lifetime of a renewable login on the approval page: 1 hour, 1 day, 7 days or 30 days. The maximum is 30 days. `--lifetime 1h|1d|7d|30d` only suggests a choice, and the person can change it. Anything above `1h` needs `--renewable`; any other value is `invalid_lifetime`. A login without `--renewable` always lasts 60 minutes.

Renewal stops at the end of that lifetime. The CLI then reports `grant_expired` (exit 3) and the person has to approve a new sign-in. `zynohosting logins` shows when each login ends.

## Renewable login

Long-running MCP processes can opt into one-time renewal-token rotation:

```bash
zynohosting login \
  --permission hosting.sitesRead \
  --permission hosting.deploy \
  --renewable
```

The renewal token is the long-lived secret. By default the CLI stores it in macOS Keychain, the Linux Secret Service (`secret-tool`), or Windows Credential Locker. Only an opaque UUID reference is written to the JSON config. A running MCP schedules renewal shortly before expiration even while idle, and every authenticated request retains the same freshness check as a backstop. The replacement renewal token is committed to the store before the new access token and expiration are atomically written to config. A lock prevents two local CLI processes from consuming the same one-time token. The background timer is unreferenced, so it never keeps the process alive after the MCP host disconnects.

The CLI checks the credential store before it asks for any approval, so a missing store fails at once with `credential_store_unavailable` instead of leaving an unused grant behind.

If renewal is forbidden because tenant policy changed, the current access token remains usable until its normal expiration. An invalid or already-used renewal token requires a new login. A non-renewable login reports `login_expired` after 60 minutes. A renewable one reports `grant_expired` when the lifetime the approver chose ends.

### File-backed renewal storage

A cloud computer or container usually has no system credential service. On a computer that only you or your agent use, opt in to a file:

```bash
zynohosting login --renewable --credential-store file
# or: export ZYNOHOSTING_CREDENTIAL_STORE=file
```

The flag wins over the variable. The flag without `--renewable` is an error; the variable without it is ignored. The token file sits next to the saved configuration, as `hosting-cli-profiles.renewal-tokens.json` for the default path:

```json
{ "version": 1, "tokens": { "<renewal key>": { "token": "zrt_…", "updatedAt": 1784246400000 } } }
```

The file is written with mode `0600` in a `0700` directory, replaced atomically under its own lock, and deleted when it empties. The CLI refuses to use it if it is a symbolic link or readable by anyone else (`credential_store_insecure`). The login records `"renewalStore": "file"`, so each login in a profile can use its own store.

::: danger
Never copy a renewal token anywhere yourself: not into MCP config, environment variables, logs, shell history, or crash reports. The only sanctioned on-disk copy is the opt-in file store (`--credential-store file`), which the CLI writes with mode 0600 and rotates on every renewal. Anyone who can read that file (root, VM snapshots or backups, or another process running as you) can act with the approved permissions until the grant expires or you log out.
:::

## Multiple logins

A person can belong to several organizations (tenants). A login is one **account in one tenant**, and each has its own token and can be removed on its own. The CLI keeps every login in each environment, so you can switch without signing in again. Two people (or two of your accounts) can be signed in to the same tenant side by side.

```bash
zynohosting logins                       # list them: tenant, account, login id, which one is used by default, when it ends
zynohosting logins --json
zynohosting logins use "Acme Co"         # make one the default (a login id, tenant id, or tenant name)
zynohosting sites list --tenant "Acme Co"   # use one for this command only
zynohosting sites list --tenant "Acme Co" --account bob@example.com   # when two accounts are in that tenant
ZYNOHOSTING_TENANT="Acme Co" ZYNOHOSTING_ACCOUNT=bob@example.com zynohosting sites list
zynohosting whoami                       # the login a command uses now
```

Each login has an id, `<accountId>:<tenantId>`. Signing in again as the same account to the same tenant replaces that login (the old grant is revoked on a best-effort basis). Signing in as another account, or to another tenant, adds a login and makes it the default.

The login a command uses is chosen in this order: `--tenant` (with `--account`), then `ZYNOHOSTING_TENANT` (with `ZYNOHOSTING_ACCOUNT`), then the default login, then the only login. `--tenant` takes a login id, a tenant id, or a tenant name (case-insensitive). `--account` takes an account email or id and narrows the match. If there are several logins and none is the default, the command fails with `login_selection_required` and lists them. An unknown name is `login_not_found`. A tenant that matches several logins, because several accounts are signed in to it, is `login_ambiguous`: the error lists each login id with its account email and tenant name, and you pass `--account` or the full login id. `--tenant` never changes the default.

An expired login stays in the list, marked expired, until you log out of it or sign in again as that account to that tenant. Using it fails with `grant_expired`.

## Logout and revocation

```bash
zynohosting logout                    # the default login of the selected environment
zynohosting logout --tenant "Acme Co" --account bob@example.com   # a different one
zynohosting logout --all              # every login in every environment
```

`logout` removes one login: the one `--tenant` (and `--account`) or `ZYNOHOSTING_TENANT` names, else the default one, chosen the same way as for any command (see [Saved configuration](#saved-configuration)). Other logins in the profile are kept. `--all` logs out of every saved login in every environment, revoking each in turn using its own stored URLs, and cancels any pending sign-in. If the selected environment has no login but others do, plain `logout` fails and lists them rather than reporting success.

For a saved scoped token, logout calls `POST /identity/scoped-tokens/revoke` with the scoped access token. That revokes only its own grant and clears the server-side renewal token. Local config and credential-store entries are removed only after revocation succeeds or the access/renewal credential is already unusable. Tenant API keys are only removed locally. After a logout, token-file entries that no saved login uses and that are more than an hour old are removed too.

## Tenant API keys

Use an environment variable in CI:

```bash
export ZYNOHOSTING_API_KEY='your-tenant-api-key'
zynohosting sites list
```

You may save an API key for local use:

```bash
zynohosting login --api-key 'your-tenant-api-key'
```

A saved API key is listed beside the logins of its environment as `API key` (id `api-key`). Select it with `--tenant api-key` or `logins use api-key`; saving one makes it the default.

Do not put API keys in command histories, MCP configuration committed to source control, workflow files, or logs. Prefer your CI secret store and environment injection.

## Credential precedence

The first complete credential found wins:

1. command options;
2. environment variables;
3. saved configuration.

Supplying both an API key and a user access token at the same precedence level is rejected as invalid configuration.

## Saved configuration

The default path is:

| Platform        | Path                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------ |
| macOS and Linux | `$XDG_CONFIG_HOME/zyno/hosting-cli-profiles.json`, or `~/.config/zyno/hosting-cli-profiles.json` |
| Windows         | `%APPDATA%\Zyno\hosting-cli-profiles.json`                                                       |

Set `ZYNOHOSTING_CONFIG` to use a different file. On POSIX systems, the CLI creates the directory with mode `0700` and the file with mode `0600`.

The file holds one profile per environment, keyed `production`, `alpha`, or `dev`, or `url:<Hosting API URL>` for a custom API URL. Each profile holds one login per account and tenant (see [Multiple logins](#multiple-logins)). Logging in to alpha leaves the production logins alone, and there is no "current" environment: a command with no environment or URL selected always uses `production`. The Hosting API URL comes from `--api-url`, then `--environment`, then `ZYNOHOSTING_API_URL`, then `ZYNOHOSTING_ENVIRONMENT`, and the saved profile is the one for that URL (an `--api-url` equal to alpha's URL uses the `alpha` login). If the selected environment has no login but others do, the command fails with `missing_config` and names them, for example `Not signed in to production. Saved logins: alpha. Pass --environment alpha, or run `zynohosting login`.` Files saved by earlier versions are read as one login for their tenant and converted the next time they are saved; see the [configuration reference](../reference/configuration#saved-configuration-schema).

## Environments

Select an environment with a command option:

```bash
zynohosting --environment production sites list
zynohosting --environment alpha sites list
```

Or set it once for the process:

```bash
export ZYNOHOSTING_ENVIRONMENT=alpha
```

| Environment  | Hosting API                          | ZynoSuite API                      | ZynoAuth API                      |
| ------------ | ------------------------------------ | ---------------------------------- | --------------------------------- |
| `production` | `https://hosting.api.zyno.app`       | `https://suite.api.zyno.app`       | `https://auth.api.zyno.app`       |
| `alpha`      | `https://hosting.api-alpha.zyno.dev` | `https://suite.api-alpha.zyno.dev` | `https://auth.api-alpha.zyno.dev` |
| `dev`        | `http://localhost:39840`             | `http://localhost:39874`           | `http://localhost:39827`          |

An explicit `--api-url` or `ZYNOHOSTING_API_URL` overrides the Hosting API, and a flag beats an environment variable: `--api-url`, `--environment`, `ZYNOHOSTING_API_URL`, `ZYNOHOSTING_ENVIRONMENT`. Form tools also accept `--suite-api-url` or `ZYNO_SUITE_API_URL`; renewal accepts `--auth-api-url` or `ZYNO_AUTH_API_URL`. When `--api-url` or `--environment` chose the Hosting URL, those variables are ignored (a flag-chosen login is never redirected); see the [configuration reference](../reference/configuration#resolution-order). Standard environments and recognized standard Hosting API URLs select matching companion endpoints automatically. Custom remote URLs must use HTTPS; HTTP is accepted only for localhost.

## Environment-based user tokens

Advanced integrations may inject a scoped ZynoSuite access token directly:

```bash
export ZYNOHOSTING_ACCESS_TOKEN='...'
export ZYNOHOSTING_TOKEN_EXPIRES_AT='1784246400000'
```

`ZYNOHOSTING_TOKEN_EXPIRES_AT` is an epoch-millisecond timestamp. `ZYNOHOSTING_TENANT_ID` is optional metadata and is never sent as `x-zs-tid`; the scoped JWT is already tenant-bound. Injected tokens cannot auto-renew because the CLI has no renewal credential. Most users should use `zynohosting login` instead.

The CLI sends scoped JWTs only as `Authorization: Bearer <jwt>`. It never sends masquerade headers. If another client elects to send `x-zs-tid`, it must match the JWT’s bound tenant.

## Authorization failures

Authentication proves who the caller is; [hosting permissions](../reference/permissions) determine which operations are allowed. A valid credential may list sites but still be unable to deploy, delete files, or request a sensitive download.
