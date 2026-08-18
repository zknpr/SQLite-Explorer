/**
 * A minimal DOM, big enough to drive `core/ui/modules/modals.js` for real.
 *
 * The repo has no jsdom; DOM-dependent suites hand-roll whatever surface the
 * module under test touches. The confirmation dialog needs more than the usual
 * `getElementById` stub, because the behaviour worth testing lives in the
 * DISMISSAL routes rather than in the markup: the delegated ✕/Cancel click, the
 * overlay click, the document-level Escape handler and `closeAllModals()` all
 * reach it through `document.querySelector`/`closest` and event delegation. A
 * stub that skipped those would prove nothing about whether an operation can
 * get wedged waiting on a promise no dismissal ever settles.
 *
 * Only what those paths use is implemented: class-based selectors with a
 * single `:not(.class)` qualifier, `dataset`, `classList`, `closest`, and click
 * / keydown dispatch that visits the target's own listeners and then the
 * document's (which is the only delegation shape modals.js relies on).
 */

type Listener = (event: FakeEvent) => void;

export interface FakeEvent {
    key?: string;
    target: FakeElement;
    defaultPrevented: boolean;
    preventDefault(): void;
    stopPropagation(): void;
    stopImmediatePropagation(): void;
}

export class FakeElement {
    readonly tagName: string;
    id = '';
    type = '';
    className = '';
    textContent = '';
    title = '';
    readonly children: FakeElement[] = [];
    readonly dataset: Record<string, string> = {};
    readonly attributes: Record<string, string> = {};
    parentNode: FakeElement | null = null;
    focusCount = 0;
    readonly listeners = new Map<string, Listener[]>();
    readonly ownerDocument: FakeDocument;

    constructor(tagName: string, ownerDocument: FakeDocument) {
        this.tagName = tagName.toUpperCase();
        this.ownerDocument = ownerDocument;
    }

    private classSet(): Set<string> {
        return new Set(this.className.split(/\s+/).filter(Boolean));
    }

    private writeClasses(classes: Set<string>): void {
        this.className = [...classes].join(' ');
    }

    get classList() {
        return {
            add: (...names: string[]) => {
                const classes = this.classSet();
                for (const name of names) classes.add(name);
                this.writeClasses(classes);
            },
            remove: (...names: string[]) => {
                const classes = this.classSet();
                for (const name of names) classes.delete(name);
                this.writeClasses(classes);
            },
            contains: (name: string) => this.classSet().has(name)
        };
    }

    appendChild(child: FakeElement): FakeElement {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }

    replaceChildren(...next: FakeElement[]): void {
        for (const child of this.children) child.parentNode = null;
        this.children.length = 0;
        for (const child of next) this.appendChild(child);
    }

    setAttribute(name: string, value: string): void {
        this.attributes[name] = value;
        if (name === 'id') this.id = value;
    }

    getAttribute(name: string): string | null {
        return this.attributes[name] ?? null;
    }

    addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    focus(): void {
        this.focusCount += 1;
        this.ownerDocument.activeElement = this;
    }

    /** Self, then ancestors, first one matching any comma-separated `.class`. */
    closest(selector: string): FakeElement | null {
        const wanted = selector.split(',').map(part => part.trim().replace(/^\./, ''));
        for (let node: FakeElement | null = this; node; node = node.parentNode) {
            if (wanted.some(cls => node!.classList.contains(cls))) return node;
        }
        return null;
    }

    /** Depth-first document order, self included. */
    *walk(): Generator<FakeElement> {
        yield this;
        for (const child of this.children) yield* child.walk();
    }

    /** Descendants only, document order — `openModal` focuses the first match. */
    querySelectorAll(selector: string): FakeElement[] {
        const compounds = selector.split(',').map(part => part.trim()).filter(Boolean);
        const matched: FakeElement[] = [];
        for (const node of this.walk()) {
            if (node === this) continue;
            if (compounds.some(compound => matchesCompound(node, compound))) matched.push(node);
        }
        return matched;
    }

    querySelector(selector: string): FakeElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }
}

/** `tag`, `.a.b` and `:not(.c)` — the whole grammar modals.js uses. */
function matchesCompound(element: FakeElement, compound: string): boolean {
    const negations = [...compound.matchAll(/:not\(\.([\w-]+)\)/g)].map(m => m[1]);
    const withoutNegations = compound.replace(/:not\(\.[\w-]+\)/g, '').trim();
    const [tag, ...classes] = withoutNegations.split('.');
    if (tag && element.tagName !== tag.toUpperCase()) return false;
    if (classes.some(cls => cls && !element.classList.contains(cls))) return false;
    return !negations.some(cls => element.classList.contains(cls));
}

export class FakeDocument {
    readonly body: FakeElement;
    activeElement: FakeElement | null = null;
    readonly listeners = new Map<string, Listener[]>();

    constructor() {
        this.body = new FakeElement('body', this);
    }

    createElement(tagName: string): FakeElement {
        return new FakeElement(tagName, this);
    }

    addEventListener(type: string, listener: Listener): void {
        const existing = this.listeners.get(type) ?? [];
        existing.push(listener);
        this.listeners.set(type, existing);
    }

    getElementById(id: string): FakeElement | null {
        for (const node of this.body.walk()) {
            if (node.id === id) return node;
        }
        return null;
    }

    querySelectorAll(selector: string): FakeElement[] {
        return this.body.querySelectorAll(selector);
    }

    querySelector(selector: string): FakeElement | null {
        return this.body.querySelector(selector);
    }

    private makeEvent(target: FakeElement, key?: string): FakeEvent {
        let stopped = false;
        const event: FakeEvent = {
            key,
            target,
            defaultPrevented: false,
            preventDefault() { event.defaultPrevented = true; },
            stopPropagation() { stopped = true; },
            stopImmediatePropagation() { stopped = true; }
        };
        Object.defineProperty(event, '__stopped', { get: () => stopped, enumerable: false });
        return event;
    }

    private isStopped(event: FakeEvent): boolean {
        return (event as unknown as { __stopped: boolean }).__stopped;
    }

    /** Target's own listeners first, then the document's — modals.js delegates. */
    dispatchClick(target: FakeElement): FakeEvent {
        const event = this.makeEvent(target);
        for (const listener of target.listeners.get('click') ?? []) {
            listener(event);
            if (this.isStopped(event)) return event;
        }
        for (const listener of this.listeners.get('click') ?? []) {
            listener(event);
            if (this.isStopped(event)) return event;
        }
        return event;
    }

    dispatchKeydown(key: string, target: FakeElement = this.body): FakeEvent {
        const event = this.makeEvent(target, key);
        for (const listener of this.listeners.get('keydown') ?? []) {
            listener(event);
            if (this.isStopped(event)) return event;
        }
        return event;
    }
}

/**
 * Install a fresh document (and a `window` with NO dialog primitives — the
 * desktop webview has none, which is the whole reason the in-page dialog
 * exists; a test that leaves a working `window.confirm` behind could not tell
 * the two implementations apart).
 */
export function installFakeDom(): FakeDocument {
    const document = new FakeDocument();
    const globals = globalThis as Record<string, unknown>;
    globals.document = document;
    globals.window = { document };
    return document;
}

export function uninstallFakeDom(): void {
    const globals = globalThis as Record<string, unknown>;
    delete globals.document;
    delete globals.window;
}
