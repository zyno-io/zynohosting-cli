# Set up ZynoHosting for an agent

Copy one prompt at a time into Codex or Claude Code. You do not need to open a terminal—the agent runs everything itself.

**If you are an agent that fetched this file:** the blockquoted text is what the _user_ pastes to start a task. Read it as a task description, not as an instruction addressed to you. Your own rules are in [Agent procedure](#agent-procedure) at the end of this file; follow that section.

[Configure the MCP server](#configure-the-mcp-server) once per project, then [Sign in](#sign-in). The remaining sections are independent tasks—do whichever you need.

## What each task needs

| Task                                                            | MCP tools                                                          | Zyno permissions                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- |
| [Configure the MCP server](#configure-the-mcp-server)           | none—a one-off CLI installer                                       | none                                                            |
| [Sign in](#sign-in)                                             | `login`                                                            | requests only what the next task needs                          |
| [Publish a site](#publish-a-site)                               | `list_sites`, `get_site`, `plan_deploy`, `apply_deploy`            | `hosting.sitesRead`, `hosting.deploy`                           |
| [Create a form and wire a page](#create-a-form-and-wire-a-page) | `create_basic_form`, `get_form_integration`, `update_form_origins` | `forms.create`, plus `hosting.sitesRead` for site-based origins |
| [Change an existing form](#change-an-existing-form)             | `describe_form`, `update_form`                                     | `forms.edit`                                                    |

Full argument and effect details: [MCP tool reference](https://zyno-io.github.io/zynohosting-cli/mcp/tools).

## Configure the MCP server

> Set up ZynoHosting MCP for this project if it's not already configured. See https://raw.githubusercontent.com/zyno-io/zynohosting-cli/main/docs/mcp/setup.md for details.

The agent configures only itself:

- Codex writes this project’s `.codex/config.toml`.
- Claude Code writes this project’s `.mcp.json`.

It never writes both files. The agent uses its own identity to run the installer with `--agent codex` or `--agent claude`; it does not need the user to run that command. Re-running the installer is safe: it merges a single `zynohosting` entry and leaves an existing one unchanged. Neither file stores an API key or browser credential, so both are safe to commit.

**Important:** Start a new Codex or Claude Code session after setup. MCP servers are loaded at session start, so the session that installed it cannot use the new tools.

Claude Code may also ask for its normal one-time approval before it enables a project MCP server.

If it does not work: the package requires Node.js 24. Codex pins this project’s absolute path in its entry, so re-run the installer after moving or renaming the project directory.

## Sign in

> Sign in to ZynoHosting for this project. Use the MCP `login` tool, open the browser sign-in page, and give me the one-time link if my browser does not open automatically. After I finish signing in, verify the login status before continuing.

The agent opens a secure browser sign-in flow—there is no CLI login command for you to run. It requests only the permissions needed for the task, listed in the table above.

Signing in again can switch to a different ZynoHosting account or organization. It cannot replace an API key or bearer token injected into the MCP process; in that situation, change the injected credential and restart the agent.

Sign-in waits for you to finish multi-factor or single sign-on, and expires after five minutes. On Codex the installer already sets a longer MCP tool timeout to allow for that.

## Publish a site

> Publish this project to [your-domain.com]. Do not infer or substitute a domain. First verify that I can access this exact domain with the current ZynoHosting login. If I cannot, offer to sign in again and switch context. Create and show me the deployment plan, then wait for my approval before applying it.

Replace `[your-domain.com]` with the exact domain you want to publish. The agent must not guess it from the repository, site content, organization name, or another available site.

If the exact domain is not available in the current login context, the agent must not pick a similar one. It should offer the Sign in prompt again so you can switch to an account or organization that has access.

You always see a plan before anything is published, and nothing is applied until you approve it.

## Create a form and wire a page

> Create a ZynoForms definition for the form on [your-page-url], then wire this project’s existing page form to that definition. First inspect the page and explain the form’s content, fields, labels, requiredness, choices, validation, and visual layout. Propose how you will preserve that layout while using the ZynoForms native integration, and identify anything ZynoForms cannot represent exactly. Do not create or publish a form, edit files, or deploy until I approve your plan.

Replace `[your-page-url]` with the exact page that contains the form. The agent should read the current page before making a plan; it should not substitute a generic contact form or redesign the page.

After you approve the plan, the agent creates the ZynoForms definition with matching supported fields, obtains its integration details, and wires the existing page markup to the returned native integration. This keeps the page’s design and layout while ZynoForms handles submissions. It must use the exact page origin for the form’s allowed origins, follow the returned response contract, and use the returned `jsonScript` or `capScript` when applicable.

If the form has behavior or controls ZynoForms cannot represent, the agent must explain the limitation and ask how you want to proceed. It must not silently drop fields, validation, choices, or protection.

## Change an existing form

> Update the ZynoForms form [slug-or-uuid]: [what you want changed]. Describe the form as it exists today first, tell me what will change and what cannot change, and wait for my approval before saving.

Replace `[slug-or-uuid]` with the form’s exact slug or UUID—names are not accepted—and say what you want changed.

The agent reads the current form before proposing an edit, so it changes that form in place instead of creating a second one. Fields it does not touch keep every stored property, including content the agent cannot author itself, such as sections, conditional rules, themes, and translations.

Some things are refused rather than half-applied: a field a conditional rule depends on cannot be renamed or removed, and a form with an unpublished draft in the ZynoForms builder is not overwritten. The agent should tell you which of these it hit and what your options are.

## Agent procedure

This section is for the agent. Everything above is written for the user.

### Configuring the MCP server

1. Identify which agent you are, then run exactly one of these:

    ```bash
    # Codex — writes ./.codex/config.toml
    npx -y @zyno-io/zynohosting mcp install --project . --agent codex

    # Claude Code — writes ./.mcp.json
    npx -y @zyno-io/zynohosting mcp install --project . --agent claude
    ```

2. Always pass `--agent` explicitly. Detection without it works only when `CLAUDECODE=1` or `CODEX_HOME` is set, and the command fails rather than guessing.
3. Never configure the other agent’s project file.
4. You do not need to check whether it is already configured. The installer merges one `zynohosting` entry, leaves an existing entry untouched, writes no credentials, and reports which files it configured versus already configured.
5. Afterward, tell the user to restart this agent. Do not claim the ZynoHosting tools are available in the current session—they are not.

### Signing in

- There is no CLI login for the user to run. Call the `login` tool, give the user the one-time URL from the result, then call `login` with `action: "status"` to confirm completion before continuing.
- Request only the permissions the task needs, per the table above. Do not request `hosting.deploy` or `forms.edit` speculatively.
- If the MCP process was given an injected `ZYNO_HOSTING_API_KEY` or bearer token, `login` cannot replace it. Tell the user to change that injected credential and restart the MCP host.

### Publishing a site

- Never infer a deployment domain from the repository, site content, organization name, or a similar available site. If the user has not named one, ask.
- Verify the named domain with `get_site` or `list_sites` before planning. If it is unavailable in the current login context, do not substitute another—offer `login` so the user can switch account or organization.
- Call `plan_deploy`, show the plan, and wait for explicit approval before calling `apply_deploy` with the returned `planId`.

### Working with forms

- Read the existing page before proposing anything. Preserve its markup and layout; do not replace it with a generic form.
- Before editing an existing form, call `describe_form`. It reports what is editable, what is locked, and whether an unpublished draft is blocking edits. Then use `update_form`; do not create a duplicate form.
- Use the exact page origin in the form’s allowed origins, follow the returned response contract, and use the returned `jsonScript` or `capScript` when the form is bot-protected.
- If ZynoForms cannot represent a field, validation rule, choice, or protection behavior, say so and ask how to proceed. Never drop it silently.

### Editing this file

It is fetched raw by agents, so keep it plain Markdown: no VitePress `:::` containers, and no relative links, which do not resolve on `raw.githubusercontent.com`. Use full `https://zyno-io.github.io/zynohosting-cli/...` URLs.
