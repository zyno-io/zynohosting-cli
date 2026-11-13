# Set up Grok Bot or ChatGPT dots

For always-on agents that have their own cloud computer: **Grok Bot** from xAI, and **dots** in ChatGPT.

## Before you start: let it use your computer

These agents normally work on their own computer in the cloud. That computer can't see the website files on yours, and the ZynoHosting sign-in can't finish there. Give the agent access to your computer first:

- **Grok Bot:** in the Grok Bot desktop app, open **Settings → Computer** and set **Execution on this computer** to **Ask every time** or **Always allow**.
- **ChatGPT dots:** install the ChatGPT desktop app and turn on your dot's access to this computer. In a work or school workspace, an admin may need to allow it first.

The app must be open on your computer while the agent works.

## 1. Paste this into your agent

Replace the folder with the one that holds your website:

```text:no-line-numbers
Set up ZynoHosting for the website in ~/Sites/my-site. Run every command on my computer, not your cloud computer. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Your agent saves an instruction file in that folder that teaches it to use ZynoHosting. The file holds no passwords.

ZynoHosting needs **Node.js 24** on your computer. If your agent reports it missing, install it from [nodejs.org](https://nodejs.org/) and paste the message again.

If the agent asks to run a command on your computer, allow it.

## 2. Sign in

```text:no-line-numbers
Sign in to ZynoHosting on my computer. Ask only for the permissions this task needs, open the browser sign-in page, and give me the link if my browser does not open. Confirm the sign-in worked before continuing.
```

A sign-in page opens in your browser. Sign in as usual, read what you are allowing, and approve it.

## 3. Start working

Go to [What to ask your agent](./prompts). Name your website's folder in each request, and add _on my computer_ if the agent starts working in its cloud computer instead.

## If something goes wrong

| What you see                              | What to do                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| The agent can't find your folder          | Check its access to your computer is on and the desktop app is open, then ask again on _my computer_. |
| The sign-in page opens but never finishes | The sign-in ran on the cloud computer. Ask: _Sign in to ZynoHosting again, on my computer._           |
| A Node or `npx` error                     | Install Node.js 24 from [nodejs.org](https://nodejs.org/), then try again.                            |
| The agent asks you to run a command       | Reply: _Please do that yourself, on my computer. I don't use the terminal._                           |
| An error you don't understand             | Paste it back and ask: _Explain this in plain language and tell me what to do next._                  |
