/**
 * Types for settings.js — the pragma/extension-settings editor. Pragma and
 * extension-settings payloads are opaque RPC round-trips (same fidelity as
 * desktop-api.d.ts's backendApi: unknown in, unknown out); only the shapes
 * this module itself branches on are typed precisely.
 */

/** Wires the settings modal's delegated change listener. Call once at startup. */
export function initSettings(): void;

/** Shows the settings modal and loads its pragma/extension-settings form. */
export function openSettingsModal(): Promise<void>;

/**
 * The double-click cell-edit modes offered to the user. The desktop shell
 * has no VS Code host to hand a cell off to, so 'vscode' is dropped there.
 */
export function doubleClickOptions(isDesktop: boolean): Array<'inline' | 'modal' | 'vscode'>;

export function updateExtensionSetting(key: string, value: unknown): Promise<void>;
export function updatePragma(name: string, value: unknown): Promise<void>;
