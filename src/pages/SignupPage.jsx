// Accumu v2 — 회원가입 (docs/specs/auth-signup.md A절 / ADR 0008)
//
// [이 화면은 role 을 정하지 않는다]
//   폼이 보내는 role 은 *신청*이고, 승인은 DB 트리거 handle_new_user() 가 invite_codes 를 조회해서 한다.
//   관리자 탭에서 초대코드가 틀리면 가입 자체가 롤백된다 — 학생으로 대신 만들어주지 않는다(fail-closed).
//   그래서 이 파일의 검증은 전부 "사용자에게 친절한 문구"를 위한 것이지 보안 경계가 아니다.
//
// [로그인 화면과 같은 껍데기를 쓴다] #login / .lcard / .tabs / .field 는 LoginPage 가 이미 소유한
//   클래스다. 복제하면 두 화면이 시간이 지나며 어긋난다 — 가입 전용 값만 LoginPage.css 에 덧붙였다.
//
// [표시하지 않는 것] 약관·법정대리인 동의(CLAUDE.md 11장 스코프 제외), 이메일 인증 메일,
//   구글·카카오·페이스북(케빈 확정: 네이버만 붙인다 — ADR 0009). 가입 보너스 포인트도 없다(원칙 1).
//   학교 계정·관리자 탭에서는 이메일도 받지 않는다 — 가상 이메일({code}@accumu.local)로 변환되기 때문이다.
import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import NaverLoginButton from '../components/NaverLoginButton';
import { signUpAdmin, signUpPersonal, signUpStudent, signupReasonText } from '../lib/authService';
import { TRACK } from '../lib/taxonomy';
// 계열 선택 칩(.chip/.chiprow/.chipdot)은 StudentShell.css 가 소유한 앱 공통 프리미티브다
// (AdminShell 이 같은 이유로 이 파일을 import 한다). 가입 화면은 셸 밖이라 명시적으로 가져온다.
import '../styles/StudentShell.css';
import '../styles/LoginPage.css';

// [개인 계정에는 학번이 없다 — 2026-07-31 개정]
//   학번은 학교가 부여하는 식별자다. 소속이 없는 계정에 받을 근거가 없고, 받으면 "아무 숫자나 학번처럼
//   입력된 값"이 unique 공간을 차지한다. 개인 계정의 아이디는 이메일(또는 소셜 계정)이고
//   profiles.code 는 서버가 P-XXXXXX 로 발급한다(generate_personal_code).
const emptyStudent = { studentId: '', name: '', password: '', confirm: '', invite: '' };
const emptyPersonal = { email: '', name: '', password: '', confirm: '' };
const emptyAdmin = { code: '', name: '', password: '', confirm: '', invite: '' };

const PASSWORD_MIN = 6; // Supabase Auth 기본 최소 길이

function LogoMark() {
  return (
    <svg style={{ width: 54, height: 50 }} viewBox="0 0 32 30" aria-hidden="true">
      <rect x="2" y="19" width="5.4" height="9" rx="2.1" fill="#BCD0FF" />
      <rect x="9" y="14" width="5.4" height="14" rx="2.1" fill="#7098EE" />
      <rect x="16" y="9" width="5.4" height="19" rx="2.1" fill="#3463DA" />
      <rect x="23" y="3" width="5.4" height="25" rx="2.1" fill="#16213E" />
    </svg>
  );
}

export default function SignupPage() {
  const { session, profile, loading, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [tab, setTab] = useState('student');
  const [accountType, setAccountType] = useState('personal'); // 'personal' | 'school'
  const [studentForm, setStudentForm] = useState(emptyStudent);
  const [personalForm, setPersonalForm] = useState(emptyPersonal);
  const [adminForm, setAdminForm] = useState(emptyAdmin);
  const [track, setTrack] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (!loading && session && profile) {
    return <Navigate to={`/${profile.role}`} replace />;
  }

  function switchTab(next) {
    if (next === tab) return;
    setTab(next);
    setStudentForm(emptyStudent);
    setPersonalForm(emptyPersonal);
    setAdminForm(emptyAdmin);
    setTrack('');
    setError('');
    setNotice('');
  }

  // 현재 폼이 무엇인지 한 곳에서 정한다 — 학생(개인) / 학생(학교) / 관리자 3가지.
  const isPersonal = tab === 'student' && accountType === 'personal';
  const form = tab === 'admin' ? adminForm : isPersonal ? personalForm : studentForm;
  const setForm = tab === 'admin' ? setAdminForm : isPersonal ? setPersonalForm : setStudentForm;

  /** 폼 검증 — 서버까지 갈 필요가 없는 것만 여기서 막는다. */
  function validate() {
    if (isPersonal) {
      // 개인 계정은 학번을 받지 않는다. 아이디 역할을 이메일이 한다.
      if (!personalForm.email.trim()) return '이메일을 입력해주세요.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(personalForm.email.trim())) return '이메일 형식을 확인해주세요.';
    } else {
      const code = tab === 'student' ? studentForm.studentId : adminForm.code;
      if (!code.trim()) return tab === 'student' ? '학번을 입력해주세요.' : '관리자 코드를 입력해주세요.';
    }
    if (!form.name.trim()) return '이름을 입력해주세요.';
    if (form.password.length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 합니다.`;
    if (form.password !== form.confirm) return '비밀번호가 서로 다릅니다.';
    if (tab === 'admin' && !adminForm.invite.trim()) return '관리자 초대코드를 입력해주세요.';
    if (tab === 'student' && accountType === 'school' && !studentForm.invite.trim()) {
      return '학교 계정은 초대코드가 필요합니다. 개인 계정으로 가입할 수도 있어요.';
    }
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submitting) return;

    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }

    setError('');
    setNotice('');
    setSubmitting(true);

    try {
      let result;
      if (tab === 'admin') {
        result = await signUpAdmin({
          code: adminForm.code,
          name: adminForm.name,
          password: adminForm.password,
          invite: adminForm.invite,
        });
      } else if (isPersonal) {
        // 학번도 초대코드도 보내지 않는다 = 트리거가 개인 계정으로 만들고 code 를 자동 발급한다.
        result = await signUpPersonal({
          email: personalForm.email,
          password: personalForm.password,
          name: personalForm.name,
          careerInterest: track,
        });
      } else {
        result = await signUpStudent({
          studentId: studentForm.studentId,
          name: studentForm.name,
          password: studentForm.password,
          invite: studentForm.invite,
          careerInterest: track,
        });
      }

      if (!result.ok) {
        setError(signupReasonText(result.reason));
        return;
      }

      if (!result.session) {
        // Supabase 의 "Confirm email" 이 켜진 프로젝트 — 가상 이메일이라 확인 메일을 받을 수 없다.
        // 계정은 만들어졌으므로 실패로 표시하지 않고 로그인 화면으로 안내한다(스펙 에러 처리 표).
        setNotice('가입이 완료됐어요. 로그인 화면에서 로그인해주세요.');
        return;
      }

      // 세션은 생겼지만 전역 profile 은 아직 비어 있다(가입은 로그인 함수를 타지 않는다).
      // 여기서 채우지 않으면 ProtectedRoute 가 profile 없음으로 보고 /login 으로 되돌린다.
      await refreshProfile();
      navigate(`/${tab}`, { replace: true });
    } catch (err) {
      console.error('[Signup] 가입 처리 실패:', err);
      setError('가입에 실패했어요. 잠시 후 다시 시도해 주세요.');
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
          <div className="tag">계정을 만들고 활동을 쌓아보세요</div>
        </div>

        <div className="tabs" role="tablist" aria-label="가입 유형">
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
          {tab === 'student' && (
            <>
              {/* 계정 종류 — 기본값은 개인이다. 코드 없이도 끝까지 갈 수 있는 쪽을 기본으로 둔다. */}
              <div className="field">
                <label>계정 종류</label>
                <div className="segrow" role="group" aria-label="계정 종류">
                  <button
                    type="button"
                    className={accountType === 'personal' ? 'seg on' : 'seg'}
                    aria-pressed={accountType === 'personal'}
                    onClick={() => setAccountType('personal')}
                  >
                    개인 계정
                  </button>
                  <button
                    type="button"
                    className={accountType === 'school' ? 'seg on' : 'seg'}
                    aria-pressed={accountType === 'school'}
                    onClick={() => setAccountType('school')}
                  >
                    학교 계정
                  </button>
                </div>
                <div className="help">
                  {accountType === 'school'
                    ? '선생님이 알려준 초대코드를 입력하면 담당 선생님과 연동됩니다.'
                    : '혼자 사용하는 계정입니다. 나중에 마이페이지에서 초대코드를 넣어 학교 계정으로 바꿀 수 있어요.'}
                </div>
              </div>

              {/* 학교 계정만 학번을 받는다. 개인 계정은 소속이 없어 학번이라는 값 자체가 없다. */}
              {accountType === 'school' ? (
                <div className="field">
                  <label htmlFor="su-sid">학번</label>
                  <input
                    id="su-sid"
                    placeholder="예: 10723"
                    value={studentForm.studentId}
                    autoComplete="username"
                    onChange={(e) => setStudentForm((f) => ({ ...f, studentId: e.target.value }))}
                  />
                </div>
              ) : (
                <div className="field">
                  <label htmlFor="su-email">이메일</label>
                  <input
                    id="su-email"
                    type="email"
                    placeholder="you@example.com"
                    value={personalForm.email}
                    autoComplete="username"
                    onChange={(e) => setPersonalForm((f) => ({ ...f, email: e.target.value }))}
                  />
                  <div className="help">로그인할 때 쓰는 아이디예요. 학번은 입력하지 않아요.</div>
                </div>
              )}
            </>
          )}

          {tab === 'admin' && (
            <div className="field">
              <label htmlFor="su-code">관리자 코드</label>
              <input
                id="su-code"
                placeholder="예: ADM-0002"
                value={adminForm.code}
                autoComplete="username"
                onChange={(e) => setAdminForm((f) => ({ ...f, code: e.target.value }))}
              />
            </div>
          )}

          <div className="field">
            <label htmlFor="su-name">이름</label>
            <input
              id="su-name"
              placeholder="이름을 입력하세요"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />
          </div>

          <div className="field">
            <label htmlFor="su-pw">비밀번호</label>
            <input
              id="su-pw"
              type="password"
              placeholder={`${PASSWORD_MIN}자 이상`}
              value={form.password}
              autoComplete="new-password"
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>

          <div className="field">
            <label htmlFor="su-pw2">비밀번호 확인</label>
            <input
              id="su-pw2"
              type="password"
              placeholder="한 번 더 입력"
              value={form.confirm}
              autoComplete="new-password"
              onChange={(e) => setForm((f) => ({ ...f, confirm: e.target.value }))}
            />
          </div>

          {(tab === 'admin' || accountType === 'school') && (
            <div className="field">
              <label htmlFor="su-invite">{tab === 'admin' ? '관리자 초대코드' : '학교 초대코드'}</label>
              <input
                id="su-invite"
                placeholder={tab === 'admin' ? '예: ADMIN-2026' : '예: SCH-1A2B'}
                value={form.invite}
                onChange={(e) => setForm((f) => ({ ...f, invite: e.target.value }))}
              />
              <div className="help">
                {tab === 'admin'
                  ? '관리자 계정은 초대코드가 있어야 만들 수 있습니다.'
                  : '담당 선생님의 마이페이지에서 확인할 수 있는 코드입니다.'}
              </div>
            </div>
          )}

          {/* 관심 계열은 선택이다 — 넣으면 첫 홈 화면부터 추천이 동작한다(안 넣어도 가입된다). */}
          {tab === 'student' && (
            <div className="field">
              <label>관심 진로 계열 (선택)</label>
              <div className="chiprow">
                {Object.entries(TRACK).map(([key, t]) => (
                  <button
                    key={key}
                    type="button"
                    className={track === key ? 'chip on' : 'chip'}
                    aria-pressed={track === key}
                    onClick={() => setTrack(track === key ? '' : key)}
                  >
                    <i className="chipdot" style={{ background: t.color }} />
                    {t.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="form-notice" role="status">
              {notice}
            </div>
          )}

          <button className="btn-primary" type="submit" disabled={submitting}>
            {submitting ? (
              '가입 중…'
            ) : (
              <>
                회원가입 <span>→</span>
              </>
            )}
          </button>
        </form>

        {/* 네이버는 개인 계정 수단이다 — 학교 계정·관리자 탭에는 두지 않는다.
            네이버로 만들어지는 계정은 Edge Function 과 트리거가 언제나 학생·개인으로 고정하기 때문에,
            다른 탭에 두면 되지 않는 경로를 약속하는 셈이 된다. */}
        {isPersonal && <NaverLoginButton label="네이버로 가입하기" />}

        <div className="hint">
          이미 계정이 있나요? <Link to="/login">로그인</Link>
        </div>
      </div>
    </div>
  );
}
