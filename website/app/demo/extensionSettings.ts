const DEMO_CELL_EDIT_BEHAVIORS = Object.freeze(['inline', 'modal'] as const);

export interface DemoExtensionSettings {
  autoCommit: false;
  autoCommitSupported: false;
  cellEditBehavior: typeof DEMO_CELL_EDIT_BEHAVIORS[number];
  cellEditBehaviorOptions: typeof DEMO_CELL_EDIT_BEHAVIORS;
  fileOperations: 'web';
}

export const DEMO_EXTENSION_SETTINGS: DemoExtensionSettings = Object.freeze({
  autoCommit: false,
  autoCommitSupported: false,
  cellEditBehavior: 'inline',
  cellEditBehaviorOptions: DEMO_CELL_EDIT_BEHAVIORS,
  fileOperations: 'web'
});

export function createDemoExtensionSettings(): DemoExtensionSettings {
  return { ...DEMO_EXTENSION_SETTINGS };
}

export function updateDemoExtensionSetting(
  current: DemoExtensionSettings,
  key: unknown,
  value: unknown
): DemoExtensionSettings {
  if (key === 'autoCommit') {
    if (value === false) return current;
    throw new Error('Auto-commit is not available in the web demo; download the database to save changes.');
  }
  if (key === 'doubleClickBehavior') {
    if (
      typeof value !== 'string'
      || !DEMO_CELL_EDIT_BEHAVIORS.includes(value as typeof DEMO_CELL_EDIT_BEHAVIORS[number])
    ) {
      throw new Error(`Double-click behavior "${String(value)}" is not available in the web demo.`);
    }
    return {
      ...current,
      cellEditBehavior: value as typeof DEMO_CELL_EDIT_BEHAVIORS[number]
    };
  }
  throw new Error(`Unsupported demo extension setting: ${String(key)}`);
}
