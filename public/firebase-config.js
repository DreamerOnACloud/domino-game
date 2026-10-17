// Firebase web config.
//
// In production this is public information (it ships in the page) — it is NOT a
// secret, and access control lives entirely in firestore.rules.
//
// Fill these in from the Firebase console: Project settings → Your apps → Web
// app → SDK setup and configuration. Until then the app still runs against the
// local emulator, which ignores these values.
export const FIREBASE_CONFIG = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'dominoes-demo',
  appId: 'REPLACE_ME',
};

// Set to false to force the emulator off (e.g. testing against production from
// localhost). By default, localhost means the emulators.
export const USE_EMULATORS = ['localhost', '127.0.0.1', ''].includes(location.hostname);
