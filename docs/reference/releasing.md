# Release and documentation publishing

GitLab is the source of truth. Normal GitHub mirroring sends release tags only; GitHub `main` is fast-forwarded to each successfully published tag.

## Release flow

1. Change the matching versions in `package.json` and `server.json` on the GitLab default branch.
2. GitLab installs immutable dependencies, type-checks, tests, builds the CLI/MCP package and docs, and verifies the package.
3. GitLab creates the protected `v{version}` tag when needed.
4. GitLab mirrors only that tag to `zyno-io/zynohosting-cli` on GitHub.
5. GitHub verifies and publishes npm and MCP Registry metadata.
6. GitHub fast-forwards `main` to the released tag.
7. The separate Pages workflow builds and deploys this VitePress site from the same tag.

No workflow runs on a push to GitHub `main`.

## Documentation commands

```bash
yarn docs:dev
yarn docs:build
yarn docs:preview
```

The production output is `docs/.vitepress/dist` and the public base path is `/` (served at `https://cli.zyno.host/`). The docs are served at `https://cli.zyno.host/` through the GitHub Pages custom domain: set it under **Settings → Pages → Custom domain** and add a DNS CNAME from `cli.zyno.host` to `zyno-io.github.io`. The VitePress base is `/`, so the site only works when it is served from that domain, not from `zyno-io.github.io/zynohosting-cli/`. Do not add a `CNAME` file: Actions deployments ignore it.

## One-time GitHub Pages setup

In the public GitHub repository:

1. open **Settings → Pages**;
2. select **GitHub Actions** under **Build and deployment → Source**;
3. allow the `github-pages` environment to deploy from release tags matching `v*`;
4. keep Actions permissions available for `pages: write` and `id-token: write`.

The `Deploy documentation` workflow also supports manual dispatch for recovery or an initial deployment.

## Why deploy from tags

The repository intentionally mirrors only immutable release tags. Building docs from the tag ensures:

- command documentation matches the published npm package;
- the site cannot get ahead of released CLI behavior;
- GitHub `main` remains a passive fast-forwarded mirror;
- a failed package release cannot silently publish unreleased docs.

For full maintainer setup—including tokens, trusted publishing, and MCP Registry publication—see `RELEASING.md` in the repository root.
