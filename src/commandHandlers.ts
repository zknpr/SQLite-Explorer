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
export async function enterLicenseKeyCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  vsc.window.showInformationMessage('SQLite Explorer is open source and free to use!', {
    modal: true,
    detail: 'No license key is required. All features are available.'
  });
}

/**
 * Placeholder for access token command.
 */
export async function enterAccessTokenCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  vsc.window.showInformationMessage('SQLite Explorer is open source and free to use!', {
    modal: true,
    detail: 'No access token is required. All features are available.'
  });
}

/**
 * Placeholder for delete license command.
 */
export async function deleteLicenseKeyCommand(context: vsc.ExtensionContext, reporter: TelemetryReporter) {
  vsc.window.showInformationMessage('No license to deactivate.', {
    modal: false
  });
}

/**
 * Calculate days since a timestamp.
 */
export function calcDaysSinceIssued(issuedAt?: number) {
  if (!issuedAt) return null;
  const currentTime = Date.now() / 1000;
  const diffSeconds = currentTime - issuedAt;
  const diffDays = diffSeconds / (24 * 60 * 60);
  return diffDays;
}

/**
 * Get payload from access token (stub).
 */
export function getPayload(accessToken?: string) {
  return null;
}

/**
 * Refresh access token (stub - always returns undefined).
 */
export async function refreshAccessToken(context: vsc.ExtensionContext, licenseKey: string, accessToken?: string) {
  return undefined;
}

/**
 * Verify token (stub - always returns null).
 */
export async function verifyToken<PayloadType = any>(accessToken: string): Promise<PayloadType | null> {
  return null;
}
