# Set up another coding agent

For Cursor, Meta's Muse Code, Windsurf, Gemini CLI, GitHub Copilot's agent mode, and other agents that work in a project folder and can run commands. Using Grok Bot or ChatGPT dots? See [their setup](./always-on).

## 1. Paste this into your agent

```text:no-line-numbers
Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Your agent saves an instruction file that teaches it to use ZynoHosting. If it supports skills, the file goes where it keeps skills. If not, it reads the file whenever ZynoHosting comes up.

ZynoHosting needs **Node.js 24** on your computer. If your agent reports it missing, install it from [nodejs.org](https://nodejs.org/) and paste the message again.

Agents that run commands in a sandbox, such as Muse Code, may ask to allow network access, running `npx`, or writing outside the project folder. Allow them; ZynoHosting needs all three to reach your site.

## 2. Sign in

```text:no-line-numbers
Sign in to ZynoHosting. Ask only for the permissions this task needs, open the browser sign-in page, and give me the link if my browser does not open. Confirm the sign-in worked before continuing.
```

## 3. Start working

Go to [What to ask your agent](./prompts).

If your agent forgets about ZynoHosting in a later conversation, start with: _Read the ZynoHosting skill file in this project first._

## Agents that can't run commands

An agent that only chats, or runs commands only on its own cloud computer, cannot use ZynoHosting. If you have the Claude desktop app, use [its setup](./claude-desktop) instead.
