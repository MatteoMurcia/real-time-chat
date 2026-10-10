import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { LoginRequest, PublicUser, RegistrationRequest, SessionResponse } from '@real-time-chat/contracts/auth';
import { map, switchMap, timeout } from 'rxjs';

function readUser(body: unknown): PublicUser {
  const user = body && typeof body === 'object' && 'user' in body ? body.user : null;
  if (!user || typeof user !== 'object'
    || !['id', 'email', 'displayName', 'createdAt'].every(key => typeof (user as Record<string, unknown>)[key] === 'string')) {
    throw new Error('Invalid user response');
  }
  const { id, email, displayName, createdAt } = user as PublicUser;
  return { id, email, displayName, createdAt };
}

function readSession(body: unknown): SessionResponse {
  const user = readUser(body);
  if (!body || typeof body !== 'object' || !('expiresAt' in body)
    || typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) throw new Error('Invalid session response');
  return { user, expiresAt: body.expiresAt };
}

@Injectable({ providedIn: 'root' })
export class AuthClient {
  private readonly http = inject(HttpClient);

  register(input: RegistrationRequest) {
    return this.post('/api/auth/register', input).pipe(map(body => { readUser(body); }));
  }

  login(input: LoginRequest) {
    return this.post('/api/auth/login', input).pipe(map(readSession));
  }

  me() {
    return this.http.get<unknown>('/api/auth/me').pipe(timeout(5000), map(readSession));
  }

  private post(url: string, input: RegistrationRequest | LoginRequest) {
    return this.http.get<unknown>('/api/auth/csrf').pipe(
      switchMap(body => {
        if (!body || typeof body !== 'object' || !('csrfToken' in body)
          || typeof body.csrfToken !== 'string' || !/^[a-f0-9]{64}\.[0-9]{10}\.[a-f0-9]{64}$/.test(body.csrfToken)) {
          throw new Error('Invalid CSRF response');
        }
        return this.http.post<unknown>(url, input, { headers: { 'X-CSRF-Token': body.csrfToken } });
      }),
      timeout(15000),
    );
  }
}
