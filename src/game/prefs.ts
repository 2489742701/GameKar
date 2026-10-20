/**
 * 玩家偏好 —— 目前只有一件："压矿脉的确认框不再提示"。
 *
 * 存取包一层接口而不是直接写 localStorage：一是无痕模式下它会抛异常，
 * 二是单测里没有 window，用内存桩就能验。
 */

export interface KeyValueStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** 没有可用存储时的兜底：本次会话内记住，刷新就忘。 */
function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => void map.set(key, value),
  };
}

function browserStore(): KeyValueStore {
  try {
    const probe = '__gamekar_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return {
      get: (key) => {
        try {
          return window.localStorage.getItem(key);
        } catch {
          return null;
        }
      },
      set: (key, value) => {
        try {
          window.localStorage.setItem(key, value);
        } catch {
          // 配额满或被策略禁用：这次记住就行，下次重来
        }
      },
    };
  } catch {
    return memoryStore();
  }
}

const KEY = {
  neverAskDestroyVein: 'gamekar.pref.neverAskDestroyVein',
  theme: 'gamekar.pref.theme',
  save: 'gamekar.save',
} as const;

export class Prefs {
  private readonly store: KeyValueStore;

  constructor(store?: KeyValueStore) {
    this.store = store ?? (typeof window === 'undefined' ? memoryStore() : browserStore());
  }

  /** 勾了"不再提示"之后，压矿脉直接放行。破坏仍然真实发生，只是不再问。 */
  get neverAskDestroyVein(): boolean {
    return this.store.get(KEY.neverAskDestroyVein) === '1';
  }

  setNeverAskDestroyVein(value: boolean): void {
    this.store.set(KEY.neverAskDestroyVein, value ? '1' : '0');
  }

  /**
   * 界面材质。存的**就是那个可分享的 ID**（`mk-…`），不另存一份参数 JSON：
   * 一份真相，不会出现"参数与码对不上"。读回来的解码合法性由 ui/themePrefs 判，
   * 这里只管进出字符串。
   */
  get themeId(): string | null {
    return this.store.get(KEY.theme);
  }

  setThemeId(id: string): void {
    this.store.set(KEY.theme, id);
  }

  /** 回合结算时自动写的存档（JSON 串）。读不出来或版本不符时由 world/save 判掉。 */
  get save(): string | null {
    return this.store.get(KEY.save);
  }

  setSave(json: string): void {
    this.store.set(KEY.save, json);
  }

  clearSave(): void {
    this.store.set(KEY.save, '');
  }
}
