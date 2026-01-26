/**
 * Command Handlers for SQLite Explorer
 *
 * Contains command implementations for the extension.
 */

import * as vsc from 'vscode';
import type { TelemetryReporter } from '@vscode/extension-telemetry';

export { exportTableCommand } from './tableExporter';

/**
 * Placeholder for license key command.
 * This extension is open source and does not require a license.
 */
export async function enterLicenseKeyCommand(context: vsc.ExtensionContext, reporter?: TelemetryReporter) {
  vsc.window.showInformationMessage('SQLite Explorer is open source and free to use!', {
    modal: true,
    detail: 'No license key is required. All features are available.'
  });
}

/**
 * Placeholder for access token command.
 */
export async function enterAccessTokenCommand(context: vsc.ExtensionContext, reporter?: TelemetryReporter) {
  vsc.window.showInformationMessage('SQLite Explorer is open source and free to use!', {
    modal: true,
    detail: 'No access token is required. All features are available.'
  });
}

/**
 * Placeholder for delete license command.
 */
export async function deleteLicenseKeyCommand(context: vsc.ExtensionContext, reporter?: TelemetryReporter) {
  vsc.window.showInformationMessage('No license to deactivate.', {
    modal: false
  });
}
