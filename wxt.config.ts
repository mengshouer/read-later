import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';

export default defineConfig({
  // Explicit imports everywhere — no magic auto-imports.
  imports: false,

  vite: () => ({
    plugins: [preact()],
  }),

  manifest: {
    // The manifest is the one place `browser.i18n` is the right tool: these strings
    // are rendered by the browser and cannot be re-rendered at runtime, so they
    // follow the browser UI language. Everything inside the extension uses the
    // runtime catalogue in `utils/i18n.ts`, which the user can switch by hand.
    default_locale: 'en',
    name: '__MSG_name__',
    description: '__MSG_description__',
    permissions: [
      'contextMenus',
      'storage',
      'activeTab',
      'scripting',
      'favicon',
      'sidePanel',
      // One daily tick to ask whether a subscribed filter list is past its own
      // `! Expires:` window. Cleared entirely when auto-update is off everywhere.
      'alarms',
    ],
    // Only requested on demand, when the user subscribes to a list at an http(s) URL.
    // Bundled lists are extension-relative paths and need nothing.
    optional_host_permissions: ['*://*/*'],
    action: {
      default_title: 'Read Later',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // No `suggested_key` anywhere, on purpose. Nothing is bound out of the box; every
    // binding is the user's own, made on `chrome://extensions/shortcuts`.
    //
    // What decided it: a suggested key that is already taken is left silently unassigned by
    // Chrome. No error, no notice — the user presses it and nothing happens. `Alt+S` is an
    // easy combination to collide on, so the old default was one that only sometimes existed,
    // which is worse than no default plus one sentence saying where to set one.
    //
    // `_execute_action` is gone with it rather than kept as an empty entry: the shortcuts
    // page offers an "Activate the extension" binding for any extension with an action, so
    // declaring the reserved name with no suggested key would carry no information.
    commands: {
      'save-current-tab': {
        description: '__MSG_commandSaveCurrentTab__',
      },
    },
  },
});
