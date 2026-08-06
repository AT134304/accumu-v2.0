// Accumu v2 — 구글 로그인 콜백 (/auth/google)
//
// 구글이 code + state 를 붙여 이 주소로 돌려보낸다. 여기서 Edge Function 을 호출해 세션으로 바꾼다.
// NaverCallbackPage 와 같은 모양이다 — 두 제공자를 같은 경로로 통일한 결과다(ADR 0011).
//
// [★ code 는 1회용이다] React StrictMode 는 개발 모드에서 effect 를 두 번 실행하는데, 두 번째 교환은
//   반드시 실패한다("이미 사용된 코드"). ran ref 로 첫 실행만 통과시킨다 — 이 가드를 지우면
//   개발 중에는 항상 실패하고 프로덕션에서만 되는, 가장 헷갈리는 형태의 버그가 된다.
//
// [실패해도 화면이 죽지 않는다] 사유별 문구 + 로그인 화면으로 돌아가는 길을 남긴다.
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { completeGoogleLogin, googleReasonText } from '../lib/authService';
import '../styles/Social.css';

export default function GoogleCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();
  const [error, setError] = useState('');
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      // 사용자가 구글 화면에서 취소하면 code 대신 error 가 온다.
      if (params.get('error')) {
        setError(googleReasonText(params.get('error') === 'access_denied' ? 'denied' : 'unknown'));
        return;
      }

      const result = await completeGoogleLogin({
        code: params.get('code'),
        state: params.get('state'),
      });

      if (!result.ok) {
        setError(googleReasonText(result.reason));
        return;
      }

      // 세션은 생겼지만 전역 profile 은 비어 있다(로그인 함수를 타지 않았다).
      // 채우지 않으면 ProtectedRoute 가 "프로필 없음"으로 보고 /login 으로 되돌린다.
      await refreshProfile();
      // 구글 계정은 언제나 학생이다(Edge Function + 트리거가 그렇게 고정한다).
      navigate('/student', { replace: true });
    })();
  }, [params, refreshProfile, navigate]);

  return (
    <div className="social-callback">
      <div className="box">
        {error ? (
          <>
            <h2>로그인하지 못했어요</h2>
            <p>{error}</p>
            <Link className="back" to="/login">
              로그인 화면으로
            </Link>
          </>
        ) : (
          <>
            <h2>구글 계정으로 로그인 중…</h2>
            <p>잠시만 기다려 주세요.</p>
          </>
        )}
      </div>
    </div>
  );
}
