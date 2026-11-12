# ZynoForms

`zynohosting forms` exposes the ZynoForms tools of the [MCP server](../mcp/tools#zynoforms) on the command line, so an agent without MCP access can discover, create, inspect, edit, and connect forms. Arguments and results are identical to the MCP tools; see the [MCP tools reference](../mcp/tools#zynoforms) for every argument.

## JSON in, JSON out

- Input is one JSON object, passed with `--input`. Omit it for a command that needs no arguments.
- Output is always one line of JSON on stdout. There is no `--json` flag and no human-readable mode.
- Unknown top-level keys are rejected with `invalid_input` rather than ignored.
- Errors are printed as JSON on stderr, with the exit codes in [JSON output and errors](../reference/json-and-errors). Bad options and arguments report `invalid_input` with exit code 2. The one exception is an invalid value for a global option such as `--environment`, which the top-level parser reports in plain text with exit code 1.

## Passing input

```bash
# Inline
zynohosting forms describe --input '{"form":"contact-us"}'

# From a file, relative to the current directory
zynohosting forms create --input @form.json

# From stdin
cat form.json | zynohosting forms create --input -
```

Prefer `@file.json` or `-` for large payloads such as `create` and `update`, which avoids shell quoting.

## Commands

| Command                | MCP tool                                | Permission                                                                        |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------------- |
| `forms list`           | `list_forms`                            | Authenticated tenant access                                                       |
| `forms integration`    | `get_form_integration`                  | Authenticated tenant access                                                       |
| `forms describe`       | `describe_form`                         | Authenticated tenant access                                                       |
| `forms create`         | `create_basic_form`                     | `forms.create`; plus `hosting.sitesRead` when `origin_sites` is used              |
| `forms update`         | `update_form`                           | `forms.edit`                                                                      |
| `forms bot-protection` | `update_form_bot_protection`            | `forms.edit`                                                                      |
| `forms origins`        | `update_form_origins`                   | `forms.edit`; plus `hosting.sitesRead` when `add_sites` or `remove_sites` is used |
| `forms guide`          | resource `zynoforms://guides/embedding` | None                                                                              |

`forms guide` needs no credentials and takes no input. It prints `{ "uri": "zynoforms://guides/embedding", "markdown": "…" }`.

## Examples

List forms:

```bash
zynohosting forms list
```

Get the integration package for the live version of a form (a UUID or exact slug):

```bash
zynohosting forms integration --input '{"form":"contact-us"}'
```

Describe a form before editing it:

```bash
zynohosting forms describe --input '{"form":"contact-us","include_draft":true}'
```

Create and publish a basic form:

```bash
zynohosting forms create --input '{
  "name": "Request a quote",
  "slug": "request-quote",
  "origin_sites": ["example.com"],
  "fields": [
    { "key": "name", "label": "Name", "type": "text" },
    { "key": "email", "label": "Email", "type": "email" }
  ]
}'
```

Edit a form, publishing a new version:

```bash
zynohosting forms update --input '{
  "form": "contact-us",
  "operations": [{ "op": "update_field", "key": "email", "label": "Work email" }]
}'
```

Change bot protection to `interactive`, `invisible`, or `disabled`:

```bash
zynohosting forms bot-protection --input '{"form":"contact-us","bot_protection":"invisible"}'
```

Allow or remove browser origins:

```bash
zynohosting forms origins --input '{"form":"contact-us","add_origins":["https://app.example.org"],"remove_sites":["old.example.com"]}'
```

Read the embedding guide:

```bash
zynohosting forms guide
```

## Credentials

Forms commands use the same credentials and `--api-url`, `--suite-api-url`, `--environment`, and `--api-key` overrides as every other command; see [Configuration](../reference/configuration). The credential must carry the permission listed above.
