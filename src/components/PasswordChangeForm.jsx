// Accumu v2 — 본인 비밀번호 변경 (docs/adr/0020-self-password-management.md)
//
// [학생/관리자 마이페이지가 공유한다] 둘 다 "로그인된 계정의 비밀번호를 스스로 바꾼다"는 같은 동작이라
//   authService.updateMyPassword() 하나를 부른다. 화면마다 다른 것은 배치뿐이다.
// [소셜 계정에도 보여준다] 소셜(네이버/구글) 계정은 원래 비밀번호가 없지만, updateUser({password})는
//   그 계정에 비밀번호를 새로 얹는 것도 허용한다 — "비밀번호 로그인도 가능해지는" 부가 옵션으로 취급하고
//   막지 않는다. 굳이 계정 종류로 숨기면 화면 분기만 늘고 얻는 것이 없다.
// [현재 비밀번호를 묻지 않는다] updateMyPassword의 JSDoc과 같은 이유 — 로그인 세션 자체가 본인 확인이다.
import { useState } from 'react';
import Icon from './Icon';
import { updateMyPassword } from '../lib/authService';
import '../styles/PasswordChange.css';

const MIN_LENGTH = 6; // Supabase Auth 기본 최소 길이와 맞춘다.

export default function PasswordChangeForm() {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  function reset() {
    setPw('');
    setPw2('');
    setError('');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError('');
    setDone(false);

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
      reset();
      setDone(true);
      setOpen(false);
    } catch (err) {
      console.error('[PasswordChangeForm] 비밀번호 변경 실패:', err);
      setError('비밀번호를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pwchange">
      <button
        type="button"
        className="pwchange-toggle"
        onClick={() => {
          setOpen((v) => !v);
          setDone(false);
          reset();
        }}
        aria-expanded={open}
      >
        <Icon name="ic-refresh" size={15} />
        비밀번호 변경
      </button>

      {done && !open && <div className="pwchange-done">비밀번호가 변경되었어요.</div>}

      {open && (
        <form className="pwchange-form" onSubmit={handleSubmit}>
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
      )}
    </div>
  );
}
