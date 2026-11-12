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

| Site type                       | A request for `/about` is served by                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Static                          | `about`, then `about/index.html`, then `/404.html` with status 404                                                                      |
| Static, single-page-application | `about`, then `about/index.html`, then `/index.html` with status 200 (unless the path ends in a listed asset extension, which gets 404) |
| PHP                             | `about`, then `about/index.php` or `about/index.html`, then `/index.php` (front controller)                                             |

By default a static site has no single-page-app fallback: a client-side router's deep links return 404 on reload unless every route is pre-rendered, which Astro does by default. Prefer pre-rendering. Add a `404.html` to customize the not-found page.

### Single-page-app fallback

If a client-side router needs deep links to work, turn on the fallback. It is a per-site setting, available on static sites only (it is rejected while PHP is on):

```bash
zynohosting sites set example.com --not-found single-page-application --dry-run
zynohosting sites set example.com --not-found single-page-application --yes
zynohosting sites set example.com --not-found 404-page --yes   # back to the default
```

`zynohosting sites get example.com` shows the current value (`Not found:`; `notFoundHandling` in JSON). The change applies to production and preview immediately, and clears the CDN cache. It needs the `hosting.deploy` permission.

With the fallback on, a path that matches no file serves `/index.html` with status 200 (`/dashboard`, `/u/john.doe`, `/docs/v1.2`, `/old-page.html`). A missing file whose extension is on this list still returns 404 (using `404.html` when present), so a broken `/assets/app.js` never turns into HTML:

`7z avif bak bmp css csv env eot gif gz ico ini jpg jpeg js json log map mjs mp3 mp4 ogg old orig otf pdf png rar save sql svg swp tar tgz ttf txt wasm webm webmanifest webp woff woff2 xml yaml yml zip`

Any other extension, such as `.html` or `.v2`, falls back to `/index.html`. `.php`-like paths and `.ht*`, `.git`, `.svn`, `.user.ini`, and `.private` paths are always blocked, but other dotfiles such as `.env` are served if deployed: never deploy `.env` files or secrets. If the site has no `index.html`, unknown paths return 404. Unknown paths become soft 404s (status 200), which can affect search indexing, so keep real pages pre-rendered where you can.

Without the setting, a workaround is to copy `index.html` to `404.html`. Deep links then render the app, but the HTTP status is still 404.

## Keep secrets out

The deployed folder is the web root. Anything in it that isn't PHP can be downloaded by anyone, including `.env`, `composer.json`, and configuration files. Deploy a build output or a folder made for publishing, never a project root with credentials in it. Add exclusions with `.zynohostingignore`; see [Safety model](../reference/safety#mandatory-deployment-exclusions).

## Getting a site

The CLI and agents deploy to sites that already exist; they cannot create one. Ask ZynoHosting support to set up a site for your domain, then publish to it. To try changes before they go live, see [Preview and production](./preview).
