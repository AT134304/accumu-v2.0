// Accumu v2 — 인증 상태 전역 관리 (ADR 0001 "3. 인증 상태 관리")
// 전역 상태는 session, profile, loading 3개뿐이라 React Context로 충분 (Redux/Zustand 도입 안 함).
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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

  // 현재 profile 의 id. onAuthStateChange 콜백은 state 를 클로저로 잡으므로 최신 값을 ref 로 읽는다
  // (같은 사용자의 토큰 갱신 이벤트마다 profiles 를 다시 조회하지 않기 위한 가드).
  const profileIdRef = useRef(null);
  useEffect(() => {
    profileIdRef.current = profile?.id ?? null;
  }, [profile]);

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

      const userId = nextSession?.user?.id;
      if (!userId) {
        setProfile(null);
        return;
      }

      // [소셜 로그인 때문에 필요한 분기]
      //   이메일/학번 로그인은 signIn* 함수가 profile 을 함께 세팅한다. 그런데 소셜 로그인은
      //   제공자 화면에서 리다이렉트로 돌아오며 여기서만 세션이 생긴다 — 로그인 함수를 타지 않는다.
      //   그때 profile 을 읽지 않으면 ProtectedRoute 가 "프로필 없음"으로 보고 /login 으로 되돌려
      //   무한히 로그인 화면만 뜬다.
      //   [async 콜백을 쓰지 않는다] onAuthStateChange 콜백 안에서 await 하면 supabase-js 내부 락과
      //   교착이 생길 수 있어 then 으로 뺀다(공식 문서 권고).
      if (profileIdRef.current === userId) return;
      fetchProfile(userId).then((p) => {
        if (isMounted && p) setProfile(p);
      });
    });

    return () => {
      isMounted = false;
      listener?.subscription?.unsubscribe();
    };
  }, []);

  // school 은 학교 계정 로그인의 4번째 대조 항목이다(2026-08-14). 개인 계정 경로는 이 함수를 타지 않는다.
  const signInStudent = useCallback(async ({ studentId, name, password, school }) => {
    const p = await loginStudent({ studentId, name, password, school });
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

  // 서버가 방금 돌려준 값으로 전역 profile 을 즉시 덮는다 (docs/specs/student-archive-mypage.md 이슈 3).
  //
  // [refreshProfile 과의 차이 — 재조회를 아끼려는 최적화가 아니다]
  //   전환 RPC(convert_points_to_currency)와 계열 RPC(set_career_interest)는 갱신된 값을 응답에 실어 준다.
  //   그 값이 곧 방금 커밋된 서버 상태이므로 한 번 더 select 할 이유가 없다. 반대로 응답을 버리고
  //   재조회하면 그 사이에 다른 탭이 만든 변화가 섞여 "내가 방금 한 전환의 결과"가 아닌 값이 뜰 수 있다.
  // [프런트가 계산한 값을 넣지 않는다] 인자는 언제나 서버 응답에서 꺼낸 필드여야 한다.
  //   balance - amount 같은 계산을 넣는 순간 절대 원칙 3("표시만 한다")이 화면 코드로 넘어온다.
  const applyProfilePatch = useCallback((patch) => {
    if (!patch) return;
    setProfile((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const value = useMemo(
    () => ({
      session,
      profile,
      loading,
      signInStudent,
      signInAdmin,
      signOut,
      refreshProfile,
      applyProfilePatch,
    }),
    [session, profile, loading, signInStudent, signInAdmin, signOut, refreshProfile, applyProfilePatch]
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
