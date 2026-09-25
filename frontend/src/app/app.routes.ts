import { Routes } from '@angular/router';
import { hopAdminGuard, hopAuthGuard, HOP_AGENT_ROUTES } from '@heretto/hop-ui';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopLoginComponent) },
  { path: 'forgot-password', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopForgotPasswordComponent) },
  { path: 'reset-password', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopResetPasswordComponent) },
  { path: 'auth/sso/complete', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopSSOCallbackComponent) },
  { path: 'invite/:token', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopAcceptInvitationComponent) },
  {
    path: '',
    canActivate: [hopAuthGuard],
    loadComponent: () => import('./shell/shell.component').then(m => m.ShellComponent),
    children: [
      {
        path: 'chat-apps',
        children: [
          { path: '', loadComponent: () => import('./chat-apps/chat-apps.component').then(m => m.ChatAppsComponent) },
          { path: 'new', loadComponent: () => import('./chat-apps/chat-app-editor.component').then(m => m.ChatAppEditorComponent) },
          { path: ':chatAppId', loadComponent: () => import('./chat-apps/chat-app-editor.component').then(m => m.ChatAppEditorComponent) },
        ],
      },
      // hop-core's agent pages: list, 'new', ':agentId'. A chat app's AI is configured here.
      { path: 'agents', children: HOP_AGENT_ROUTES },
      { path: 'credentials', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopCredentialsComponent) },
      { path: 'account', loadComponent: () => import('@heretto/hop-ui').then(m => m.HopAccountComponent) },
      { path: 'admin', canActivate: [hopAdminGuard], loadComponent: () => import('@heretto/hop-ui').then(m => m.HopAdminComponent) },
      { path: 'dashboard', redirectTo: 'chat-apps' },
      { path: '', redirectTo: 'chat-apps', pathMatch: 'full' },
    ],
  },
  { path: '**', redirectTo: '' },
];
