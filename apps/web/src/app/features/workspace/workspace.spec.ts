import { Component, input, output, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, expect, it } from 'vitest';
import type { PublicChannel } from '@real-time-chat/contracts/channels';
import { SessionStore } from '../../core/session.store';
import { RealtimeConnection } from '../../core/realtime-connection';
import { ChannelList } from '../channels/channel-list';
import { Chat } from '../chat/chat';
import { Workspace } from './workspace';

const channel: PublicChannel = { id: 'first', name: 'First', slug: 'first', isMember: true, createdAt: '2026-10-18T00:00:00Z' };
@Component({ selector: 'app-channel-list', template: '<h2 id="channels-title" tabindex="-1">Channels</h2><button (click)="opened.emit(channel)">Open chat</button>' })
class ChannelListStub { readonly opened = output<PublicChannel>(); readonly left = output<string>(); readonly channel = channel; }
@Component({ selector: 'app-chat', template: '<button (click)="closed.emit()">Close conversation</button>' })
class ChatStub { readonly channel = input.required<PublicChannel>(); readonly closed = output<void>(); }
afterEach(() => TestBed.resetTestingModule());

it('removes the closed conversation before returning focus to the directory', () => {
  TestBed.configureTestingModule({ imports: [Workspace], providers: [provideRouter([]), {
    provide: SessionStore, useValue: { session: signal({ user: { displayName: 'Reader', email: 'reader@example.test' } }), status: signal('authenticated') },
  }] }).overrideComponent(Workspace, {
    remove: { imports: [Chat, ChannelList], providers: [RealtimeConnection] },
    add: { imports: [ChatStub, ChannelListStub], providers: [{ provide: RealtimeConnection, useValue: { status: signal('connected') } }] },
  });
  const fixture = TestBed.createComponent(Workspace); fixture.detectChanges();
  const element: HTMLElement = fixture.nativeElement;
  const open = Array.from(element.querySelectorAll('button')).find(button => button.textContent === 'Open chat')!;
  open.click(); fixture.detectChanges();
  let conversationAtFocus: Element | null | undefined;
  element.querySelector('#channels-title')!.addEventListener('focus', () => { conversationAtFocus = element.querySelector('app-chat'); });
  element.querySelector<HTMLButtonElement>('app-chat button')!.click(); fixture.detectChanges();
  expect(document.activeElement).toBe(element.querySelector('#channels-title'));
  expect(conversationAtFocus).toBeNull();
  open.click(); fixture.detectChanges(); expect(element.querySelector('app-chat')).not.toBeNull();
});
