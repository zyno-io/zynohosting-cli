# Release and mirror setup

GitLab is the source of truth. GitHub receives release tags only during normal operation. GitHub tag workflows publish the package and MCP metadata, deploy the matching VitePress documentation, and then fast-forward `main` to the released tag. Nothing runs for a push to GitHub `main`.

## One-time setup

1. Create an empty public GitHub repository at `zyno-io/zynohosting-cli`.
2. Seed its `main` branch once from the GitLab default branch so GitHub can discover the tag workflow:

    ```bash
    git remote add public git@github.com:zyno-io/zynohosting-cli.git
    git push public HEAD:main
    ```

3. In GitLab **Settings → CI/CD → Job token permissions**, enable **Allow Git push requests to the repository**. Protect tags matching `v*` and allow Maintainers to create them. The release job uses its short-lived `CI_JOB_TOKEN` to push the tag; no persistent GitLab release token is required.
4. Add protected GitLab CI variables:

    - `PRIVATE_NPM_PUBLISHER_TOKEN` — npm token allowed to publish `@zyno-io/zynohosting` to the internal registry.
    - `GITHUB_MIRROR_SSH_KEY_B64` — base64-encoded private half of a write-enabled deploy key scoped only to `zyno-io/zynohosting-cli`; configure it as masked and hidden. Store the canonical key in the team password manager and never commit it.
    - `INTERNAL_NPM_REGISTRY` — internal canary registry URL.
    - optionally override `GITHUB_MIRROR_REPOSITORY`.

The public release job remains skipped until `GITHUB_MIRROR_SSH_KEY_B64` is configured. A later default-branch pipeline resumes the missing tag and mirror even when the package version is unchanged.

5. In GitHub, allow GitHub Actions to write repository contents and permit the workflow identity to fast-forward protected `main`.
6. Create or reserve `@zyno-io/zynohosting` on npm and configure its trusted publisher:

    - provider: GitHub Actions;
    - repository: `zyno-io/zynohosting-cli`;
    - workflow: `.github/workflows/publish.yml`;
    - environment: `npm`.

7. Create the protected GitHub Actions environment named `npm`. Add reviewers if release approval is desired.
8. In GitHub **Settings → Pages**, select **GitHub Actions** as the publishing source.
9. Allow the `github-pages` environment to deploy from tags matching `v*`. The docs workflow also supports manual dispatch for recovery.

The first npm publication may require a one-time owner bootstrap before npm allows trusted-publisher configuration. Remove any long-lived npm publication token after OIDC is working.

## Desktop extension signing

The `.mcpb` desktop extension is built and signed in GitHub Actions, because that is where the release lives and where `GITHUB_TOKEN` can attach assets. Add two repository secrets under **Settings → Secrets and variables → Actions**:

- `MCPB_SIGN_KEY_B64` — base64 of the signing private key, single line.
- `MCPB_SIGN_CERT_B64` — base64 of the signing certificate.

Create the key pair once with `node scripts/create-signing-cert.mjs`, which writes an RSA-4096 code-signing certificate to `~/.config/zynohosting/signing` and refuses to overwrite an existing one. Keep the private key in the team password manager: losing it means the next release ships under a different publisher identity, and leaking it lets anyone publish as Zyno Consulting.

The identity must stay stable across releases. `mcpb sign --self-signed` is never used, because it mints a throwaway certificate with a placeholder subject on every run. Two things depend on the certificate specifically:

- installed extensions verify staged updates against the public key compiled into the launcher, so a key change strands every existing install on its current version until the user reinstalls;
- the certificate is what an organization would add to its trust store to have the extension report as signed rather than unsigned.

Without these secrets the workflow still succeeds for npm, the MCP Registry, documentation, and mirroring. It builds and verifies an unsigned bundle as a diagnostic, but it does not create the GitHub release or attach any desktop-extension assets under the canonical download names. The previous signed GitHub release therefore remains the latest downloadable extension until the secrets are restored and the tag workflow is rerun.

### Rotating the signing key

The certificate expires 2036-08-09. Expiry alone changes nothing for installed extensions, which pin the public key rather than the certificate and so have no validity window to enforce — deliberately, because enforcing one would stop every install from updating on a single date instead of when something is actually wrong. The certificate's dates do matter to Claude Desktop when it verifies a freshly downloaded `.mcpb`.

Replacing the key — on expiry, on compromise, or if it is lost — requires every existing user to install a new `.mcpb`, and there is no way around that.

An update stages `server.js` only. The trusted keys are compiled into the launcher, which is the extension's entry point and is replaced solely by installing the bundle again. So a release cannot teach an installed launcher a key it did not ship with, however that release is signed. After the signing key changes, existing installs keep working on the version they have and quietly stop updating.

Drive the migration with the version gate rather than hoping:

1. Generate the new key pair into a different `MCPB_SIGN_DIR`.
2. Set `MCPB_TRUST_CERT_B64` to the **outgoing** certificate and swap `MCPB_SIGN_KEY_B64` and `MCPB_SIGN_CERT_B64` to the incoming pair. New downloads then accept payloads signed by either key, which keeps releases made during the transition usable.
3. Raise `mcpbMinimumVersion` to the first release signed by the new key and ship. Installed extensions cannot stage that release, but they do read the descriptor, so every tool call tells the user to download the current version — which is exactly the action required.
4. Once the installed base has moved, clear `MCPB_TRUST_CERT_B64`.

The build accepts several trusted certificates through `MCPB_TRUSTED_CERTS`, a list separated by the platform path delimiter; the workflow materialises `MCPB_TRUST_CERT_B64` into it.

Note the asymmetry: the version gate reads an unsigned descriptor, so a forged one can at worst make clients refuse to work, never make them run something. Staging is the opposite — it acts on what it downloads, so a release signs the version bound to the payload digest, and a runtime cannot be replayed under a version it was not signed for.

Do not mistake the outgoing-certificate overlap for an automatic migration: it applies only to newly downloaded bundles. Every launcher built with only the outgoing key still has to be replaced manually; the raised version gate is what makes that requirement visible to those users.

## Releasing

Change `version` in both `package.json` and `server.json` in the same GitLab default-branch commit. The package verification script enforces the match.

`mcpbMinimumVersion` in `package.json` is the force-update lever. Raising it makes every older extension refuse to operate and tell the user to update, so raise it only for a genuine incompatibility, and only once enough of the installed base has moved. It can also be lowered by editing `update.json` on the latest GitHub release, without shipping a build.

When signing succeeds, the GitHub tag workflow attaches these release assets. It publishes none of them when signing secrets are missing, so an unsigned bundle can never replace the canonical extension:

| Asset                        | Purpose                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `zynohosting-{version}.mcpb` | The signed extension, versioned for the release listing.                                                     |
| `zynohosting.mcpb`           | The same file under a stable name, so documentation can link to `releases/latest/download/zynohosting.mcpb`. |
| `server.js`, `server.js.sig` | The runtime an installed extension stages, and its detached signature.                                       |
| `update.json`                | Version policy and payload locations, read from `releases/latest/download/update.json`.                      |

The GitLab pipeline:

1. installs immutable dependencies;
2. type-checks;
3. runs tests;
4. builds and verifies both executables and the documentation;
5. publishes `@zyno-io/zynohosting@{version}-canary.{pipeline}.g{commit}` to the configured internal registry under the `canary` dist-tag;
6. inspects the previous default-branch commit;
7. creates protected GitLab tag `v{version}` when that version is not already tagged;
8. resumes an incomplete mirror even when the package version did not change in the latest commit;
9. pushes only that tag ref to GitHub.

The canary job is idempotent on retry: if its exact version already exists, it restores the `canary` dist-tag instead of attempting to overwrite the immutable package version. Install the latest internal build with:

```bash
npm install --global @zyno-io/zynohosting@canary \
  --registry "$INTERNAL_NPM_REGISTRY"
```

The GitHub release tag workflow:

1. checks that the tag exactly matches the package and MCP metadata versions;
2. repeats type-check, test, build, package verification, and dry-run packing;
3. publishes the public npm package using GitHub OIDC;
4. waits for npm visibility;
5. publishes `server.json` to the MCP Registry using GitHub OIDC;
6. verifies GitHub `main` is an ancestor of the tag;
7. fast-forwards `main` to the tag SHA.

In parallel, the GitHub documentation workflow:

1. installs immutable dependencies from the same release tag;
2. builds the VitePress site with strict internal-link validation;
3. uploads `docs/.vitepress/dist` as a GitHub Pages artifact;
4. deploys the artifact through the `github-pages` environment.

The documentation site is published at `https://cli.zyno.host/` and uses `/` as its VitePress base path.

Existing tags are never moved. A non-descendant tag cannot update GitHub `main`. Release jobs are serialized on both CI systems.
