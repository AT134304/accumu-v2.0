// Accumu v2 — 소셜 로그인 버튼 (Google / Kakao / Facebook)
//
// [로그인과 가입이 같은 버튼이다] OAuth 는 첫 방문이면 계정이 생기고 아니면 로그인된다.
//   그래서 로그인 화면과 가입 화면이 이 컴포넌트 하나를 공유한다 — 두 벌로 만들면 문구가 갈라진다.
//
// [★ 소셜로는 관리자가 될 수 없다] 이 버튼이 만드는 계정은 언제나 학생·개인 계정이다.
//   판정은 화면이 아니라 DB 트리거(handle_new_user)의 소셜 분기가 하므로, 여기에 role 을 넘길 자리가 없다.
//
// [로고를 이모지나 외부 이미지로 쓰지 않는다] CLAUDE.md 8장(이모지 금지) + 외부 요청 0개 원칙.
//   각 브랜드 마크는 공식 색값을 그대로 쓴 인라인 SVG 다(duotone 아이콘 체계와 별개 — 브랜드 자산이라
//   currentColor 로 칠하면 안 된다). 그래서 Icon.jsx 레지스트리에 넣지 않고 이 파일이 소유한다.
import { useState } from 'react';
import { SOCIAL_PROVIDERS, signInWithProvider } from '../lib/authService';
import '../styles/Social.css';

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.44c-.28 1.48-1.12 2.73-2.38 3.58v2.98h3.86c2.26-2.09 3.57-5.17 3.57-8.8z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-2.98c-1.07.72-2.45 1.15-4.07 1.15-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.3 7.31 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.3a7.18 7.18 0 0 1 0-4.6V6.61H1.29A11.99 11.99 0 0 0 0 12c0 1.94.46 3.77 1.29 5.39l3.98-3.09z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.61l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z"
      />
    </svg>
  );
}

function KakaoMark() {
  // 카카오톡 말풍선. 버튼 배경이 카카오 옐로(#FEE500)라 마크는 브랜드 규정대로 검정으로 둔다.
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#191919"
        d="M12 3C6.48 3 2 6.48 2 10.8c0 2.79 1.86 5.24 4.66 6.63-.15.53-.97 3.35-1 3.57 0 0-.02.17.09.23.11.06.24.01.24.01.32-.04 3.7-2.42 4.29-2.83.56.08 1.13.12 1.72.12 5.52 0 10-3.48 10-7.73S17.52 3 12 3z"
      />
    </svg>
  );
}

function FacebookMark() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12.07C24 5.44 18.63.07 12 .07S0 5.44 0 12.07c0 5.99 4.39 10.95 10.13 11.85v-8.38H7.08v-3.47h3.05V9.43c0-3.01 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.51c-1.49 0-1.96.93-1.96 1.87v2.25h3.33l-.53 3.47h-2.8v8.38C19.61 23.02 24 18.06 24 12.07z"
      />
    </svg>
  );
}

const MARKS = { google: GoogleMark, kakao: KakaoMark, facebook: FacebookMark };

/**
 * @param {string} [label] 버튼 위 구분선 문구. 기본값은 로그인/가입 양쪽에 다 맞는 중립 표현.
 */
export default function SocialButtons({ label = '또는 소셜 계정으로 계속하기' }) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function handleClick(provider) {
    if (busy) return;
    setBusy(provider);
    setError('');
    try {
      // 성공하면 제공자 화면으로 페이지가 통째로 이동한다 — 여기서 busy 를 풀 필요가 없다.
      await signInWithProvider(provider);
    } catch (err) {
      // 제공자가 Supabase 대시보드에서 비활성이면 여기로 온다. 사용자가 고칠 수 없는 설정 문제라
      // "다시 시도"라고만 말하지 않는다(운영자가 곧 시연자다).
      console.error('[SocialButtons] 소셜 로그인 시작 실패:', err);
      setError('이 로그인 방식이 아직 설정되지 않았어요. Supabase에서 해당 제공자를 활성화해주세요.');
      setBusy('');
    }
  }

  return (
    <div className="socialbox">
      <div className="sdiv">
        <span>{label}</span>
      </div>
      <div className="srow">
        {SOCIAL_PROVIDERS.map((p) => {
          const Mark = MARKS[p.key];
          return (
            <button
              key={p.key}
              type="button"
              className={`sbtn ${p.key}`}
              disabled={Boolean(busy)}
              onClick={() => handleClick(p.key)}
              aria-label={`${p.label}(으)로 계속하기`}
            >
              {Mark ? <Mark /> : null}
              <span>{busy === p.key ? '이동 중…' : p.label}</span>
            </button>
          );
        })}
      </div>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
