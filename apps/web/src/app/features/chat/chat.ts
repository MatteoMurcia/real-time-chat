import { afterNextRender, afterRenderEffect, ChangeDetectionStrategy, Component, effect, ElementRef, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import type { PublicChannel } from '@real-time-chat/contracts/channels';
import { ChatStore } from './chat.store';

@Component({
  selector: 'app-chat',
  imports: [DatePipe, ReactiveFormsModule],
  providers: [ChatStore],
  templateUrl: './chat.html',
  styleUrl: './chat.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Chat {
  readonly channel = input.required<PublicChannel>();
  readonly closed = output<void>();
  protected readonly store = inject(ChatStore);
  protected readonly draft = new FormControl('', { nonNullable: true });
  protected readonly following = signal(true);
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    effect(() => {
      const channelId = this.channel().id;
      untracked(() => { this.store.open(channelId); this.draft.reset(); this.following.set(true); });
    });
    afterNextRender(() => this.element.nativeElement.querySelector<HTMLElement>('#conversation-title')?.focus());
    afterRenderEffect(() => {
      this.store.messages(); this.store.outgoing();
      if (untracked(this.following)) this.scrollToLatest();
    });
  }

  protected send(): void {
    if (this.store.send(this.draft.value)) this.draft.reset();
  }

  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); this.send(); }
  }

  protected scrollToLatest(): void {
    const log = this.element.nativeElement.querySelector<HTMLElement>('.messages');
    if (log) log.scrollTop = log.scrollHeight;
    this.following.set(true);
  }

  protected onScroll(event: Event): void {
    const log = event.target as HTMLElement;
    this.following.set(log.scrollHeight - log.scrollTop - log.clientHeight < 40);
  }
}
