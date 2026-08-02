import { defineConfig } from 'vitepress';

export default defineConfig({
    lang: 'en-US',
    title: 'ZynoHosting CLI & MCP',
    titleTemplate: ':title · ZynoHosting',
    description: 'Deploy ZynoHosting sites and connect ZynoForms from the command line or a local MCP server.',
    base: '/zynohosting-cli/',
    lastUpdated: true,
    sitemap: {
        hostname: 'https://zyno-io.github.io/zynohosting-cli/'
    },
    markdown: {
        lineNumbers: true
    },
    themeConfig: {
        siteTitle: 'ZynoHosting',
        nav: [
            { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
            { text: 'CLI', link: '/cli/sites', activeMatch: '/cli/' },
            { text: 'MCP', link: '/mcp/', activeMatch: '/mcp/' },
            {
                text: 'Reference',
                items: [
                    { text: 'Configuration', link: '/reference/configuration' },
                    { text: 'Permissions', link: '/reference/permissions' },
                    { text: 'Safety model', link: '/reference/safety' },
                    { text: 'JSON and errors', link: '/reference/json-and-errors' }
                ]
            },
            { text: 'npm', link: 'https://www.npmjs.com/package/@zyno-io/zynohosting' }
        ],
        sidebar: {
            '/guide/': [
                {
                    text: 'Guide',
                    items: [
                        { text: 'Getting started', link: '/guide/getting-started' },
                        { text: 'Authentication', link: '/guide/authentication' }
                    ]
                }
            ],
            '/cli/': [
                {
                    text: 'Command line',
                    items: [
                        { text: 'Sites', link: '/cli/sites' },
                        { text: 'Individual files', link: '/cli/files' },
                        { text: 'Full deployments', link: '/cli/deploy' },
                        { text: 'Complete downloads', link: '/cli/download' }
                    ]
                }
            ],
            '/mcp/': [
                {
                    text: 'Local MCP server',
                    items: [
                        { text: 'Set up and use it (start here)', link: '/mcp/setup' },
                        { text: 'Install instructions for agents', link: '/mcp/agent' },
                        { text: 'Configure the server', link: '/mcp/' },
                        { text: 'Tool reference', link: '/mcp/tools' }
                    ]
                }
            ],
            '/reference/': [
                {
                    text: 'Reference',
                    items: [
                        { text: 'Configuration', link: '/reference/configuration' },
                        { text: 'Permissions', link: '/reference/permissions' },
                        { text: 'Safety model', link: '/reference/safety' },
                        { text: 'JSON and errors', link: '/reference/json-and-errors' }
                    ]
                },
                {
                    text: 'Maintainers',
                    items: [{ text: 'Release and publish', link: '/reference/releasing' }]
                }
            ]
        },
        search: {
            provider: 'local'
        },
        outline: {
            level: [2, 3],
            label: 'On this page'
        },
        editLink: {
            pattern: 'https://github.com/zyno-io/zynohosting-cli/edit/main/docs/:path',
            text: 'Edit this page on GitHub'
        },
        lastUpdated: {
            text: 'Last updated'
        },
        docFooter: {
            prev: 'Previous',
            next: 'Next'
        },
        socialLinks: [{ icon: 'github', link: 'https://github.com/zyno-io/zynohosting-cli' }],
        footer: {
            message: 'Documentation for the ZynoHosting CLI and local MCP server.',
            copyright: 'Copyright © Signal24 LLC dba Zyno Consulting'
        }
    }
});
