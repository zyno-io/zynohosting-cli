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

## Releasing

Change `version` in both `package.json` and `server.json` in the same GitLab default-branch commit. The package verification script enforces the match.

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

The documentation site is published at `https://zyno-io.github.io/zynohosting-cli/` and uses `/zynohosting-cli/` as its VitePress base path.

Existing tags are never moved. A non-descendant tag cannot update GitHub `main`. Release jobs are serialized on both CI systems.
