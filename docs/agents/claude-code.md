# Set up Claude Code

For Claude Code in a terminal, in VS Code or JetBrains, or in the **Code** tab of the Claude desktop app. Chatting in the app's Chat tab instead? See [Claude desktop app](./claude-desktop).

## 1. Paste this into Claude Code

Open your website's project folder in Claude Code, then copy this in:

```text:no-line-numbers
Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Claude Code adds a small instruction file to your project, `.claude/skills/zynohosting/SKILL.md`, that teaches it to use ZynoHosting. The file holds no passwords. You can keep going straight away, with no restart.

If Claude Code says Node.js is missing or the wrong version, install **Node.js 24** from [nodejs.org](https://nodejs.org/), then paste the message again.

## 2. Sign in

```text:no-line-numbers
Sign in to ZynoHosting. Ask only for the permissions this task needs, open the browser sign-in page, and give me the link if my browser does not open. Confirm the sign-in worked before continuing.
```

A sign-in page opens in your browser. Sign in as usual, read what you are allowing, and approve it.

## 3. Start working

Go to [What to ask your agent](./prompts). In Claude Code you don't need to name the folder; it works on the open project.

## Other projects

The setup belongs to one project. Paste the same message in each project you publish, or ask Claude Code to "install the ZynoHosting skill for all my projects" to put it in your home folder instead.

## If something goes wrong

| What you see                                 | What to do                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| A Node or `npx` error                        | Install Node.js 24 from [nodejs.org](https://nodejs.org/), then try again.                        |
| Claude Code asks you to run a command        | Reply: _Please do that yourself. I don't use the terminal._                                       |
| The sign-in page never opened                | Ask: _Give me the ZynoHosting sign-in link._ Links expire after five minutes.                     |
| Claude Code doesn't seem to know ZynoHosting | Ask: _Use the ZynoHosting skill in .claude/skills/zynohosting._ Or paste the setup message again. |
| An error you don't understand                | Paste it back and ask: _Explain this in plain language and tell me what to do next._              |
