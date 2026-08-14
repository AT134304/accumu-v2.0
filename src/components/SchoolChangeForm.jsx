// Accumu v2 — 본인 학교 변경 (20260814200000 set_my_school RPC / 케빈 요청 2026-08-14)
//
// [학생/관리자 마이페이지가 공유한다] PasswordChangeForm 과 같은 이유 — 둘 다 "로그인된 계정의
//   자기 값을 스스로 고친다"는 같은 동작이고, 화면마다 다른 것은 배치뿐이다. 두 벌로 나누면
//   경고 문구와 검증 규칙이 시간이 지나며 갈라진다.
//
// [★ 학교 계정 학생에게 이 값은 로그인 자격의 일부다]
//   학번·이름·비밀번호·학교 4가지로 로그인한다(20260814180000). 바꾸면 **다음 로그인부터 새 값을
//   입력해야 한다.** 그래서 이 폼은 저장 버튼 옆이 아니라 **입력칸 위에** 그 사실을 적는다 —
//   저장한 뒤에 알려주면 이미 늦었고, 그 학생은 자기가 무엇을 바꿨는지 모른 채 로그인에 실패한다.
//   관리자에게는 그 경고가 거짓이므로(관리자는 코드+비밀번호로 로그인한다) 역할에 따라 문구가 갈린다.
//
// [인라인 펼침이다 — 모달이 아니다] 비밀번호 변경(PasswordChangeForm)은 본인 확인이 필요해서
//   화면을 덮는 게 맞았지만, 이건 값 하나를 고치는 일이고 바로 위에 지금 값이 보이는 상태에서
//   고치는 편이 낫다. 팝업으로 띄우면 "무엇을 무엇으로 바꾸는지"가 화면에서 분리된다.
import { useState } from 'react';
import Icon from './Icon';
import { useAuth } from '../context/AuthContext';
import { setMySchool } from '../lib/profileService';
import '../styles/SchoolChange.css';

const MAX_LENGTH = 60; // DB check(profiles_school_shape)와 같은 값.

const REASON_TEXT = {
  empty: '학교 이름을 입력해 주세요.',
  too_long: `학교 이름은 ${MAX_LENGTH}자 이하로 입력해 주세요.`,
  // 개인 계정은 애초에 이 폼이 렌더되지 않지만(마이페이지의 isSchool 분기), 서버 판정을 문구로 갖고 있는다.
  not_school_account: '개인 계정에는 소속이 없어요. 마이페이지에서 학교 계정으로 먼저 연동해 주세요.',
};

export default function SchoolChangeForm() {
  const { profile, applyProfilePatch } = useAuth();
  const isStudent = profile?.role === 'student';

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  function toggle() {
    setDone(false);
    setError('');
    // 열 때 지금 값을 채워 둔다 — 오타 한 글자를 고치려고 전체를 다시 치게 하지 않는다.
    setValue(profile?.school ?? '');
    setOpen((v) => !v);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (saving) return;
    setError('');

    const next = value.trim();
    if (!next) {
      setError(REASON_TEXT.empty);
      return;
    }
    if (next === (profile?.school ?? '').trim()) {
      // 같은 값이면 서버를 부를 이유가 없다. "저장됐다"고 말하는 것도 사실과 어긋난다.
      setOpen(false);
      return;
    }

    setSaving(true);
    try {
      const res = await setMySchool(next);
      if (!res.ok) {
        setError(REASON_TEXT[res.reason] ?? '학교를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
        return;
      }
      // 전역 profile 을 서버가 돌려준 값으로 맞춘다 — reload() 로 때우지 않는다(setCareerInterest 와 같은 규율).
      applyProfilePatch({ school: res.school });
      setOpen(false);
      setDone(true);
    } catch (err) {
      console.error('[SchoolChangeForm] 학교 변경 실패:', err);
      setError('학교를 바꾸지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="schoolchange">
      <button type="button" className="schoolchange-toggle" onClick={toggle} aria-expanded={open}>
        <Icon name="ic-edit" size={14} />
        학교 변경
      </button>

      {done && !open && <div className="schoolchange-done">학교가 변경되었어요.</div>}

      {open && (
        <form className="schoolchange-form" onSubmit={handleSubmit}>
          {/* 경고는 입력칸 **위**에 둔다 — 저장한 뒤에 알려주면 이미 늦다. */}
          <div className="schoolchange-warn">
            {isStudent ? (
              <>
                학교는 로그인할 때 <b>학번·이름과 함께 입력하는 값</b>이에요. 바꾸면 다음 로그인부터 새
                이름으로 입력해야 해요.
              </>
            ) : (
              <>바꾼 학교 이름은 마이페이지에 표시돼요. 관리자 로그인 방법은 달라지지 않아요.</>
            )}
          </div>
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="예: 가온고등학교"
            maxLength={MAX_LENGTH}
            aria-label="새 학교 이름"
          />
          {error && (
            <div className="schoolchange-err" role="alert">
              {error}
            </div>
          )}
          <div className="schoolchange-actions">
            <button type="button" className="ghost" onClick={() => setOpen(false)} disabled={saving}>
              취소
            </button>
            <button type="submit" disabled={saving}>
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
