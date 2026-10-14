const env = import.meta.env;

/** 로컬 에뮬레이터(firebase emulators)를 쓰는 개발 모드 */
export const useEmulator = env.VITE_FIREBASE_EMULATOR === '1';

export const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY || (useEmulator ? 'fake-api-key' : ''),
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
  // 에뮬레이터에서는 호스트가 따로 지정되므로 형식만 맞는 가짜 주소면 된다
  databaseURL: env.VITE_FIREBASE_DATABASE_URL || (useEmulator ? 'https://demo-onlinedraw-default-rtdb.firebaseio.com' : ''),
  projectId: env.VITE_FIREBASE_PROJECT_ID || (useEmulator ? 'demo-onlinedraw' : ''),
  appId: env.VITE_FIREBASE_APP_ID || (useEmulator ? 'demo-app' : ''),
};

/** 설정값이 없으면 앱은 혼자 그리는 로컬 모드로 동작한다. */
export const isFirebaseConfigured =
  useEmulator || Boolean(firebaseConfig.apiKey && firebaseConfig.databaseURL && firebaseConfig.projectId);

export const emulatorHost: string = env.VITE_FIREBASE_EMULATOR_HOST || location.hostname;
