// Accumu v2 — 인증 상태 전역 관리 (ADR 0001 "3. 인증 상태 관리")
// 전역 상태는 session, profile, loading 3개뿐이라 React Context로 충분 (Redux/Zustand 도입 안 함).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { loginStudent, loginAdmin, logout as logoutService } from '../lib/authService';

const AuthContext = createContext(undefined);

async function fetchProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) return null;
  return data;
}

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // 마운트 시 세션 복구 + onAuthStateChange 구독 (이름/role 불일치로 인한 강제 signOut 등 반영)
  useEffect(() => {
    let isMounted = true;

    async function init() {
      const { data } = await supabase.auth.getSession();
      if (!isMounted) return;

      const currentSession = data?.session ?? null;
      setSession(currentSession);

      if (currentSession?.user) {
        const p = await fetchProfile(currentSession.user.id);
        if (isMounted) setProfile(p);
      }

      if (isMounted) setLoading(false);
    }

    init();

    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      if (!nextSession?.user) {
        setProfile(null);
      }
    });

    return () => {
      isMounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  const signInStudent = useCallback(async ({ studentId, name, password }) => {
    const p = await loginStudent({ studentId, name, password });
    const { data } = await supabase.auth.getSession();
    setSession(data?.session ?? null);
    setProfile(p);
    return p;
  }, []);

  const signInAdmin = useCallback(async ({ code, password }) => {
    const p = await loginAdmin({ code, password });
    const { data } = await supabase.auth.getSession();
    setSession(data?.session ?? null);
    setProfile(p);
    return p;
  }, []);

  const signOut = useCallback(async () => {
    await logoutService();
    setSession(null);
    setProfile(null);
  }, []);

  // 본인 profiles 행을 다시 읽어 전역 상태를 갱신한다 (profiles_select_own — 새 권한 0개).
  // 필요한 이유: profile 은 로그인/마운트 시 1회만 조회되므로, QR 퇴장 인증으로 서버가
  // points_balance 를 올려도 나브 상단 잔액이 그대로 남는다. 완료 화면에는 "+400P 적립"이
  // 떠 있는데 잔액은 안 변해서 "포인트가 안 들어왔다"로 읽힌다(새로고침해야 반영).
  // 포인트를 프런트가 계산해 덮어쓰는 게 아니라 서버 값을 다시 읽는 것이다 (절대 원칙 3).
  const refreshProfile = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    const userId = data?.session?.user?.id;
    if (!userId) return null;
    const p = await fetchProfile(userId);
    if (p) setProfile(p);
    return p;
  }, []);

  const value = useMemo(
    () => ({ session, profile, loading, signInStudent, signInAdmin, signOut, refreshProfile }),
    [session, profile, loading, signInStudent, signInAdmin, signOut, refreshProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth()는 AuthProvider 내부에서만 사용할 수 있습니다.');
  }
  return ctx;
}
