// Firebase web config (public information — it ships in the page).
// Access control lives in firestore.rules, never in these values.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBA3V3vIGz0IYoiWurafeLTNuosf73Qud8",
  authDomain: "domino-game-f61dc.firebaseapp.com",
  projectId: "domino-game-f61dc",
  appId: "1:823508963902:web:5d79b82645e60e49b8376f",
  messagingSenderId: "823508963902",
  storageBucket: "domino-game-f61dc.firebasestorage.app",
};

// localhost means the emulators; the deployed site uses real Firebase.
export const USE_EMULATORS = ['localhost', '127.0.0.1', ''].includes(location.hostname);
