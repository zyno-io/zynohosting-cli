# CLI, skill, or MCP

Agents reach ZynoHosting through one of two interfaces. Use the CLI with the ZynoHosting skill wherever the agent has a shell. Use the MCP server only where it doesn't, and for ZynoForms.

| Client                                               | Use                                             | Why                                                       |
| ---------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------- |
| Claude Code (terminal, IDE, desktop Code tab), Codex | **CLI + skill**                                 | Has a shell. Nothing runs or loads until a task needs it. |
| Claude desktop app, Chat and Cowork tabs             | **Desktop extension** (`.mcpb`, the MCP server) | No shell, so a CLI is unusable there.                     |
| Any agent doing ZynoForms work                       | **MCP server**, alongside the skill             | The CLI has no forms commands yet.                        |
| CI and scripts                                       | **CLI** with `ZYNOHOSTING_API_KEY`              | No agent involved.                                        |

## Why the CLI is the default for coding agents

An MCP server is configured per project and starts with every agent session. It spawns `npx` at startup and adds about twenty tool schemas and its instructions to the agent's context, even in sessions that never touch hosting. Adding one also requires restarting the agent and approving the server.

A skill costs a one-line description until the agent decides it is relevant, then loads its instructions. The CLI runs only when invoked. The agent can install the skill and use it in the same session, so there is no restart.

The CLI already has what an agent needs:

- the same operations as the MCP hosting tools (sites, files, deploy, preview, promote, download);
- `--json` with stable error codes and exit codes;
- `--dry-run` for `deploy` and `promote`;
- a non-interactive guard: `deploy`, `promote`, `download`, and `files rm` exit with `confirmation_required` instead of prompting when `--yes` (or `--dry-run`) is missing. `files put` applies immediately, so the skill tells agents to get approval first.

The policy the MCP server delivers as server instructions, such as never guessing a domain or never forcing a promotion, lives in the skill instead.

## Why the MCP server stays

Removing the MCP server entirely would cut off two groups:

- **Claude desktop Chat and Cowork users.** They are the main non-technical audience, and their client cannot run a CLI. The signed desktop extension is the only way in, and it needs no Node.js install.
- **ZynoForms.** The form tools (`describe_form`, `update_form`, and the rest) have no CLI equivalent. Coding agents that edit forms still need the MCP server, configured with [`mcp install`](../mcp/agent).

For Codex and Claude Code, the project-level MCP setup is now optional. Use it for forms, or when a team prefers tools over shell commands.

## What the CLI does not do that the MCP server does

| MCP behavior                                                                | CLI equivalent                                                                                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `plan_deploy` returns a `planId`; `apply_deploy` applies exactly that plan. | `deploy --dry-run` shows a plan; `deploy --yes` plans again and applies at once. The agent re-runs the dry run if anything changed. |
| `login` returns the one-time URL as a tool result.                          | `login` opens the browser and blocks for up to 300 seconds. The agent runs it as a long-running command.                            |
| Local roots (`--root`, `ZYNOHOSTING_MCP_ROOTS`) confine local paths.        | None. The agent's own permission system governs the shell.                                                                          |
| Form tools and the `zynoforms://guides/embedding` resource.                 | None yet.                                                                                                                           |

## Possible follow-ups

These would let the MCP server shrink to the desktop extension alone:

1. `zynohosting forms …` commands at parity with the MCP form tools.
2. A plan file for `deploy` and `promote` (for example `--plan-out`/`--plan-in`), so an approved dry run is exactly what gets applied.
3. A `zynohosting skill install --agent claude|codex` command, so the skill ships in the npm package and stays version-matched to the CLI.

## Where the guidance lives

| Interface | Agent guidance                                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI       | [`skills/zynohosting/SKILL.md`](https://github.com/zyno-io/zynohosting-cli/blob/main/skills/zynohosting/SKILL.md), installed by [install.md](./install) |
| MCP       | `SERVER_INSTRUCTIONS` and tool descriptions in `src/mcp/server.ts` and `src/mcp/forms.ts`, delivered on every connection                                |

Keep both in step when behavior changes. The [preview guide](../guide/preview) is the shared reference for the preview model.
