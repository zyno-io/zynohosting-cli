# Permissions

ZynoHosting and ZynoForms automation use tenant permissions at their APIs. Hosting file, deploy, and download operations additionally use short-lived capability scopes at the site’s cluster.

## Tenant permissions

| Permission                  | Capability                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `hosting.sitesRead`         | List and inspect authorized sites.                                                    |
| `hosting.filesRead`         | List files and download individual files.                                             |
| `hosting.filesWrite`        | Create and replace individual files.                                                  |
| `hosting.filesDelete`       | Delete individual files.                                                              |
| `hosting.deploy`            | Deploy production/preview content, promote preview, and change missing-page handling. |
| `hosting.download`          | Download the deployable snapshot.                                                     |
| `hosting.downloadSensitive` | Include protected and user-generated content in a snapshot.                           |
| `hosting.analyticsRead`     | Read hosting analytics.                                                               |
| `hosting.analyticsManage`   | Change analytics configuration.                                                       |
| `forms.create`              | Create and immediately publish a basic form.                                          |
| `forms.edit`                | Change a form’s name, fields, Cap protection, and allowed CORS origins.               |

That table is the complete set of keys a CLI token can request. `zynohosting login --help` prints it and the MCP `login` tool enumerates it in its schema, so a plausible-looking invention such as `hosting.sitesWrite` fails locally—naming the closest real key—before any browser opens.

Browser login can issue a token only for permissions currently resolved for that user. A tenant may disable CLI-token minting and renewal for non-admin users. The browser rejects the whole request if any key is unknown, unavailable, malformed, or non-delegable; it does not partially grant the remainder.

Never request `msp.login`, `msp.impersonate`, `core.changePassword`, or `core.manageFingerprints`. Those capabilities cannot be delegated to scoped CLI tokens.

Listing forms, describing their structure, and reading their integration details require an authenticated tenant identity. Authoring a form — creating or editing one — also requires a user identity: the Suite stamps every form mutation with the account that made it, so a workstation-only credential is refused. Expanding form origins from a ZynoHosting site additionally requires `hosting.sitesRead` because the tool reads that site’s primary, alias, and vanity hostnames.

## Cluster capability scopes

The Hosting Manager maps an authorized request to the minimum agent scopes needed for that operation:

| Agent scope           | Manager permission                                 |
| --------------------- | -------------------------------------------------- |
| `deploy:inventory`    | `hosting.deploy`                                   |
| `deploy:hash`         | `hosting.deploy`                                   |
| `deploy:apply`        | `hosting.deploy`                                   |
| `files:list`          | `hosting.filesRead`                                |
| `files:read`          | `hosting.filesRead`                                |
| `files:write`         | `hosting.filesWrite`                               |
| `files:delete`        | `hosting.filesDelete`                              |
| `download:deployable` | `hosting.download`                                 |
| `download:sensitive`  | `hosting.download` and `hosting.downloadSensitive` |

The capability is bound to one site and cluster and includes exact scopes, protocol version, upload/download limits, a unique token ID, and time bounds.

## Least-privilege examples

### Read-only inspection

Grant:

- `hosting.sitesRead`
- `hosting.filesRead`

This supports site discovery, listings, and individual-file downloads without remote mutation.

### Deployment automation

Grant:

- `hosting.sitesRead`
- `hosting.deploy`

Add `hosting.filesRead` only if the same workflow must inspect or download individual files.

This same permission set covers `deploy --preview`, `promote`, `sites set`, and their MCP tools.
No new permission is introduced for preview or promotion.

### Backup automation

Grant:

- `hosting.sitesRead`
- `hosting.download`

Add `hosting.downloadSensitive` only when the backup destination is approved to receive protected and user-generated content.

## Troubleshoot a forbidden operation

Check:

1. that the credential belongs to the intended tenant;
2. that the site is granted to that tenant or principal;
3. that the matching hosting permission is assigned;
4. that a sensitive download has both required permissions;
5. that a non-renewable login has not reached its fixed 60-minute expiration;
6. that tenant policy still permits renewal for a renewable login.

Do not solve a narrow authorization failure by broadly granting tenant-admin access. Add the smallest permission set that supports the workflow.
