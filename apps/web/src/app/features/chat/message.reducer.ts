import type { PublicMessage, SendMessageRequest } from '@real-time-chat/contracts/messages';

export interface Outgoing {
  request: SendMessageRequest;
  state: 'pending' | 'unconfirmed' | 'rejected';
  attempt: number;
}
export interface MessageState { messages: PublicMessage[]; outgoing: Outgoing[] }
type Action = { type: 'queue' | 'retry'; request: SendMessageRequest }
  | { type: 'unconfirmed' | 'rejected'; request: SendMessageRequest; attempt: number }
  | { type: 'confirm'; message: PublicMessage; userId: string | undefined }
  | { type: 'disconnect' };

export function reduceMessages(state: MessageState, action: Action): MessageState {
  switch (action.type) {
    case 'queue': return { ...state, outgoing: [...state.outgoing, { request: action.request, state: 'pending', attempt: 1 }] };
    case 'retry': return { ...state, outgoing: state.outgoing.map(item => item.request === action.request && item.state === 'unconfirmed'
      ? { ...item, state: 'pending', attempt: item.attempt + 1 } : item) };
    case 'unconfirmed':
    case 'rejected': return { ...state, outgoing: state.outgoing.map(item => item.request === action.request && item.attempt === action.attempt && item.state !== 'rejected'
      ? { ...item, state: action.type } : item) };
    case 'disconnect': return { ...state, outgoing: state.outgoing.map(item => item.state === 'pending' ? { ...item, state: 'unconfirmed' } : item) };
    case 'confirm': {
      const message = action.message;
      const messages = state.messages.some(item => item.id === message.id) ? state.messages
        : [...state.messages, message].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
      return { messages, outgoing: state.outgoing.filter(item => !(message.author.id === action.userId
        && item.request.channelId === message.channelId && item.request.clientMessageId === message.clientMessageId && item.request.body === message.body)) };
    }
  }
}
