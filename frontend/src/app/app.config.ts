import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withInterceptors, withXhr } from '@angular/common/http';
import { provideAnimations } from '@angular/platform-browser/animations';

import { hopAuthInterceptor } from '@heretto/hop-ui';
import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    // hop-ui components need Zone.js change detection (hop-core AGENTS.md §7).
    provideZoneChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withXhr(), withInterceptors([hopAuthInterceptor])),
    provideAnimations(),
  ],
};
