# Set up ZynoHosting: instructions for agents

This page is for the AI agent that fetched it. The person you are working for reads https://cli.zyno.host/agents/ instead.

If you can run shell commands, you use ZynoHosting through its CLI and a skill file that teaches you the CLI. Setup takes one download, and you can carry on in this session right away. Do not install the MCP server as well; the CLI covers hosting and ZynoForms.

If you cannot run shell commands, skip to "Agents without a shell".

If you have your own cloud computer as well as access to the user's computer (Grok Bot, ChatGPT dots), run every command in this page, and every ZynoHosting command afterward, on the user's computer in their website folder. The cloud computer cannot see their files, and sign-in only completes on the machine whose browser approves it. If you only have the cloud computer, stop and send the user to https://cli.zyno.host/agents/always-on.html to turn on access to their computer.

## Install the skill

1. Identify which agent you are, then run exactly one of these from the project root:

    ```bash
    # Claude Code (terminal, IDE extensions, or the desktop app's Code tab)
    mkdir -p .claude/skills/zynohosting && curl -fsSL https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/skills/zynohosting/SKILL.md -o .claude/skills/zynohosting/SKILL.md

    # Codex or Muse Code
    mkdir -p .agents/skills/zynohosting && curl -fsSL https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/skills/zynohosting/SKILL.md -o .agents/skills/zynohosting/SKILL.md
    ```

    Another agent that supports Agent Skills: put the same file at `zynohosting/SKILL.md` in its skills directory. An agent without skill support can read the file directly whenever ZynoHosting comes up.

2. If the file already exists and its frontmatter has `name: zynohosting`, overwrite it. That is how the skill is updated. If a different file is at that path, stop and ask the user.
3. Write only your own agent's path. One agent, one file.
4. To make it available in every project, the user can ask for `~/.claude/skills/zynohosting/SKILL.md` or `~/.agents/skills/zynohosting/SKILL.md` instead. Default to the project.
5. Check the CLI runs:

    ```bash
    npx -y @zyno-io/zynohosting --version
    ```

    A failure that mentions the Node version or an unsupported engine means the user needs Node.js 24 from https://nodejs.org/.

6. Read the skill file you just wrote, and follow it for the rest of this session. You do not need a restart. New sessions load it automatically when ZynoHosting comes up.
7. Tell the user it is set up. The skill file holds no credentials and is safe to commit. Sign-in happens later, in their browser, the first time a task needs it.

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
