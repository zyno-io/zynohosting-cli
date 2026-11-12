# Set up and use ZynoHosting in your agent

ZynoHosting works inside the Claude desktop app, Codex, and Claude Code. You describe what you want in plain English, and your agent does the work: signing in, publishing your site, trying changes on a preview site, and connecting your forms.

Setup takes a few clicks, once. After that, everything on this page is something you copy and paste into your agent, one prompt at a time. You never need to open a terminal or type a command. If your agent ever asks you to run one yourself, you can reply:

> Please do that yourself. I don't use the terminal.

## Before you start

You need two things.

- **A ZynoHosting account** you can sign in to in a browser.
- **Your website's files in a folder on your own computer.** ZynoHosting publishes from that folder, so it has to be on the same machine your agent runs on. A folder that is only in Dropbox on another laptop won't work.

## Step 1: Install ZynoHosting

Do this once. Use the section that matches what you have.

### Install in the Claude desktop app

This covers the **Chat** and **Cowork** tabs.

[**Download ZynoHosting for Claude**](https://github.com/zyno-io/zynohosting-cli/releases/latest/download/zynohosting.mcpb), then **double-click the downloaded file**. Claude opens an install window. Read what it says, then click **Install**.

That is the whole setup. You do not need Node.js or anything else, and Claude keeps ZynoHosting up to date from then on.

The install window offers to limit ZynoHosting to particular folders. **Leave that empty.** You can then publish any folder you point it at, and add new sites whenever you like without changing settings. If you would rather confine it, say on a shared computer, add folders there. You can change them later without reinstalling.

**How to tell it worked.** Click the **+** button beside the message box, hover **Connectors**, and choose **Manage connectors**. ZynoHosting should be listed. If it is not, see [If something goes wrong](#if-something-goes-wrong).

Nothing you installed holds a password. You sign in separately, in Step 2, through your browser.

### Set up Codex or Claude Code

This covers Codex, Claude Code in a terminal or your editor, and the Claude desktop app's **Code** tab. These agents can install ZynoHosting themselves, per project. They need [Node.js 24](https://nodejs.org/) on the computer. Copy this into your agent:

> Set up ZynoHosting for this project. Follow https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/agents/install.md

**What happens.** Your agent adds a small instruction file to your project that teaches it how to use ZynoHosting. The file holds no passwords. You can carry on straight away, with no restart.

Forms need one more piece. If you plan to [add or change forms](#add-a-form-to-a-page), say so, and your agent will also connect the ZynoHosting MCP server. That part does need a restart afterward.

## Step 2: Sign in

> Sign in to ZynoHosting. Ask only for the permissions this task needs, open the browser sign-in page, and give me the link if my browser does not open. Confirm the sign-in worked before continuing.

**What happens.** A ZynoHosting sign-in page opens in your browser. If it does not open on its own, your agent gives you a link to click. Sign in the way you normally would.

The page lists what you are allowing your agent to do. Read it, and approve it if it matches what you asked for. Your agent asks only for what the job needs, so publishing a site asks for more than looking at one.

You stay signed in. Use this prompt again whenever you want to switch to a different ZynoHosting account or organization.

## Publish your site

> Publish this project to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I cannot, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.

Replace `[your-domain.com]` with the real web address you want to publish to.

In the Claude desktop app's Chat tab, also say which folder, because a conversation has no project open:

> Publish the site in [/absolute/path/to/project] to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I cannot, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.

To get that path without typing it: on macOS, right-click the folder in Finder, hold **Option**, and choose **Copy "folder" as Pathname**. On Windows, hold **Shift**, right-click, and choose **Copy as path**, then remove the quotation marks.

**What happens.** Your agent checks that you can publish to that exact address. Then it shows you a plan: what it will upload, change, and remove. Nothing goes live until you say yes.

Your agent will not guess your domain, on purpose. Publishing to the wrong site is not something you can quietly undo, so it uses only the address you give it. If it says it cannot reach that address, your account may not have access to it. Ask it to sign you in again so you can pick a different account or organization.

In Chat, read the plan carefully before you approve it. Your agent cannot browse your computer there. It is working from the path you gave it, and the plan is your one chance to catch a wrong folder before it goes live.

## Try changes on a preview site first

Every ZynoHosting site has a separate preview address. You can put a new version there, look at it, and make it live only when you are happy.

> Deploy this project to the preview site for [your-domain.com], not the live site. Do not infer or substitute a domain. Show me the plan and wait for my approval. Then give me the preview address, and remind me what the preview shares with the live site.

**What happens.** Your agent uploads to the preview address only. Your live site does not change. When it is done, it gives you a link to check.

The preview has its own files but **shares the live site's database**. Anything you submit or change on the preview, such as a form, a login, or a setting, really happens on your live site. Look, but don't test by entering data.

## Make the preview live

> Make the preview of [your-domain.com] live. Show me the preview and live addresses and what will happen, and wait for my approval.

**What happens.** The preview version replaces your live site in one step, and the preview becomes empty again, ready for the next round. The previous live version is deleted shortly after. There is no undo button, but your agent can always publish an older copy of your files.

**Don't use preview for WordPress sites.** WordPress keeps its settings and media outside the files your agent uploads, so a WordPress preview never has them, and making it live would take them off your real site. Your agent should warn you if you ask. Publish WordPress changes directly instead.

## Add a form to a page

> Create a ZynoForms definition for the form on [your-page-url], then wire this project's existing page form to that definition. First inspect the page and explain the form's content, fields, labels, requiredness, choices, validation, and visual layout. Propose how you will preserve that layout while using the ZynoForms native integration, and identify anything ZynoForms cannot represent exactly. Do not create or publish a form, edit files, or deploy until I approve your plan.

Replace `[your-page-url]` with the address of the page your form is on.

**What happens.** Your agent reads that page, tells you which fields it found, and proposes a plan before touching anything. Your page keeps its existing design. Only the handling of submissions changes.

If something on your form cannot be recreated exactly, your agent tells you and asks how you want to handle it, rather than quietly leaving it out.

In Codex or Claude Code, forms need the ZynoHosting MCP server alongside the skill. If it isn't connected yet, your agent offers to add it and asks you to restart.

## Change a form you already have

> Update the ZynoForms form [slug-or-uuid]: [what you want changed]. Describe the form as it exists today first, tell me what will change and what cannot change, and wait for my approval before saving.

Say which form and what you want changed, for example adding a phone number field or changing where submission emails go.

**What happens.** Your agent looks at the form as it is today, tells you what it plans to change, and waits for your approval. It edits the form you already have instead of creating a second one. The parts you did not ask about stay exactly as they are.

Some changes get refused rather than half-finished. If your form is open and unsaved in the ZynoForms builder, your agent will not overwrite that work. Some fields cannot be renamed or removed because the rest of the form depends on them. Your agent tells you when it hits one of these and what your options are.

## If something goes wrong

| What you see                                             | What to do                                                                                                                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The Claude Chat tab cannot set ZynoHosting up for itself | It never can, and it does not need to. Install it from [the download](#install-in-the-claude-desktop-app) instead.                                                           |
| Claude Chat says it has no ZynoHosting tools             | Quit the whole Claude app, not just the window, and reopen it. If that doesn't help, repeat [the install](#install-in-the-claude-desktop-app).                               |
| ZynoHosting says the extension must be updated           | Install the current version from [the download](#install-in-the-claude-desktop-app), then restart Claude. It normally updates itself, so this means an update was blocked.   |
| It has the tools but says a folder is not allowed        | You limited it to specific folders during install. Open Settings → Extensions → ZynoHosting, add the folder or clear the list entirely, then restart Claude.                 |
| Codex or Claude Code shows a Node or `npx` error         | Those need [Node.js 24](https://nodejs.org/) installed. The Claude desktop extension does not.                                                                               |
| Codex or Claude Code says it has no form tools           | Ask: _Connect the ZynoHosting MCP server for forms._ Then restart it.                                                                                                        |
| Your agent asks for a folder path you do not know        | On macOS, right-click the folder in Finder, hold **Option**, and choose **Copy "folder" as Pathname**. On Windows, hold **Shift**, right-click, and choose **Copy as path**. |
| The sign-in page never opened                            | Ask: _Give me the ZynoHosting sign-in link._ Links expire after five minutes. If yours has, ask it to start sign-in again.                                                   |
| Your agent says it cannot reach your domain              | Ask: _Sign me in to ZynoHosting again so I can choose a different account._                                                                                                  |
| The preview address shows an error or an empty page      | Nothing has been deployed to preview yet, or it was just made live and is empty again. Ask your agent to deploy to preview.                                                  |
| Your agent asks you to run a command                     | Reply: _Please do that yourself. I don't use the terminal._                                                                                                                  |
| An error you don't understand                            | Paste it back and ask: _Explain this in plain language and tell me what to do next._                                                                                         |

## For developers

- [CLI, skill, or MCP](./interfaces): which agent interface to use, and why.
- [Install instructions for agents](./install): what the agent does during Step 1.
- [The ZynoHosting skill](https://github.com/zyno-io/zynohosting-cli/blob/main/skills/zynohosting/SKILL.md): what the agent knows afterward.
- [Preview and production](../guide/preview): the preview model, hostnames, and pitfalls.
- [Configure the local MCP server](../mcp/): the desktop extension, manual MCP setup, and security boundaries.
