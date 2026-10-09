import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { RegistrationRequest } from '@real-time-chat/contracts/auth';
import { map, switchMap, timeout } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class AuthClient {
  private readonly http = inject(HttpClient);

  register(input: RegistrationRequest) {
    return this.http.get<unknown>('/api/auth/csrf').pipe(
      switchMap(body => {
        if (!body || typeof body !== 'object' || !('csrfToken' in body)
          || typeof body.csrfToken !== 'string' || !/^[a-f0-9]{64}\.[0-9]{10}\.[a-f0-9]{64}$/.test(body.csrfToken)) {
          throw new Error('Invalid CSRF response');
        }
        return this.http.post<unknown>('/api/auth/register', input, { headers: { 'X-CSRF-Token': body.csrfToken } });
      }),
      map(body => {
        const user = body && typeof body === 'object' && 'user' in body ? body.user : null;
        if (!user || typeof user !== 'object'
          || !['id', 'email', 'displayName', 'createdAt'].every(key =>
            typeof (user as Record<string, unknown>)[key] === 'string')) {
          throw new Error('Invalid registration response');
        }
      }),
      timeout(15000),
    );
  }
}
