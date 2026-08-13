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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import { CAT, TRACK, STATUS } from '../../lib/taxonomy';
import { todayISO } from '../../lib/date';
import ImageCropper from './ImageCropper';
import {
  createProgram,
  updateProgram,
  uploadProgramImage,
  validateImageFile,
  ProgramImageError,
  PROGRAM_IMAGE_RULE_MSG,
} from '../../lib/programService';
import { CAPACITY_RULE_MSG, POINTS_RULE_MSG, describeSaveError } from '../../lib/programErrors';

// 라벨이 name 하나다 — 4종으로 줄면서 group(교내/교외)이 사라졌다(ADR 0014).
const CAT_OPTIONS = Object.entries(CAT).map(([key, c]) => ({ key, label: c.name }));
const TRACK_OPTIONS = Object.entries(TRACK).map(([key, t]) => ({ key, label: t.name }));
const STATUS_OPTIONS = Object.entries(STATUS).map(([key, s]) => ({ key, label: s.label }));

// [드롭다운 옵션의 유일한 소유자는 taxonomy.js 다] 여기 없는 값을 하드코딩하면 enum 위반(22P02)이 난다.

// [지급 방식 3종 — 20260809160000] DB enum attendance_payout_mode 와 키까지 그대로 맞춘다(CAT/TRACK와 같은 관례).
const PAYOUT_MODE_OPTIONS = [
  { key: 'full', label: '전체 수강 완료 시 (종료일 퇴장 인증 1회)' },
  { key: 'per_session', label: '참석할 때마다 (퇴장 인증마다 매번)' },
  { key: 'threshold', label: '최소 참여일수 도달 시 (그 시점 1회)' },
];

// [진행일 캘린더 그리드 — 20260809180000] CalendarPopup.jsx와 같은 요일 순서(일~토)를 쓴다.
const DOW = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' 사이 모든 날짜를 배열로. UTC 자정 파싱이라 두 값을 같은 방식으로 다루는 한 안전하다
 *  (todayISO()처럼 "실제 오늘"을 구하는 게 아니라 이미 확정된 두 날짜를 잇는 것뿐이라 로컬 타임존 이슈가 없다). */
function datesBetween(startIso, endIso) {
  if (!startIso || !endIso) return [];
  const start = new Date(startIso);
  const end = new Date(endIso);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const out = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

/** 'YYYY-MM-DD' -> 요일 인덱스(0=일~6=토). datesBetween과 같은 UTC 파싱을 써야 어긋나지 않는다. */
function weekdayOf(iso) {
  return new Date(iso).getUTCDay();
}

/** 프로그램 행 -> 폼 값. 숫자/NULL 을 input 이 다룰 수 있는 문자열로 바꾼다. */
function toFormValues(program) {
  if (!program) {
    return {
      category: '',
      title: '',
      org: '',
      description: '',
      // 대표 사진(ADR 0022). 선택 항목 — 비어 있으면 카드가 기존 category 아이콘을 그린다.
      image_url: '',
      // 캘린더/날짜 기본값은 하드코딩이 아니라 실행 시점의 실제 오늘 (CLAUDE.md 9장, toISOString() 금지)
      date: todayISO(),
      end_date: '', // 기간제 프로그램의 종료일. "기간제 프로그램" 체크가 꺼져 있으면 저장 시 null로 보낸다.
      attendance_payout_mode: 'full', // 기간제 기본 지급 방식. 체크가 꺼져 있으면 저장 시 null로 보낸다.
      min_attendance_days: '', // attendance_payout_mode='threshold'일 때만 쓴다.
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
    image_url: program.image_url ?? '',
    date: program.date ?? '',
    end_date: program.end_date ?? '',
    attendance_payout_mode: program.attendance_payout_mode ?? 'full',
    min_attendance_days: program.min_attendance_days == null ? '' : String(program.min_attendance_days),
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
  // [기간제 — 20260809140000 마이그레이션] 체크가 꺼지면 저장 시 end_date를 null로 보낸다(단일 일자로 되돌림).
  // 켜졌을 때만 종료일 입력이 뜨고 필수가 된다. program.end_date 유무로 초기값을 정한다(수정 모드).
  const [isPeriod, setIsPeriod] = useState(() => Boolean(program?.end_date));
  // [진행일 목록 — 20260809180000] Set<'YYYY-MM-DD'>. 저장 진실은 이 Set 하나뿐이고, 아래 프리셋
  // 버튼들은 전부 이 Set을 채우는 도우미다(계산 결과를 별도로 저장하지 않는다).
  const [sessionDates, setSessionDates] = useState(() => new Set(program?.session_dates ?? []));
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverErr, setServerErr] = useState(null); // { field?, message }
  // [사진 — ADR 0022] 업로드는 저장과 별개의 왕복이다. 파일을 고르면 자르기 패널이 뜨고, 영역을
  // 확정하는 순간 스토리지로 올라간다. 폼이 들고 있는 값은 그 결과 URL 하나뿐이다(File 객체를
  // 폼 상태에 담아두지 않는다 — 담으면 저장 시점에 업로드가 시작돼 "저장 눌렀는데 한참 뒤 사진
  // 때문에 실패"가 된다).
  const [cropFile, setCropFile] = useState(null); // 자르는 중인 원본 파일 (null = 자르기 패널 닫힘)
  const [uploading, setUploading] = useState(false);
  const [photoErr, setPhotoErr] = useState(null);
  const bodyRef = useRef(null);
  const fileRef = useRef(null);

  // 저장/업로드 중에는 Esc/바깥 클릭으로 닫히지 않게 한다(요청이 날아간 채 화면만 사라지는 상태 방지).
  // 자르는 중이면 폼이 아니라 **자르기만** 취소한다 — 사진 하나 잘못 골랐다고 입력하던 폼 전체가
  // 날아가면 안 된다.
  // 참조가 안정적이어야 Modal 의 keydown 리스너가 매 렌더 재등록되지 않는다.
  const handleClose = useCallback(() => {
    if (saving || uploading) return;
    if (cropFile) {
      setCropFile(null);
      return;
    }
    onClose();
  }, [saving, uploading, cropFile, onClose]);

  const set = (key) => (e) => {
    const next = e.target.value;
    setV((prev) => ({ ...prev, [key]: next }));
    // 서버가 지목한 필드를 고치는 중이라면 그 오류는 낡은 정보다.
    setServerErr((prev) => (prev && prev.field === key ? null : prev));
  };
  const blur = (key) => () => setTouched((prev) => ({ ...prev, [key]: true }));

  // [기간이 바뀌면 진행일 목록을 그 범위로 정리한다]
  //   - 처음 기간을 잡는 순간(Set이 비어 있을 때)은 "매일"로 기본 채운다 — 빈 캘린더보다 낫다.
  //   - 이미 손댄 뒤(Set에 값이 있음)라면 범위 밖으로 밀려난 날짜만 걷어낸다. 골라둔 요일 패턴을
  //     날짜만 살짝 조정했다고 통째로 초기화하지 않는다.
  useEffect(() => {
    if (!isPeriod || !v.date || !v.end_date) return;
    const valid = new Set(datesBetween(v.date, v.end_date));
    setSessionDates((prev) => {
      if (prev.size === 0) return valid;
      const next = new Set([...prev].filter((d) => valid.has(d)));
      return next.size === prev.size ? prev : next;
    });
  }, [isPeriod, v.date, v.end_date]);

  // 필수 8개 (category/title/org/description/date/time/career_track/points).
  // capacity 는 선택 — 빈칸 = 정원 제한 없음.
  const missing = useMemo(() => {
    const e = {};
    if (!v.category) e.category = '활동 유형을 선택해 주세요.';
    if (!v.title.trim()) e.title = '제목을 입력해 주세요.';
    if (!v.org.trim()) e.org = '주최를 입력해 주세요.';
    if (!v.description.trim()) e.description = '설명을 입력해 주세요.';
    if (!v.date) e.date = '날짜를 선택해 주세요.';
    if (isPeriod && !v.end_date) e.end_date = '종료일을 선택해 주세요.';
    if (isPeriod && v.date && v.end_date && sessionDates.size === 0) {
      e.session_dates = '진행일을 하나 이상 선택해 주세요.';
    }
    if (isPeriod && v.attendance_payout_mode === 'threshold' && !String(v.min_attendance_days).trim()) {
      e.min_attendance_days = '최소 참여일수를 입력해 주세요.';
    }
    if (!v.time.trim()) e.time = '시간을 입력해 주세요.';
    if (!v.career_track) e.career_track = '진로 계열을 선택해 주세요.';
    if (!String(v.points).trim()) e.points = '지급 포인트를 입력해 주세요.';
    return e;
  }, [v, isPeriod, sessionDates]);

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
    // [기간제 — DB 제약 programs_end_date_after_start 를 프런트에서 먼저 막는다]
    if (isPeriod && v.date && v.end_date && v.end_date < v.date) {
      e.end_date = '종료일은 시작일보다 빠를 수 없습니다.';
    }
    // [최소 참여일수 — DB 제약 programs_min_days_range 를 프런트에서 먼저 막는다]
    //   상한은 달력 일수가 아니라 "실제로 고른 진행일 수"다(20260809180000) — 주말만 8일 진행인데
    //   최소참여일수를 10일로 걸면 절대 달성 불가능한 목표가 된다.
    if (isPeriod && v.attendance_payout_mode === 'threshold' && String(v.min_attendance_days).trim()) {
      const n = Number(v.min_attendance_days);
      const totalSessions = sessionDates.size;
      if (!Number.isInteger(n) || n < 1 || (totalSessions > 0 && n > totalSessions)) {
        e.min_attendance_days =
          totalSessions > 0
            ? `1~${totalSessions}일 사이여야 합니다(현재 고른 진행일 기준).`
            : '진행일을 먼저 선택해 주세요.';
      }
    }
    return e;
  }, [v.points, v.capacity, v.date, v.end_date, v.attendance_payout_mode, v.min_attendance_days, isPeriod, sessionDates]);

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

  // [진행일 그리드 핸들러 3개] 저장하는 값은 언제나 sessionDates(Set) 하나뿐 — 프리셋/요일칩/개별
  // 클릭 전부 이 Set을 채우는 도우미일 뿐 각자의 "모드"를 별도로 기억하지 않는다(원칙: 명시적 상태 하나).
  const applyPreset = useCallback(
    (preset) => {
      const dates = datesBetween(v.date, v.end_date);
      let next;
      if (preset === 'weekday') next = dates.filter((d) => weekdayOf(d) >= 1 && weekdayOf(d) <= 5);
      else if (preset === 'weekend') next = dates.filter((d) => weekdayOf(d) === 0 || weekdayOf(d) === 6);
      else if (preset === 'everyOther') next = dates.filter((_, i) => i % 2 === 0);
      else next = dates; // 'all'
      setSessionDates(new Set(next));
    },
    [v.date, v.end_date]
  );

  const toggleWeekday = useCallback(
    (w) => {
      const matching = datesBetween(v.date, v.end_date).filter((d) => weekdayOf(d) === w);
      setSessionDates((prev) => {
        const allSelected = matching.length > 0 && matching.every((d) => prev.has(d));
        const next = new Set(prev);
        matching.forEach((d) => (allSelected ? next.delete(d) : next.add(d)));
        return next;
      });
    },
    [v.date, v.end_date]
  );

  const toggleDate = useCallback((d) => {
    setSessionDates((prev) => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d);
      else next.add(d);
      return next;
    });
  }, []);

  /** 파일 선택 → (업로드하지 않고) 자르기 패널을 연다. */
  const handlePhotoPick = useCallback((e) => {
    const file = e.target.files?.[0];
    // [값을 비우는 이유] 같은 파일을 다시 고르면 change 가 발생하지 않는다 — 자르기를 취소한 뒤
    // 같은 사진을 다시 고르는 게 가장 흔한 시나리오인데 그때 아무 반응이 없게 된다.
    e.target.value = '';
    if (!file) return;

    setPhotoErr(null);
    try {
      // 못 읽을 파일이면 자르기 창을 열기 전에 말해준다.
      validateImageFile(file);
      setCropFile(file);
    } catch (err) {
      setPhotoErr(err instanceof ProgramImageError ? err.message : PROGRAM_IMAGE_RULE_MSG);
    }
  }, []);

  /** 자르기 확정 → 그 결과물만 업로드 → 성공하면 폼 값이 URL 로 바뀐다. */
  const handleCropConfirm = useCallback(
    async (blob) => {
      setPhotoErr(null);
      setUploading(true);
      try {
        const url = await uploadProgramImage(adminId, blob);
        setV((prev) => ({ ...prev, image_url: url }));
        setCropFile(null); // 성공했을 때만 닫는다 — 실패하면 고른 영역 그대로 다시 시도할 수 있다.
      } catch (err) {
        console.error('[AdminPrograms] 사진 업로드 실패:', err);
        setPhotoErr(err instanceof ProgramImageError ? err.message : PROGRAM_IMAGE_RULE_MSG);
      } finally {
        setUploading(false);
      }
    },
    [adminId]
  );

  /** 사진 지우기 — 폼 값만 비운다. 스토리지 오브젝트는 지우지 않는다(ADR 0022 / 마이그레이션 3절):
   *  저장하지 않고 취소하면 DB 는 여전히 옛 URL 을 가리키므로, 여기서 지우면 그 행이 깨진다. */
  const clearPhoto = useCallback(() => {
    setPhotoErr(null);
    setV((prev) => ({ ...prev, image_url: '' }));
  }, []);

  // 스크롤 컨테이너는 .mbody 가 아니라 .modal 이다(overflow:auto 가 거기 있다).
  // 첫 오류 필드가 접힌 스크롤 아래에 있으면 "눌리지도 않고 이유도 안 보이는" 상태가 된다.
  const scrollFormTop = () =>
    bodyRef.current?.closest('.modal')?.scrollTo({ top: 0, behavior: 'smooth' });

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitted(true);
    setServerErr(null);
    // 업로드가 끝나기 전에 저장하면 방금 고른 사진 없이 저장된다(폼 값이 아직 옛 URL 이다).
    if (uploading) return;
    if (locked || Object.keys(missing).length > 0) {
      scrollFormTop();
      return;
    }

    const payload = {
      category: v.category,
      title: v.title.trim(),
      org: v.org.trim(),
      description: v.description.trim(),
      // 빈 문자열이 아니라 null 을 보낸다 — DB 체크(programs_image_url_shape)가 '^https://' 를
      // 요구하므로 ''는 23514 로 튄다. "사진 없음"의 표현은 NULL 하나다.
      image_url: v.image_url || null,
      date: v.date,
      // 체크가 꺼져 있으면 v.end_date에 남은 값이 있어도(예: 껐다 켰다) 무시하고 null을 보낸다 —
      // "기간제 프로그램" 체크박스가 유일한 소유자다.
      end_date: isPeriod ? v.end_date : null,
      attendance_payout_mode: isPeriod ? v.attendance_payout_mode : null,
      min_attendance_days:
        isPeriod && v.attendance_payout_mode === 'threshold' ? Number(v.min_attendance_days) : null,
      // 정렬은 의미가 없다(DB 제약이 min/max만 본다) — 그래도 보기 좋으라고 오름차순으로 보낸다.
      session_dates: isPeriod ? [...sessionDates].sort() : null,
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

          {/* [대표 사진 — ADR 0022] 선택 항목이다. 없으면 지금까지처럼 활동 유형 아이콘이 그려지므로
              "사진 없는 프로그램"이 미완성으로 보이지 않는다(기존 20여 행이 전부 그 상태다).
              필수로 만들지 않는 이유이기도 하다 — 필수가 되면 사진을 못 구한 활동은 올릴 수 없게 된다.
              [원칙 4] 사진은 활동(포트폴리오) 쪽 요소라 포인트 칸보다 위에 둔다. */}
          <div className={photoErr ? 'pf err' : 'pf'}>
            <label htmlFor="pf-photo">대표 사진</label>

            {/* 실제 입력칸은 숨기고 버튼으로 연다 — file input 의 기본 모양("파일 선택 없음")은
                디자인 시스템 밖이고 문구도 손댈 수 없다. label htmlFor 는 그대로 살아 있어
                위의 "대표 사진" 라벨을 눌러도 열린다.
                [자르기 중에도 마운트를 유지한다] 조건부 안에 넣으면 fileRef.current 가 사라져
                패널을 닫은 뒤 "사진 바꾸기"가 아무 반응도 하지 않는 버튼이 된다. */}
            <input
              ref={fileRef}
              id="pf-photo"
              type="file"
              className="pf-photo-input"
              accept="image/jpeg,image/png,image/webp"
              onChange={handlePhotoPick}
              disabled={uploading || Boolean(cropFile)}
            />

            {cropFile ? (
              <ImageCropper
                file={cropFile}
                busy={uploading}
                onCancel={() => setCropFile(null)}
                onConfirm={handleCropConfirm}
              />
            ) : (
              <div className="pf-photo">
                {v.image_url ? (
                  <img className="pf-photo-preview" src={v.image_url} alt="선택한 대표 사진 미리보기" />
                ) : (
                  <div className="pf-photo-empty">
                    <Icon name="ic-image" size={24} />
                    <span>사진을 올리지 않으면 활동 유형 아이콘이 표시됩니다.</span>
                  </div>
                )}

                <div className="pf-photo-acts">
                  <button
                    type="button"
                    className="pf-photo-btn"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploading}
                  >
                    <Icon name="ic-image" size={15} />
                    {v.image_url ? '사진 바꾸기' : '사진 올리기'}
                  </button>
                  {v.image_url && !uploading && (
                    <button type="button" className="pf-photo-btn ghost" onClick={clearPhoto}>
                      <Icon name="ic-close" size={14} />
                      지우기
                    </button>
                  )}
                </div>
              </div>
            )}

            {photoErr ? (
              <p className="pf-msg err">{photoErr}</p>
            ) : (
              !cropFile && (
                <p className="pf-msg hint">
                  JPG·PNG·WEBP, 15MB 이하. 사진을 고르면 <b>어느 부분을 보여줄지 직접 정하는
                  화면</b>이 나와요 — 거기서 확정한 영역이 그대로 학생 카드에 올라갑니다.
                </p>
              )
            )}
          </div>

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

          {/* [기간제 프로그램 — 20260809140000 마이그레이션] 공유학교·온라인학교처럼 하루가 아니라
              여러 날에 걸쳐 진행되는 프로그램. 켜면 종료일이 필수가 되고, 학생은 그 기간 동안 매일
              QR 센터에서 그날의 입·퇴장을 따로 인증한다(원칙 5 — QR 단순화 금지를 매일 단위로 적용). */}
          <label className="pf-check">
            <input
              type="checkbox"
              checked={isPeriod}
              onChange={(e) => {
                const checked = e.target.checked;
                setIsPeriod(checked);
                if (!checked) {
                  // 체크를 끄면 종료일·지급 방식·최소일수·진행일 목록을 모두 초기화한다 — payload는 이미
                  // isPeriod로 null을 보내지만, 다시 켰을 때 지난 값이 남아있는 것도 혼란스러우므로 지운다.
                  setV((prev) => ({ ...prev, end_date: '', attendance_payout_mode: 'full', min_attendance_days: '' }));
                  setSessionDates(new Set());
                }
              }}
            />
            <span>기간제 프로그램 (공유학교·온라인학교처럼 여러 날에 걸쳐 진행)</span>
          </label>

          {isPeriod && (
            <Field
              label="종료일"
              htmlFor="pf-enddate"
              required
              error={errorOf('end_date')}
              hint="학생은 시작일~종료일 동안 매일 입·퇴장 QR을 인증합니다."
            >
              <input
                id="pf-enddate"
                type="date"
                value={v.end_date}
                onChange={set('end_date')}
                onBlur={blur('end_date')}
                min={v.date || undefined}
              />
            </Field>
          )}

          {/* [진행일 — 20260809180000] 종료일까지 정해져야 그릴 수 있다(범위가 있어야 날짜 목록이 나온다). */}
          {isPeriod && v.date && v.end_date && (
            <div className={errorOf('session_dates') ? 'pf err' : 'pf'}>
              <label>
                진행일<em className="req">필수</em>
              </label>
              <SessionDatesPicker
                startIso={v.date}
                endIso={v.end_date}
                selected={sessionDates}
                onPreset={applyPreset}
                onToggleWeekday={toggleWeekday}
                onToggleDate={toggleDate}
              />
              {errorOf('session_dates') && <p className="pf-msg err">{errorOf('session_dates')}</p>}
              {!errorOf('session_dates') && (
                <p className="pf-msg hint">
                  빠른 채우기로 큰 틀을 잡고, 달력에서 개별 날짜를 눌러 세부 조정하세요.
                </p>
              )}
            </div>
          )}

          {isPeriod && (
            <Field
              label="포인트 지급 방식"
              htmlFor="pf-payoutmode"
              required
              error={errorOf('attendance_payout_mode')}
              hint={
                v.attendance_payout_mode === 'per_session'
                  ? '퇴장 인증을 할 때마다 매번 지급 포인트만큼 지급됩니다.'
                  : v.attendance_payout_mode === 'threshold'
                    ? '아래 최소 참여일수에 도달한 퇴장 인증에서 한 번 지급됩니다.'
                    : '종료일 퇴장 인증 시 한 번 지급됩니다.'
              }
            >
              <select
                id="pf-payoutmode"
                value={v.attendance_payout_mode}
                onChange={set('attendance_payout_mode')}
                onBlur={blur('attendance_payout_mode')}
              >
                {PAYOUT_MODE_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </Field>
          )}

          {isPeriod && v.attendance_payout_mode === 'threshold' && (
            <Field
              label="최소 참여일수"
              htmlFor="pf-mindays"
              required
              error={errorOf('min_attendance_days')}
              hint={
                sessionDates.size > 0
                  ? `현재 고른 진행일은 총 ${sessionDates.size}일입니다.`
                  : '진행일을 먼저 선택해 주세요.'
              }
            >
              <input
                id="pf-mindays"
                type="number"
                inputMode="numeric"
                min={1}
                max={sessionDates.size || undefined}
                value={v.min_attendance_days}
                onChange={set('min_attendance_days')}
                onBlur={blur('min_attendance_days')}
                placeholder="예) 8"
              />
            </Field>
          )}

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

            {/* [hint를 쓰는 이유 — ADR 0018] placeholder는 값이 있으면(수정 모드처럼 이미 숫자가
                채워진 경우) 아예 안 보인다 — "지우면 무제한이 된다"는 사실을 수정 화면에서는 영원히
                알 수 없었다. hint는 값과 무관하게 항상 떠 있어 새 프로그램/수정 화면 모두에서 같은
                정보를 준다. */}
            <Field
              label="정원"
              htmlFor="pf-capacity"
              error={errorOf('capacity')}
              hint="비워두면 정원 제한 없음"
            >
              <input
                id="pf-capacity"
                type="number"
                inputMode="numeric"
                min={1}
                value={v.capacity}
                onChange={set('capacity')}
                onBlur={blur('capacity')}
                placeholder="예) 20"
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
            <button type="button" className="pf-btn ghost" onClick={onClose} disabled={saving || uploading}>
              취소
            </button>
            {/* 업로드 중 저장을 막는다 — 누르면 방금 고른 사진 없이 저장된다(handleSubmit 의 가드와 짝). */}
            <button type="submit" className="pf-btn primary" disabled={saving || uploading || locked}>
              {saving ? '저장 중…' : uploading ? '사진 올리는 중…' : isEdit ? '저장' : '초안으로 저장'}
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

/**
 * 기간제 프로그램의 진행일 선택 UI (20260809180000). 저장되는 값은 selected(Set) 그대로 —
 * 프리셋/요일칩/개별 클릭은 전부 이 컴포넌트 밖(ProgramFormModal)의 핸들러 3개가 처리하고,
 * 여기는 순수하게 그 결과를 그린다(제어 컴포넌트).
 */
function SessionDatesPicker({ startIso, endIso, selected, onPreset, onToggleWeekday, onToggleDate }) {
  const dates = datesBetween(startIso, endIso);
  if (dates.length === 0) return null;

  // 그리드가 요일 열에 맞게 정렬되도록 시작일 앞을 그 주의 일요일까지 빈 칸으로 채운다.
  const leadingBlanks = weekdayOf(dates[0]);
  const cells = [...Array(leadingBlanks).fill(null), ...dates];

  return (
    <div className="pf-sessionpicker">
      <div className="pf-sessionpresets">
        <button type="button" onClick={() => onPreset('all')}>
          매일
        </button>
        <button type="button" onClick={() => onPreset('weekday')}>
          평일만
        </button>
        <button type="button" onClick={() => onPreset('weekend')}>
          주말만
        </button>
        <button type="button" onClick={() => onPreset('everyOther')}>
          격일
        </button>
      </div>

      {/* 요일 칩 — 눌린 요일에 해당하는 날짜 전부를 한 번에 토글한다("특정 요일마다"를 이 칩들의
          조합으로 표현한다: 예) 월+수+금 = 매주 월수금). 이미 그 요일 전부가 선택된 상태면 끈다. */}
      <div className="pf-weekdaychips">
        {DOW.map((label, w) => {
          const matching = dates.filter((d) => weekdayOf(d) === w);
          const active = matching.length > 0 && matching.every((d) => selected.has(d));
          return (
            <button
              key={label}
              type="button"
              className={active ? 'pf-daychip on' : 'pf-daychip'}
              aria-pressed={active}
              disabled={matching.length === 0}
              onClick={() => onToggleWeekday(w)}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="pf-sessiongrid">
        {DOW.map((label) => (
          <div key={label} className="pf-sessiondow">
            {label}
          </div>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <div key={`blank-${i}`} className="pf-sessioncell blank" aria-hidden="true" />
          ) : (
            <button
              key={d}
              type="button"
              className={selected.has(d) ? 'pf-sessioncell on' : 'pf-sessioncell'}
              aria-pressed={selected.has(d)}
              onClick={() => onToggleDate(d)}
            >
              {Number(d.slice(8, 10))}
            </button>
          )
        )}
      </div>

      {/* 원칙 1 — 분모 없는 개수만. "8/20일" 같은 비율은 만들지 않는다. */}
      <div className="pf-sessioncount">{selected.size}일 선택됨</div>
    </div>
  );
}
