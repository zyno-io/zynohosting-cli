import { defineConfig } from 'vitepress';

export default defineConfig({
    lang: 'en-US',
    title: 'ZynoHosting CLI & MCP',
    titleTemplate: ':title · ZynoHosting',
    description: 'Deploy, preview, and promote ZynoHosting sites from the command line or an agent, and create and connect ZynoForms.',
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
            { text: 'Agents', link: '/agents/', activeMatch: '/agents/' },
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
                        { text: 'Authentication', link: '/guide/authentication' },
                        { text: 'Preview and production', link: '/guide/preview' },
                        { text: 'Building a site', link: '/guide/building-a-site' }
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
                        { text: 'Complete downloads', link: '/cli/download' },
                        { text: 'ZynoForms', link: '/cli/forms' }
                    ]
                }
            ],
            '/agents/': [
                {
                    text: 'Set up an agent',
                    items: [
                        { text: 'Choose your agent', link: '/agents/' },
                        { text: 'Claude desktop app', link: '/agents/claude-desktop' },
                        { text: 'Claude Code', link: '/agents/claude-code' },
                        { text: 'Codex', link: '/agents/codex' },
                        { text: 'Grok Bot or ChatGPT dots', link: '/agents/always-on' },
                        { text: 'Another coding agent', link: '/agents/other' },
                        { text: 'What to ask your agent', link: '/agents/prompts' }
                    ]
                },
                {
                    text: 'For developers',
                    items: [
                        { text: 'CLI, skill, or MCP', link: '/agents/interfaces' },
                        { text: 'Install instructions for agents', link: '/agents/install' }
                    ]
                }
            ],
            '/mcp/': [
                {
                    text: 'Local MCP server',
                    items: [
                        { text: 'Configure the server', link: '/mcp/' },
                        { text: 'MCP install instructions for agents', link: '/mcp/agent' },
                        { text: 'Tool reference', link: '/mcp/tools' }
                    ]
                },
                {
                    text: 'Agents',
                    items: [{ text: 'Set up an agent (start here)', link: '/agents/' }]
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
