import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import { SessionStore } from './session.store';

export const authGuard: CanActivateFn = () => {
  const router = inject(Router);
  return inject(SessionStore).restore().pipe(
    map(session => session ? true : router.createUrlTree(['/login'], { queryParams: { reason: 'required' } })),
    catchError(() => of(router.createUrlTree(['/login'], { queryParams: { reason: 'unavailable' } }))),
  );
};
