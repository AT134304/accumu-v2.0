// Accumu v2 — 로그인 화면 (docs/specs/auth-login.md, Accumu_prototype.html 디자인 참고)
//
// [2026-07-31 개정 — 개인 계정 / 네이버 로그인 (docs/specs/auth-signup.md, ADR 0009)]
//   학생 탭 안에서 **학교 계정 / 개인 계정**이 갈린다. 로그인 수단 자체가 다르기 때문이다:
//     - 학교 계정: 학교 + 학번 + 이름 + 비밀번호 (2026-08-14부터 학교가 4번째 대조 항목이다.
//       가입할 때 학생이 직접 적은 값을 그대로 적으면 통과한다 — 이름 대조와 같은 성격이다.
//       같은 학교의 관리자가 없어도 성립한다: 학교는 관리자 목록과 무관한 값이다)
//     - 개인 계정: 이메일 + 비밀번호 (학번이 없다) 또는 네이버 로그인
//   관리자 탭은 그대로다 — **관리자는 네이버로 로그인할 수 없다.** 네이버로 만들어지는 계정은 언제나
//   학생·개인이므로(Edge Function + 트리거가 고정) 관리자 탭에 두면 되지 않는 경로를 약속하는 셈이다.
import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import SocialLogin from '../components/SocialLogin';
import AccountHelpModal from '../components/AccountHelpModal';
import { loginPersonal } from '../lib/authService';
import '../styles/LoginPage.css';

const emptyStudentForm = { school: '', studentId: '', name: '', password: '' };
const emptyPersonalForm = { email: '', password: '' };
const emptyAdminForm = { code: '', password: '' };

function LogoMark() {
  // Accumu_prototype.html #ic-logo 심볼 그대로 재사용 (누적되는 막대, 단색 블루 톤)
  // 크기는 .lmark 클래스가 가진다 — 인라인 style 이면 모바일 축소를 CSS 로 덮을 수 없다.
  return (
    <svg className="lmark" viewBox="0 0 32 30" aria-hidden="true">
      <rect x="2" y="19" width="5.4" height="9" rx="2.1" fill="#BCD0FF" />
      <rect x="9" y="14" width="5.4" height="14" rx="2.1" fill="#7098EE" />
      <rect x="16" y="9" width="5.4" height="19" rx="2.1" fill="#3463DA" />
      <rect x="23" y="3" width="5.4" height="25" rx="2.1" fill="#16213E" />
    </svg>
  );
}

export default function LoginPage() {
  const { session, profile, loading, signInStudent, signInAdmin, refreshProfile } = useAuth();
  const [tab, setTab] = useState('student');
  const [mode, setMode] = useState('school'); // 학생 탭 안: 'school' | 'personal'
  const [studentForm, setStudentForm] = useState(emptyStudentForm);
  const [personalForm, setPersonalForm] = useState(emptyPersonalForm);
  const [adminForm, setAdminForm] = useState(emptyAdminForm);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // 아이디/비밀번호 찾기 (ADR 0020). 어느 모달인지만 담고, 내용 분기는 AccountHelpModal이 tab/mode로 한다.
  const [helpType, setHelpType] = useState(null); // 'find-id' | 'forgot-password' | null

  // 이미 로그인 + role 확정 상태면 즉시 자기 role 홈으로 리다이렉트 (ADR 0001 라우트 테이블)
  if (!loading && session && profile) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  function switchTab(nextTab) {
    if (nextTab === tab) return;
    setTab(nextTab);
    setStudentForm(emptyStudentForm);
    setPersonalForm(emptyPersonalForm);
    setAdminForm(emptyAdminForm);
    setError('');
  }

  function switchMode(nextMode) {
    if (nextMode === mode) return;
    setMode(nextMode);
    setStudentForm(emptyStudentForm);
    setPersonalForm(emptyPersonalForm);
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;
    setError('');
    setSubmitting(true);

    try {
      if (tab === 'admin') {
        await signInAdmin({ code: adminForm.code, password: adminForm.password });
      } else if (mode === 'personal') {
        // 개인 계정은 이름 대조가 없다 — 이메일 자체가 고유 식별자다.
        await loginPersonal({ email: personalForm.email, password: personalForm.password });
        // loginPersonal 은 서비스 레이어라 전역 상태를 건드리지 않는다. 세션은 생겼으므로 프로필만 채운다.
        await refreshProfile();
      } else {
        await signInStudent({
          school: studentForm.school,
          studentId: studentForm.studentId,
          name: studentForm.name,
          password: studentForm.password,
        });
      }
    } catch (err) {
      setError(err.message || '로그인 중 오류가 발생했습니다.');
      // 에러 시 비밀번호 필드만 초기화 (학번/이름/코드/이메일은 유지)
      if (tab === 'admin') {
        setAdminForm((f) => ({ ...f, password: '' }));
      } else if (mode === 'personal') {
        setPersonalForm((f) => ({ ...f, password: '' }));
      } else {
        setStudentForm((f) => ({ ...f, password: '' }));
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

        {/* 학생 탭 안의 계정 종류 — 로그인 수단이 다르므로 입력 필드가 통째로 바뀐다. */}
        {tab === 'student' && (
          <div className="segrow" role="group" aria-label="계정 종류" style={{ marginBottom: 16 }}>
            <button
              type="button"
              className={mode === 'school' ? 'seg on' : 'seg'}
              aria-pressed={mode === 'school'}
              onClick={() => switchMode('school')}
            >
              학교 계정
            </button>
            <button
              type="button"
              className={mode === 'personal' ? 'seg on' : 'seg'}
              aria-pressed={mode === 'personal'}
              onClick={() => switchMode('personal')}
            >
              개인 계정
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {tab === 'student' && mode === 'school' && (
            <>
              {/* [학교 — 2026-08-14 케빈 요청] 학번 위에 둔다: 넓은 소속에서 좁은 식별자로 좁혀 가는
                  순서가 종이 서식과 같고, 학번을 치기 전에 "어느 학교의 학번인가"가 정해진다.
                  [드롭다운이 아니라 직접 입력이다 — 같은 날 재변경] 처음에는 관리자가 등록한 학교
                  목록에서 고르게 했다. 학교가 관리자와 무관해지면서(가입할 때 학생이 직접 적는다)
                  그 목록은 **부분 목록**이 됐다 — 내 학교가 목록에 없는 상황이 정상이 되므로
                  드롭다운은 오히려 막다른 길이 된다. 가입 때 적은 값을 그대로 적으면 통과한다
                  (앞뒤 공백·연속 공백은 서버가 무시한다). */}
              <div className="field">
                <label htmlFor="in-school">학교</label>
                <input
                  id="in-school"
                  placeholder="가입할 때 입력한 학교"
                  value={studentForm.school}
                  onChange={(e) => setStudentForm((f) => ({ ...f, school: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="in-sid">학번</label>
                <input
                  id="in-sid"
                  placeholder="예: 10718"
                  value={studentForm.studentId}
                  autoComplete="username"
                  onChange={(e) => setStudentForm((f) => ({ ...f, studentId: e.target.value }))}
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
                  onChange={(e) => setStudentForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
            </>
          )}

          {tab === 'student' && mode === 'personal' && (
            <>
              <div className="field">
                <label htmlFor="in-email">이메일</label>
                <input
                  id="in-email"
                  type="email"
                  placeholder="you@example.com"
                  value={personalForm.email}
                  autoComplete="username"
                  onChange={(e) => setPersonalForm((f) => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div className="field">
                <label htmlFor="in-ppw">비밀번호</label>
                <input
                  id="in-ppw"
                  type="password"
                  placeholder="비밀번호"
                  value={personalForm.password}
                  autoComplete="current-password"
                  onChange={(e) => setPersonalForm((f) => ({ ...f, password: e.target.value }))}
                />
              </div>
            </>
          )}

          {tab === 'admin' && (
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
                  onChange={(e) => setAdminForm((f) => ({ ...f, password: e.target.value }))}
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

        {/* 아이디/비밀번호 찾기 (ADR 0020) — 실제로 할 수 있는 일은 계정 종류(tab/mode)마다 다르다.
            여기서는 어느 모달을 열지만 정하고, 내용 분기는 AccountHelpModal이 맡는다. */}
        <div className="hint accthelp-links">
          <button type="button" className="linklike" onClick={() => setHelpType('find-id')}>
            아이디를 잊으셨나요?
          </button>
          <span aria-hidden="true"> · </span>
          <button type="button" className="linklike" onClick={() => setHelpType('forgot-password')}>
            비밀번호를 잊으셨나요?
          </button>
        </div>

        {/* 소셜(네이버·구글)은 개인 계정 수단이다 — 관리자 탭과 학교 계정 탭에는 두지 않는다.
            (학교 계정은 학번·이름 대조가 로그인의 일부라 소셜 계정으로 대체할 수 없다.) */}
        {tab === 'student' && mode === 'personal' && <SocialLogin mode="login" />}

        {/* [왜 학교 계정 화면에 이 줄이 있는가 — 2026-08-06]
            소셜(네이버·구글)로 가입한 계정은 예외 없이 개인 계정인데, 이 화면의 기본값은 학교 계정이다.
            그래서 소셜로 가입한 사람이 로그인하러 오면 "버튼이 아예 없다"로 읽힌다(실제로 밟은 문제).
            버튼을 학교 계정에도 놓는 것은 ADR 0009/0010 을 깨는 일이다 — 학교 계정은 소셜로 로그인될 수
            없으므로 되지 않는 경로를 약속하게 된다. 그래서 버튼 대신 **개인 계정으로 가는 길**을 놓는다.
            제공자 설정 여부로 이 줄을 감추지 않는다 — 개인 계정은 이메일로도 만들어지므로 언제나 참이다. */}
        {tab === 'student' && mode === 'school' && (
          <div className="hint social-hint">
            이메일·소셜로 가입하셨나요?{' '}
            <button type="button" className="linklike" onClick={() => switchMode('personal')}>
              개인 계정으로 로그인
            </button>
          </div>
        )}

        <div className="hint">
          계정이 없으신가요? <Link to="/signup">회원가입</Link>
        </div>
        {/* 장식 문구다. 좁은 화면에서는 숨긴다(아래 CSS) — 로고·태그가 이미 같은 말을 한다.
            [:last-child 로 숨기지 않는 이유] 가입 화면에는 .hint 가 "이미 계정이 있나요? 로그인"
            하나뿐이라, 위치로 고르면 그 필수 링크가 사라진다. 그래서 전용 클래스로 지목한다. */}
        <div className="hint tagline">Accumu — 참여·인증 기반 커리어 포트폴리오</div>
      </div>

      {helpType && (
        <AccountHelpModal
          type={helpType}
          tab={tab}
          mode={mode}
          prefillEmail={personalForm.email}
          onClose={() => setHelpType(null)}
        />
      )}
    </div>
  );
}
