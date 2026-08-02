# Set up and use ZynoHosting in your agent

ZynoHosting works inside Codex and Claude Code. You describe what you want in plain English, and your agent does the work—signing in, publishing your site, connecting your forms.

Everything on this page is something you copy and paste into your agent, one at a time. You never need to open a terminal or type a command. If your agent ever asks you to run something yourself, you can reply:

> Please do that yourself. I don't use the terminal.

## Before you start

- Codex or Claude Code, open on your project.
- A ZynoHosting account you can sign in to in a browser.

## Step 1: Connect ZynoHosting to your project

Do this once for each project. Copy this into your agent:

> Set up ZynoHosting MCP for this project if it's not already configured. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/agent.md for details.

**What happens.** Your agent connects itself to ZynoHosting and saves a small settings file inside your project. That file holds no passwords.

**Then restart your agent.** Close it and open it again.

This is the step people miss. Your agent cannot use ZynoHosting until it has been restarted—even though it just finished setting it up. If it tells you it has no ZynoHosting tools, this is almost always why.

Claude Code may also ask you once to approve ZynoHosting for this project. Approve it.

## Step 2: Sign in

> Sign in to ZynoHosting for this project. Use the MCP `login` tool, open the browser sign-in page, and give me the one-time link if my browser does not open automatically. After I finish signing in, verify the login status before continuing.

**What happens.** A ZynoHosting sign-in page opens in your browser. If it does not open on its own, your agent gives you a link to click. Sign in the way you normally would.

The page lists what you are allowing your agent to do. Read it, and approve it if it matches what you asked for. Your agent asks only for what the job needs, so publishing a site asks for more than simply looking at one.

You sign in once, and your agent stays signed in. Use this prompt again whenever you want to switch to a different ZynoHosting account or organization.

## Publish your site

> Publish this project to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I cannot, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.

Replace `[your-domain.com]` with the real web address you want to publish to.

**What happens.** Your agent checks that you can publish to that exact address, then shows you a plan—what it will upload, change, and remove. Nothing goes live until you say yes.

Your agent will not guess your domain, on purpose. Publishing to the wrong site is not something you can quietly undo, so it uses the address you give it and nothing else. If it says it cannot reach that address, your account may not have access to it; ask it to sign you in again so you can pick a different account or organization.

## Add a form to a page

> Create a ZynoForms definition for the form on [your-page-url], then wire this project’s existing page form to that definition. First inspect the page and explain the form’s content, fields, labels, requiredness, choices, validation, and visual layout. Propose how you will preserve that layout while using the ZynoForms native integration, and identify anything ZynoForms cannot represent exactly. Do not create or publish a form, edit files, or deploy until I approve your plan.

Replace `[your-page-url]` with the address of the page your form is on.

**What happens.** Your agent reads that page, tells you which fields it found, and proposes a plan before touching anything. Your page keeps its existing design—only the handling of submissions changes.

If something on your form cannot be recreated exactly, your agent tells you and asks how you want to handle it, rather than quietly leaving it out.

## Change a form you already have

> Update the ZynoForms form [slug-or-uuid]: [what you want changed]. Describe the form as it exists today first, tell me what will change and what cannot change, and wait for my approval before saving.

Say which form and what you want changed—for example, adding a phone number field or changing where submission emails go.

**What happens.** Your agent looks at the form as it is today, tells you what it plans to change, and waits for your approval. It edits the form you already have instead of creating a second one, and the parts you did not ask about stay exactly as they are.

Some changes get refused rather than half-finished. If your form is open and unsaved in the ZynoForms builder, your agent will not overwrite that work. Some fields cannot be renamed or removed because the rest of the form depends on them. Your agent tells you when it hits one of these and what your options are.

## If something goes wrong

| What you see                                | What to do                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Your agent says it has no ZynoHosting tools | Restart it. If you already have, paste the Step 1 prompt again, then restart.                                             |
| The sign-in page never opened               | Ask: _Give me the ZynoHosting sign-in link._ Links expire after five minutes—if yours has, ask it to start sign-in again. |
| Your agent says it cannot reach your domain | Ask: _Sign me in to ZynoHosting again so I can choose a different account._                                               |
| Your agent asks you to run a command        | Reply: _Please do that yourself. I don't use the terminal._                                                               |
| An error you don't understand               | Paste it back and ask: _Explain this in plain language and tell me what to do next._                                      |

## For developers

- [Install instructions for agents](./agent)—what the agent does during Step 1.
- [Configure the local MCP server](./)—manual setup, environments, and security boundaries.
- [MCP tool reference](./tools)—every tool, argument, and permission.
