# Permissions

ZynoHosting automation uses tenant permissions at the manager and short-lived capability scopes at the site’s cluster.

## Tenant permissions

| Permission                  | Capability                                                  |
| --------------------------- | ----------------------------------------------------------- |
| `hosting.sitesRead`         | List and inspect authorized sites.                          |
| `hosting.filesRead`         | List files and download individual files.                   |
| `hosting.filesWrite`        | Create and replace individual files.                        |
| `hosting.filesDelete`       | Delete individual files.                                    |
| `hosting.deploy`            | Plan and apply full deployments.                            |
| `hosting.download`          | Download the deployable snapshot.                           |
| `hosting.downloadSensitive` | Include protected and user-generated content in a snapshot. |
| `hosting.analyticsRead`     | Read hosting analytics.                                     |
| `hosting.analyticsManage`   | Change analytics configuration.                             |

Tenant administrators receive all hosting permissions through their normal admin grant. Non-admin credentials receive only explicitly assigned operations.

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
5. that an old interactive login has not expired.

Do not solve a narrow authorization failure by broadly granting tenant-admin access. Add the smallest permission set that supports the workflow.
