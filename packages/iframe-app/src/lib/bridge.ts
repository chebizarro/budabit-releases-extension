import type { WidgetBridge } from 'budabit-sdk';
import type { NostrEvent } from './types.js';

export const FALLBACK_RELAYS = ['wss://relay.sharegap.net', 'wss://nos.lol'];

export function getRelays(repoRelays: string[]): string[] {
  const merged = [...repoRelays, ...FALLBACK_RELAYS];
  return [...new Set(merged.filter(Boolean))];
}

/**
 * One-shot relay query. Returns events (may timeout — still returns partial results).
 */
export async function queryEvents(
  bridge: WidgetBridge,
  relays: string[],
  filter: Record<string, unknown>
): Promise<NostrEvent[]> {
  const res = (await bridge.request('nostr:query', { relays, filter })) as any;
  if (res && 'error' in res) throw new Error(String(res.error));
  if (res?.status === 'ok' || res?.status === 'timeout') return (res.events as NostrEvent[]) ?? [];
  return [];
}

/**
 * Open a persistent subscription. Returns subscriptionId and cleanup.
 * Events arrive via bridge.onEvent('nostr:event', ...) filtered by subscriptionId.
 */
export async function openSubscription(
  bridge: WidgetBridge,
  relays: string[],
  filter: Record<string, unknown>,
  subscriptionId: string
): Promise<void> {
  const res = (await bridge.request('nostr:subscribe', {
    subscriptionId,
    relays,
    filter,
  })) as any;
  if (res && 'error' in res) throw new Error(String(res.error));
}

export async function closeSubscription(
  bridge: WidgetBridge,
  subscriptionId: string
): Promise<void> {
  await bridge.request('nostr:unsubscribe', { subscriptionId }).catch(() => {});
}

/**
 * Publish an unsigned event. The host signs it and publishes to its relay list.
 */
export async function publishEvent(
  bridge: WidgetBridge,
  unsignedEvent: Record<string, unknown>
): Promise<void> {
  const res = (await bridge.request('nostr:publish', unsignedEvent)) as any;
  if (res && 'error' in res) throw new Error(String(res.error));
}

export function tagValue(event: NostrEvent, tagName: string): string | undefined {
  return event.tags.find((t) => t[0] === tagName)?.[1];
}
