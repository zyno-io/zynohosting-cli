# Sites

Site commands list, inspect, and configure the ZynoHosting sites authorized for the current tenant credential.

## List sites

```bash
zynohosting sites list
```

Machine-readable output:

```bash
zynohosting sites list --json
```

Each result includes the site ID, primary fully qualified domain name, status, and PHP version. Static sites return `null` for `phpVersion`.

## Get one site

```bash
zynohosting sites get example.com
zynohosting sites get 11111111-1111-4111-8111-111111111111 --json
```

A site reference may be:

- the site UUID;
- its primary hostname;
- its ZynoHosting vanity hostname;
- an authorized alias.

The detailed response also includes the production and preview URLs and every hostname with its kind: `custom`, `vanity` (a platform name that serves production), or `preview` (the only hostname that serves the preview slot). Read the preview URL from here rather than constructing it. See [Preview and production](../guide/preview#hostnames).

`sites get` (static sites only; PHP ignores the setting) also prints `Not found: 404 page` or `Not found: single-page app` (JSON `notFoundHandling`) when the manager reports it. Older managers omit it.

## Set not-found handling

```bash
zynohosting sites set example.com --not-found single-page-application --dry-run
zynohosting sites set example.com --not-found single-page-application --yes
zynohosting sites set example.com --not-found 404-page --yes
```

| Option                | Meaning                                                      |
| --------------------- | ------------------------------------------------------------ |
| `--not-found <mode>`  | `404-page` (default) or `single-page-application`. Required. |
| `-y, --yes`           | Apply without prompting.                                     |
| `--dry-run`           | Show the change without applying it.                         |
| `--json`              | Newline-delimited JSON; requires `--yes` or `--dry-run`.     |
| `--timeout <seconds>` | Update and reconciliation timeout (default 300).             |

`single-page-application` serves `/index.html` with status 200 for unknown paths unless they end in a listed asset extension (`.js`, `.css`, images, fonts, `.json`, `.txt`, ...), which still return 404. The full list is in [Building a site](../guide/building-a-site#single-page-app-fallback). It is a site-level setting: production and preview change immediately and the CDN cache is cleared. Static sites only; enabling it on a PHP site fails with `not_found_handling_requires_static` (exit 2) before anything is sent. A manager that does not report `notFoundHandling` fails with `not_found_handling_unavailable` (exit 5).

Confirmation works like `promote`: without a terminal pass `--yes` or `--dry-run`. The command always submits and waits for serving reconciliation, even when the value is unchanged, so re-running after `reconciliation_pending` is safe. `--json` emits `site_settings_plan`, progress events, then `site_settings_result` (`siteId`, `site`, `notFoundHandling`, `previous`, `changed`, `operationId`, `status`). Failures are `reconciliation_failed` or `reconciliation_pending` (exit 7, with the operation ID).

## Permission

`sites list` and `sites get` require `hosting.sitesRead`. Tenant administrators receive the permission through their normal admin grant. `sites set` also requires `hosting.deploy`.

## Example JSON

```json
{
    "id": "11111111-1111-4111-8111-111111111111",
    "fqdn": "example.com",
    "status": "active",
    "phpVersion": "8.4",
    "notFoundHandling": "404-page",
    "hostnames": [
        { "name": "example-com-preview.aspen.zynohosting.net", "type": "preview" },
        { "name": "example-com.aspen.zynohosting.net", "type": "vanity" },
        { "name": "example.com", "type": "custom" }
    ],
    "deployments": {
        "production": { "deploymentId": null, "url": "https://example.com", "directory": "/public_html" },
        "preview": {
            "url": "https://example-com-preview.aspen.zynohosting.net",
            "directory": "/preview_html",
            "sharesDatabase": true,
            "sharesStorageQuota": true
        }
    }
}
```

`fqdn` is the primary hostname. `deployments.production.deploymentId` is `null` until the first promotion.

Access is tenant-scoped even when a hostname is known. A site outside the current credential’s grants is not exposed by these commands.
