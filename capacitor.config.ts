import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The store wrapper (spec §1, §8). The shell loads the same deployed Next.js
 * app the browser does — so a change to a stage form or a customer phrase
 * appears in the app without a store submission, and only native changes
 * (plugins, permissions, icons) need a release.
 *
 * `server.url` is what makes that true. The alternative — bundling a static
 * export inside the app — would mean shipping a new build through review every
 * time a field changed, which is exactly the maintenance cost the single-source
 * rule exists to avoid.
 *
 * To create the native projects (needs Xcode on macOS and Android Studio, so
 * this is a step on a developer machine, not on the server):
 *
 *   npm install @capacitor/core @capacitor/cli @capacitor/ios @capacitor/android
 *   npm install @capacitor/push-notifications @capacitor/camera \
 *               @capacitor/preferences @capacitor/share @capacitor/app
 *   npx cap add ios
 *   npx cap add android
 *   npx cap sync
 *
 * Then set APP_URL below to the production origin before building for release.
 */
const APP_URL = process.env.CAPACITOR_APP_URL ?? 'https://solarflow.integratesun.com';

const config: CapacitorConfig = {
  appId: 'com.integratesun.solarflow',
  appName: 'SolarFlow',
  // Not used when server.url is set, but Capacitor requires it to exist.
  webDir: 'public',

  // Marks every request from the native shell, so the server can keep this app
  // to the homeowner's portal and nothing else. The app is for customers: a
  // staff member who signs in here gets told to use a browser rather than being
  // handed the pipeline on a phone screen it was never designed for.
  appendUserAgent: 'SolarFlowApp/1',

  server: {
    // '/portal' rather than the site root: the root is a router that sends an
    // unauthenticated visitor to the *staff* login door, which is the wrong
    // first screen for an app that only ever belongs to a homeowner.
    url: `${APP_URL.replace(/\/+$/, '')}/portal`,
    // No cleartext, ever: the Android network config must not permit it and
    // certificate validation stays on (spec §6).
    cleartext: false,
    androidScheme: 'https',
    // Only our own origin loads in the shell; anything else opens in the
    // system browser, which is what keeps a phishing link out of the WebView.
    allowNavigation: [new URL(APP_URL).host],
  },

  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: true,
  },

  android: {
    allowMixedContent: false,
    captureInput: true,
  },

  plugins: {
    PushNotifications: {
      // The push permission prompt is asked for by the app at the right moment
      // (spec §4), never automatically at launch.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
    SplashScreen: {
      backgroundColor: '#0b1b33',
      showSpinner: false,
      launchAutoHide: true,
      launchShowDuration: 600,
    },
  },
};

export default config;
