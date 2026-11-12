# Set up Codex

For OpenAI's Codex in a terminal, in an editor extension, or in the Codex app.

## 1. Paste this into Codex

Open your website's project folder in Codex, then copy this in:

```text:no-line-numbers
Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Codex adds a small instruction file to your project, `.agents/skills/zynohosting/SKILL.md`, that teaches it to use ZynoHosting. The file holds no passwords. You can keep going straight away, with no restart.

If Codex says Node.js is missing or the wrong version, install **Node.js 24** from [nodejs.org](https://nodejs.org/), then paste the message again.

Codex may ask to allow network access or running `npx`. Allow it; ZynoHosting needs both to reach your site.

## 2. Sign in

```text:no-line-numbers
Sign in to ZynoHosting. Ask only for the permissions this task needs, open the browser sign-in page, and give me the link if my browser does not open. Confirm the sign-in worked before continuing.
```

A sign-in page opens in your browser. Sign in as usual, read what you are allowing, and approve it.

## 3. Start working

Go to [What to ask your agent](./prompts). In Codex you don't need to name the folder; it works on the open project.

## Other projects

The setup belongs to one project. Paste the same message in each project you publish, or ask Codex to "install the ZynoHosting skill for all my projects" to put it in your home folder instead.

## If something goes wrong

| What you see                           | What to do                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------ |
| A Node or `npx` error                  | Install Node.js 24 from [nodejs.org](https://nodejs.org/), then try again.           |
| A network or sandbox error             | Approve network access for this command when Codex asks, then ask it to try again.   |
| The sign-in page never opened          | Ask: _Give me the ZynoHosting sign-in link._ Links expire after five minutes.        |
| Codex asks you to run a command        | Reply: _Please do that yourself. I don't use the terminal._                          |
| Codex doesn't seem to know ZynoHosting | Ask: _Use the ZynoHosting skill in .agents/skills/zynohosting._                      |
| An error you don't understand          | Paste it back and ask: _Explain this in plain language and tell me what to do next._ |
