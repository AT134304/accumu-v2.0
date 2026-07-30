// Accumu v2 — 프로그램 등록·수정 모달 (docs/specs/admin-programs.md 확정 A / B절)
//
// [등록과 수정이 같은 컴포넌트다] 폼을 2개 만들면 검증 규칙이 갈라진다. 모드로만 갈린다:
//   create -> createProgram(초안 저장, is_published:false 명시) / 버튼 "초안으로 저장"
//   edit   -> updateProgram(게시 상태를 건드리지 않는다)        / 버튼 "저장"
//
// [폼에 만들지 않는 것]
//   is_published : 게시 상태를 바꾸는 유일한 경로는 목록의 올리기/내리기 토글이다 (확정 D)
//   created_by   : 소유권 이전은 with check 가 막지만 애초에 보내지 않는 것이 경계다
//   popularity   : 원칙 1 가드 (컬럼 주석이 명시적으로 금지)
//   삭제 버튼    : delete 정책이 0개다 — 만들어도 동작하지 않는다
//
// [원칙 4] 포인트 입력칸은 상단·강조 위치에 두지 않는다. 제목·유형·설명·일정 아래에 두고,
//   amber 는 값 표시에만 쓴다. 폼 어디에도 참여자 수/신청자 수 관련 칸이 없다(F-3: 데이터를 얻을 수도 없다).
import { useCallback, useMemo, useRef, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { CAT, TRACK, STATUS } from '../../lib/taxonomy';
import { todayISO } from '../../lib/date';
import { createProgram, updateProgram } from '../../lib/programService';
import { CAPACITY_RULE_MSG, POINTS_RULE_MSG, describeSaveError } from '../../lib/programErrors';

const CAT_OPTIONS = Object.entries(CAT).map(([key, c]) => ({ key, label: `${c.group} · ${c.name}` }));
const TRACK_OPTIONS = Object.entries(TRACK).map(([key, t]) => ({ key, label: t.name }));
const STATUS_OPTIONS = Object.entries(STATUS).map(([key, s]) => ({ key, label: s.label }));

// [드롭다운 옵션의 유일한 소유자는 taxonomy.js 다] 여기 없는 값을 하드코딩하면 enum 위반(22P02)이 난다.

/** 프로그램 행 -> 폼 값. 숫자/NULL 을 input 이 다룰 수 있는 문자열로 바꾼다. */
function toFormValues(program) {
  if (!program) {
    return {
      category: '',
      title: '',
      org: '',
      description: '',
      // 캘린더/날짜 기본값은 하드코딩이 아니라 실행 시점의 실제 오늘 (CLAUDE.md 9장, toISOString() 금지)
      date: todayISO(),
      time: '',
      career_track: '',
      points: '',
      capacity: '',
      status: 'open', // 확정 E: 기본 open
    };
  }
  return {
    category: program.category ?? '',
    title: program.title ?? '',
    org: program.org ?? '',
    description: program.description ?? '',
    date: program.date ?? '',
    time: program.time ?? '',
    career_track: program.career_track ?? '',
    points: program.points == null ? '' : String(program.points),
    capacity: program.capacity == null ? '' : String(program.capacity),
    status: program.status ?? 'open',
  };
}

export default function ProgramFormModal({ mode, program = null, adminId, onClose, onSaved }) {
  const isEdit = mode === 'edit';
  const [v, setV] = useState(() => toFormValues(program));
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErr, setServerErr] = useState(null); // { field?, message }
  const bodyRef = useRef(null);

  // 저장 중에는 Esc/바깥 클릭으로 닫히지 않게 한다(요청이 날아간 채 화면만 사라지는 상태 방지).
  // 참조가 안정적이어야 Modal 의 keydown 리스너가 매 렌더 재등록되지 않는다.
  const handleClose = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);

  const set = (key) => (e) => {
    const next = e.target.value;
    setV((prev) => ({ ...prev, [key]: next }));
    // 서버가 지목한 필드를 고치는 중이라면 그 오류는 낡은 정보다.
    setServerErr((prev) => (prev && prev.field === key ? null : prev));
  };
  const blur = (key) => () => setTouched((prev) => ({ ...prev, [key]: true }));

  // 필수 8개 (category/title/org/description/date/time/career_track/points).
  // capacity 는 선택 — 빈칸 = 정원 제한 없음.
  const missing = useMemo(() => {
    const e = {};
    if (!v.category) e.category = '활동 유형을 선택해 주세요.';
    if (!v.title.trim()) e.title = '제목을 입력해 주세요.';
    if (!v.org.trim()) e.org = '주최를 입력해 주세요.';
    if (!v.description.trim()) e.description = '설명을 입력해 주세요.';
    if (!v.date) e.date = '날짜를 선택해 주세요.';
    if (!v.time.trim()) e.time = '시간을 입력해 주세요.';
    if (!v.career_track) e.career_track = '진로 계열을 선택해 주세요.';
    if (!String(v.points).trim()) e.points = '지급 포인트를 입력해 주세요.';
    return e;
  }, [v]);

  // "값은 들어 있는데 규칙 위반" — 확정 G. 서버를 왕복시키지 않고 저장 버튼을 잠근다.
  // (DB CHECK 도 그대로 살아 있다. 프런트 검증은 개발자도구로 우회 가능하므로 23514 처리는 describeSaveError 가 맡는다.)
  const invalid = useMemo(() => {
    const e = {};
    const p = String(v.points).trim();
    if (p) {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 150 || n > 3000 || n % 10 !== 0) e.points = POINTS_RULE_MSG;
    }
    const c = String(v.capacity).trim();
    if (c) {
      const n = Number(c);
      if (!Number.isInteger(n) || n < 1) e.capacity = CAPACITY_RULE_MSG;
    }
    return e;
  }, [v.points, v.capacity]);

  // 규칙 위반 값이 있으면 저장 버튼을 잠근다. 빈 필수값은 잠그지 않고 제출 시 사유를 드러낸다
  // (처음부터 잠가두면 왜 못 누르는지 알 수 없는 버튼이 된다).
  const locked = Object.keys(invalid).length > 0;

  const errorOf = (key) => {
    if (serverErr?.field === key) return serverErr.message;
    if (invalid[key]) return invalid[key];
    if ((submitted || touched[key]) && missing[key]) return missing[key];
    return null;
  };

  // 확정 H: 지난 날짜는 막지 않고 경고만 한다 (학생 쪽 차단이 이미 있고, 시드의 과거 행도 수정할 수 있어야 한다).
  const isPastDate = Boolean(v.date) && v.date < todayISO();

  // 스크롤 컨테이너는 .mbody 가 아니라 .modal 이다(overflow:auto 가 거기 있다).
  // 첫 오류 필드가 접힌 스크롤 아래에 있으면 "눌리지도 않고 이유도 안 보이는" 상태가 된다.
  const scrollFormTop = () =>
    bodyRef.current?.closest('.modal')?.scrollTo({ top: 0, behavior: 'smooth' });

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
    setServerErr(null);
    if (locked || Object.keys(missing).length > 0) {
      scrollFormTop();
      return;
    }

    const payload = {
      category: v.category,
      title: v.title.trim(),
      org: v.org.trim(),
      description: v.description.trim(),
      date: v.date,
      time: v.time.trim(),
      career_track: v.career_track,
      points: Number(v.points),
      capacity: String(v.capacity).trim() === '' ? null : Number(v.capacity),
      status: v.status,
    };

    setSaving(true);
    try {
      const row = isEdit
        ? await updateProgram(program.id, payload)
        : await createProgram(adminId, payload);
      onSaved(row, mode);
    } catch (err) {
      // 저장 실패 시 모달을 닫지 않는다. 입력값을 보존한 채 사유만 표시하고 재시도할 수 있게 둔다.
      console.error('[AdminPrograms] 프로그램 저장 실패:', err);
      const described = describeSaveError(err);
      setServerErr(described);
      // 필드 오류(23514 등)는 그 입력칸 옆에 뜨므로 화면을 위로 튀게 하지 않는다.
      if (!described.field) scrollFormTop();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal onClose={handleClose} labelledBy="pform-title" className="pform-modal">
      <div className="mbody" ref={bodyRef}>
        <h3 id="pform-title">{isEdit ? '프로그램 수정' : '새 프로그램 올리기'}</h3>
        <p className="pform-lead">
          {isEdit
            ? '내용을 고쳐도 게시 상태는 그대로 유지됩니다.'
            : '저장하면 학생에게는 아직 보이지 않습니다. 목록에서 ‘올리기’를 눌러 공개하세요.'}
        </p>

        {serverErr && !serverErr.field && (
          <div className="pf-alert" role="alert">
            <Icon name="ic-alert" size={16} />
            <span>{serverErr.message}</span>
          </div>
        )}

        <form className="pform" onSubmit={handleSubmit} noValidate>
          <Field label="활동 유형" htmlFor="pf-category" required error={errorOf('category')}>
            <select
              id="pf-category"
              value={v.category}
              onChange={set('category')}
              onBlur={blur('category')}
            >
              <option value="">선택하세요</option>
              {CAT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="제목" htmlFor="pf-title-input" required error={errorOf('title')}>
            <input
              id="pf-title-input"
              type="text"
              value={v.title}
              onChange={set('title')}
              onBlur={blur('title')}
              placeholder="예) 데이터 사이언스 진로 특강"
              maxLength={80}
            />
          </Field>

          <Field label="주최" htmlFor="pf-org" required error={errorOf('org')}>
            <input
              id="pf-org"
              type="text"
              value={v.org}
              onChange={set('org')}
              onBlur={blur('org')}
              placeholder="예) 진로진학부"
              maxLength={60}
            />
          </Field>

          <Field
            label="설명"
            htmlFor="pf-desc"
            required
            error={errorOf('description')}
            hint="학생 참여 팝업에 그대로 표시됩니다."
          >
            <textarea
              id="pf-desc"
              rows={3}
              value={v.description}
              onChange={set('description')}
              onBlur={blur('description')}
              placeholder="어떤 활동인지 학생이 이해할 수 있게 적어주세요."
              maxLength={400}
            />
          </Field>

          <div className="pf-2col">
            <Field
              label="날짜"
              htmlFor="pf-date"
              required
              error={errorOf('date')}
              warn={isPastDate ? '이미 지난 날짜입니다. 학생은 이 프로그램에 신청할 수 없습니다.' : null}
            >
              <input
                id="pf-date"
                type="date"
                value={v.date}
                onChange={set('date')}
                onBlur={blur('date')}
              />
            </Field>

            {/* [time picker 를 쓰지 않는다] DB 컬럼이 time 타입이 아니라 자유 텍스트다.
                "방과후", "무박 2일" 같은 값이 실제로 들어간다. */}
            <Field
              label="시간"
              htmlFor="pf-time"
              required
              error={errorOf('time')}
              hint="‘15:30–17:00’, ‘방과후’처럼 자유롭게 적을 수 있어요."
            >
              <input
                id="pf-time"
                type="text"
                value={v.time}
                onChange={set('time')}
                onBlur={blur('time')}
                placeholder="예) 15:30–17:00"
                maxLength={40}
              />
            </Field>
          </div>

          <div className="pf-2col">
            <Field label="진로 계열" htmlFor="pf-track" required error={errorOf('career_track')}>
              <select
                id="pf-track"
                value={v.career_track}
                onChange={set('career_track')}
                onBlur={blur('career_track')}
              >
                <option value="">선택하세요</option>
                {TRACK_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>

            {/* 확정 E — 모집 상태는 관리자가 수동 지정하는 정적 값이다(정원·참여수 파생 아님). */}
            <Field label="모집 상태" htmlFor="pf-status" hint="학생 화면의 참여 버튼 상태에 반영됩니다.">
              <select id="pf-status" value={v.status} onChange={set('status')}>
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="pf-2col">
            <Field
              label="지급 포인트"
              htmlFor="pf-points"
              required
              error={errorOf('points')}
              hint="150~3,000P, 10원 단위"
            >
              <input
                id="pf-points"
                type="number"
                inputMode="numeric"
                step={10}
                min={150}
                max={3000}
                value={v.points}
                onChange={set('points')}
                onBlur={blur('points')}
                placeholder="예) 300"
              />
            </Field>

            <Field label="정원" htmlFor="pf-capacity" error={errorOf('capacity')}>
              <input
                id="pf-capacity"
                type="number"
                inputMode="numeric"
                min={1}
                value={v.capacity}
                onChange={set('capacity')}
                onBlur={blur('capacity')}
                placeholder="비워두면 제한 없음"
              />
            </Field>
          </div>

          {/* 확정 I — 수정 모드에서 항상 표시한다. 참여자 유무를 알 권한이 없어 조건부 표시가 구조적으로 불가능하다. */}
          {isEdit && (
            <p className="pf-note">
              포인트를 바꿔도 <b>이미 지급이 끝난 학생의 포인트는 변경되지 않습니다.</b> 이후 퇴장
              인증부터 새 금액이 적용됩니다.
            </p>
          )}

          {/* 확정 F — 값 유무·모드와 무관하게 항상 표시 (조건부 문구를 만들 수 없다) */}
          <p className="pf-note">
            정원을 비워두면 제한이 없습니다. 정원을 채우면 새 신청이 막히며,{' '}
            <b>정원을 줄여도 이미 신청한 학생은 취소되지 않습니다.</b>
          </p>

          <div className="pf-actions">
            <button type="button" className="pf-btn ghost" onClick={onClose} disabled={saving}>
              취소
            </button>
            <button type="submit" className="pf-btn primary" disabled={saving || locked}>
              {saving ? '저장 중…' : isEdit ? '저장' : '초안으로 저장'}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

/** 라벨 + 입력 + (오류 | 경고 | 안내) 한 칸. 오류가 있으면 안내 대신 오류를 보여준다. */
function Field({ label, htmlFor, required = false, error = null, warn = null, hint = null, children }) {
  return (
    <div className={error ? 'pf err' : 'pf'}>
      <label htmlFor={htmlFor}>
        {label}
        {required && <em className="req">필수</em>}
      </label>
      {children}
      {error && <p className="pf-msg err">{error}</p>}
      {!error && warn && (
        <p className="pf-msg warn">
          <Icon name="ic-alert" size={14} />
          {warn}
        </p>
      )}
      {!error && !warn && hint && <p className="pf-msg hint">{hint}</p>}
    </div>
  );
}
