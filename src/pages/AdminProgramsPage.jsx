// Accumu v2 — 관리자 프로그램 관리 (docs/specs/admin-programs.md)
//
// 관리자 기능 3종(CLAUDE.md 2장 6번) 중 1번: 프로그램 올리기 / 내리기 / 수정.
// 지금까지 프로그램은 시드로만 존재했고 앱 안에서 프로그램이 태어나는 경로가 없었다. 그 한 칸을 채우는 화면.
//
// [행 경계] created_by = auth.uid() (ADR 0005 결정 7-0 축 A). 남의 프로그램은 목록에 뜨지 않는다 —
//   띄우면 "누르면 반드시 실패하는 버튼"이 된다.
// [삭제가 없다] delete 정책 0개. "내리기"는 is_published=false 토글이다. 삭제 UI를 만들지 않는다.
//
// [★ 끝난 프로그램은 수정할 수 없다 — ADR 0025 / 20260821120000]
//   진행이 끝난 프로그램(coalesce(end_date, date) < 오늘)에는 이미 참여한 학생과 지급된 포인트가
//   붙어 있다. 그 내용을 나중에 바꾸는 것은 **끝난 사실의 기록을 고치는 일**이라 서버 트리거가 막는다.
//   화면은 그 사실을 미리 말해줄 뿐이다(수정 버튼 비활성) — 경계는 트리거다.
//   게시 상태(올리기/내리기)는 끝난 뒤에도 계속 바꿀 수 있다. stale 알림이 요구하는 행동이 "내리기"라서,
//   그것까지 막으면 앱이 하라는 일을 앱이 막는 상태가 된다.
//
// [원칙 1·6 가드 — 이 화면에 없는 것]
//   신청자 명단 / 학번·이름 / 출석률 / 랭킹 / popularity / "남은 자리 N석"(비율·게이지).
//   [ADR 0016로 예외가 하나 생겼다 — 신청자 수] 케빈이 학생 화면에 신청자 수를 열면서 관리자 목록에도
//   보여주기로 확정했다(2026-08-10). program_applicant_counts() RPC가 이제 authenticated 전체에
//   grant돼 있어 "데이터를 얻을 수조차 없다"는 더 이상 사실이 아니다 — 명단(누가)은 여전히 닫혀 있고
//   (ADR 0005 결정 7-2(d)), 숫자(몇 명)만 열렸다. N/20명처럼 정원과 나란히 적어도 게이지·퍼센트를
//   그리지 않는 한 비율 표시가 아니다(ADR 0016).
//   그래서 게시중단 고지 문구는 여전히 참여자 유무로 분기하지 않는다 — 그건 데이터가 없어서가 아니라
//   "내려도 참여 기록은 유지된다"는 사실이 신청자 수와 무관하게 항상 같기 때문이다.
// [원칙 4] 시각 위계는 제목·카테고리·날짜(brand blue)가 먼저, 포인트는 우측 끝 작은 amber 한 칸.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import Toast from '../components/Toast';
import Modal from '../components/Modal';
import ProgramFormModal from '../components/admin/ProgramFormModal';
import { catOf, statusOf } from '../lib/taxonomy';
import { endOfProgram, fmtDateRange, isProgramOver, todayISO } from '../lib/date';
import {
  fetchAdminPrograms,
  fetchApplicantCounts,
  publishMyProgram,
  setProgramPublished,
} from '../lib/programService';
import { describeSaveError } from '../lib/programErrors';
import '../styles/AdminShell.css';

export default function AdminProgramsPage() {
  const { profile } = useAuth();
  const adminId = profile?.id;

  const [rows, setRows] = useState([]);
  // program_id -> 신청자 수(applied+entered+completed). ADR 0016 예외 — 관리자에게도 "몇 명"은 연다.
  const [applicantCounts, setApplicantCounts] = useState(() => new Map());
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'
  const [form, setForm] = useState(null); // { mode: 'create'|'edit', program }
  const [confirmRow, setConfirmRow] = useState(null); // 내리기 확인 대상 (확정 J)
  // [ADR 0026] 올리기 확인 대상. 내리기보다 **되돌리기 어려운** 쪽인데 확인이 없었다 —
  //   내린 프로그램은 아무도 못 보지만, 올린 프로그램은 이미 본 학생을 되돌릴 수 없다.
  const [publishRow, setPublishRow] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [toast, setToast] = useState(null);
  const [alert, setAlert] = useState(null); // 토글 실패 배너 — 조용히 삼키지 않는다
  const [highlight, setHighlight] = useState(null); // { id, seq }
  const [pastOpen, setPastOpen] = useState(false);

  const rowRefs = useRef(new Map());
  const today = todayISO();

  useEffect(() => {
    let cancelled = false;
    if (!adminId) return undefined;

    (async () => {
      setState('loading');
      try {
        // 신청자 수 조회 실패는 목록 자체를 죽일 이유가 아니다 — fetchApplicantCounts()가 이미
        // 실패를 빈 Map으로 축약해 준다(programService.js).
        const [data, counts] = await Promise.all([fetchAdminPrograms(adminId), fetchApplicantCounts()]);
        if (cancelled) return;
        setRows(data);
        setApplicantCounts(counts);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        // 셸과 다른 메뉴는 살아 있어야 한다. 원본 에러는 콘솔에 남긴다.
        console.error('[AdminPrograms] 프로그램 조회 실패:', err);
        setRows([]);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [adminId]);

  // 확정 C — 날짜 축 2그룹. "오늘·예정" 오름차순(가까운 것 먼저) / "지난 프로그램" 내림차순.
  // 미게시 행도 이 축 안에 섞인다(게시 상태로 그룹을 나누지 않는다 — 확정 B).
  //
  // [ADR 0025 — 기준을 date 에서 coalesce(end_date, date) 로 바꿨다]
  //   전에는 시작일만 봐서 **진행 중인 기간제**가 '지난 프로그램'으로 접혀 들어갔다(8/1~8/30 짜리를
  //   8/15 에 열면 '지남'). 수정 잠금이 생기면서 이 어긋남이 눈에 보이게 됐다 — 지난 그룹에 있는데
  //   수정 버튼은 켜져 있는 행이 생긴다. 두 자리가 같은 식을 쓰도록 맞춘다.
  const { upcoming, past } = useMemo(() => {
    const asc = (a, b) => endOfProgram(a).localeCompare(endOfProgram(b));
    return {
      upcoming: rows.filter((p) => !isProgramOver(p, today)).sort(asc),
      past: rows.filter((p) => isProgramOver(p, today)).sort((a, b) => asc(b, a)),
    };
  }, [rows, today]);

  // 저장·토글 직후 그 행으로 스크롤 + 짧은 하이라이트.
  // [필수 요구사항인 이유] 목록이 날짜 축 정렬이라 새 초안이 맨 위가 아니라 날짜 위치에 꽂힌다.
  //   안 하면 "저장했는데 어디 갔지?"가 된다 (확정 C x D 상호작용).
  useEffect(() => {
    if (!highlight) return undefined;
    const el = rowRefs.current.get(highlight.id);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setHighlight(null), 2200);
    return () => clearTimeout(t);
  }, [highlight]);

  // 대상 행이 접힌 "지난 프로그램" 안에 있으면 먼저 펼친다 — 안 그러면 스크롤할 DOM 이 없다.
  const focusRow = useCallback(
    (row) => {
      if (isProgramOver(row, today)) setPastOpen(true);
      setHighlight({ id: row.id, seq: Date.now() });
    },
    [today]
  );

  const dismissToast = useCallback(() => setToast(null), []);

  const handleSaved = useCallback(
    (row, mode) => {
      // 서버가 돌려준 행으로 갱신한다(낙관적 삽입 후 방치 금지).
      setRows((prev) =>
        mode === 'edit' ? prev.map((r) => (r.id === row.id ? row : r)) : [...prev, row]
      );
      setForm(null);
      setAlert(null);
      setToast({
        id: Date.now(),
        message:
          mode === 'edit'
            ? '수정 내용을 저장했어요'
            : '초안으로 저장했어요. ‘올리기’를 눌러야 학생에게 공개됩니다',
      });
      focusRow(row);
    },
    [focusRow]
  );

  // 내리기 — 평범한 update 다. 올리기와 달리 조건 검사가 없다(ADR 0026): stale 알림이 요구하는
  // 행동이 "내리기"라서 그쪽에 문턱을 두면 앱이 하라는 일을 앱이 막게 된다.
  //   >>> 여기로 is_published: true 를 보내지 말 것. 트리거 programs_publish_gate 가 거부한다.
  const handleUnpublish = useCallback(
    async (program) => {
      setAlert(null);
      setBusyId(program.id);
      try {
        const row = await setProgramPublished(program.id, false);
        setRows((prev) => prev.map((r) => (r.id === row.id ? row : r)));
        setConfirmRow(null);
        setToast({ id: Date.now(), message: '게시를 중단했어요. 언제든 다시 올릴 수 있어요' });
        focusRow(row);
      } catch (err) {
        console.error('[AdminPrograms] 게시 중단 실패:', err);
        setConfirmRow(null);
        setAlert(describeSaveError(err).message);
      } finally {
        setBusyId(null);
      }
    },
    [focusRow]
  );

  // 게시 — 서버가 조건을 검사한 뒤에만 공개된다(publish_my_program). 실패는 예외가 아니라
  // "무엇이 부족한지"라서 alert 배너가 아니라 확인 창 안에 그대로 남긴다.
  const handlePublish = useCallback(
    async (program) => {
      setAlert(null);
      setBusyId(program.id);
      try {
        const res = await publishMyProgram(program.id);
        if (!res.ok) return res.message;
        // RPC 는 행을 돌려주지 않는다(검사 결과가 본체다) — 화면 상태만 맞춘다.
        const next = { ...program, is_published: true };
        setRows((prev) => prev.map((r) => (r.id === program.id ? next : r)));
        setPublishRow(null);
        setToast({ id: Date.now(), message: '학생에게 공개했어요' });
        focusRow(next);
        return null;
      } finally {
        setBusyId(null);
      }
    },
    [focusRow]
  );

  const renderRow = (p) => (
    <ProgramRow
      key={p.id}
      program={p}
      applicantCount={applicantCounts.get(p.id) ?? 0}
      busy={busyId === p.id}
      highlighted={highlight?.id === p.id}
      rowRef={(el) => {
        if (el) rowRefs.current.set(p.id, el);
        else rowRefs.current.delete(p.id);
      }}
      locked={isProgramOver(p, today)}
      onEdit={() => setForm({ mode: 'edit', program: p })}
      onPublish={() => setPublishRow(p)}
      onUnpublish={() => setConfirmRow(p)}
    />
  );

  return (
    <section className="screen">
      <div className="sec-head">
        <div>
          <div className="eyebrow">Programs</div>
          <h2 className="sec">프로그램 관리</h2>
          <div className="sec-sub">내가 올린 프로그램을 관리합니다</div>
        </div>
        <button type="button" className="adm-scanall" onClick={() => setForm({ mode: 'create' })}>
          <Icon name="ic-plus" size={17} />
          새 프로그램 올리기
        </button>
      </div>

      {alert && (
        <div className="adm-alert" role="alert">
          <Icon name="ic-alert" size={17} />
          <span>{alert}</span>
          <button type="button" className="x" onClick={() => setAlert(null)} aria-label="닫기">
            <Icon name="ic-close" size={15} />
          </button>
        </div>
      )}

      {state === 'loading' && <div className="empty">프로그램을 불러오는 중…</div>}

      {state === 'error' && (
        <div className="empty">
          프로그램을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' && rows.length === 0 && (
        <div className="empty">
          아직 올린 프로그램이 없습니다.
          <br />
          우측 상단에서 새 프로그램을 올려보세요.
        </div>
      )}

      {state === 'ready' && upcoming.length > 0 && (
        <>
          <div className="adm-grouphead">
            <h3>오늘 · 예정</h3>
            <span className="cnt">{upcoming.length}건</span>
          </div>
          <div className="adm-list">{upcoming.map(renderRow)}</div>
        </>
      )}

      {state === 'ready' && past.length > 0 && (
        <div className="adm-fold">
          {/* 기본 접힘. <details> 대신 제어 상태를 쓰는 이유: 저장·토글 후 이 안의 행으로 스크롤해야 할 때
              프로그램적으로 펼쳐야 한다. */}
          <button
            type="button"
            className="adm-foldbtn"
            aria-expanded={pastOpen}
            onClick={() => setPastOpen((o) => !o)}
          >
            <Icon name="ic-clock" size={16} />
            지난 프로그램
            <span className="cnt">{past.length}건</span>
            <span className={pastOpen ? 'chev on' : 'chev'} aria-hidden="true" />
          </button>
          {pastOpen && <div className="adm-list">{past.map(renderRow)}</div>}
        </div>
      )}

      {form && (
        <ProgramFormModal
          mode={form.mode}
          program={form.program ?? null}
          adminId={adminId}
          onClose={() => setForm(null)}
          onSaved={handleSaved}
        />
      )}

      {publishRow && (
        <PublishConfirm
          program={publishRow}
          busy={busyId === publishRow.id}
          onCancel={() => setPublishRow(null)}
          onConfirm={() => handlePublish(publishRow)}
        />
      )}

      {confirmRow && (
        <UnpublishConfirm
          program={confirmRow}
          busy={busyId === confirmRow.id}
          onCancel={() => setConfirmRow(null)}
          onConfirm={() => handleUnpublish(confirmRow)}
        />
      )}

      {toast && <Toast key={toast.id} message={toast.message} onDone={dismissToast} />}
    </section>
  );
}

/* ---------- 목록 행 (관리자 홈의 .adm-row 를 확장) ---------- */
function ProgramRow({ program, applicantCount = 0, busy, locked = false, highlighted, rowRef, onEdit, onPublish, onUnpublish }) {
  const cat = catOf(program.category);
  const st = statusOf(program.status);
  const published = program.is_published;

  const cls = ['adm-row', 'prog'];
  if (!published) cls.push('unpub'); // 확정 B: 배지 + 행 흐림
  if (highlighted) cls.push('hl');

  return (
    <div className={cls.join(' ')} ref={rowRef}>
      {/* [사진 — ADR 0022] 올린 사진을 목록에서 바로 확인할 수 있게 아이콘 자리에 작게 띄운다.
          [학생 화면과 달리 onError fallback 을 두지 않는다] 학생에게는 깨진 사진을 숨기는 게 맞지만,
          관리자에게는 "사진이 깨졌다"가 고쳐야 할 사실이다 — 숨기면 다시 올릴 이유를 못 본다. */}
      <div className="ic" style={{ background: cat.soft }}>
        {program.image_url ? (
          <img className="ic-photo" src={program.image_url} alt="" loading="lazy" />
        ) : (
          <Icon name={cat.icon} size={20} color={cat.color} />
        )}
      </div>

      <div className="info">
        <h5>{program.title}</h5>
        <div className="m">
          {/* group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014.
              기간제(end_date 있음)는 범위로 찍힌다 — fmtDateRange가 단일 일자면 fmtDate와 같다.
              [신청 N명 — ADR 0016 예외] 명단(누가)은 여전히 안 보이지만 숫자(몇 명)는 이제 보인다.
              정원이 있으면 나란히 적는다 — 게이지·퍼센트가 아니라 두 사실의 병기다. */}
          {[
            cat.name,
            program.org,
            fmtDateRange(program.date, program.end_date),
            program.time,
            `신청 ${applicantCount}명${program.capacity != null ? ` · 정원 ${program.capacity}명` : ''}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
        <div className="badges">
          {/* 초안과 "내렸던 것"을 구분하지 않는다 — DB 에 그 구분이 없다(확정 D). 배지는 "미게시" 하나. */}
          <span className={published ? 'pubbadge on' : 'pubbadge'}>
            {published ? '게시중' : '미게시'}
          </span>
          <span className={`badge ${st.cls}`}>{st.label}</span>
          {/* 끝난 프로그램임을 배지로도 말해준다 — 비활성 버튼만으로는 이유가 전달되지 않는다.
              게시 상태는 여전히 바꿀 수 있으므로 "잠김"이 아니라 "수정 잠금"이다. */}
          {locked && <span className="pubbadge lock">수정 잠금</span>}
        </div>
      </div>

      {/* 포인트는 amber 한 칸, 작게 (원칙 4) */}
      {program.points != null && <div className="pt">{program.points.toLocaleString()}P</div>}

      <div className="adm-acts">
        {/* [ADR 0025] 끝난 프로그램은 내용을 못 고친다. 버튼을 숨기지 않고 **비활성 + 사유**로 둔다 —
            숨기면 "수정 기능이 어디 갔지"가 되고, 왜 못 하는지는 영영 알 수 없다. */}
        <button
          type="button"
          className="adm-act"
          onClick={onEdit}
          disabled={busy || locked}
          title={locked ? '진행이 끝난 프로그램은 내용을 수정할 수 없습니다' : undefined}
        >
          <Icon name={locked ? 'ic-lock' : 'ic-edit'} size={15} />
          수정
        </button>
        {published ? (
          // 확정 J — 내리기는 확인 창을 거친다(되돌릴 수 있지만 학생 화면에 열화가 생긴다).
          <button type="button" className="adm-act warn" onClick={onUnpublish} disabled={busy}>
            <Icon name="ic-eye-off" size={15} />
            내리기
          </button>
        ) : (
          // 올리기는 확인 없이 즉시(위험이 없다). 문구는 "다시 올리기"가 아니라 "올리기"로 통일한다 —
          // 처음 올리는 초안에 대해 "다시"는 거짓말이 된다.
          <button type="button" className="adm-act primary" onClick={onPublish} disabled={busy}>
            <Icon name="ic-eye" size={15} />
            올리기
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------- 올리기 확인 창 (ADR 0026) ----------

   [★ 왜 확인 창이 필요한가]
     내리기에는 확인이 있었는데(확정 J) 올리기에는 없었다. 그런데 **되돌리기 어려운 쪽은 올리기다** —
     내린 프로그램은 아무도 못 보지만, 올린 프로그램은 이미 본 학생을 되돌릴 수 없다.

   [세 관문]
     1) 미리보기   — 학생 화면에 어떻게 보이는지 그대로 (등록 폼에서는 절대 안 보이는 모습이다)
     2) 체크리스트 — 서버가 판정할 수 없는 사실을 관리자가 스스로 확인한다
     3) 서버 검사  — publish_my_program() 이 설명 길이·날짜·진행일을 본다 (실패 사유가 여기 뜬다)

   [★ 체크리스트 3문장 = 공개 신고 사유 3종]
     여기서 체크하는 것과, 참여하지 않은 학생이 신고할 수 있는 것이 **정확히 같은 목록**이다
     (reportService.js REPORT_REASONS 의 scope:'open' 3종).
     "네가 올리며 확인한 것이 곧 학생이 신고할 수 있는 것" — 그래서 신고가 취향 차이가 아니라
     약속 위반을 가리킨다. >>> 한쪽을 바꾸면 다른 쪽도 함께 바꿀 것.

   [체크를 저장하지 않는다] DB 에 컬럼을 만들지 않는다. 이건 기록이 아니라 **읽게 만드는 장치**다.
     저장하면 "언제 체크했나"를 보여줄 화면이 필요해지고, 그건 관리자 기능이 하나 더 느는 일이다. */
const PUBLISH_CHECKS = [
  { key: 'career', label: '학업(자습·문제풀이)이 아니라 진로·커리어 활동입니다' },
  { key: 'free', label: '참여에 수강료·재료비 등 비용이 들지 않습니다' },
  { key: 'proper', label: '고등학생 대상 활동으로 부적절한 내용이 없습니다' },
];

function PublishConfirm({ program, busy, onCancel, onConfirm }) {
  const [checked, setChecked] = useState(() => new Set());
  const [serverMsg, setServerMsg] = useState(null);

  const cat = catOf(program.category);
  const allChecked = checked.size === PUBLISH_CHECKS.length;

  const toggle = (key) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  async function handleConfirm() {
    setServerMsg(null);
    // 실패하면 사유 문자열이, 성공하면 null 이 온다(호출부가 창을 닫는다).
    const message = await onConfirm();
    if (message) setServerMsg(message);
  }

  return (
    <Modal onClose={busy ? () => {} : onCancel} labelledBy="pub-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="pub-title">학생에게 공개할까요?</h3>

        {/* 1) 미리보기 — 학생 목록의 카드와 같은 정보 순서(사진/유형·제목/주최·날짜·시간). */}
        <div className="pub-preview">
          <div className="pv-thumb" style={{ background: cat.soft }}>
            {program.image_url ? (
              <img src={program.image_url} alt="" loading="lazy" />
            ) : (
              <Icon name={cat.icon} size={22} color={cat.color} />
            )}
          </div>
          <div className="pv-info">
            <span className="pv-cat" style={{ color: cat.color, background: cat.soft }}>
              {cat.name}
            </span>
            <h5>{program.title}</h5>
            <div className="pv-meta">
              {[program.org, fmtDateRange(program.date, program.end_date), program.time]
                .filter(Boolean)
                .join(' · ')}
            </div>
          </div>
        </div>
        <p className="pv-caption">학생 목록에 이렇게 보입니다.</p>

        {/* 2) 체크리스트 — 서버가 알 수 없는 사실. 전부 체크해야 버튼이 열린다. */}
        <div className="pub-checks">
          {PUBLISH_CHECKS.map((c) => (
            <label key={c.key} className={checked.has(c.key) ? 'pub-check on' : 'pub-check'}>
              <input
                type="checkbox"
                checked={checked.has(c.key)}
                disabled={busy}
                onChange={() => toggle(c.key)}
              />
              <span>{c.label}</span>
            </label>
          ))}
        </div>

        {/* 어긴 채로 올리면 어떻게 되는지 말해준다 — 체크가 형식이 되지 않게. */}
        <p className="confirm-desc">
          공개하면 모든 학생의 목록에 즉시 나타나고, 신청을 받기 시작합니다.{' '}
          <b>위 세 가지는 학생이 그대로 신고할 수 있는 항목</b>이며, 서로 다른 학생 3명이 신고하면
          게시가 자동으로 중단됩니다.
        </p>

        {serverMsg && (
          <div className="join-err" role="alert">
            {serverMsg}
          </div>
        )}

        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button
            type="button"
            className="pf-btn primary"
            onClick={handleConfirm}
            disabled={busy || !allChecked}
          >
            {busy ? '처리 중…' : allChecked ? '공개하기' : '위 항목을 확인해 주세요'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/* ---------- 내리기 확인 창 (확정 J / ADR 0005 결정 7-4 영향 고지) ---------- */
function UnpublishConfirm({ program, busy, onCancel, onConfirm }) {
  return (
    <Modal onClose={busy ? () => {} : onCancel} labelledBy="unpub-title" className="confirm-modal">
      <div className="mbody">
        <h3 id="unpub-title">게시를 중단할까요?</h3>
        <p className="confirm-target">{program.title}</p>
        {/* [문구를 참여자 유무로 분기하지 않는다] ADR 0016 이후로 관리자가 신청자 "수"는 알 수 있지만,
            이 문구가 갈릴 이유는 원래 데이터 유무가 아니었다 — "내려도 참여 기록은 유지된다"는 사실이
            신청자가 0명이든 20명이든 항상 같아서다. 그래서 여기서 applicantCount를 참조하지 않는다. */}
        <p className="confirm-desc">
          학생에게 더 이상 보이지 않게 됩니다. <b>이미 신청한 학생의 참여 기록과 QR 인증은 그대로
          유지</b>되지만, 학생 화면에서 이 프로그램의 제목·날짜가 정상적으로 표시되지 않을 수 있습니다.
          언제든 다시 올릴 수 있습니다.
        </p>
        <div className="pf-actions">
          <button type="button" className="pf-btn ghost" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button type="button" className="pf-btn danger" onClick={onConfirm} disabled={busy}>
            {busy ? '처리 중…' : '내리기'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
