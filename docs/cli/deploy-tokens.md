# Deploy tokens

A deploy token is an API key made through an API key request, for CI. It can deploy one site and do almost nothing else. Use it instead of a tenant API key.

If a deploy token leaks, an attacker can deploy to that one site until you revoke it. A leaked tenant API key reaches your whole tenant.

## What a token can do

A deploy token is an ordinary restricted API key (`zak_` plus 43 characters, the same format as any other API key) with the `hosting` app permission and nothing else by default. Its access to sites is a grant stored in hosting: one or more sites, each with the environments you choose (production, preview, or both). `deploy-tokens create` asks for one site.

It can:

- deploy to the environments it includes (a token for a PHP site must include production);
- promote preview to production, if it includes both;
- clear the site cache;
- turn PHP on or off and change the PHP version, if it includes production;
- change not-found handling, if it includes production;
- say what it is (`zynohosting whoami`) and revoke itself.

It can list and read only the sites it is granted. It cannot read other sites, read or write single files, download the site, edit forms, or create other tokens. Hosting does not know a token's expiry; the CLI reads it from ZynoAuth. Every token has an expiry: 30, 90 (the default), 180, or 365 days. There are no tokens that never expire.

A deploy that is already running when you revoke the token can finish. That takes up to 20 minutes.

## PHP sites need production

On a site that runs PHP, code deployed to preview can reach production. So a deploy token for a PHP site must include production: use `--production` or `--both`. A preview-only token is refused for a PHP site.

`deploy-tokens create --preview` fails at once, before anything is requested, with `deploy_token_requires_production`. If PHP is turned on after a preview-only token was approved, deploys with that token fail with the same code. Static sites can use preview-only tokens.

## Create a token

You need a ZynoSuite login (`zynohosting login`) and the `hosting.deploy` permission. The same person who starts the request approves it.

```bash
zynohosting deploy-tokens create example.com --production --github acme/web
```

The CLI opens an approval page in your browser. Check that the code, site, and environments match what the CLI printed. Choose how long the token lasts, then approve.

The CLI saves the token to GitHub for you. It never prints it.

You must say which environments the token may use: `--production`, `--preview`, or `--both`.

### Extra permissions

A token gets the `hosting` app permission for its site grant. To also give it an ordinary permission, repeat `--permission <key>`:

```bash
zynohosting deploy-tokens create example.com --production --github acme/web --permission hosting.sitesRead
```

The CLI checks only that each key is well formed. ZynoAuth is authoritative: an unknown key is refused when the request starts. The approver sees the permissions on the approval page and can remove any of them. The approver must hold every permission that is approved.

### Where the token goes

| Option                     | Result                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `--github <owner/repo>`    | A GitHub Actions secret, set with `gh`. Add `--github-environment <name>` for an environment secret. |
| `--gitlab <group/project>` | A masked GitLab CI/CD variable, set with `glab`.                                                     |
| `--file <path>`            | A new file with mode `0600`. An existing file is never overwritten.                                  |
| none of these              | You copy the token once from the approval page.                                                      |

`--name <name>` changes the secret or variable name. The default is `ZYNOHOSTING_DEPLOY_TOKEN`.

Pick one destination. The CLI checks that `gh` or `glab` is signed in and can reach the repository before it asks for a token.

The token goes to `gh` and `glab` on standard input. It is never in a command line, in `--json` output, in an error, or in a log.

If saving the token fails, the CLI revokes the new token with itself and exits with `handoff_failed`. The message says the token was revoked. If the revoke also fails, the message says so and names the key id: run `zynohosting deploy-tokens revoke <keyId>` with that id (or revoke it in ZynoSuite), because a live token nobody holds is left until then.

If a destination such as a GitLab variable already exists, the CLI replaces its value (`glab variable update`) and keeps its protected, raw, type, and description settings. The variable stays masked. GitHub secrets are overwritten by `gh secret set`.

A file inside a git repository that is not ignored gets a warning. Add it to `.gitignore` before you commit.

### Other options

| Option                              | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `--permission <key>`                | Also grant a permission key such as `hosting.sitesRead`. Repeatable.      |
| `--lifetime <30d\|90d\|180d\|365d>` | Suggest a lifetime. The approver chooses.                                 |
| `--no-wait`                         | With no destination: print the link and code, save the request, and exit. |
| `--resume`                          | Finish a request saved with `--no-wait`.                                  |
| `--no-open`                         | Print the link instead of opening a browser.                              |
| `--timeout <seconds>`               | How long to wait for approval. The default is until the code expires.     |
| `--json`                            | Newline-delimited JSON events. The token is never in them.                |

Where no browser can open, the CLI prints the link and code. Open it on any device.

## List and revoke

```bash
zynohosting deploy-tokens list
zynohosting deploy-tokens list example.com
zynohosting deploy-tokens revoke <keyId>
```

The list shows each token's id, short preview, sites and environments, extra permission keys, who approved it, expiry, and last use. It never shows a token. `list <site>` keeps the tokens granted that site. The list comes from ZynoAuth's `app=hosting` filter, so it holds hosting tokens only. A login that lacks `hosting.sitesRead` sees none.

Revoking a token that ZynoAuth no longer has (already revoked, or no such id) is not an error: the command says so and exits 0.

CI can revoke its own token:

```bash
zynohosting deploy-tokens revoke --self
```

## Use a token in CI

Set `ZYNOHOSTING_DEPLOY_TOKEN`. A token that covers one site lets you leave the site out:

```bash
export ZYNOHOSTING_DEPLOY_TOKEN='...'
zynohosting deploy ./dist --yes --json
```

With a token, `deploy` takes the site and the directory in either form:

- `deploy` deploys the current directory to the token's site;
- `deploy ./dist` deploys `./dist`;
- `deploy example.com` deploys the current directory;
- a name that looks like a site (`site-b.com`) but is not covered by the token is refused (`deploy_token_wrong_site`), even if a folder has that name. Write a folder as a path (`./site-b.com`) or give both arguments;
- `deploy example.com ./dist` names both.

If one argument is both the site and a directory, the CLI stops and asks for both. If the site or environment does not match the token, it fails before it uploads anything.

A token that covers several sites always needs the site named: `deploy` or `deploy ./dist` fails with `deploy_token_site_required`, and a site the token does not cover fails with `deploy_token_wrong_site` and lists the sites it does cover.

If every site the token was approved for was deleted or moved to another tenant, hosting lists no sites for it. Commands fail with `deploy_token_no_sites`; create a new token.

`zynohosting whoami` with a token prints its sites, environments, and expiry. The expiry is read from ZynoAuth. If ZynoAuth is unreachable or its URL is not set, `whoami` still prints the sites, says "expiry unknown", and warns on stderr. An expired or revoked token fails with `deploy_token_expired` or `deploy_token_revoked`.

A token only runs `deploy`, `promote`, `whoami`, `sites set`, `sites runtime`, and `deploy-tokens revoke --self`. Every other command fails with `deploy_token_not_allowed`.

The CLI treats a key as a deploy token because you put it in `ZYNOHOSTING_DEPLOY_TOKEN`, not because of its prefix. The same key in `ZYNOHOSTING_API_KEY` is an ordinary API key.

Do not set `ZYNOHOSTING_DEPLOY_TOKEN` together with `ZYNOHOSTING_API_KEY` or `ZYNOHOSTING_ACCESS_TOKEN`. That is `conflicting_credentials`. A token cannot be combined with `--tenant` either.

### GitHub Actions

Create the secret once:

```bash
zynohosting deploy-tokens create example.com --production --github acme/web
```

Then deploy on every push to `main`:

```yaml
name: Deploy
on:
    push:
        branches: [main]

jobs:
    deploy:
        runs-on: ubuntu-latest
        steps:
            - uses: actions/checkout@v4
            - uses: actions/setup-node@v4
              with:
                  node-version: 24
            - run: npm ci && npm run build
            - run: npx -y @zyno-io/zynohosting deploy ./dist --yes --json
              env:
                  ZYNOHOSTING_DEPLOY_TOKEN: ${{ secrets.ZYNOHOSTING_DEPLOY_TOKEN }}
```

To deploy pull requests to preview, create a second token with `--preview`. Use a different name:

```bash
zynohosting deploy-tokens create example.com --preview --github acme/web --name ZYNOHOSTING_PREVIEW_TOKEN
```

```yaml
- run: npx -y @zyno-io/zynohosting deploy ./dist --preview --yes --json
  env:
      ZYNOHOSTING_DEPLOY_TOKEN: ${{ secrets.ZYNOHOSTING_PREVIEW_TOKEN }}
```

### GitLab CI

Create the variable once:

```bash
zynohosting deploy-tokens create example.com --production --gitlab acme/web
```

The variable is masked. Then:

```yaml
deploy:
    image: node:24
    stage: deploy
    rules:
        - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
    script:
        - npm ci && npm run build
        - npx -y @zyno-io/zynohosting deploy ./dist --yes --json
```

GitLab passes the `ZYNOHOSTING_DEPLOY_TOKEN` variable to the job by itself. The token body uses letters, digits, `_` and `-`. GitLab accepts all of these in a masked variable.

To limit the variable to protected branches, mark it protected in the project's CI/CD settings.

## Errors

| Code                               | Meaning                                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy_token_not_allowed`         | A deploy token cannot run this command (exit 3).                                                                                          |
| `conflicting_credentials`          | A deploy token was set together with an API key or access token (exit 2).                                                                 |
| `invalid_deploy_token`             | The value is not shaped like a key: `zak_` plus 43 characters (exit 2).                                                                   |
| `deploy_token_wrong_site`          | The site is not one the token covers (exit 3, or 2 for a deploy argument).                                                                |
| `deploy_token_site_required`       | The token covers several sites: name the one to deploy (exit 2).                                                                          |
| `deploy_token_no_sites`            | Every site of the token was deleted or transferred. Create a new token (exit 3).                                                          |
| `deploy_token_wrong_environment`   | The token's grant for that site does not include that environment (exit 3). Checked before the request.                                   |
| `deploy_token_denied`              | The token is valid, but hosting refused the call (`not bound to this site`, wrong scope, and so on). The message quotes hosting (exit 3). |
| `deploy_token_requires_production` | The site runs PHP, so its token must include production (exit 3).                                                                         |
| `deploy_token_expired`             | The token expired. Create a new one (exit 3).                                                                                             |
| `deploy_token_revoked`             | The token was revoked or is no longer valid (exit 3).                                                                                     |
| `ambiguous_deploy_argument`        | One argument is both the site and a directory. Give both (exit 2).                                                                        |
| `handoff_unavailable`              | `gh`, `glab`, or the file path cannot take the token. Nothing was requested (exit 2).                                                     |
| `handoff_failed`                   | Saving the token failed. The new token was revoked if possible (exit 7).                                                                  |
| `key_request_denied`               | The approver denied the request (exit 3).                                                                                                 |
| `key_request_expired`              | The approval code ran out. Start again (exit 3).                                                                                          |
| `key_request_pending`              | `--resume` timed out with nobody approving (exit 3).                                                                                      |
| `no_pending_key_request`           | `--resume` with nothing saved (exit 2).                                                                                                   |
| `key_credential_lost`              | The connection dropped as the token was handed over. List and revoke, then create again (exit 3).                                         |

## Permissions

Starting a request needs `hosting.deploy` (or tenant administrator) on your login: hosting checks it when the request starts and again at approval. Approving needs the same, and any extra `--permission` key must be one you hold. The CLI also reads the site before it asks, which needs `hosting.sitesRead`, so a login with only `hosting.deploy` cannot use `create`. Tenant administrators pass every check.
