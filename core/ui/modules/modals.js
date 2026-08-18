/**
 * Modal Management
 */
import { state } from './state.js';

const modalCloseHandlers = new Map();

const CONFIRM_MODAL_ID = 'destructiveConfirmModal';
/** The confirmation dialog's elements; built on first use, then reused. */
let confirmDialog = null;
/** `{ resolve }` while a confirmation is on screen, `null` otherwise. */
let pendingConfirmation = null;
let previouslyFocused = null;

/** Register cleanup for modal-owned state that generic dismissal cannot see. */
export function registerModalCloseHandler(modalId, handler) {
    modalCloseHandlers.set(modalId, handler);
}

export function initModals() {
    document.addEventListener('click', (e) => {
        const target = e.target;

        // Handle close buttons (X) and cancel buttons
        const closeBtn = target.closest('.modal-close, .modal-cancel');
        if (closeBtn) {
            const modalId = closeBtn.dataset.modal;
            if (modalId) {
                closeModal(modalId);
            }
        }

        // Close on click outside (overlay)
        if (target.classList.contains('modal-overlay')) {
            if (target.id) closeModal(target.id);
            else target.classList.add('hidden');
        }
    });

    // Close on Escape key
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            const visibleModal = topmostOpenModal();
            if (visibleModal) {
                if (visibleModal.id) closeModal(visibleModal.id);
                else visibleModal.classList.add('hidden');
                e.preventDefault();
                e.stopPropagation(); // Prevent other escape handlers (like clearing selection)
                e.stopImmediatePropagation();
            }
        }
    });
}

/**
 * The modal Escape should dismiss.
 *
 * Plain document order is wrong for the confirmation dialog below: it opens
 * from INSIDE an operation another modal already started (a column drop runs
 * while "Confirm Delete" is still up), and it is appended last, so the first
 * `.modal-overlay:not(.hidden)` in the document is the one UNDERNEATH it.
 * Escaping that one would dismiss the wrong modal and leave the confirmation
 * on screen with its promise unanswered — a wedged operation, not a cancel.
 */
function topmostOpenModal() {
    const confirmOverlay = confirmDialog?.overlay;
    if (confirmOverlay && !confirmOverlay.classList.contains('hidden')) return confirmOverlay;
    return document.querySelector(
        '.modal-overlay:not(.hidden), .cell-preview-modal:not(.hidden)'
    );
}

export function openModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) {
        el.classList.remove('hidden');
        // Focus first input if available
        const firstInput = el.querySelector('input, select, textarea, button');
        if (firstInput) firstInput.focus();
    }
}

export function closeModal(modalId) {
    const el = document.getElementById(modalId);
    if (el) el.classList.add('hidden');
    if (modalId === 'cellPreviewModal') state.cellPreviewInfo = null;
    modalCloseHandlers.get(modalId)?.();
}

/**
 * Dismiss every open modal, running each one's registered cleanup.
 *
 * Used when the ground a modal stands on is replaced underneath it — the
 * desktop's database switch, where a cell preview, a view editor or a BLOB
 * inspector is showing content from the database the user just left, and its
 * Save would now target a different file. Same element selector the Escape
 * handler uses, so "what counts as an open modal" has one definition.
 */
export function closeAllModals() {
    const open = document.querySelectorAll(
        '.modal-overlay:not(.hidden), .cell-preview-modal:not(.hidden)'
    );
    for (const el of open) {
        if (el.id) closeModal(el.id);
        else el.classList.add('hidden');
    }
}

// ---------------------------------------------------------------------------
// Destructive-operation confirmation
// ---------------------------------------------------------------------------

/**
 * An in-page replacement for `window.confirm`, for operations that destroy data.
 *
 * WHY IT EXISTS. On the desktop the viewer runs in wry's WKWebView, and wry's
 * `WKUIDelegate` (0.55.1, `src/wkwebview/class/wry_web_view_ui_delegate.rs`)
 * implements exactly three selectors: the file-open panel, the media-capture
 * permission, and create-webview. It implements NONE of the JS dialog panels,
 * so WebKit falls back to its unimplemented-delegate defaults — measured
 * against a delegate reproducing wry's exact surface, `alert()` is a silent
 * no-op, `prompt()` returns `null`, and **`confirm()` returns `false` without
 * displaying anything**. Every `window.confirm` gate in this bundle therefore
 * answered "cancel" on the user's behalf, silently: the warnings were never
 * shown AND the operations behind them (dropping a view, dropping a column,
 * replacing an oversized cell) could not be performed at all.
 *
 * WHY IN THE PAGE. The shell can show a native dialog, but reaching it would
 * mean a new webview-callable command; a confirmation needs no privilege, so it
 * stays here and reuses the modal machinery the viewer already has. Dismissal
 * therefore composes for free — the overlay click, the ✕/Cancel delegation,
 * Escape and `closeAllModals()` (database switch) all route through
 * `closeModal`, and the close handler registered below turns every one of them
 * into a plain `false` rather than a promise nobody ever settles.
 *
 * @param {{title?: string, message: string, confirmLabel?: string}} options
 * @returns {Promise<boolean>} true only if the user activated the confirm button
 */
export function confirmDestructiveAction({ title = 'Confirm', message, confirmLabel = 'Continue' }) {
    if (typeof message !== 'string' || message.length === 0) {
        throw new Error('confirmDestructiveAction requires a message to show the user');
    }
    if (typeof document === 'undefined' || !document.body) {
        // Never guess an answer for a destructive operation. A caller with no
        // document to render into must fail loudly, not silently proceed.
        throw new Error('confirmDestructiveAction requires a document to render into');
    }
    if (pendingConfirmation) {
        throw new Error('A destructive-operation confirmation is already open');
    }

    const dialog = ensureConfirmDialog();
    dialog.title.textContent = title;
    dialog.confirmButton.textContent = confirmLabel;
    // One paragraph per line: the callers compose plain-text warnings with
    // newlines (they were written for `window.confirm`), and HTML would
    // otherwise collapse every one of them into a single run-on sentence.
    dialog.body.replaceChildren();
    for (const line of message.split('\n')) {
        if (line.trim() === '') continue;
        const paragraph = document.createElement('p');
        // textContent, never innerHTML: these lines name tables, columns and
        // indexes read out of an untrusted database file.
        paragraph.textContent = line;
        dialog.body.appendChild(paragraph);
    }

    return new Promise((resolve) => {
        pendingConfirmation = { resolve };
        try {
            previouslyFocused = document.activeElement ?? null;
            openModal(CONFIRM_MODAL_ID);
            // openModal focuses the first focusable child (the ✕). Move to
            // Cancel so a reflexive Space/Enter on a destructive prompt is the
            // safe answer, not a dismissal that looks like one.
            dialog.cancelButton.focus?.();
        } catch (error) {
            pendingConfirmation = null;
            previouslyFocused = null;
            throw error; // rejects this promise — the operation must not proceed
        }
    });
}

/**
 * Answer the open confirmation exactly once.
 *
 * Re-entrant by construction: `closeModal` runs the registered close handler,
 * which calls back in here, so `pendingConfirmation` is cleared BEFORE the
 * close so the second pass is a no-op.
 */
function settleConfirmation(answer) {
    if (!pendingConfirmation) return;
    const { resolve } = pendingConfirmation;
    pendingConfirmation = null;
    closeModal(CONFIRM_MODAL_ID);
    const restoreTo = previouslyFocused;
    previouslyFocused = null;
    // Focus was moved into a subtree that is now display:none; leaving it there
    // strands keyboard navigation.
    if (restoreTo && typeof restoreTo.focus === 'function') restoreTo.focus();
    resolve(answer);
}

function ensureConfirmDialog() {
    if (confirmDialog) return confirmDialog;

    const overlay = document.createElement('div');
    // `confirm-modal-overlay` lifts it above the modal it was opened from;
    // every other overlay shares one z-index, so DOM order alone would decide.
    overlay.className = 'modal-overlay confirm-modal-overlay hidden';
    overlay.id = CONFIRM_MODAL_ID;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', `${CONFIRM_MODAL_ID}Title`);

    const dialogEl = document.createElement('div');
    dialogEl.className = 'modal-dialog';

    const header = document.createElement('div');
    header.className = 'modal-header';
    const title = document.createElement('span');
    title.className = 'modal-title';
    title.id = `${CONFIRM_MODAL_ID}Title`;
    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'modal-close';
    closeButton.dataset.modal = CONFIRM_MODAL_ID;
    closeButton.textContent = '×';
    header.appendChild(title);
    header.appendChild(closeButton);

    const body = document.createElement('div');
    body.className = 'modal-body';

    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.className = 'btn-secondary modal-cancel';
    cancelButton.dataset.modal = CONFIRM_MODAL_ID;
    cancelButton.textContent = 'Cancel';
    const confirmButton = document.createElement('button');
    confirmButton.type = 'button';
    confirmButton.className = 'btn-danger';
    confirmButton.addEventListener('click', () => settleConfirmation(true));
    footer.appendChild(cancelButton);
    footer.appendChild(confirmButton);

    dialogEl.appendChild(header);
    dialogEl.appendChild(body);
    dialogEl.appendChild(footer);
    overlay.appendChild(dialogEl);
    document.body.appendChild(overlay);

    // The single point every dismissal route converges on.
    registerModalCloseHandler(CONFIRM_MODAL_ID, () => settleConfirmation(false));

    confirmDialog = { overlay, title, body, cancelButton, confirmButton };
    return confirmDialog;
}
