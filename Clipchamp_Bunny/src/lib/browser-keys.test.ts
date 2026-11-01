import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BINDINGS,
  BROWSER_GROUPS,
  dispatchBrowserKey,
  matchBrowserKey,
  type BrowserKeyDeps
} from './browser-keys.ts';

type Calls = Array<{ action: string; args: unknown[] }>;

/** A recorder that satisfies BrowserKeyDeps. */
function recorder(): { deps: BrowserKeyDeps; calls: Calls } {
  const calls: Calls = [];
  const deps: BrowserKeyDeps = new Proxy(
    {},
    {
      get(_t, prop: string): unknown {
        return (...args: unknown[]) => void calls.push({ action: prop, args });
      }
    }
  ) as unknown as BrowserKeyDeps;
  return { deps, calls };
}

/** A minimal KeyboardEvent-like object — no DOM required. */
function ev(key: string, opts: Partial<KeyLike> = {}): KeyLike {
  return {
    key,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    target: null,
    ...opts
  };
}

interface KeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
  preventDefault?: () => void;
}

const asEvt = (e: KeyLike) => e as unknown as Parameters<typeof dispatchBrowserKey>[0];

describe('browser keys — the Firefox map', () => {
  it('fires every binding in the table exactly once, to the named dep', () => {
    const seen = new Map<string, string[]>();
    for (const entry of BINDINGS) {
      for (const combo of entry.combos) {
        const { deps, calls } = recorder();
        const parts = combo.split('+');
        const key = ['tab', 'pageup', 'pagedown', 'delete'].includes(parts.at(-1)!)
          ? parts.at(-1)![0].toUpperCase() + parts.at(-1)!.slice(1)
          : parts.at(-1)!;
        const fired = dispatchBrowserKey(
          asEvt(
            ev(key, {
              ctrlKey: parts.includes('ctrl'),
              shiftKey: parts.includes('shift'),
              altKey: parts.includes('alt')
            })
          ),
          deps
        );
        assert.equal(fired, true, `${combo} must fire`);
        assert.equal(calls.length, 1, `${combo} must call exactly one dep`);
        assert.equal(calls[0].action, entry.action, `${combo} must drive ${entry.action}`);
        seen.set(combo, [entry.action]);
      }
    }
  });

  it('has no duplicate combo across entries — the table must stay deterministic', () => {
    const all = BINDINGS.flatMap((b) => b.combos);
    assert.equal(new Set(all).size, all.length);
  });

  it('marks preventDefault on every handled event', () => {
    let prevented = false;
    const e = ev('t', { ctrlKey: true });
    e.preventDefault = () => {
      prevented = true;
    };
    const { deps } = recorder();
    assert.equal(dispatchBrowserKey(asEvt(e), deps), true);
    assert.equal(prevented, true);
  });

  it('tab grid: n, last, cycle and reorder', () => {
    const { deps, calls } = recorder();
    assert.equal(matchBrowserKey(asEvt(ev('5', { ctrlKey: true })))!.action, 'selectTabN');
    assert.equal(matchBrowserKey(asEvt(ev('9', { ctrlKey: true })))!.action, 'lastTab');
    dispatchBrowserKey(asEvt(ev('5', { ctrlKey: true })), deps);
    assert.deepEqual(calls.at(-1)!.args, [4]);
    dispatchBrowserKey(asEvt(ev('9', { ctrlKey: true })), deps);
    assert.equal(calls.at(-1)!.action, 'lastTab');
    assert.deepEqual(calls.at(-1)!.args, []);
    dispatchBrowserKey(asEvt(ev('Tab', { ctrlKey: true })), deps);
    assert.equal(calls.at(-1)!.action, 'nextTab');
    dispatchBrowserKey(asEvt(ev('PageDown', { ctrlKey: true })), deps);
    assert.equal(calls.at(-1)!.action, 'nextTab');
    dispatchBrowserKey(asEvt(ev('Tab', { ctrlKey: true, shiftKey: true })), deps);
    assert.equal(calls.at(-1)!.action, 'prevTab');
    dispatchBrowserKey(asEvt(ev('PageUp', { ctrlKey: true, shiftKey: true })), deps);
    assert.deepEqual(
      calls.filter((c) => c.action === 'moveTab').map((c) => c.args),
      [[-1]]
    );
    dispatchBrowserKey(asEvt(ev('PageDown', { ctrlKey: true, shiftKey: true })), deps);
    assert.deepEqual(
      calls.filter((c) => c.action === 'moveTab').map((c) => c.args),
      [[-1], [1]]
    );
  });

  it('reopening, closing and window-close rules', () => {
    const { deps, calls } = recorder();
    for (const key of ['shift+t', 'F4', 'w', 'shift+w'] as const) {
      dispatchBrowserKey(
        asEvt(
          ev(key.startsWith('F') ? key : key.at(-1)!, {
            ctrlKey: true,
            shiftKey: key.startsWith('shift')
          })
        ),
        deps
      );
    }
    const acts = calls.map((c) => c.action);
    assert.deepEqual(acts, ['reopenClosedTab', 'closeTab', 'closeTab', 'closeBrowserView']);
  });

  it('navigation: back/forward/reload/stop/home/address bar', () => {
    const { deps, calls } = recorder();
    dispatchBrowserKey(asEvt(ev('ArrowLeft', { altKey: true })), deps);
    dispatchBrowserKey(asEvt(ev('Backspace')), deps);
    dispatchBrowserKey(asEvt(ev('ArrowRight', { altKey: true })), deps);
    dispatchBrowserKey(asEvt(ev('Backspace', { shiftKey: true })), deps);
    assert.deepEqual(
      calls.filter((c) => ['back', 'forward'].includes(c.action)).map((c) => c.action),
      ['back', 'back', 'forward', 'forward']
    );
    dispatchBrowserKey(asEvt(ev('f5')), deps);
    assert.deepEqual(calls.at(-1)!.args, [false]);
    dispatchBrowserKey(asEvt(ev('r', { ctrlKey: true })), deps);
    assert.deepEqual(calls.at(-1)!.args, [false]);
    dispatchBrowserKey(asEvt(ev('r', { ctrlKey: true, shiftKey: true })), deps);
    assert.deepEqual(calls.at(-1)!.args, [true]);
    dispatchBrowserKey(asEvt(ev('F5', { ctrlKey: true })), deps);
    assert.deepEqual(calls.at(-1)!.args, [true]);
    dispatchBrowserKey(asEvt(ev('Escape')), deps);
    assert.equal(calls.at(-1)!.action, 'stopLoading');
    dispatchBrowserKey(asEvt(ev('Home', { altKey: true })), deps);
    assert.equal(calls.at(-1)!.action, 'goHome');
    for (const combo of [
      ev('l', { ctrlKey: true }),
      ev('d', { altKey: true }),
      ev('k', { ctrlKey: true })
    ]) {
      dispatchBrowserKey(asEvt(combo), deps);
      assert.equal(calls.at(-1)!.action, 'focusUrlbar');
    }
  });

  it('page: bookmark, panels, save, print, source, zoom', () => {
    const { deps, calls } = recorder();
    for (const [key, opts, action, args] of [
      ['d', { ctrlKey: true }, 'bookmark', []],
      ['d', { ctrlKey: true, shiftKey: true }, 'bookmarkAllTabs', []],
      ['b', { ctrlKey: true }, 'openBookmarks', []],
      ['o', { ctrlKey: true, shiftKey: true }, 'openBookmarks', []],
      ['j', { ctrlKey: true }, 'downloads', []],
      ['h', { ctrlKey: true }, 'history', []],
      ['Delete', { ctrlKey: true, shiftKey: true }, 'clearHistory', []],
      ['s', { ctrlKey: true }, 'savePage', []],
      ['o', { ctrlKey: true }, 'openFile', []],
      ['p', { ctrlKey: true }, 'printPage', []],
      ['u', { ctrlKey: true }, 'viewSource', []],
      ['=', { ctrlKey: true }, 'zoom', [1]],
      ['=', { ctrlKey: true, shiftKey: true }, 'zoom', [1]],
      ['+', { ctrlKey: true }, 'zoom', [1]],
      ['-', { ctrlKey: true }, 'zoom', [-1]],
      ['0', { ctrlKey: true }, 'zoom', [0]]
    ] as const) {
      dispatchBrowserKey(asEvt(ev(key, opts)), deps);
      assert.equal(calls.at(-1)!.action, action, `${key} ${JSON.stringify(opts)} → ${action}`);
      assert.deepEqual(calls.at(-1)!.args, args);
    }
  });

  it('find + F1 help', () => {
    const { deps, calls } = recorder();
    dispatchBrowserKey(asEvt(ev('f', { ctrlKey: true })), deps);
    dispatchBrowserKey(asEvt(ev('F3')), deps);
    dispatchBrowserKey(asEvt(ev('F3', { shiftKey: true })), deps);
    dispatchBrowserKey(asEvt(ev('g', { ctrlKey: true, shiftKey: true })), deps);
    assert.deepEqual(
      calls.filter((c) => c.action === 'findInPage').length,
      4,
      'every find combo resolves'
    );
    dispatchBrowserKey(asEvt(ev('F1')), deps);
    assert.equal(calls.at(-1)!.action, 'openHelp');
  });

  it('the meta/Windows key is sacred — never a browser chord', () => {
    const { deps, calls } = recorder();
    for (const e of [
      ev('t', { metaKey: true, ctrlKey: true }),
      ev('d', { metaKey: true, ctrlKey: true })
    ]) {
      assert.equal(dispatchBrowserKey(asEvt(e), deps), false);
    }
    assert.equal(calls.length, 0);
  });

  it('modifier drift never collides: Ctrl+Shift+T is reopen, Ctrl+W stays close', () => {
    const decide = (e: KeyLike): string | null => matchBrowserKey(asEvt(e))?.action ?? null;
    assert.equal(decide(ev('t', { ctrlKey: true, shiftKey: true })), 'reopenClosedTab');
    assert.equal(decide(ev('w', { ctrlKey: true })), 'closeTab');
    assert.equal(decide(ev('w', { ctrlKey: true, shiftKey: true })), 'closeBrowserView');
    assert.equal(decide(ev('t', { altKey: true })), null);
  });

  it('typing focus: back/forward/stop/clear-history stand down, Firefox chords stay', () => {
    const decide = (e: KeyLike): string | null => matchBrowserKey(asEvt(e))?.action ?? null;
    const input = { tagName: 'INPUT' } as unknown as EventTarget;
    assert.equal(decide(ev('Backspace', { target: input })), null, 'Backspace keeps editing');
    assert.equal(decide(ev('Delete', { ctrlKey: true, shiftKey: true, target: input })), null);
    assert.equal(decide(ev('Escape', { target: input })), null, 'Esc is the input\u2019s own key');
    assert.equal(decide(ev('t', { ctrlKey: true, target: input })), 'newTab');
    assert.equal(decide(ev('l', { ctrlKey: true, target: input })), 'focusUrlbar');
    assert.equal(decide(ev('r', { ctrlKey: true, target: input })), 'reload');
  });

  it('the shortcut sheet groups carry every bound action', () => {
    // A static smoke check — the sheet is hand-written prose over the table,
    // so it must mention the actions that exist in the bindings.
    const text = JSON.stringify(BROWSER_GROUPS);
    for (const probe of [
      'Naya tab',
      'Band kiya tab wapas',
      'Address bar',
      'Downloads panel',
      'History panel',
      'Page source',
      'Print',
      'Page zoom'
    ]) {
      assert.ok(text.includes(probe), `sheet must document: ${probe}`);
    }
  });
});
