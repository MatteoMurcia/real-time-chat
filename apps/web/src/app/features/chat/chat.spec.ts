import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Chat } from './chat';
import { ChatStore } from './chat.store';
import { ActivityService } from '../../core/activity.service';
import { TypingStore } from './typing.store';

const store = {
  open: vi.fn(), send: vi.fn(() => true), retry: vi.fn(), recover: vi.fn(), loadHistory: vi.fn(),
  messages: signal<unknown[]>([]), outgoing: signal<unknown[]>([]), outgoingNotice: signal('No messages awaiting confirmation.'), liveNotice: signal(''), notice: signal(''),
  ready: signal(true), historyLoading: signal(false), historyError: signal(''), olderCursor: signal<string | null>(null),
  snapshotCursor: signal('snapshot'), syncCursor: signal('djE6Y2hhbm5lbDoxMDoxMA'), recoveredSequence: signal('10'), syncLoading: signal(false), syncError: signal(''),
};
const activity = { revision: signal(0), visible: signal(true), readError: signal(null), mark: vi.fn() };
const typing = { open: vi.fn(), input: vi.fn(), stop: vi.fn(), notice: signal('') };
let intersect: IntersectionObserverCallback;
const channel = (id: string) => ({ id, name: id, slug: id, isMember: true, createdAt: '2026-10-18T00:00:00Z' });
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { constructor(callback: IntersectionObserverCallback) { intersect = callback; } observe() {} disconnect() {} });
  vi.clearAllMocks(); store.messages.set([]); store.outgoing.set([]); store.liveNotice.set('');
  activity.visible.set(true); store.recoveredSequence.set('10');
  store.syncError.set(''); store.syncLoading.set(false);
  TestBed.configureTestingModule({ imports: [Chat], providers: [{ provide: ActivityService, useValue: activity }] }).overrideComponent(Chat, { set: { providers: [{ provide: ChatStore, useValue: store }, { provide: TypingStore, useValue: typing }] } });
});
afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

it('marks only reached, fully visible, recovered messages in the current channel', () => {
  const { fixture, element } = setup();
  store.messages.set([{ id: 'one', channelId: 'first', sequence: '10', author: { displayName: 'Other' }, createdAt: '2026-10-20T00:00:00Z', body: 'Read me' }]);
  fixture.detectChanges();
  const marker = element.querySelector('[data-read-sequence]')!;
  const notify = (ratio = 1) => intersect([{ target: marker, isIntersecting: true, intersectionRatio: ratio } as IntersectionObserverEntry], {} as IntersectionObserver);
  activity.visible.set(false); notify(); expect(activity.mark).not.toHaveBeenCalled();
  activity.visible.set(true); store.syncLoading.set(true); notify(); expect(activity.mark).not.toHaveBeenCalled();
  store.syncLoading.set(false); store.recoveredSequence.set('9'); notify(); expect(activity.mark).not.toHaveBeenCalled();
  store.recoveredSequence.set('10'); notify(.5); expect(activity.mark).not.toHaveBeenCalled();
  notify(); expect(activity.mark).toHaveBeenCalledExactlyOnceWith('first', '10');
  activity.mark.mockClear(); fixture.componentRef.setInput('channel', channel('second')); fixture.detectChanges();
  notify(); expect(activity.mark).not.toHaveBeenCalled();
});

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

it('connects accessible typing status to input, send and blur without replacing the draft', () => {
  const { fixture, element, composer, fill } = setup();
  typing.notice.set('Alice is typing�'); fixture.detectChanges();
  expect(element.querySelector('.typing')?.getAttribute('role')).toBe('status');
  expect(element.querySelector('.typing')?.textContent).toBe('Alice is typing�');
  fill('a private draft'); expect(typing.input).toHaveBeenLastCalledWith('a private draft');
  composer.dispatchEvent(new Event('blur')); expect(typing.stop).toHaveBeenCalled();
  expect(composer.value).toBe('a private draft');
  typing.stop.mockClear(); element.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
  expect(typing.stop).toHaveBeenCalledOnce();
});
