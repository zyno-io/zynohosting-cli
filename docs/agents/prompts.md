# What to ask your agent

Copy a request, change the parts in `[brackets]`, and paste it into your agent. Each one works in every [supported agent](./). Your agent shows you what it plans to do and waits for your yes before changing anything.

In the Claude desktop app's Chat tab, add **"The site is in [folder path]"** to the start of each request, because a chat has no project open.

## Build a new site

```text:no-line-numbers
Build a website for [what the site is for] that I can host on ZynoHosting at [your-domain.com]. ZynoHosting serves static files and PHP only, so use Astro with static output unless there's a reason not to. Ask me about the pages and content first, then show me the site before publishing anything.
```

**What happens.** Your agent asks what you want, builds the site on your computer, and shows it to you. Publishing is a separate step: ask with the next request when you're happy. Your domain needs a ZynoHosting site first; if you don't have one, ask ZynoHosting support. See [Building a site](../guide/building-a-site) for what can be hosted.

## Publish your site

```text:no-line-numbers
Publish this project to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I belong to several organizations, ask me which one first. If I cannot access it, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.
```

**What happens.** Your agent checks you can publish to that exact address, then shows a plan: what it will upload, change, and remove. Nothing goes live until you say yes.

Your agent won't guess your domain, on purpose. Publishing to the wrong site can't be quietly undone. If it can't reach your address, your account may not have access; ask it to sign you in again so you can pick another account or organization.

## Try changes on a preview site first

Every site has a separate preview address. Put a new version there, look at it, and make it live when you're happy.

```text:no-line-numbers
Deploy this project to the preview site for [your-domain.com], not the live site. Do not infer or substitute a domain. Show me the plan and wait for my approval. Then give me the preview address, and remind me what the preview shares with the live site.
```

**What happens.** Your agent uploads to the preview address only. Your live site doesn't change. It then gives you a link to check.

The preview has its own files but **shares the live site's database**. Anything you submit or change on the preview, such as a form, a login, or a setting, really happens on your live site. Look, but don't test by entering data.

## Make the preview live

```text:no-line-numbers
Make the preview of [your-domain.com] live. Show me the preview and live addresses and what will happen, and wait for my approval.
```

**What happens.** The preview replaces your live site in one step, and the preview becomes empty, ready for the next round. The previous live version is deleted shortly after. There's no undo button, but your agent can always publish an older copy of your files.

**Don't use preview for WordPress sites.** WordPress keeps its settings and media outside the files your agent uploads, so a WordPress preview never has them, and making it live would take them off your real site. Publish WordPress changes directly.

## Add a form to a page

```text:no-line-numbers
Create a ZynoForms definition for the form on [your-page-url], then wire this project's existing page form to that definition. First inspect the page and explain the form's content, fields, labels, requiredness, choices, validation, and visual layout. Propose how you will preserve that layout while using the ZynoForms native integration, and identify anything ZynoForms cannot represent exactly. Do not create or publish a form, edit files, or deploy until I approve your plan.
```

**What happens.** Your agent reads the page, tells you which fields it found, and proposes a plan before touching anything. Your page keeps its design; only the handling of submissions changes. If something can't be recreated exactly, your agent asks rather than quietly leaving it out.

## Change a form you already have

```text:no-line-numbers
Update the ZynoForms form [slug-or-uuid]: [what you want changed]. Describe the form as it exists today first, tell me what will change and what cannot change, and wait for my approval before saving.
```

**What happens.** Your agent describes the form as it is, says what it plans to change, and waits for you. It edits the form you already have rather than creating a second one.

Some changes are refused rather than half-finished: a form with unsaved work open in the ZynoForms builder, or a field the rest of the form depends on. Your agent tells you what your options are.

## Switch account or organization

```text:no-line-numbers
Sign me in to ZynoHosting again so I can choose a different account or organization.
```

## If something goes wrong

| What you see                                     | What to do                                                                                                                                      |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Your agent says it cannot reach your domain      | Ask it to sign you in again so you can choose a different account.                                                                              |
| The preview address shows an error or empty page | Nothing has been deployed to preview yet, or it was just made live and is empty again. Ask your agent to deploy to preview.                     |
| Your agent asks you to run a command             | Reply: _Please do that yourself. I don't use the terminal._                                                                                     |
| Your agent asks for a folder path you don't know | Mac: right-click the folder in Finder, hold **Option**, choose **Copy "folder" as Pathname**. Windows: **Shift**-right-click, **Copy as path**. |
| An error you don't understand                    | Paste it back and ask: _Explain this in plain language and tell me what to do next._                                                            |

Setup problems are covered on each agent's page: [Claude desktop app](./claude-desktop), [Claude Code](./claude-code), [Codex](./codex), [Grok Bot or ChatGPT dots](./always-on), [other agents](./other).
