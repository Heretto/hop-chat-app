import { ChangeDetectionStrategy, Component } from '@angular/core';
import { HopMainLayoutComponent, NavItem } from '@heretto/hop-ui';

@Component({
  selector: 'app-shell',
  imports: [HopMainLayoutComponent],
  changeDetection: ChangeDetectionStrategy.Eager,
  template: `<hop-main-layout appTitle="HOP Chat" [navItems]="navItems"></hop-main-layout>`,
})
export class ShellComponent {
  // The layout appends Account / Administration itself.
  navItems: NavItem[] = [
    { label: 'Chat Apps', route: '/chat-apps', icon: 'forum' },
    { label: 'Agents', route: '/agents', icon: 'smart_toy' },
    { label: 'Credentials', route: '/credentials', icon: 'key' },
  ];
}
