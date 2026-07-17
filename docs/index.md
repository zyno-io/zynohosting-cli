---
layout: home
title: ZynoHosting CLI and MCP
titleTemplate: false

hero:
    name: ZynoHosting
    text: Ship sites from a terminal or an agent
    tagline: Inspect authorized sites, move individual files, plan exact deployments, download snapshots, and expose the same guarded operations through local MCP.
    actions:
        - theme: brand
          text: Get started
          link: /guide/getting-started
        - theme: alt
          text: Configure MCP
          link: /mcp/
        - theme: alt
          text: View on GitHub
          link: https://github.com/zyno-io/zynohosting-cli

features:
    - icon: 🚀
      title: Exact deployments
      details: Preview creates, replacements, and deletions before uploading only the content that changed.
      link: /cli/deploy
      linkText: Deployment guide
    - icon: 📁
      title: Safe file operations
      details: List, read, create, replace, and delete regular files with optional ETag preconditions.
      link: /cli/files
      linkText: File commands
    - icon: 🤖
      title: Local MCP
      details: Give agents the same capabilities through stdio while confining every local path to explicit roots.
      link: /mcp/
      linkText: MCP setup
    - icon: 🔐
      title: Scoped authorization
      details: Tenant permissions become short-lived, site-bound capabilities with only the requested operations.
      link: /reference/permissions
      linkText: Permission model
    - icon: 📦
      title: Complete snapshots
      details: Download the deployable tree or, with separate authorization, protected and user-generated content.
      link: /cli/download
      linkText: Download guide
    - icon: 🧭
      title: Built for automation
      details: Machine-readable output, stable exit codes, CI API keys, and two-phase plans support unattended workflows.
      link: /reference/json-and-errors
      linkText: Automation reference
---
