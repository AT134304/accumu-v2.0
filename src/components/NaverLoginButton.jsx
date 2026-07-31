// Accumu v2 — 네이버 로그인 버튼 (로그인/가입 화면 공용)
//
// [로그인과 가입이 같은 버튼이다] 첫 방문이면 계정이 생기고 아니면 로그인된다. 두 화면이 이 하나를 쓴다.
//
// [★ 이 버튼이 만드는 계정은 언제나 학생 · 개인 계정이다] 판정은 화면이 아니라 Edge Function 과
//   DB 트리거가 한다(role/초대코드를 넘길 자리가 없다). 그래서 관리자 탭·학교 계정에는 두지 않는다.
//
// [설정 전에는 버튼을 비활성으로 둔다] 없는 기능을 눌리게 두고 실패 문구를 띄우는 것보다,
//   "아직 설정되지 않았다"를 미리 말하는 편이 정직하다(CLAUDE.md — 없는 것을 지어내지 않는다).
import { useState } from 'react';
import { isNaverConfigured, startNaverLogin } from '../lib/authService';
import '../styles/Naver.css';

function NaverMark() {
  // 네이버 브랜드 마크(N). 브랜드 자산이라 duotone/currentColor 체계를 쓰지 않고 흰색 고정이다.
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path fill="#fff" d="M14.02 12.66 9.72 6.4H6v11.2h3.98v-6.26l4.3 6.26H18V6.4h-3.98v6.26z" />
    </svg>
  );
}

export default function NaverLoginButton({ label = '네이버로 계속하기' }) {
  const configured = isNaverConfigured();
  const [busy, setBusy] = useState(false);

  function handleClick() {
    if (busy || !configured) return;
    setBusy(true);
    try {
      // 성공하면 페이지가 네이버로 통째로 이동한다 — busy 를 풀 필요가 없다.
      startNaverLogin();
    } catch (err) {
      console.error('[NaverLoginButton] 네이버 로그인 시작 실패:', err);
      setBusy(false);
    }
  }

  return (
    <div className="naverbox">
      <div className="ndiv">
        <span>또는</span>
      </div>
      <button type="button" className="nbtn" onClick={handleClick} disabled={busy || !configured}>
        <NaverMark />
        <span>{busy ? '이동 중…' : label}</span>
      </button>
      {!configured && (
        <div className="nnote">
          네이버 로그인은 아직 설정되지 않았어요. <code>VITE_NAVER_CLIENT_ID</code>를 채우면 활성화됩니다.
        </div>
      )}
    </div>
  );
}
