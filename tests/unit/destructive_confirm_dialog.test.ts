/**
 * The in-page confirmation for destructive operations (modules/modals.js).
 *
 * WHY IT REPLACED `window.confirm`: the desktop viewer runs in wry's
 * WKWebView, and wry's WKUIDelegate (0.55.1,
 * `src/wkwebview/class/wry_web_view_ui_delegate.rs`) implements exactly three
 * selectors — the file-open panel, the media-capture permission, and
 * create-webview. It implements NONE of the JS dialog panels, so WebKit takes
 * its unimplemented-delegate defaults. Measured against a WKUIDelegate
 * reproducing wry's exact surface: `alert()` is a silent no-op, `prompt()`
 * returns `null`, and `confirm()` returns **false** without displaying
 * anything. Every gate written as `if (!window.confirm(...))` therefore
 * cancelled on the user's behalf without asking — the warnings were dead text
 * AND the operations behind them were unreachable.
 *
 * So the tests below check BOTH answers, deliberately. A confirmation that
 * always says yes is a data-loss bug; one that always says no is the bug that
 * was actually shipped.
 */
import { afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { FakeDocument, FakeElement, installFakeDom } from './helpers/fake-dom';

// Untyped UI module, imported through a path VARIABLE so tsc does not demand a
// declaration file (the convention desktop_capstone_ui.test.ts already uses).
const modalsModulePath = '../../core/ui/modules/modals.js';

let doc: FakeDocument;
let modals: {
    initModals(): void;
    openModal(id: string): void;
    closeModal(id: string): void;
    closeAllModals(): void;
    confirmDestructiveAction(options: {
        title?: string; message: string; confirmLabel?: string;
    }): Promise<boolean>;
};

/** The overlay a real operation would already have open underneath (crud.js). */
let underlyingModal: FakeElement;

before(async () => {
    // ONE document for the file: the dialog is built once and cached, exactly
    // as it is on a real page, so swapping documents between tests would leave
    // the cache pointing at a detached tree.
    doc = installFakeDom();
    modals = await import(modalsModulePath);

    underlyingModal = doc.createElement('div');
    underlyingModal.className = 'modal-overlay hidden';
    underlyingModal.id = 'deleteModal';
    doc.body.appendChild(underlyingModal);

    modals.initModals();
});

afterEach(() => {
    modals.closeModal('deleteModal');
});

function overlay(): FakeElement {
    const el = doc.getElementById('destructiveConfirmModal');
    assert.ok(el, 'the confirmation dialog was never added to the document');
    return el;
}

function shownLines(): string[] {
    const body = [...overlay().walk()].find(node => node.className.includes('modal-body'));
    assert.ok(body, 'the confirmation dialog has no body');
    return body.children.map(child => child.textContent);
}

function button(className: string): FakeElement {
    const el = [...overlay().walk()].find(node => node.className.includes(className));
    assert.ok(el, `the confirmation dialog has no .${className}`);
    return el;
}

/**
 * The failure mode these tests exist to catch is a STRANDED promise — a
 * dismissal route that hides the dialog without answering it, wedging the
 * operation behind it forever. Awaiting that directly would hang the runner
 * until its timeout with no explanation, so name it instead.
 */
async function answered(pending: Promise<boolean>): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error('the confirmation was dismissed but never answered')),
                    1000
                );
            })
        ]);
    } finally {
        clearTimeout(timer);
    }
}

test('the confirmation is actually PRESENTED — it does not answer itself', async () => {
    const answer = modals.confirmDestructiveAction({
        title: 'Drop column',
        message: 'Drop column note from "people"?\n\nThis cannot be undone with ⌘Z.',
        confirmLabel: 'Drop column'
    });

    // Visible, and carrying every line the caller wrote. `window.confirm`
    // presented none of this.
    assert.equal(overlay().classList.contains('hidden'), false);
    assert.equal(button('modal-title').textContent, 'Drop column');
    assert.deepEqual(shownLines(), [
        'Drop column note from "people"?',
        'This cannot be undone with ⌘Z.'
    ]);
    assert.equal(button('btn-danger').textContent, 'Drop column');
    // Cancel holds focus, so a reflexive Space/Enter on a destructive prompt is
    // the safe answer.
    assert.equal(button('modal-cancel').focusCount > 0, true);

    doc.dispatchClick(button('btn-danger'));
    assert.equal(await answered(answer), true);
});

test('the confirm button answers TRUE and closes', async () => {
    const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });
    doc.dispatchClick(button('btn-danger'));
    assert.equal(await answered(answer), true);
    assert.equal(overlay().classList.contains('hidden'), true);
});

for (const [name, target] of [
    ['Cancel', 'modal-cancel'],
    ['the ✕ button', 'modal-close']
] as const) {
    test(`${name} answers FALSE through the delegated handler`, async () => {
        const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });
        doc.dispatchClick(button(target));
        assert.equal(await answered(answer), false);
        assert.equal(overlay().classList.contains('hidden'), true);
    });
}

test('clicking the overlay answers FALSE', async () => {
    const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });
    doc.dispatchClick(overlay());
    assert.equal(await answered(answer), false);
});

test('Escape dismisses the CONFIRMATION, not the modal it was opened from', async () => {
    // The real sequence: crud.js opens "Confirm Delete", its submit calls
    // deleteColumns, and the dependency warning opens on top. The underlying
    // modal is EARLIER in the document, so plain document order would dismiss
    // the wrong one and strand the confirmation's promise forever.
    modals.openModal('deleteModal');
    const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });

    const event = doc.dispatchKeydown('Escape');

    assert.equal(await answered(answer), false);
    assert.equal(overlay().classList.contains('hidden'), true);
    assert.equal(
        underlyingModal.classList.contains('hidden'), false,
        'Escape must not reach past the confirmation to the modal underneath it'
    );
    // Still swallowed, so Escape does not also clear the grid selection.
    assert.equal(event.defaultPrevented, true);
});

test('a database switch (closeAllModals) answers FALSE instead of stranding the operation', async () => {
    const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });
    modals.closeAllModals();
    assert.equal(await answered(answer), false);
});

test('a concurrent confirmation is refused explicitly, never silently answered', async () => {
    const first = modals.confirmDestructiveAction({ message: 'First?' });
    assert.throws(
        () => modals.confirmDestructiveAction({ message: 'Second?' }),
        /already open/
    );
    doc.dispatchClick(button('modal-cancel'));
    assert.equal(await answered(first), false);
});

test('focus returns to where it was before the dialog took it', async () => {
    const grid = doc.createElement('div');
    doc.body.appendChild(grid);
    grid.focus();

    const answer = modals.confirmDestructiveAction({ message: 'Proceed?' });
    assert.notEqual(doc.activeElement, grid);
    doc.dispatchClick(button('btn-danger'));
    await answered(answer);

    assert.equal(doc.activeElement, grid);
});

test('a caller with no message, or no document, fails loudly', async () => {
    assert.throws(
        () => modals.confirmDestructiveAction({ message: '' }),
        /requires a message/
    );

    const globals = globalThis as Record<string, unknown>;
    const saved = globals.document;
    globals.document = undefined;
    try {
        assert.throws(
            () => modals.confirmDestructiveAction({ message: 'Proceed?' }),
            /requires a document/,
            'a destructive operation must never proceed on a guessed answer'
        );
    } finally {
        globals.document = saved;
    }
});

test('the shipped desktop bundle contains no JS dialog primitive at all', () => {
    // The bundle-level guard. Any `window.confirm`/`alert`/`prompt` reachable
    // from the desktop viewer is auto-answered by WebKit with nothing shown, so
    // the only safe number is zero — including in code pulled in from shared
    // modules that were written for the browser lanes.
    const desktop = readFileSync(path.resolve('desktop/viewer.html'), 'utf8');
    for (const primitive of ['window.confirm', 'window.alert', 'window.prompt']) {
        assert.equal(
            desktop.split(primitive).length - 1, 0,
            `${primitive} is reachable in the desktop bundle; wry's WKWebView shows no `
            + 'dialog for it and answers it without asking the user'
        );
    }

    // The web demo keeps using the browser primitives on purpose: it runs in a
    // real browser, where they work. Asserting that here is what keeps this
    // test honest about being a DESKTOP constraint rather than a blanket ban.
    const demo = readFileSync(path.resolve('website/public/sqlite-viewer/viewer.html'), 'utf8');
    assert.ok(
        demo.includes('window.confirm'),
        'the web demo lost its confirmations; they are correct there'
    );
});

test('the confirmation paints above every other layer, including the cell preview', () => {
    // It is only ever opened from INSIDE an operation another modal started, so
    // "on top" is not a nicety. The blob inspector's .cell-preview-modal is
    // z-index 1100 and is open when an oversized-cell replacement asks — a
    // confirmation rendered underneath it is as invisible as no confirmation.
    const css = readFileSync(path.resolve('core/ui/viewer.css'), 'utf8');
    const confirmRule = css.match(/\.confirm-modal-overlay\s*\{([^}]*)\}/)?.[1];
    assert.ok(confirmRule, '.confirm-modal-overlay has no rule');
    const confirmZ = Number(confirmRule.match(/z-index:\s*(\d+)/)?.[1]);
    assert.ok(Number.isFinite(confirmZ), '.confirm-modal-overlay declares no z-index');

    const others = [...css.matchAll(/z-index:\s*(\d+)/g)]
        .map(match => Number(match[1]))
        .filter(value => value !== confirmZ);
    assert.ok(
        others.every(value => value < confirmZ),
        `.confirm-modal-overlay (z-index ${confirmZ}) must outrank every other layer; `
        + `highest other is ${Math.max(...others)}`
    );
});
