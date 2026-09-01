/**
 * Modal Management
 */
import { state } from './state.js';

const modalCloseHandlers = new Map();
const modalFocusOrigins = new Map();
const visibleModalSelector =
    '.modal-overlay:not(.hidden), .cell-preview-modal:not(.hidden)';
const DATABASE_TARGET_MODAL_IDS = [
    'viewModal',
    'addRowModal',
    'deleteModal',
    'createTableModal',
    'addColumnModal',
    'exportModal',
    'cellPreviewModal',
    'blob-inspector-modal'
];
const focusableSelector = [
    'button:not([disabled])',
    '[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

function getTopVisibleModal() {
    const visible = Array.from(document.querySelectorAll?.(visibleModalSelector) ?? []);
    return visible[visible.length - 1] ?? document.querySelector?.(visibleModalSelector) ?? null;
}

function getFocusableElements(modal) {
    return Array.from(modal?.querySelectorAll?.(focusableSelector) ?? []).filter(element => {
        if (element.disabled || element.hidden) return false;
        if (element.getAttribute?.('tabindex') === '-1') return false;
        if (element.closest?.('[hidden], [aria-hidden="true"]')) return false;
        const style = globalThis.window?.getComputedStyle?.(element);
        return !style || (style.display !== 'none' && style.visibility !== 'hidden');
    });
}

function trapModalTab(event, modal) {
    const focusable = getFocusableElements(modal);
    if (focusable.length === 0) {
        if (!modal.hasAttribute?.('tabindex')) modal.setAttribute?.('tabindex', '-1');
        modal.focus?.();
    } else {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!modal.contains?.(active) || (!event.shiftKey && active === last)) first.focus?.();
        else if (event.shiftKey && active === first) last.focus?.();
        else return;
    }
    event.preventDefault();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();
}

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
        const visibleModal = getTopVisibleModal();
        if (e.key === 'Tab' && visibleModal) {
            trapModalTab(e, visibleModal);
            return;
        }
        if (e.key === 'Escape') {
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

export function openModal(modalId, modalElement = null) {
    const el = modalElement ?? globalThis.document?.getElementById?.(modalId);
    if (el) {
        const wasHidden = el.classList?.contains?.('hidden') ?? true;
        if (wasHidden && !modalFocusOrigins.has(modalId)) {
            modalFocusOrigins.set(modalId, globalThis.document?.activeElement ?? null);
        }
        el.classList.remove('hidden');
        // Focus first input if available
        const firstInput = el.querySelector?.('input, select, textarea, button');
        if (firstInput) firstInput.focus?.();
    }
}

export function closeModal(modalId, modalElement = null) {
    const el = modalElement ?? globalThis.document?.getElementById?.(modalId);
    if (el) el.classList.add('hidden');
    if (modalId === 'cellPreviewModal') state.cellPreviewInfo = null;
    modalCloseHandlers.get(modalId)?.();
    const focusOrigin = modalFocusOrigins.get(modalId);
    modalFocusOrigins.delete(modalId);
    if (focusOrigin?.focus && focusOrigin.isConnected !== false) focusOrigin.focus();
}

/** Invalidate every draft or confirmation bound to the old database content. */
export function closeDatabaseTargetModals({ connectionReplaced = false } = {}) {
    for (const modalId of DATABASE_TARGET_MODAL_IDS) closeModal(modalId);
    if (connectionReplaced) closeModal('settingsModal');
}
