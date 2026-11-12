# Building a site

ZynoHosting serves **static files**, plus **PHP** on sites that have PHP turned on. It runs no Node.js, Python, Ruby, or other server process. Whatever you deploy must already be the finished files a browser or PHP needs.

## What runs

| Works                                                      | Does not work                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------ |
| HTML, CSS, JavaScript, images, fonts, downloads            | Server-side rendering (Astro/Next.js/Nuxt/SvelteKit server output) |
| Static site generator output (Astro, Eleventy, Hugo, Vite) | API routes, server functions, middleware                           |
| PHP 7.4–8.5 scripts and front-controller apps              | Node.js, Python, Ruby, or Go servers; background workers           |
| [ZynoForms](../cli/forms) for contact and signup forms     | `.htaccess` rules (sites are served by nginx)                      |

## Recommended: Astro

For a new site, use [Astro](https://astro.build) with its default static output:

1. Keep `output: 'static'` (the default) and add no server adapter such as `@astrojs/node`.
2. Build with `npm run build` and check it with `npm run preview`.
3. Deploy the `dist/` folder, not the project root:

```bash
zynohosting deploy example.com ./dist --dry-run
```

Other static generators work the same way. Deploy only their output folder: Vite `dist/`, Eleventy `_site/`, Hugo `public/`, or Next.js with `output: 'export'` (`out/`). A hand-written site needs no build at all; deploy the folder that holds `index.html`.

## Static or PHP

`zynohosting sites get example.com` shows `PHP: static` when PHP is off (`phpVersion: null` in JSON). A static site answers 404 for every `.php` file. Turn PHP on in the ZynoHosting portal under the site's **Settings → Runtime**. Use PHP only when the site needs server-side code; forms don't, because ZynoForms handles submissions.

## Routing

| Site type | A request for `/about` is served by                                                         |
| --------- | ------------------------------------------------------------------------------------------- |
| Static    | `about`, then `about/index.html`, then `/404.html` with status 404                          |
| PHP       | `about`, then `about/index.php` or `about/index.html`, then `/index.php` (front controller) |

A static site has no single-page-app fallback. A client-side router's deep links return 404 on reload unless every route is pre-rendered, which Astro does by default. Add a `404.html` to customize the not-found page.

## Keep secrets out

The deployed folder is the web root. Anything in it that isn't PHP can be downloaded by anyone, including `.env`, `composer.json`, and configuration files. Deploy a build output or a folder made for publishing, never a project root with credentials in it. Add exclusions with `.zynohostingignore`; see [Safety model](../reference/safety#mandatory-deployment-exclusions).

## Getting a site

The CLI and agents deploy to sites that already exist; they cannot create one. Ask ZynoHosting support to set up a site for your domain, then publish to it. To try changes before they go live, see [Preview and production](./preview).
