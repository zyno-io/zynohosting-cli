# Set up ZynoHosting: instructions for agents

This page is for the AI agent that fetched it. The person you are working for reads https://cli.zyno.host/agents/ instead.

If you can run shell commands, you use ZynoHosting through its CLI and a skill file that teaches you the CLI. Setup takes one download, and you can carry on in this session right away. Do not install the MCP server as well; the CLI covers hosting and ZynoForms.

If you cannot run shell commands, skip to "Agents without a shell".

If you have your own cloud computer (Grok Bot, ChatGPT dots), work on that computer by default and run every command in this page, and every ZynoHosting command afterward, there. Sign-in uses a link and a code the user approves on any device, so nothing has to happen on the user's own computer. Use the user's computer only when they ask you to work on files that are on it, and then run every command there, in their website folder.

## Install the skill

1. Identify which agent you are. Then check the target file before you download anything: if `.claude/skills/zynohosting/SKILL.md` (Claude Code) or `.agents/skills/zynohosting/SKILL.md` (Codex, Muse Code) already exists, read its frontmatter. If it has `name: zynohosting`, carry on, because overwriting it is how the skill is updated. If it is a different file, stop and ask the user. Then run exactly one of these from the project root:

    ```bash
    # Claude Code (terminal, IDE extensions, or the desktop app's Code tab)
    mkdir -p .claude/skills/zynohosting && curl -fsSL https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/skills/zynohosting/SKILL.md -o .claude/skills/zynohosting/SKILL.md

    # Codex or Muse Code
    mkdir -p .agents/skills/zynohosting && curl -fsSL https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/skills/zynohosting/SKILL.md -o .agents/skills/zynohosting/SKILL.md
    ```

    Another agent that supports Agent Skills: put the same file at `zynohosting/SKILL.md` in its skills directory. An agent without skill support can read the file directly whenever ZynoHosting comes up.

2. Write only your own agent's path. One agent, one file.
3. To make it available in every project, the user can ask for `~/.claude/skills/zynohosting/SKILL.md` or `~/.agents/skills/zynohosting/SKILL.md` instead. Default to the project.
4. Check the CLI runs:

    ```bash
    npx -y @zyno-io/zynohosting --version
    ```

    The CLI checks its own Node.js version at startup and stops with `unsupported_node` (exit 1) when it is older than 24; a warning from npm about an engine mismatch means the same thing. Install Node.js 24 first. On your own cloud computer, install it yourself (for example with `nvm install 24`, or from https://nodejs.org/). On the user's computer, ask them to install it from https://nodejs.org/.

5. Read the skill file you just wrote, and follow it for the rest of this session. You do not need a restart. New sessions load it automatically when ZynoHosting comes up.
6. Tell the user it is set up. The skill file holds no credentials and is safe to commit. Sign-in happens later, the first time a task needs it. On a computer with a browser it opens the browser. On a cloud computer the skill gives the user a link and a short code to approve on any device, and tells you how to wait for it.

## Agents without a shell

The Chat and Cowork tabs of the Claude desktop app cannot run the CLI, and nothing said in a conversation can install anything into them. Do not write files through any other tool, and do not report success. Tell the user to install the desktop extension instead:

1. Download https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb
2. Double-click the downloaded file. Claude opens an install window, and they click Install.
3. The install window offers to limit ZynoHosting to particular folders. Tell them to leave it empty unless they specifically want to confine it. An empty list lets them publish any folder.
4. To confirm, they click the **+** button beside the message box, then Connectors, then Manage connectors. ZynoHosting should be listed.

The extension carries everything it needs, so Node.js is not required, and it keeps itself up to date.

## Editing this page

Agents fetch it raw from GitHub, so keep it plain Markdown: no VitePress `:::` containers, and no relative links, which do not resolve on `raw.githubusercontent.com`. Use full `https://cli.zyno.host/...` URLs.

Keep it install-only. Everything an agent needs afterward belongs in `skills/zynohosting/SKILL.md`.
