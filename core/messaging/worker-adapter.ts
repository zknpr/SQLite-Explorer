/**
 * Worker Thread Adapter
 *
 * Adapts Node.js worker_threads for the messaging layer.
 */

import { Worker, MessagePort, parentPort } from 'worker_threads';

/**
 * Adapter interface for worker communication
 */
export interface WorkerAdapter {
  postMessage(data: any): void;
  on(event: 'message', handler: (data: any) => void): void;
  terminate?(): Promise<number>;
}

/**
 * Create adapter for main thread communicating with a worker.
 */
export function createWorkerAdapter(worker: Worker): WorkerAdapter {
  return {
    postMessage(data: any): void {
      worker.postMessage(data);
    },
    on(event: 'message', handler: (data: any) => void): void {
      worker.on(event, handler);
    },
    async terminate(): Promise<number> {
      return worker.terminate();
    }
  };
}

/**
 * Create adapter for worker thread communicating with main thread.
 */
export function createParentAdapter(): WorkerAdapter {
  if (!parentPort) {
    throw new Error('Not running in a worker thread');
  }

  const port = parentPort;

  return {
    postMessage(data: any): void {
      port.postMessage(data);
    },
    on(event: 'message', handler: (data: any) => void): void {
      port.on(event, handler);
    }
  };
}

/**
 * Create adapter from a MessagePort.
 */
export function createPortAdapter(port: MessagePort): WorkerAdapter {
  return {
    postMessage(data: any): void {
      port.postMessage(data);
    },
    on(event: 'message', handler: (data: any) => void): void {
      port.on(event, handler);
    }
  };
}
