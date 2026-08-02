const DEFAULT_INDENT = '    ';
const focusEscapeArmed = new WeakSet();

/** Clear the one-shot focus escape when a static textarea starts a new session. */
export function resetTextareaTabFocusEscape(textarea) {
    if (textarea) focusEscapeArmed.delete(textarea);
}

function clampPosition(value, position) {
    return Math.max(0, Math.min(value.length, Number.isFinite(position) ? position : 0));
}

function getSelectedLineStarts(value, selectionStart, selectionEnd) {
    const firstLineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
    // A selection ending immediately after a newline does not include the next
    // line. This matches the indentation behavior users expect from code editors.
    const effectiveEnd = selectionEnd > selectionStart && value[selectionEnd - 1] === '\n'
        ? selectionEnd - 1
        : selectionEnd;
    const starts = [firstLineStart];
    let newline = value.indexOf('\n', firstLineStart);
    while (newline !== -1 && newline + 1 <= effectiveEnd) {
        starts.push(newline + 1);
        newline = value.indexOf('\n', newline + 1);
    }
    return starts;
}

function mapPositionThroughEdits(position, edits) {
    let delta = 0;
    for (const edit of edits) {
        if (position < edit.start) break;
        if (position <= edit.start + edit.deleteCount) {
            return edit.start + delta + edit.text.length;
        }
        delta += edit.text.length - edit.deleteCount;
    }
    return position + delta;
}

function applyEdits(value, edits) {
    let result = '';
    let cursor = 0;
    for (const edit of edits) {
        result += value.slice(cursor, edit.start);
        result += edit.text;
        cursor = edit.start + edit.deleteCount;
    }
    return result + value.slice(cursor);
}

/** Apply code-editor Tab/Shift+Tab behavior to a textarea key event. */
export function handleTextareaTab(event, indent = DEFAULT_INDENT) {
    const textarea = event.target;
    if (!textarea || textarea.readOnly || textarea.disabled || typeof textarea.value !== 'string') {
        return false;
    }

    // A code editor normally consumes Tab, so use the first Escape as a
    // one-shot "Tab moves focus" command. A second Escape retains the modal's
    // normal close behavior, and editing any other key cancels the armed state.
    if (event.key === 'Escape') {
        if (focusEscapeArmed.has(textarea)) {
            focusEscapeArmed.delete(textarea);
            return false;
        }
        focusEscapeArmed.add(textarea);
        event.preventDefault();
        event.stopPropagation();
        return true;
    }
    if (event.key !== 'Tab') {
        focusEscapeArmed.delete(textarea);
        return false;
    }
    if (focusEscapeArmed.has(textarea)) {
        focusEscapeArmed.delete(textarea);
        return false;
    }

    const value = textarea.value;
    const selectionStart = clampPosition(value, textarea.selectionStart);
    const selectionEnd = clampPosition(value, textarea.selectionEnd);
    let edits;

    if (!event.shiftKey && selectionStart === selectionEnd) {
        edits = [{ start: selectionStart, deleteCount: 0, text: indent }];
    } else {
        const lineStarts = getSelectedLineStarts(value, selectionStart, selectionEnd);
        if (event.shiftKey) {
            edits = lineStarts.map(start => {
                if (value[start] === '\t') {
                    return { start, deleteCount: 1, text: '' };
                }
                const spaces = value.slice(start, start + indent.length).match(/^ +/)?.[0].length ?? 0;
                return { start, deleteCount: spaces, text: '' };
            }).filter(edit => edit.deleteCount > 0);
        } else {
            edits = lineStarts.map(start => ({ start, deleteCount: 0, text: indent }));
        }
    }

    event.preventDefault();
    if (edits.length > 0) {
        textarea.value = applyEdits(value, edits);
        textarea.selectionStart = mapPositionThroughEdits(selectionStart, edits);
        textarea.selectionEnd = mapPositionThroughEdits(selectionEnd, edits);
        if (typeof Event === 'function' && typeof textarea.dispatchEvent === 'function') {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
    }
    return true;
}
