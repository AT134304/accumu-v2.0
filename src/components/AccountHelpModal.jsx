// Accumu v2 — 로그인 화면 "아이디/비밀번호를 잊으셨나요?" (docs/adr/0020-self-password-management.md)
//
// [계정 종류마다 실제로 할 수 있는 일이 다르다 — 그 사실을 숨기지 않는다]
//   학교 계정(학번)·관리자(코드)는 가상 이메일이라 이메일 기반 자동화가 통하지 않는다(ADR 0019 배경).
//   개인 계정(실제 이메일)만 진짜로 "메일을 보내는" 동작을 한다. 나머지는 안내 문구다 — 안 되는 걸
//   되는 것처럼 꾸미지 않는다(확정 F-1이 QR에 대해 지킨 것과 같은 원칙: 없는 기능을 약속하지 않는다).
import { useState } from 'react';
import Modal from './Modal';
import { findStudentCodeByName, requestPasswordReset } from '../lib/authService';
import '../styles/AccountHelp.css';

/**
 * @param {'find-id'|'forgot-password'} type
 * @param {'student'|'admin'} tab
 * @param {'school'|'personal'} mode   tab==='student'일 때만 의미 있음
 * @param {string} prefillEmail        forgot-password + personal일 때 이미 입력된 이메일을 채워준다
 */
export default function AccountHelpModal({ type, tab, mode, prefillEmail = '', onClose }) {
  const isPersonal = tab === 'student' && mode === 'personal';
  const isSchool = tab === 'student' && mode === 'school';
  const isAdmin = tab === 'admin';

  if (type === 'find-id' && isSchool) return <FindIdBySchool onClose={onClose} />;
  if (type === 'forgot-password' && isPersonal) {
    return <ForgotPasswordPersonal prefillEmail={prefillEmail} onClose={onClose} />;
  }

  // 나머지 조합은 전부 "실제로 할 수 있는 일이 없는" 경우다 — 안내 문구 한 종류로 충분하다.
  const title = type === 'find-id' ? '아이디를 잊으셨나요?' : '비밀번호를 잊으셨나요?';
  let body;
  if (type === 'find-id' && isPersonal) {
    body = '개인 계정의 아이디는 가입 시 사용한 이메일이에요. 받은메일함이나 가입 확인 메일을 확인해 보세요.';
  } else if (type === 'find-id' && isAdmin) {
    body = '관리자 코드를 잊으셨다면 운영자에게 문의해 주세요.';
  } else if (isSchool) {
    // forgot-password + school
    body = '학번 계정은 이메일이 없어 스스로 재설정할 수 없어요. 담당 선생님(관리자)에게 문의해 비밀번호 초기화를 요청해 주세요.';
  } else {
    // forgot-password + admin
    body = '관리자 계정의 비밀번호는 스스로 재설정할 수 없어요. 운영자에게 문의해 주세요.';
  }

  return (
    <Modal onClose={onClose} labelledBy="accthelp-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="accthelp-title">{title}</h3>
        <p className="confirm-desc">{body}</p>
        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 아이디(학번) 찾기 — 학교 계정 ---------- */
function FindIdBySchool({ onClose }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { ok, code } | { ok:false, reason }

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await findStudentCodeByName(name.trim());
      setResult(res);
    } catch (err) {
      console.error('[AccountHelpModal] 학번 조회 실패:', err);
      setResult({ ok: false, reason: 'error' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="findid-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="findid-title">아이디(학번)를 잊으셨나요?</h3>
        <p className="confirm-desc">가입할 때 입력한 이름을 넣으면 학번을 확인해 드려요.</p>
        <form onSubmit={handleSubmit} className="accthelp-form">
          <input
            placeholder="이름"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? '확인 중…' : '학번 확인'}
          </button>
        </form>

        {result?.ok && (
          <p className="accthelp-result ok">
            회원님의 학번은 <b>{result.code}</b> 이에요.
          </p>
        )}
        {result && !result.ok && result.reason === 'not_found' && (
          <p className="accthelp-result err">일치하는 학교 계정을 찾지 못했어요. 이름을 다시 확인해 주세요.</p>
        )}
        {result && !result.ok && result.reason === 'ambiguous' && (
          <p className="accthelp-result err">
            같은 이름의 학생이 여러 명 있어 확인이 어려워요. 담당 선생님께 문의해 주세요.
          </p>
        )}
        {result && !result.ok && result.reason === 'error' && (
          <p className="accthelp-result err">잠시 후 다시 시도해 주세요.</p>
        )}

        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 비밀번호 재설정 — 개인 계정(실제 이메일) ---------- */
function ForgotPasswordPersonal({ prefillEmail, onClose }) {
  const [email, setEmail] = useState(prefillEmail);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError('');
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      console.error('[AccountHelpModal] 재설정 메일 발송 실패:', err);
      setError('잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} labelledBy="forgotpw-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="forgotpw-title">비밀번호를 잊으셨나요?</h3>
        {sent ? (
          <p className="confirm-desc">
            <b>{email}</b> 로 재설정 링크를 보냈어요(계정이 있는 경우). 메일함을 확인해 주세요.
          </p>
        ) : (
          <>
            <p className="confirm-desc">가입한 이메일로 비밀번호 재설정 링크를 보내드려요.</p>
            <form onSubmit={handleSubmit} className="accthelp-form">
              <input
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
              <button type="submit" disabled={busy || !email.trim()}>
                {busy ? '보내는 중…' : '재설정 메일 보내기'}
              </button>
            </form>
            {error && <p className="accthelp-result err">{error}</p>}
          </>
        )}
        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </Modal>
  );
}
