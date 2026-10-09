import type { Routes } from '@angular/router';
import { Overview } from './features/overview/overview';
import { Register } from './features/auth/register';
import { Login } from './features/auth/login';
import { Workspace } from './features/workspace/workspace';
import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', component: Overview, title: 'Overview · Real-time Chat' },
  { path: 'register', component: Register, title: 'Create account · Real-time Chat' },
  { path: 'login', component: Login, title: 'Sign in · Real-time Chat' },
  { path: 'workspace', component: Workspace, canActivate: [authGuard], title: 'Workspace · Real-time Chat' },
  { path: '**', redirectTo: '' },
];
