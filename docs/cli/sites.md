# Sites

Site commands list and inspect only the ZynoHosting sites authorized for the current tenant credential.

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

## Permission

Both commands require `hosting.sitesRead`. Tenant administrators receive the permission through their normal admin grant.

## Example JSON

```json
{
    "id": "11111111-1111-4111-8111-111111111111",
    "fqdn": "example.com",
    "status": "active",
    "phpVersion": "8.4",
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
