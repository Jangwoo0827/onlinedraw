import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, onAuthStateChanged, signInAnonymously, type Auth } from 'firebase/auth';
import { connectDatabaseEmulator, getDatabase, type Database } from 'firebase/database';
import { emulatorHost, firebaseConfig, isFirebaseConfigured, useEmulator } from './config';

export interface FirebaseHandles {
  auth: Auth;
  db: Database;
}

/** Firebase 설정이 없으면 null (로컬 모드) */
export function createFirebase(): FirebaseHandles | null {
  if (!isFirebaseConfigured) return null;
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getDatabase(app);
  if (useEmulator) {
    connectAuthEmulator(auth, `http://${emulatorHost}:9099`, { disableWarnings: true });
    connectDatabaseEmulator(db, emulatorHost, 9000);
  }
  return { auth, db };
}

/** 익명 로그인. 같은 브라우저에서는 uid 가 유지된다. */
export async function signInAnon(auth: Auth): Promise<string> {
  await auth.authStateReady();
  if (!auth.currentUser) await signInAnonymously(auth);
  const user = auth.currentUser;
  if (!user) {
    // 드물게 상태 전파가 늦는 경우
    return new Promise((resolve) => {
      const off = onAuthStateChanged(auth, (u) => {
        if (u) {
          off();
          resolve(u.uid);
        }
      });
    });
  }
  return user.uid;
}
