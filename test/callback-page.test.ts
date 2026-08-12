import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CallbackOutcome, escapeHtml, renderCallbackPage } from '../src/login/callback-page.js';

const OUTCOMES: CallbackOutcome[] = ['complete', 'cancelled', 'failed'];

test('escapes the characters that would break out of markup', () => {
    assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
    assert.equal(escapeHtml(`a & b "c" 'd'`), 'a &amp; b &quot;c&quot; &#39;d&#39;');
    assert.equal(escapeHtml('nothing to escape'), 'nothing to escape');
});

test('escapes the detail message rather than interpolating it', () => {
    const page = renderCallbackPage('failed', '<img src=x onerror=alert(1)>');
    assert.doesNotMatch(page, /<img src=x/);
    assert.match(page, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('renders every outcome with its own colour and title', () => {
    const complete = renderCallbackPage('complete', 'done');
    const cancelled = renderCallbackPage('cancelled', 'stopped');
    const failed = renderCallbackPage('failed', 'broken');

    // A cancelled sign-in must not look like a successful one.
    assert.match(complete, /Signed in/);
    assert.match(cancelled, /Sign-in cancelled/);
    assert.match(failed, /Sign-in failed/);
    assert.match(complete, /#1f7a4d/);
    assert.match(cancelled, /#b66b00/);
    assert.match(failed, /#b3321b/);
    assert.doesNotMatch(cancelled, /#1f7a4d/, 'cancelled must not borrow the success colour');
});

test('requests no external resources', () => {
    // The loopback server serves this under `default-src 'none'`, so a
    // stylesheet, web font, or image would silently fail to load.
    for (const outcome of OUTCOMES) {
        const page = renderCallbackPage(outcome, 'message');
        assert.doesNotMatch(page, /https?:\/\//, `${outcome} must not reference a remote origin`);
        assert.doesNotMatch(page, /@import|<link|<img\b/, `${outcome} must not load an external resource`);
        assert.doesNotMatch(page, /url\(/, `${outcome} must not reference a URL from CSS`);
    }
});

test('closes itself only after a successful sign-in', () => {
    // Closing the window on a failure would take the explanation with it.
    assert.match(renderCallbackPage('complete', 'done', { autoClose: true }), /window\.close\(\)/);
    assert.doesNotMatch(renderCallbackPage('failed', 'broken'), /window\.close\(\)/);
    assert.doesNotMatch(renderCallbackPage('cancelled', 'stopped'), /window\.close\(\)/);
});

test('is a complete, self-contained document', () => {
    for (const outcome of OUTCOMES) {
        const page = renderCallbackPage(outcome, 'message');
        assert.match(page, /^<!doctype html>/);
        assert.match(page, /<meta charset="utf-8">/);
        assert.match(page, /<meta name="viewport"/, `${outcome} must be readable on a phone`);
        assert.match(page, /<title>[^<]+· ZynoHosting<\/title>/);
    }
});

test('matches the ZynoSuite sign-in screen rather than the app interior', () => {
    const page = renderCallbackPage('complete', 'done');
    // The sign-in screen is the slate chrome colour, not the warm workspace canvas.
    assert.match(page, /#1e293b/, 'slate backdrop');
    assert.doesNotMatch(page, /#f7f6f3/, 'the warm workspace canvas belongs to the app interior');
    assert.match(page, /#e8e6e0/, 'hairline border on the white pane');
    assert.match(page, /prefers-reduced-motion/, 'the entrance animation must be suppressible');
});

test('draws the wordmark the way the SPA does', () => {
    const page = renderCallbackPage('complete', 'done');
    // "Zyno" light, product name medium — the lockup is typographic, not an image.
    assert.match(page, /Zyno<b>Hosting<\/b>/);
    assert.match(page, /font-weight: 200/);
    assert.match(page, /\.wordmark b \{ font-weight: 500; \}/);
});
