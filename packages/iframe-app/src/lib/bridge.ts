import {
  type NostrEvent,
  type WidgetActionMap,
  type WidgetEventAction,
  type WidgetRequestAction,
  type WidgetWireMessage,
  WidgetWireMessageSchema,
} from './types.js';

interface PendingRequest {
  action: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

type EventHandler = (payload: unknown) => void | Promise<void>;
type RequestHandler = (payload: unknown) => unknown | Promise<unknown>;

export interface WidgetBridgeOptions {
  targetWindow?: Window | null;
  targetOrigin?: string;
  validateOrigin?: (origin: string) => boolean;
  timeoutMs?: number;
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/**
 * Unwrap Proxy values (including Svelte 5 $state) while preserving common
 * structured-clone-friendly built-ins.
 */
function deepSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value);
  if (value instanceof ArrayBuffer) return value.slice(0);
  if (ArrayBuffer.isView(value)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const view = value as any;
    return new view.constructor(view.buffer.slice(0), view.byteOffset, view.length);
  }
  if (Array.isArray(value)) return value.map(deepSnapshot);
  if (value instanceof Map) {
    const snapshot = new Map();
    for (const [key, item] of value) snapshot.set(deepSnapshot(key), deepSnapshot(item));
    return snapshot;
  }
  if (value instanceof Set) {
    const snapshot = new Set();
    for (const item of value) snapshot.add(deepSnapshot(item));
    return snapshot;
  }

  const snapshot: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    snapshot[key] = deepSnapshot((value as Record<string, unknown>)[key]);
  }
  return snapshot;
}

/** Retry postMessage with a proxy-free snapshot when structured cloning fails. */
function safePostMessage(target: Window, message: unknown, origin: string): void {
  try {
    target.postMessage(message, origin);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'DataCloneError') {
      console.warn(
        '[WidgetBridge] postMessage payload not cloneable, retrying with snapshot:',
        error.message,
        message
      );
      target.postMessage(deepSnapshot(message), origin);
      return;
    }
    throw error;
  }
}

export class WidgetBridge {
  private readySent = false;
  private targetWindow: Window;
  private targetOrigin: string;
  private validateOrigin?: (origin: string) => boolean;
  private timeoutMs: number;
  private pending = new Map<string, PendingRequest>();
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();
  private listener: ((event: MessageEvent) => void) | null = null;
  private subscriptions = new Set<string>();

  constructor(options: WidgetBridgeOptions = {}) {
    const targetWindow = options.targetWindow ?? window.parent;
    if (!targetWindow) throw new Error('WidgetBridge: targetWindow is not available');

    this.targetWindow = targetWindow;
    this.targetOrigin = options.targetOrigin ?? '*';
    this.validateOrigin = options.validateOrigin;
    this.timeoutMs = options.timeoutMs ?? 15000;
    this.listener = (event: MessageEvent) => {
      void this.handleMessage(event);
    };
    window.addEventListener('message', this.listener);
  }

  request<A extends WidgetRequestAction>(
    action: A,
    payload: WidgetActionMap[A]['req']
  ): Promise<WidgetActionMap[A]['res']>;
  request(action: string, payload?: unknown): Promise<unknown>;
  request(action: string, payload?: unknown): Promise<unknown> {
    const id = makeId();
    const message: WidgetWireMessage = { type: 'request', id, action, payload };

    return new Promise((resolve, reject) => {
      const timeoutId =
        this.timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`WidgetBridge: request timed out (${action})`));
            }, this.timeoutMs)
          : null;

      this.pending.set(id, { action, resolve, reject, timeoutId });
      try {
        safePostMessage(this.targetWindow, message, this.targetOrigin);
      } catch (error) {
        if (timeoutId) clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  onEvent<A extends WidgetEventAction>(
    action: A,
    handler: (payload: WidgetActionMap[A]['event']) => void | Promise<void>
  ): () => void;
  onEvent(action: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  onEvent(action: string, handler: (payload: unknown) => void | Promise<void>): () => void {
    if (!this.eventHandlers.has(action)) this.eventHandlers.set(action, new Set());
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const handlers = this.eventHandlers.get(action)!;
    const wrapped: EventHandler = (payload) => handler(payload);
    handlers.add(wrapped);

    return () => {
      handlers.delete(wrapped);
      if (handlers.size === 0) this.eventHandlers.delete(action);
    };
  }

  onRequest<A extends WidgetRequestAction>(
    action: A,
    handler: (
      payload: WidgetActionMap[A]['req']
    ) => WidgetActionMap[A]['res'] | Promise<WidgetActionMap[A]['res']>
  ): () => void;
  onRequest(action: string, handler: (payload: unknown) => unknown | Promise<unknown>): () => void;
  onRequest(action: string, handler: (payload: unknown) => unknown | Promise<unknown>): () => void {
    const wrapped: RequestHandler = (payload) => handler(payload);
    this.requestHandlers.set(action, wrapped);
    return () => {
      if (this.requestHandlers.get(action) === wrapped) this.requestHandlers.delete(action);
    };
  }

  /** Signal readiness once, after lifecycle handlers have been installed. */
  signalReady(): void {
    if (this.readySent) return;
    this.readySent = true;
    const message: WidgetWireMessage = {
      type: 'event',
      action: 'widget:ready',
      payload: { timestamp: Date.now() },
    };
    try {
      safePostMessage(this.targetWindow, message, this.targetOrigin);
    } catch {
      // The host may not be listening yet.
    }
  }

  /** Open a subscription and retain the host-assigned subscription ID. */
  async subscribe(payload: {
    subscriptionId: string;
    relays: string[];
    filter: Record<string, unknown>;
  }): Promise<{ subscriptionId: string; unsubscribe: () => Promise<unknown> }> {
    const response = await this.request('nostr:subscribe', payload);
    if ('error' in response) throw new Error(response.error);
    if (response.status !== 'ok') throw new Error('Subscription failed with unknown error');

    const subscriptionId = response.subscriptionId;
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      throw new Error('Invalid subscription ID from nostr:subscribe');
    }

    this.subscriptions.add(subscriptionId);
    return {
      subscriptionId,
      unsubscribe: async () => {
        this.subscriptions.delete(subscriptionId);
        return this.request('nostr:unsubscribe', { subscriptionId });
      },
    };
  }

  destroy(): void {
    for (const subscriptionId of this.subscriptions) {
      this.request('nostr:unsubscribe', { subscriptionId }).catch(() => {
        // Ignore cleanup failures.
      });
    }
    this.subscriptions.clear();

    if (this.listener) {
      window.removeEventListener('message', this.listener);
      this.listener = null;
    }

    for (const pending of this.pending.values()) {
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      pending.reject(
        new Error(`WidgetBridge: destroyed while awaiting response (${pending.action})`)
      );
    }
    this.pending.clear();
    this.eventHandlers.clear();
    this.requestHandlers.clear();
  }

  private shouldAcceptMessage(event: MessageEvent): boolean {
    if (event.source && event.source !== this.targetWindow) return false;
    if (this.targetOrigin !== '*' && event.origin !== this.targetOrigin) return false;
    if (this.validateOrigin && !this.validateOrigin(event.origin)) return false;
    return true;
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (!this.shouldAcceptMessage(event)) return;
    const parsed = WidgetWireMessageSchema.safeParse(event.data);
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === 'response') {
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      if (pending.timeoutId) clearTimeout(pending.timeoutId);
      this.pending.delete(message.id);
      pending.resolve(message.payload);
      return;
    }

    if (message.type === 'event') {
      const handlers = this.eventHandlers.get(message.action);
      if (!handlers?.size) return;
      await Promise.all([...handlers].map(async (handler) => handler(message.payload)));
      return;
    }

    const handler = this.requestHandlers.get(message.action);
    const source = event.source as Window | null;
    if (!source) return;

    try {
      const result = handler
        ? await handler(message.payload)
        : { error: `No handler registered for action ${message.action}` };
      const response: WidgetWireMessage = {
        type: 'response',
        id: message.id,
        action: message.action,
        payload: result,
      };
      safePostMessage(source, response, event.origin);
    } catch (error) {
      const response: WidgetWireMessage = {
        type: 'response',
        id: message.id,
        action: message.action,
        payload: { error: error instanceof Error ? error.message : String(error) },
      };
      safePostMessage(source, response, event.origin);
    }
  }
}

export function createWidgetBridge(options: WidgetBridgeOptions = {}): WidgetBridge {
  return new WidgetBridge(options);
}

// ── Releases extension domain helpers ───────────────────────────────────────

export const FALLBACK_RELAYS = ['wss://relay.sharegap.net', 'wss://nos.lol'];

export function getRelays(repoRelays: string[] | undefined): string[] {
  const merged = [...(repoRelays ?? []), ...FALLBACK_RELAYS];
  return [...new Set(merged.filter(Boolean))];
}

export async function queryEvents(
  bridge: WidgetBridge,
  relays: string[],
  filter: Record<string, unknown>
): Promise<NostrEvent[]> {
  const response = await bridge.request('nostr:query', { relays, filter });
  if ('error' in response) throw new Error(response.error);
  return response.events ?? [];
}

export async function signEvent(
  bridge: WidgetBridge,
  unsignedEvent: Record<string, unknown>
): Promise<NostrEvent> {
  const response = (await bridge.request('nostr:sign', unsignedEvent)) as
    | { status: 'ok'; event: NostrEvent }
    | { error: string };
  if ('error' in response) throw new Error(response.error);
  if (response.status === 'ok' && response.event) return response.event;
  throw new Error('Unexpected response from nostr:sign');
}

export async function publishEvent(
  bridge: WidgetBridge,
  event: Record<string, unknown>,
  relays?: string[]
): Promise<string> {
  const payload = relays ? { event, relays } : event;
  const response = (await bridge.request('nostr:publish', payload)) as {
    error?: string;
    result?: { eventId?: string };
    eventId?: string;
  };
  if (response.error) throw new Error(response.error);
  return response.result?.eventId ?? response.eventId ?? '';
}

export function tagValue(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find((tag) => tag[0] === tagName)?.[1];
}

export function tagValues(event: NostrEvent, tagName: string): string[] {
  return event.tags
    .filter((tag) => tag[0] === tagName)
    .map((tag) => tag[1])
    .filter((value): value is string => Boolean(value));
}
