// Accumu v2 — 로그인 화면 (docs/specs/auth-login.md, Accumu_prototype.html 디자인 참고)
import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../styles/LoginPage.css';

const emptyStudentForm = { studentId: '', name: '', password: '' };
const emptyAdminForm = { code: '', password: '' };

function LogoMark() {
  // Accumu_prototype.html #ic-logo 심볼 그대로 재사용 (누적되는 막대, 단색 블루 톤)
  return (
    <svg style={{ width: 54, height: 50 }} viewBox="0 0 32 30" aria-hidden="true">
      <rect x="2" y="19" width="5.4" height="9" rx="2.1" fill="#BCD0FF" />
      <rect x="9" y="14" width="5.4" height="14" rx="2.1" fill="#7098EE" />
      <rect x="16" y="9" width="5.4" height="19" rx="2.1" fill="#3463DA" />
      <rect x="23" y="3" width="5.4" height="25" rx="2.1" fill="#16213E" />
    </svg>
  );
}

export default function LoginPage() {
  const { session, profile, loading, signInStudent, signInAdmin } = useAuth();
  const [tab, setTab] = useState('student');
  const [studentForm, setStudentForm] = useState(emptyStudentForm);
  const [adminForm, setAdminForm] = useState(emptyAdminForm);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 이미 로그인 + role 확정 상태면 즉시 자기 role 홈으로 리다이렉트 (ADR 0001 라우트 테이블)
  if (!loading && session && profile) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  function switchTab(nextTab) {
    if (nextTab === tab) return;
    setTab(nextTab);
    setStudentForm(emptyStudentForm);
    setAdminForm(emptyAdminForm);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);

    try {
      if (tab === 'student') {
        await signInStudent({
          studentId: studentForm.studentId,
          name: studentForm.name,
          password: studentForm.password,
        });
      } else {
        await signInAdmin({ code: adminForm.code, password: adminForm.password });
      }
    } catch (err) {
      setError(err.message || '로그인 중 오류가 발생했습니다.');
      // 에러 시 비밀번호 필드만 초기화 (학번/이름/코드는 유지)
      if (tab === 'student') {
        setStudentForm((f) => ({ ...f, password: '' }));
      } else {
        setAdminForm((f) => ({ ...f, password: '' }));
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div id="login">
      <div className="lcard">
        <div className="top">
          <LogoMark />
          <h1>
            Accu<b>mu</b>
          </h1>
          <div className="tag">참여가 쌓여 나의 커리어가 됩니다</div>
        </div>

        <div className="tabs" role="tablist" aria-label="로그인 유형">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'student'}
            className={tab === 'student' ? 'active' : ''}
            onClick={() => switchTab('student')}
          >
            학생
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'admin'}
            className={tab === 'admin' ? 'active' : ''}
            onClick={() => switchTab('admin')}
          >
            관리자
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          {tab === 'student' ? (
            <>
              <div className="field">
                <label htmlFor="in-sid">학번</label>
                <input
                  id="in-sid"
                  placeholder="예: 10718"
                  value={studentForm.studentId}
                  autoComplete="username"
                  onChange={(e) =>
                    setStudentForm((f) => ({ ...f, studentId: e.target.value }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="in-name">이름</label>
                <input
                  id="in-name"
                  placeholder="이름을 입력하세요"
                  value={studentForm.name}
                  onChange={(e) => setStudentForm((f) => ({ ...f, name: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="in-pw">비밀번호</label>
                <input
                  id="in-pw"
                  type="password"
                  placeholder="비밀번호"
                  value={studentForm.password}
                  autoComplete="current-password"
                  onChange={(e) =>
                    setStudentForm((f) => ({ ...f, password: e.target.value }))
                  }
                />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label htmlFor="in-code">관리자 코드</label>
                <input
                  id="in-code"
                  placeholder="예: ADM-0001"
                  value={adminForm.code}
                  autoComplete="username"
                  onChange={(e) => setAdminForm((f) => ({ ...f, code: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="in-admin-pw">비밀번호</label>
                <input
                  id="in-admin-pw"
                  type="password"
                  placeholder="비밀번호"
                  value={adminForm.password}
                  autoComplete="current-password"
                  onChange={(e) =>
                    setAdminForm((f) => ({ ...f, password: e.target.value }))
                  }
                />
              </div>
            </>
          )}

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? (
              '로그인 중…'
            ) : (
              <>
                로그인 <span>→</span>
              </>
            )}
          </button>
        </form>

        <div className="hint">Accumu — 참여·인증 기반 커리어 포트폴리오</div>
      </div>
    </div>
  );
}
