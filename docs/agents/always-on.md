# Set up Grok Bot or ChatGPT dots

For always-on agents that have their own cloud computer: **Grok Bot** from xAI, and **dots** in ChatGPT.

By default your agent works on its own cloud computer. It signs in to ZynoHosting with a link and a short code that you approve from any device, even your phone. Nothing has to run on your computer.

## 1. Paste this into your agent

```text:no-line-numbers
Set up ZynoHosting on your cloud computer. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Your agent saves an instruction file in its workspace that teaches it to use ZynoHosting. The file holds no passwords. ZynoHosting needs **Node.js 24** on that computer, and your agent installs it if it is missing.

## 2. Sign in

```text:no-line-numbers
Sign in to ZynoHosting. Ask only for the permissions this task needs. Give me the link and the code, then wait while I approve it. When it is done, tell me which account and organization you signed in to.
```

Your agent shows a link and a short code, like `ABCD-EFGH`. Then:

1. Open the link on any device.
2. Sign in to ZynoHosting if it asks.
3. Check that the code on the page matches the one your agent showed you.
4. Choose how long this access lasts: 1 hour, 1 day, 7 days, or 30 days.
5. Tick the box that confirms you started this sign-in yourself, then approve.

If you do not hold some of the permissions your agent asked for in that organization, you can approve only the ones you have. Your agent tells you which were left out, and anything that needs them will not work until someone who has them signs in.

Your agent finishes by itself. It then tells you which account and organization it signed in to. Check that they are yours.

::: warning Only approve a code you just asked for
If someone else sent you a link or a code, do not approve it. It would give them access to your sites.
:::

The code works for about ten minutes. If it runs out, ask your agent to sign in again.

## 3. Start working

Go to [What to ask your agent](./prompts).

- **A new site:** your agent builds it on its own computer and publishes it.
- **A site you already have:** ask your agent to download it first, for example _Download example.com from ZynoHosting, then change the opening hours on the contact page._ That needs the backup permission, so allow it when the agent asks.

## How long access lasts, and signing out

The access you approve ends when the time you chose runs out. Your agent then asks you to approve a new sign-in. You can end it sooner at any time:

- Ask your agent: _Sign out of ZynoHosting._
- Or cancel it yourself on the **CLI logins** page of your Zyno account.

If you belong to more than one organization, the agent keeps one sign-in for each. It asks which organization you mean before it changes anything. Ask _Which organizations are you signed in to?_ to see them.

The agent's sign-in is kept in a private file on its cloud computer. Anyone who can read that file, or a backup of that computer, can act with the access you approved until it ends or you sign out. Choose the shortest time that fits the job.

## Optional: work on files on your own computer

Only do this if your website folder is on your computer and you want your agent to use it directly. First give the agent access to your computer:

- **Grok Bot:** in the Grok Bot desktop app, open **Settings → Computer** and set **Execution on this computer** to **Ask every time** or **Always allow**.
- **ChatGPT dots:** install the ChatGPT desktop app and turn on your dot's access to this computer. In a work or school workspace, an admin may need to allow it first.

The app must be open on your computer while the agent works. You need **Node.js 24** on your computer, from [nodejs.org](https://nodejs.org/).

Then paste this, with the folder that holds your website:

```text:no-line-numbers
Set up ZynoHosting for the website in ~/Sites/my-site. Run every command on my computer, not your cloud computer. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md
```

Sign in the same way as above, and add _on my computer_ to each request if the agent starts working in its cloud computer instead.

## If something goes wrong

| What you see                                   | What to do                                                                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The code expired, or the page says it is wrong | Ask: _Start the ZynoHosting sign-in again and give me the new link and code._                                     |
| The link will not open                         | Open it on another device, or go to the sign-in address your agent showed and type the code.                      |
| The agent says the credential store is missing | Reply: _Use the file store on your cloud computer, as the ZynoHosting skill says._                                |
| A Node or `npx` error                          | Reply: _Install Node.js 24 on your cloud computer, then try again._                                               |
| The agent can't find your website files        | Ask it to download the site from ZynoHosting first, or use the optional section above for files on your computer. |
| The agent asks you to run a command            | Reply: _Please do that yourself. I don't use the terminal._                                                       |
| An error you don't understand                  | Paste it back and ask: _Explain this in plain language and tell me what to do next._                              |
