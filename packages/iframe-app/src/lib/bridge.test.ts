import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WidgetBridge } from './bridge.js';

type TestWireMessage = {
  type: string;
  action: string;
  id?: string;
  payload?: unknown;
};

describe('WidgetBridge', () => {
  let targetWindow: { postMessage: ReturnType<typeof vi.fn> };
  let bridge: WidgetBridge;

  beforeEach(() => {
    targetWindow = { postMessage: vi.fn() };
    bridge = new WidgetBridge({
      targetWindow: targetWindow as unknown as Window,
      targetOrigin: '*',
      timeoutMs: 1000,
    });
  });

  afterEach(() => {
    bridge.destroy();
    vi.restoreAllMocks();
  });

  function dispatch(data: unknown, origin = window.location.origin): void {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        source: targetWindow as unknown as Window,
        origin,
      })
    );
  }

  it('sends a request and resolves only its matching response', async () => {
    const pending = bridge.request('ui:toast', { message: 'Hello' });
    const sent = targetWindow.postMessage.mock.calls[0]![0] as TestWireMessage;

    expect(sent).toMatchObject({
      type: 'request',
      action: 'ui:toast',
      payload: { message: 'Hello' },
    });
    expect(sent.id).toEqual(expect.any(String));

    dispatch({
      type: 'response',
      id: sent.id,
      action: sent.action,
      payload: { status: 'ok' },
    });

    await expect(pending).resolves.toEqual({ status: 'ok' });
  });

  it('ignores response envelopes with missing or empty ids', async () => {
    const pending = bridge.request('ui:resize', { height: 400 });
    const sent = targetWindow.postMessage.mock.calls[0]![0] as TestWireMessage;
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    dispatch({ type: 'response', action: sent.action, payload: { status: 'ok' } });
    dispatch({ type: 'response', id: '', action: sent.action, payload: { status: 'ok' } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    dispatch({
      type: 'response',
      id: sent.id,
      action: sent.action,
      payload: { status: 'ok' },
    });
    await expect(pending).resolves.toEqual({ status: 'ok' });
  });

  it('retries DataCloneError failures with a deep snapshot', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    targetWindow.postMessage
      .mockImplementationOnce(() => {
        throw new DOMException('proxy payload', 'DataCloneError');
      })
      .mockImplementationOnce(() => {});

    const proxied = new Proxy({ nested: new Proxy({ value: 42 }, {}) }, {});
    const pending = bridge.request('custom:proxy', proxied);

    expect(targetWindow.postMessage).toHaveBeenCalledTimes(2);
    const retried = targetWindow.postMessage.mock.calls[1]![0] as TestWireMessage;
    expect(retried.payload).toEqual({ nested: { value: 42 } });
    expect(warn).toHaveBeenCalledOnce();

    void pending.catch(() => {});
  });

  it('signals widget readiness at most once', () => {
    bridge.signalReady();
    bridge.signalReady();

    expect(targetWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(targetWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'event', action: 'widget:ready' }),
      '*'
    );
  });

  it('dispatches current lifecycle and subscription events', async () => {
    const initHandler = vi.fn();
    const repoHandler = vi.fn();
    const subscriptionHandler = vi.fn();
    bridge.onEvent('widget:init', initHandler);
    bridge.onEvent('context:repoUpdate', repoHandler);
    bridge.onEvent('nostr:subscription:event', subscriptionHandler);

    dispatch({
      type: 'event',
      action: 'widget:init',
      payload: { extensionId: 'releases', pubkey: 'user' },
    });
    dispatch({
      type: 'event',
      action: 'context:repoUpdate',
      payload: { pubkey: 'owner', name: 'repo', relays: [] },
    });
    dispatch({
      type: 'event',
      action: 'nostr:subscription:event',
      payload: { subscriptionId: 'host-id', event: { id: 'event-id' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(initHandler).toHaveBeenCalledWith({ extensionId: 'releases', pubkey: 'user' });
    expect(repoHandler).toHaveBeenCalledWith({ pubkey: 'owner', name: 'repo', relays: [] });
    expect(subscriptionHandler).toHaveBeenCalledWith({
      subscriptionId: 'host-id',
      event: { id: 'event-id' },
    });
  });

  it('uses the host-returned subscription id for unsubscribe', async () => {
    const pending = bridge.subscribe({
      subscriptionId: 'client-id',
      relays: ['wss://relay.example'],
      filter: { kinds: [1] },
    });
    const subscribeMessage = targetWindow.postMessage.mock.calls[0]![0] as TestWireMessage;

    dispatch({
      type: 'response',
      id: subscribeMessage.id,
      action: 'nostr:subscribe',
      payload: { status: 'ok', subscriptionId: 'host-id' },
    });

    const subscription = await pending;
    expect(subscription.subscriptionId).toBe('host-id');

    const unsubscribe = subscription.unsubscribe();
    const unsubscribeMessage = targetWindow.postMessage.mock.calls.at(-1)?.[0] as TestWireMessage;
    expect(unsubscribeMessage).toMatchObject({
      action: 'nostr:unsubscribe',
      payload: { subscriptionId: 'host-id' },
    });

    dispatch({
      type: 'response',
      id: unsubscribeMessage.id,
      action: 'nostr:unsubscribe',
      payload: { status: 'ok' },
    });
    await expect(unsubscribe).resolves.toEqual({ status: 'ok' });
  });

  it('unsubscribes active host ids during destroy', async () => {
    const pending = bridge.subscribe({
      subscriptionId: 'client-id',
      relays: ['wss://relay.example'],
      filter: { kinds: [1] },
    });
    const subscribeMessage = targetWindow.postMessage.mock.calls[0]![0] as TestWireMessage;
    dispatch({
      type: 'response',
      id: subscribeMessage.id,
      action: 'nostr:subscribe',
      payload: { status: 'ok', subscriptionId: 'host-id' },
    });
    await pending;

    targetWindow.postMessage.mockClear();
    bridge.destroy();
    expect(targetWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'nostr:unsubscribe',
        payload: { subscriptionId: 'host-id' },
      }),
      '*'
    );
  });

  it('responds to host requests and validates configured origins', async () => {
    const strictTarget = { postMessage: vi.fn() };
    const strictBridge = new WidgetBridge({
      targetWindow: strictTarget as unknown as Window,
      targetOrigin: 'https://trusted.example',
    });
    const handler = vi.fn().mockReturnValue({ status: 'ok' });
    strictBridge.onRequest('custom:action', handler);

    const request = {
      type: 'request',
      id: 'host-request',
      action: 'custom:action',
      payload: { value: 1 },
    };
    window.dispatchEvent(
      new MessageEvent('message', {
        data: request,
        source: strictTarget as unknown as Window,
        origin: 'https://untrusted.example',
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).not.toHaveBeenCalled();

    window.dispatchEvent(
      new MessageEvent('message', {
        data: request,
        source: strictTarget as unknown as Window,
        origin: 'https://trusted.example',
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handler).toHaveBeenCalledWith({ value: 1 });
    expect(strictTarget.postMessage).toHaveBeenCalledWith(
      {
        type: 'response',
        id: 'host-request',
        action: 'custom:action',
        payload: { status: 'ok' },
      },
      'https://trusted.example'
    );
    strictBridge.destroy();
  });

  it('rejects pending requests on timeout and destroy', async () => {
    const timeoutBridge = new WidgetBridge({
      targetWindow: targetWindow as unknown as Window,
      timeoutMs: 5,
    });
    await expect(timeoutBridge.request('ui:toast', { message: 'late' })).rejects.toThrow(
      /timed out/
    );
    timeoutBridge.destroy();

    const pending = bridge.request('ui:toast', { message: 'destroyed' });
    bridge.destroy();
    await expect(pending).rejects.toThrow(/destroyed/);
  });
});
