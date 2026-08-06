// Accumu v2 — 소셜 로그인 블록 (로그인/가입 화면 공용)
//
// [로그인과 가입이 같은 버튼이다] 첫 방문이면 계정이 생기고 아니면 로그인된다. mode 는 문구만 바꾼다.
//
// [★ 여기 있는 버튼이 만드는 계정은 언제나 학생 · 개인 계정이다]
//   판정은 화면이 아니라 DB 트리거 handle_new_user() 의 (b) 소셜 분기가 한다 — role 을 'student',
//   account_type 을 'personal' 로 고정한다. 네이버는 Edge Function 이, 구글은 Supabase Auth 가
//   계정을 만들지만 둘 다 초대코드를 실을 자리가 없어서 결과가 같다.
//   그래서 이 블록은 **관리자 탭과 학교 계정에는 두지 않는다** (되지 않는 경로를 약속하게 된다).
//
// [설정 전에는 버튼을 비활성으로 둔다] 없는 기능을 눌리게 두고 실패 문구를 띄우는 것보다,
//   "아직 설정되지 않았다"를 미리 말하는 편이 정직하다. 사유도 함께 적는다 — 운영자가 곧 시연자다.
//
// [이 파일이 NaverLoginButton 을 대체했다 — 2026-08-06, ADR 0010]
//   제공자가 둘이 되면서 "또는" 구분선을 누가 그리는가가 문제가 됐다. 버튼마다 그리면 구분선이
//   두 번 나오고, 한쪽만 그리면 그쪽이 꺼졌을 때 사라진다. 블록이 구분선을 소유하는 것이 답이다.
import { useEffect, useState } from 'react';
import {
  isGoogleEnabled,
  isNaverConfigured,
  startGoogleLogin,
  startNaverLogin,
} from '../lib/authService';
import '../styles/Social.css';

function NaverMark() {
  // 네이버 브랜드 마크(N). 브랜드 자산이라 duotone/currentColor 체계를 쓰지 않고 흰색 고정이다.
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="#fff" d="M14.02 12.66 9.72 6.4H6v11.2h3.98v-6.26l4.3 6.26H18V6.4h-3.98v6.26z" />
    </svg>
  );
}

function GoogleMark() {
  // 구글 브랜드 마크(G). 4색 고정이 브랜드 규정이라 색을 앱 팔레트로 바꾸지 않는다(Social.css 상단 참고).
  return (
    <svg viewBox="0 0 48 48" width="17" height="17" aria-hidden="true">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24s.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

export default function SocialLogin({ mode = 'login' }) {
  const verb = mode === 'signup' ? '가입하기' : '로그인';

  // 네이버: 클라이언트 ID 주입 여부라 동기로 알 수 있다.
  const naverReady = isNaverConfigured();
  // 구글: 켜짐 여부를 아는 것은 Supabase 서버다. null = 아직 확인 중.
  const [googleReady, setGoogleReady] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    let alive = true;
    isGoogleEnabled().then((ok) => {
      if (alive) setGoogleReady(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  function handleNaver() {
    if (busy || !naverReady) return;
    setBusy('naver');
    try {
      // 성공하면 페이지가 네이버로 통째로 이동한다 — busy 를 풀 필요가 없다.
      startNaverLogin();
    } catch (err) {
      console.error('[SocialLogin] 네이버 로그인 시작 실패:', err);
      setBusy('');
    }
  }

  async function handleGoogle() {
    if (busy || !googleReady) return;
    setBusy('google');
    try {
      await startGoogleLogin();
    } catch (err) {
      // 여기까지 오면 이동이 시작되지 않은 것이다(제공자 꺼짐·네트워크 등). 버튼을 되살린다.
      console.error('[SocialLogin] 구글 로그인 시작 실패:', err);
      setBusy('');
      setGoogleReady(false);
    }
  }

  return (
    <div className="socialbox">
      <div className="sdiv">
        <span>또는</span>
      </div>

      <button
        type="button"
        className="sbtn sbtn-naver"
        onClick={handleNaver}
        disabled={Boolean(busy) || !naverReady}
      >
        <NaverMark />
        <span>{busy === 'naver' ? '이동 중…' : `네이버로 ${verb}`}</span>
      </button>

      <button
        type="button"
        className="sbtn sbtn-google"
        onClick={handleGoogle}
        disabled={Boolean(busy) || !googleReady}
      >
        <GoogleMark />
        <span>{busy === 'google' ? '이동 중…' : `Google로 ${verb}`}</span>
      </button>

      {!naverReady && (
        <div className="snote">
          네이버 로그인은 아직 설정되지 않았어요. <code>VITE_NAVER_CLIENT_ID</code>를 채우면 활성화됩니다.
        </div>
      )}
      {googleReady === false && (
        <div className="snote">
          구글 로그인은 아직 설정되지 않았어요. Supabase 대시보드의 Authentication → Providers 에서
          Google 을 켜면 활성화됩니다.
        </div>
      )}
    </div>
  );
}
