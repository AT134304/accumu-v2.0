// Accumu v2 — 비밀번호 재설정 완료 (/auth/reset-password, ADR 0020)
//
// [개인 계정(실제 이메일) 전용] requestPasswordReset()이 보낸 링크가 돌아오는 곳이다. 학교/관리자
// 계정은 이 경로로 오지 않는다(애초에 이메일이 없어 링크 자체를 못 받는다 — ADR 0019/0020 배경).
//
// [세션은 Supabase 클라이언트가 이미 만들어 놨다] 이메일 링크의 recovery 토큰은 페이지가 로드되는
// 순간 supabase-js가 URL에서 자동으로 읽어 세션으로 바꾼다(detectSessionInUrl, 기본값). 이 화면은
// 그 세션이 있는지 확인만 하고, 새 비밀번호는 마이페이지와 같은 함수(updateMyPassword)로 반영한다
// — "로그인된 상태에서 비밀번호를 바꾼다"는 점에서 둘은 같은 동작이다.
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { updateMyPassword } from '../lib/authService';
import { useAuth } from '../context/AuthContext';
import '../styles/LoginPage.css';

const MIN_LENGTH = 6;

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { refreshProfile } = useAuth();

  // 'checking' | 'ready' | 'invalid' | 'done'
  const [state, setState] = useState('checking');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    // [즉시 확인 + 이벤트 둘 다] supabase-js가 URL의 토큰을 비동기로 처리하므로, 마운트 즉시 확인하면
    // 아직 세션이 안 만들어졌을 수 있다 — onAuthStateChange로 늦게 도착하는 경우도 함께 받는다.
    supabase.auth.getSession().then(({ data }) => {
      if (alive && data.session) setState('ready');
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) setState('ready');
    });
    // 몇 초 안에 세션이 안 잡히면 유효하지 않은/만료된 링크로 본다.
    const timer = setTimeout(() => {
      if (alive) setState((s) => (s === 'checking' ? 'invalid' : s));
    }, 4000);
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError('');

    if (pw.length < MIN_LENGTH) {
      setError(`비밀번호는 최소 ${MIN_LENGTH}자 이상이어야 해요.`);
      return;
    }
    if (pw !== pw2) {
      setError('입력한 두 비밀번호가 서로 달라요.');
      return;
    }

    setSaving(true);
    try {
      await updateMyPassword(pw);
      setState('done');
    } catch (err) {
      console.error('[ResetPasswordPage] 비밀번호 변경 실패:', err);
      setError('비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }

  async function handleContinue() {
    await refreshProfile();
    navigate('/student', { replace: true });
  }

  return (
    <div id="login">
      <div className="lcard">
        <div className="top">
          <h1>
            Accu<b>mu</b>
          </h1>
          <div className="tag">새 비밀번호를 설정해 주세요</div>
        </div>

        {state === 'checking' && <p className="hint">링크를 확인하는 중…</p>}

        {state === 'invalid' && (
          <>
            <p className="hint">유효하지 않거나 만료된 링크예요. 로그인 화면에서 다시 요청해 주세요.</p>
            <button className="btn-primary" type="button" onClick={() => navigate('/login')}>
              로그인 화면으로
            </button>
          </>
        )}

        {state === 'ready' && (
          <form onSubmit={handleSubmit}>
            <div className="field">
              <label htmlFor="rp-pw">새 비밀번호</label>
              <input
                id="rp-pw"
                type="password"
                placeholder="새 비밀번호"
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="rp-pw2">새 비밀번호 확인</label>
              <input
                id="rp-pw2"
                type="password"
                placeholder="새 비밀번호 확인"
                autoComplete="new-password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
            </div>
            {error && (
              <div className="form-error" role="alert">
                {error}
              </div>
            )}
            <button className="btn-primary" type="submit" disabled={saving}>
              {saving ? '변경 중…' : '비밀번호 변경'}
            </button>
          </form>
        )}

        {state === 'done' && (
          <>
            <p className="hint">비밀번호가 변경됐어요.</p>
            <button className="btn-primary" type="button" onClick={handleContinue}>
              계속하기 <span>→</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
