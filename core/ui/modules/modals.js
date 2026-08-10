/**
 * Modal Management
 */
import { state } from './state.js';

const modalCloseHandlers = new Map();

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
            const visibleModal = document.querySelector(
                '.modal-overlay:not(.hidden), .cell-preview-modal:not(.hidden)'
            );
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
