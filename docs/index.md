---
layout: home
title: ZynoHosting CLI and MCP
titleTemplate: false

hero:
    name: ZynoHosting
    text: Ship sites from a terminal or an agent
    tagline: Deploy, preview, and promote hosted sites from the CLI, create and connect ZynoForms, and teach any agent to do the same.
    actions:
        - theme: brand
          text: Get started
          link: /guide/getting-started
        - theme: alt
          text: Set up an agent
          link: /agents/
        - theme: alt
          text: View on GitHub
          link: https://github.com/zyno-io/zynohosting-cli

features:
    - icon: 🚀
      title: Exact deployments
      details: Plan creates, replacements, and deletions before uploading only the content that changed.
      link: /cli/deploy
      linkText: Deployment guide
    - icon: 👀
      title: Preview, then promote
      details: Deploy to a separate preview hostname, check it, and swap it into production in one step.
      link: /guide/preview
      linkText: Preview and production
    - icon: 📁
      title: Safe file operations
      details: List, read, create, replace, and delete regular files with optional ETag preconditions.
      link: /cli/files
      linkText: File commands
    - icon: 🤖
      title: Agent-ready
      details: Coding agents drive the CLI through one skill file. The Claude desktop app installs a one-click extension.
      link: /agents/interfaces
      linkText: CLI, skill, or MCP
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
