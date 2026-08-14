// Accumu v2 — 본인 비밀번호 변경 (docs/adr/0020-self-password-management.md + 2026-08-14 개정)
//
// [학생/관리자 마이페이지가 공유한다] 둘 다 "로그인된 계정의 비밀번호를 스스로 바꾼다"는 같은 동작이다.
//   화면마다 다른 것은 배치뿐이다.
//
// [2026-08-14 개정 두 가지 — 케빈 요청]
//   1. **현재 비밀번호를 묻는다.** 예전에는 세션만 있으면 새 비밀번호를 그냥 덮어썼다. 세션이 곧
//      본인 확인이라는 논리는 맞지만, 이 확인이 막는 위협은 "계정 주인인가"가 아니라 **로그인된
//      화면을 잠깐 만진 사람이 계정을 영구히 가져가는 것**이다(학교 공용 PC, 빌려준 폰).
//      이 앱은 학번이 곧 로그인 아이디라 아이디 쪽이 이미 반쯤 공개돼 있어 더 중요하다.
//      검증 방법은 authService.changeMyPasswordWithCurrent() 주석 참고.
//   2. **소셜 계정에는 아예 보여주지 않는다.** 네이버/구글 계정에는 바꿀 비밀번호 자체가 없다.
//      예전 주석은 "비밀번호를 새로 얹는 부가 옵션"으로 뒀지만, 현재 비밀번호를 묻기로 한 이상
//      소셜 계정은 **입력할 값이 없어 통과가 불가능하다** — 폼을 띄워 두면 반드시 실패하는 칸이 된다.
//      대신 왜 없는지 한 줄로 말해 준다(그냥 비우면 빠진 기능처럼 보인다).
//
// [인라인 펼침이 아니라 모달인 이유] 비밀번호 입력이 3칸으로 늘면서 마이페이지 프로필 카드 안에서
//   세로로 길게 밀려났다. 그리고 "지금 하는 일에 집중"시켜야 하는 동작이라 화면을 덮는 쪽이 맞다.
import { useState } from 'react';
import Icon from './Icon';
import Modal from './Modal';
import { useAuth } from '../context/AuthContext';
import { changeMyPasswordWithCurrent, socialProviderOf } from '../lib/authService';
import '../styles/PasswordChange.css';

const MIN_LENGTH = 6; // Supabase Auth 기본 최소 길이와 맞춘다.

const PROVIDER_LABEL = { naver: '네이버', google: '구글' };

export default function PasswordChangeForm() {
  const { session } = useAuth();
  const social = socialProviderOf(session?.user);

  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  function closeModal() {
    if (saving) return; // 요청이 날아간 채 화면만 사라지지 않게 (다른 모달들과 같은 규율)
    setOpen(false);
    setCurrent('');
    setPw('');
    setPw2('');
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError('');

    if (!current) {
      setError('현재 비밀번호를 입력해 주세요.');
      return;
    }
    if (pw.length < MIN_LENGTH) {
      setError(`새 비밀번호는 최소 ${MIN_LENGTH}자 이상이어야 해요.`);
      return;
    }
    if (pw !== pw2) {
      setError('입력한 두 비밀번호가 서로 달라요.');
      return;
    }
    if (pw === current) {
      setError('지금 쓰는 비밀번호와 같아요. 다른 비밀번호를 입력해 주세요.');
      return;
    }

    setSaving(true);
    try {
      await changeMyPasswordWithCurrent(current, pw);
      setCurrent('');
      setPw('');
      setPw2('');
      setOpen(false);
      setDone(true);
    } catch (err) {
      // changeMyPasswordWithCurrent 는 사용자에게 그대로 보여줄 수 있는 문구를 던진다
      // (현재 비밀번호 불일치 / 시도 과다). 그 외는 일반 문구로 덮는다.
      console.error('[PasswordChangeForm] 비밀번호 변경 실패:', err);
      setError(err?.message ?? '비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }

  // 소셜 계정 — 변경 칸을 만들지 않는다. 비워 두지도 않는다(빠진 기능처럼 보인다).
  if (social) {
    return (
      <div className="pwchange">
        <div className="pwchange-social">
          <Icon name="ic-check" size={14} />
          {PROVIDER_LABEL[social]} 계정으로 로그인 중이에요 · 비밀번호는 {PROVIDER_LABEL[social]}에서
          관리합니다
        </div>
      </div>
    );
  }

  return (
    <div className="pwchange">
      <button
        type="button"
        className="pwchange-toggle"
        onClick={() => {
          setDone(false);
          setOpen(true);
        }}
      >
        <Icon name="ic-refresh" size={15} />
        비밀번호 변경
      </button>

      {done && <div className="pwchange-done">비밀번호가 변경되었어요.</div>}

      {open && (
        <Modal onClose={closeModal} labelledBy="pwchange-title" className="confirm-modal">
          <div className="mbody pwchange-modal">
            <h3 id="pwchange-title">비밀번호 변경</h3>
            {/* [.confirm-desc 를 쓰지 않는다] 그 클래스는 AdminShell.css 에만 있다. 번들이 하나라
                지금은 어디서든 먹지만, 학생 화면이 관리자 CSS 파일에 기대는 숨은 의존이 된다. */}
            <p className="pwchange-lead">본인 확인을 위해 지금 쓰는 비밀번호를 먼저 입력해 주세요.</p>

            <form className="pwchange-form" onSubmit={handleSubmit}>
              {/* [username 힌트를 숨겨 둔다] 비밀번호 관리자가 "어느 계정의 비밀번호인지" 를 알아야
                  새 값을 올바른 항목에 저장한다. 없으면 엉뚱한 계정에 저장되거나 저장 제안이 안 뜬다. */}
              <input
                type="text"
                name="username"
                autoComplete="username"
                value={session?.user?.email ?? ''}
                readOnly
                hidden
              />
              <input
                type="password"
                placeholder="현재 비밀번호"
                autoComplete="current-password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
              />
              <input
                type="password"
                placeholder="새 비밀번호"
                autoComplete="new-password"
                value={pw}
                onChange={(e) => setPw(e.target.value)}
              />
              <input
                type="password"
                placeholder="새 비밀번호 확인"
                autoComplete="new-password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
              />
              {error && (
                <div className="pwchange-err" role="alert">
                  {error}
                </div>
              )}
              <button type="submit" disabled={saving}>
                {saving ? '변경 중…' : '변경하기'}
              </button>
            </form>
          </div>
        </Modal>
      )}
    </div>
  );
}
