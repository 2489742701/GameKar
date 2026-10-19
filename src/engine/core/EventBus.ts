/**
 * 强类型事件总线 —— 引擎内所有跨模块通信的唯一通道。
 * 用法：`bus.on('building:placed', ({ tile }) => ...)`，返回值即可 `dispose()` 的订阅。
 */

export interface Subscription {
  dispose(): void;
}

type Listener<P> = (payload: P) => void;

export class EventBus<EventMap extends object> {
  private readonly channels = new Map<keyof EventMap, Set<Listener<never>>>();

  on<K extends keyof EventMap>(type: K, listener: Listener<EventMap[K]>): Subscription {
    let set = this.channels.get(type);
    if (!set) {
      set = new Set();
      this.channels.set(type, set);
    }
    set.add(listener as Listener<never>);

    return {
      dispose: () => this.off(type, listener),
    };
  }

  once<K extends keyof EventMap>(type: K, listener: Listener<EventMap[K]>): Subscription {
    const sub = this.on(type, (payload) => {
      sub.dispose();
      listener(payload);
    });
    return sub;
  }

  off<K extends keyof EventMap>(type: K, listener: Listener<EventMap[K]>): void {
    this.channels.get(type)?.delete(listener as Listener<never>);
  }

  /** 无 payload 的事件把类型声明成 `void` 即可省略第二个实参。 */
  emit<K extends keyof EventMap>(
    type: K,
    ...payload: EventMap[K] extends void ? [] : [EventMap[K]]
  ): void {
    const set = this.channels.get(type);
    if (!set || set.size === 0) return;
    // 复制一份：允许监听器在回调里增删订阅
    for (const listener of [...set]) {
      (listener as Listener<EventMap[K]>)(payload[0] as EventMap[K]);
    }
  }

  listenerCount(type: keyof EventMap): number {
    return this.channels.get(type)?.size ?? 0;
  }

  clear(): void {
    this.channels.clear();
  }
}
