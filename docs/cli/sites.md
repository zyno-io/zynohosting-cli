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

The detailed response also includes known hostnames and their types.

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
        { "name": "example.com", "type": "primary" },
        { "name": "example.zynohosting.net", "type": "vanity" }
    ]
}
```

Access is tenant-scoped even when a hostname is known. A site outside the current credential’s grants is not exposed by these commands.
