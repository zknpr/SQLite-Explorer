import type {
    WebviewPayloadLimitErrorData,
    WebviewTransportLimits
} from '../../../src/core/webview-transport';

export {
    MAX_WEBVIEW_BINARY_VALUE_BYTES,
    WEBVIEW_TRANSPORT_SURFACES,
    assertWebviewTransportPayload,
    fromWebviewPayloadLimitErrorData,
    toWebviewPayloadLimitErrorData
} from '../../../src/core/webview-transport';

export function serializeValueAsync(
    value: unknown,
    limits?: WebviewTransportLimits
): Promise<unknown>;
export function serializeArgsAsync(
    args: unknown[],
    limits?: WebviewTransportLimits
): Promise<unknown>;
export function encodeJsonSafeNonFiniteNumber(value: number): string;
export function escapeJsonSafeNumberString(value: string): string;
export function decodeJsonSafeNumberString(value: string): string | number;
export function deserializeValue(
    value: unknown,
    limits?: WebviewTransportLimits
): unknown;
export function errorFromRpcResponse(message: {
    error?: unknown;
    errorMessage?: string;
}): Error;
export function rpcErrorFields(error: unknown): {
    errorMessage: string;
    error?: WebviewPayloadLimitErrorData;
};
