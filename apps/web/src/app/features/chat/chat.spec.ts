import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Chat } from './chat';
import { ChatStore } from './chat.store';

const store = {
  open: vi.fn(), send: vi.fn(() => true), retry: vi.fn(), recover: vi.fn(), loadHistory: vi.fn(),
  messages: signal<unknown[]>([]), outgoing: signal<unknown[]>([]), outgoingNotice: signal('No messages awaiting confirmation.'), liveNotice: signal(''), notice: signal(''),
  ready: signal(true), historyLoading: signal(false), historyError: signal(''), olderCursor: signal<string | null>(null),
  snapshotCursor: signal('snapshot'), syncLoading: signal(false), syncError: signal(''),
};
const channel = (id: string) => ({ id, name: id, slug: id, isMember: true, createdAt: '2026-10-18T00:00:00Z' });
beforeEach(() => {
  vi.clearAllMocks(); store.messages.set([]); store.outgoing.set([]); store.liveNotice.set('');
  store.syncError.set(''); store.syncLoading.set(false);
  TestBed.configureTestingModule({ imports: [Chat] }).overrideComponent(Chat, { set: { providers: [{ provide: ChatStore, useValue: store }] } });
});
afterEach(() => TestBed.resetTestingModule());

function setup() {
  const fixture = TestBed.createComponent(Chat);
  fixture.componentRef.setInput('channel', channel('first'));
  fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const composer = element.querySelector('textarea')!;
  const fill = (text = 'Draft') => { composer.value = text; composer.dispatchEvent(new Event('input')); fixture.detectChanges(); };
  const key = (init: KeyboardEventInit) => composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init }));
  return { fixture, element, composer, fill, key };
}

it('focuses each selected channel once and leaves the draft focused on live updates', () => {
  const { fixture, element, composer } = setup();
  expect(document.activeElement).toBe(element.querySelector('h2'));
  composer.focus(); store.liveNotice.set('A new message arrived.'); fixture.detectChanges();
  expect(document.activeElement).toBe(composer);
  fixture.componentRef.setInput('channel', channel('second')); fixture.detectChanges();
  expect(document.activeElement).toBe(element.querySelector('h2'));
});

it.each([{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }, { keyCode: 229 }])('does not send or cancel Enter with %o', init => {
  const { fill, key } = setup(); fill();
  expect(key(init)).toBe(true); expect(store.send).not.toHaveBeenCalled();
});

it('guards the whole composition lifecycle, including submit, then sends one completed draft', () => {
  const { fixture, element, composer, fill, key } = setup(); fill('日本語');
  composer.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
  key({}); element.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  expect(store.send).not.toHaveBeenCalled();
  composer.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '日本語' }));
  key({ keyCode: 229 }); expect(store.send).not.toHaveBeenCalled();
  expect(key({})).toBe(false); fixture.detectChanges();
  expect(store.send).toHaveBeenCalledExactlyOnceWith('日本語'); expect(composer.value).toBe('');
  expect(document.activeElement).toBe(composer);
});

it('returns focus to the composer after explicit button send and retry, and to the log before recovery', () => {
  const { fixture, element, composer, fill } = setup(); fill();
  const send = element.querySelector<HTMLButtonElement>('button[type=submit]')!; send.focus(); send.click(); fixture.detectChanges();
  expect(document.activeElement).toBe(composer);
  store.outgoing.set([{ request: { clientMessageId: 'one', body: 'Unconfirmed' }, state: 'unconfirmed', attempt: 2 }]);
  store.syncError.set('Recovery failed.'); fixture.detectChanges();
  const retry = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('Retry confirmation'))!;
  retry.focus(); retry.click(); expect(document.activeElement).toBe(composer);
  const recovery = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('Retry recovery'))!;
  recovery.focus(); recovery.click(); expect(document.activeElement).toBe(element.querySelector('[role=log]'));
});
