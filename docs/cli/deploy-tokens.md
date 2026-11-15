# Deploy tokens

A deploy token is a key for CI. It can deploy one site and do almost nothing else. Use it instead of a tenant API key.

If a deploy token leaks, an attacker can deploy to that one site until you revoke it. A leaked tenant API key reaches your whole tenant.

## What a token can do

A deploy token is tied to one site and to the environments you choose: production, preview, or both.

It can:

- deploy to the environments it includes (a token for a PHP site must include production);
- promote preview to production, if it includes both;
- clear the site cache;
- turn PHP on or off and change the PHP version, if it includes production;
- change not-found handling, if it includes production;
- say what it is (`zynohosting whoami`) and revoke itself.

It cannot list other sites, read or write single files, download the site, edit forms, or create other tokens. Every token has an expiry: 30, 90 (the default), 180, or 365 days. There are no tokens that never expire.

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

If saving the token fails, the CLI revokes the new token with itself and exits with an error. Nothing is left behind.

A file inside a git repository that is not ignored gets a warning. Add it to `.gitignore` before you commit.

### Other options

| Option                              | Purpose                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
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

The list shows each token's id, short preview, environments, who approved it, expiry, and last use. It never shows a token.

CI can revoke its own token:

```bash
zynohosting deploy-tokens revoke --self
```

## Use a token in CI

Set `ZYNOHOSTING_DEPLOY_TOKEN`. The CLI knows the site from the token, so you can leave it out:

```bash
export ZYNOHOSTING_DEPLOY_TOKEN='...'
zynohosting deploy ./dist --yes --json
```

With a token, `deploy` takes the site and the directory in either form:

- `deploy` deploys the current directory to the token's site;
- `deploy ./dist` deploys `./dist`;
- `deploy example.com` deploys the current directory;
- `deploy example.com ./dist` names both.

If one argument is both the site and a directory, the CLI stops and asks for both. If the site or environment does not match the token, it fails before it uploads anything.

A token only runs `deploy`, `promote`, `whoami`, `sites set`, `sites runtime`, and `deploy-tokens revoke --self`. Every other command fails with `deploy_token_not_allowed`.

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

| Code                               | Meaning                                                                                                |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `deploy_token_not_allowed`         | A deploy token cannot run this command (exit 3).                                                       |
| `conflicting_credentials`          | A deploy token was set together with an API key or access token (exit 2).                              |
| `invalid_deploy_token`             | The value is not a deploy token. A tenant API key gets its own message (exit 2).                       |
| `deploy_token_wrong_site`          | The site is not the one the token was created for (exit 3).                                            |
| `deploy_token_wrong_environment`   | The token does not include that environment (exit 3).                                                  |
| `deploy_token_requires_production` | The site runs PHP, so its token must include production (exit 2 when creating, exit 3 when deploying). |
| `deploy_token_expired`             | The token expired. Create a new one (exit 3).                                                          |
| `deploy_token_revoked`             | The token was revoked or is no longer valid (exit 3).                                                  |
| `ambiguous_deploy_argument`        | One argument is both the site and a directory. Give both (exit 2).                                     |
| `handoff_unavailable`              | `gh`, `glab`, or the file path cannot take the token. Nothing was requested (exit 2).                  |
| `handoff_failed`                   | Saving the token failed. The new token was revoked if possible (exit 7).                               |
| `key_request_denied`               | The approver denied the request (exit 3).                                                              |
| `key_request_expired`              | The approval code ran out. Start again (exit 3).                                                       |
| `key_request_pending`              | `--resume` timed out with nobody approving (exit 3).                                                   |
| `no_pending_key_request`           | `--resume` with nothing saved (exit 2).                                                                |
| `key_credential_lost`              | The connection dropped as the token was handed over. List and revoke, then create again (exit 3).      |

## Permissions

Creating a token needs `hosting.sitesRead` on your login. Approving needs `hosting.deploy`. Tenant administrators pass both checks.
