import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { Chat } from './chat';
import { ChatStore } from './chat.store';
import { ActivityService } from '../../core/activity.service';
import { TypingStore } from './typing.store';
import { PresenceStore } from './presence.store';

afterEach(() => { TestBed.resetTestingModule(); vi.unstubAllGlobals(); });

it('renders presence as text beside its author, reserves one status and follows subscription changes', () => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  const value = signal('Presence unknown'), ready = signal(true), select = vi.fn();
  const message = { id: 'message', author: { id: 'author', displayName: 'Alice' }, body: 'Hello', createdAt: '2026-10-21T00:00:00Z' };
  const store = { open: vi.fn(), recover: vi.fn(), ready, messages: signal([message]), outgoing: signal([]),
    recoveredSequence: signal('0'), historyLoading: signal(false), syncLoading: signal(false), notice: signal(''),
    liveNotice: signal(''), outgoingNotice: signal(''), olderCursor: signal(null), snapshotCursor: signal(null),
    historyError: signal(''), syncError: signal('') };
  TestBed.configureTestingModule({ imports: [Chat], providers: [{ provide: ActivityService,
    useValue: { visible: signal(true), revision: signal(0), readError: signal(null) } }] })
    .overrideComponent(Chat, { set: { providers: [
      { provide: ChatStore, useValue: store }, { provide: TypingStore, useValue: { open: vi.fn(), notice: signal('') } },
      { provide: PresenceStore, useValue: { select, label: () => value(), notice: signal('Presence unknown.') } },
    ] } });
  const fixture = TestBed.createComponent(Chat);
  const channel = { id: 'first', name: 'First', slug: 'first', isMember: true, createdAt: message.createdAt };
  fixture.componentRef.setInput('channel', channel); fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const badge = element.querySelector('[data-presence-user="author"]')!;
  expect(badge.parentElement?.textContent).toContain('Alice Presence unknown');
  expect(select).toHaveBeenLastCalledWith('first', true, ['author']);
  expect(element.querySelector('.presence-notice')?.getAttribute('role')).toBe('status');
  for (const state of ['Online', 'Offline']) { value.set(state); fixture.detectChanges(); expect(badge.textContent).toBe(state); }
  ready.set(false); fixture.detectChanges(); expect(select).toHaveBeenLastCalledWith('first', false, ['author']);
  fixture.componentRef.setInput('channel', { ...channel, id: 'second' }); fixture.detectChanges();
  expect(select).toHaveBeenLastCalledWith('second', false, ['author']);
});
