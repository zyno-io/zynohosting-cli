/**
 * The page the browser lands on after a ZynoHosting sign-in.
 *
 * Built to match the ZynoSuite sign-in screen rather than the app interior: a
 * slate backdrop (`--chrome`, #1e293b) with the wordmark above a white pane.
 * The pane and its contents use the v2 light tokens, because that is what
 * `.zs-pane` is on that screen. Values are copied here rather than imported
 * because the CLI serves this page, not the SPA, and it has to render from one
 * self-contained response.
 *
 * The wordmark is typographic, as it is in the SPA: "Zyno" at weight 200
 * followed by the product at weight 500. There is no logo image to load, which
 * suits this page, because the loopback server sets `default-src 'none'` with
 * only inline styles and scripts allowed. No stylesheet, web font, or image can
 * be fetched. Inter cannot load, so the fallback stack it uses in the SPA is
 * named directly.
 */
export type CallbackOutcome = 'complete' | 'cancelled' | 'failed';

interface OutcomeStyle {
    title: string;
    ink: string;
    soft: string;
    icon: string;
}

// --ok / --warn / --err with their soft companions, from the v2 tokens.
const OUTCOMES: Record<CallbackOutcome, OutcomeStyle> = {
    complete: {
        title: 'Signed in',
        ink: '#1f7a4d',
        soft: '#e6f1ea',
        icon: '<path d="M5 10.5l3.5 3.5L15 7" />'
    },
    cancelled: {
        title: 'Sign-in cancelled',
        ink: '#b66b00',
        soft: '#fbeed7',
        icon: '<path d="M10 6v5" /><path d="M10 14h.01" />'
    },
    failed: {
        title: 'Sign-in failed',
        ink: '#b3321b',
        soft: '#fbe5df',
        icon: '<path d="M6.5 6.5l7 7" /><path d="M13.5 6.5l-7 7" />'
    }
};

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, character => HTML_ESCAPES[character] as string);
}

/**
 * Render the whole response body. `detail` is escaped: every caller passes a
 * literal today, but this is the one place a future message could carry text
 * from a request into markup.
 */
export function renderCallbackPage(outcome: CallbackOutcome, detail: string, options: { autoClose?: boolean } = {}): string {
    const style = OUTCOMES[outcome];
    const closeScript = options.autoClose ? '<script>setTimeout(()=>window.close(),1200)</script>' : '';

    return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(style.title)} · ZynoHosting</title>
<style>
    :root {
        --chrome: #1e293b;
        --ink-on-chrome-2: #94a3b8;
        --surface: #ffffff;
        --ink: #11110f;
        --ink-2: #44423d;
        --ink-3: #76746e;
        --line: #e8e6e0;
        /* The sign-in screen is dark and has no light counterpart, so the page
           does not follow the browser preference. */
        color-scheme: dark;
    }
    * { box-sizing: border-box; }
    body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 24px;
        background: var(--chrome);
        /* Inter is the SPA's face; it cannot be fetched under this page's CSP,
           so its own fallback stack is used directly. */
        font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        -webkit-font-smoothing: antialiased;
    }
    /* The wordmark as the SPA draws it: light "Zyno", medium product name. */
    .wordmark {
        display: flex;
        color: #fff;
        font-size: 30px;
        line-height: 1.2;
        font-weight: 200;
        letter-spacing: -0.01em;
        user-select: none;
    }
    .wordmark b { font-weight: 500; }
    .pane {
        width: 100%;
        max-width: 420px;
        margin-top: 48px;
        background: var(--surface);
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 24px;
        color: var(--ink);
        /* --el-1: the system is hairline-led and barely shadows anything. */
        box-shadow: 0 1px 0 rgba(17, 17, 15, 0.04);
        animation: rise 240ms cubic-bezier(0.2, 0, 0.2, 1) both;
    }
    .badge {
        width: 40px;
        height: 40px;
        border-radius: 999px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: ${style.soft};
        margin-bottom: 16px;
    }
    h1 {
        margin: 0 0 8px;
        font-size: 19px;
        line-height: 1.3;
        font-weight: 600;
        letter-spacing: -0.01em;
    }
    p {
        margin: 0;
        font-size: 14px;
        line-height: 1.5;
        color: var(--ink-2);
    }
    .hint {
        margin-top: 24px;
        font-size: 13px;
        line-height: 1.5;
        color: var(--ink-on-chrome-2);
        text-align: center;
    }
    @keyframes rise {
        from { opacity: 0; transform: translateY(4px); }
        to { opacity: 1; transform: none; }
    }
    @media (prefers-reduced-motion: reduce) {
        .pane { animation: none; }
    }
</style>
<div class="wordmark">Zyno<b>Hosting</b></div>
<div class="pane">
    <div class="badge">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="${style.ink}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${style.icon}</svg>
    </div>
    <h1>${escapeHtml(style.title)}</h1>
    <p>${escapeHtml(detail)}</p>
</div>
<div class="hint">You can close this window and return to where you started.</div>
${closeScript}
`;
}
