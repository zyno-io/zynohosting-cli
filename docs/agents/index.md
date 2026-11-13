# Set up an agent

ZynoHosting works inside the AI agent you already use. You describe what you want in plain English, and your agent publishes your site, tries changes on a preview, and connects your forms. You never need to type a command.

## Which agent do you use?

<div class="agent-picker">
  <a class="agent-card" href="./claude-desktop.html">
    <strong>Claude desktop app</strong>
    <span>You chat with Claude in its Chat or Cowork tab.</span>
    <em>Setup: download one file</em>
  </a>
  <a class="agent-card" href="./claude-code.html">
    <strong>Claude Code</strong>
    <span>In a terminal, in VS Code or JetBrains, or in the desktop app's Code tab.</span>
    <em>Setup: paste one message</em>
  </a>
  <a class="agent-card" href="./codex.html">
    <strong>Codex</strong>
    <span>OpenAI's coding agent, in a terminal, an editor, or the Codex app.</span>
    <em>Setup: paste one message</em>
  </a>
  <a class="agent-card" href="./always-on.html">
    <strong>Grok Bot or ChatGPT dots</strong>
    <span>An always-on agent with its own cloud computer. You approve its sign-in from any device.</span>
    <em>Setup: paste one message</em>
  </a>
  <a class="agent-card" href="./other.html">
    <strong>Another coding agent</strong>
    <span>Cursor, Muse Code, Windsurf, Gemini CLI, GitHub Copilot, or any agent that can run commands.</span>
    <em>Setup: paste one message</em>
  </a>
</div>

**Not sure?** If you open the Claude app and type into a chat box, choose **Claude desktop app**. If your agent works inside a project folder and can run commands, choose that agent.

**Not supported:** Claude or ChatGPT in a web browser. They cannot run commands, so they cannot publish a site. An agent with its own cloud computer works fine: it builds or downloads the site there, and you approve its sign-in with a link and a code.

## You need

- **A ZynoHosting account** you can sign in to in a browser.
- **Your website's files**, in a folder on the same computer your agent runs on. An agent with its own cloud computer can instead build a new site there, or download an existing one first.

## After setup

Every agent page ends with a sign-in step. Then use [What to ask your agent](./prompts) for copy-and-paste requests: publish a site, try changes on a preview, make a preview live, and add or change forms.

## For developers

- [CLI, skill, or MCP](./interfaces): which interface each agent uses, and why.
- [Install instructions for agents](./install): what a coding agent does during setup.
- [The ZynoHosting skill](https://github.com/zyno-io/zynohosting-cli/blob/main/skills/zynohosting/SKILL.md): what a coding agent knows afterward.
- [Preview and production](../guide/preview): the preview model, hostnames, and pitfalls.
