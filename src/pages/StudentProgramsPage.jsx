// Accumu v2 — 프로그램 선택 화면 (docs/specs/student-programs.md A절 / 확정 A-1~H-1)
// Accumu_prototype.html screen-programs(584~602줄) + renderPrograms()(900줄) 재현.
//
// [홈과 다른 점] `date >= 오늘`로 거르지 않는다. 지난 프로그램도 조회해서 "날짜 지난 프로그램" 그룹으로
//   따로 보여준다 (fetchAllPrograms).
// [원칙 1 가드] popularity는 "인기순" 정렬의 입력으로만 쓴다. 숫자·순위 라벨을 화면에 내지 않는다.
//   [ADR 0016 예외] 신청자 수(applicantCounts)는 다르다 — 순위/비교가 아니라 그 프로그램 하나의
//   사실이고, 케빈이 명시적으로 요청해서 열었다("신청자 수를 보이게 해"). "N명 신청"만 적고,
//   "TOP 인기"/"마감 임박"/게이지·퍼센트를 붙이지 않는다.
// [원칙 4 가드] 포인트순은 정렬 선택지 중 하나일 뿐 기본값이 아니다(기본값 인기순 — 확정 B-1).
//   포인트 amber는 카드 뱃지와 팝업 infogrid 1칸에서만. 큰 포인트 배너/"포인트 많이 주는 활동" 섹션 없음.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import Icon from '../components/Icon';
import Toast from '../components/Toast';
import ProgramCard from '../components/student/ProgramCard';
import JoinModal from '../components/student/JoinModal';
import { CAT, TRACK, catOf } from '../lib/taxonomy';
import { todayISO } from '../lib/date';
import {
  applyToProgram,
  cancelMyParticipation,
  fetchAllPrograms,
  fetchApplicantCounts,
  fetchMyParticipationsByProgram,
  fetchMyWaitlistPositions,
} from '../lib/programService';
import '../styles/StudentPrograms.css';

// [카테고리 그룹이 사라졌다 — ADR 0014]
//   2026-08-09 이전에는 '학교 내 활동' / '학교 외 활동' 두 그룹으로 8종을 나눠 그렸다(프로토타입 904줄).
//   교내/교외 축이 폐지되면서 그 묶음의 근거가 없어졌고, 유형이 4종이라 한 화면에 다 들어간다.
//   남는 구분은 "참여할 수 있는 것 / 날짜가 지난 것" 하나뿐이다 — 그건 학생이 실제로 신경 쓰는 축이다.
//   >>> 여기에 CAT 을 다시 묶는 그룹 배열을 만들지 말 것. 4종은 묶을 필요가 없다.
const ALL_CATS = Object.keys(CAT);

// 확정 B-1: 3종 유지, 기본값 인기순. (포인트순이 기본이 되면 절대 원칙 4 위반)
const SORTS = [
  { key: 'popular', label: '인기순' },
  { key: 'recent', label: '최신순' },
  { key: 'points', label: '포인트순' },
];

// 정렬 비교자. Array.prototype.sort는 안정 정렬이라 동점은 원래 순서를 유지한다.
const COMPARE = {
  popular: (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0), // 값은 정렬 입력일 뿐 화면에 렌더하지 않는다
  points: (a, b) => (b.points ?? 0) - (a.points ?? 0),
  recent: (a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')),
};

export default function StudentProgramsPage() {
  const { session } = useAuth();
  const studentId = session?.user?.id ?? null;

  const [programs, setPrograms] = useState([]);
  // program_id -> {id, status}. ADR 0016 이전에는 존재 여부만 봤지만(Set), 이제 대기중/신청됨을
  // 구분해야 하고 취소 버튼에 participation id 가 필요해 Map으로 바꿨다.
  const [participationByProgram, setParticipationByProgram] = useState(() => new Map());
  // program_id -> 신청자 수(applied+entered+completed). ADR 0016 — program_applicant_counts() RPC.
  const [applicantCounts, setApplicantCounts] = useState(() => new Map());
  // program_id -> 내 대기 순번(1부터). ADR 0018 — my_waitlist_positions() RPC.
  const [waitlistPositions, setWaitlistPositions] = useState(() => new Map());
  const [state, setState] = useState('loading'); // 'loading' | 'ready' | 'error'

  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState('popular');
  const [typeFilter, setTypeFilter] = useState('all'); // CAT key | 'all'
  const [trackFilter, setTrackFilter] = useState('all'); // TRACK key | 'all'

  const [openProgram, setOpenProgram] = useState(null);
  const [toast, setToast] = useState(null); // { id, message }

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState('loading');
      try {
        // 병렬 4쿼리 (ADR 0004 5번 — 조인 뷰/embed 기각).
        // fetchMyParticipationsByProgram/fetchApplicantCounts/fetchMyWaitlistPositions는 조회 실패를
        // 빈 Map으로 축약하므로, 마이그레이션 미적용 환경에서도 목록 자체는 뜬다.
        const [rows, participation, counts, positions] = await Promise.all([
          fetchAllPrograms(),
          fetchMyParticipationsByProgram(),
          fetchApplicantCounts(),
          fetchMyWaitlistPositions(),
        ]);
        if (cancelled) return;
        setPrograms(rows);
        setParticipationByProgram(participation);
        setApplicantCounts(counts);
        setWaitlistPositions(positions);
        setState('ready');
      } catch (err) {
        if (cancelled) return;
        // 마이그레이션 미적용/네트워크 오류 등 — 화면이 깨지지 않도록 목록만 에러 상태로 둔다.
        console.error('[StudentPrograms] 프로그램 목록 조회 실패:', err);
        setPrograms([]);
        setState('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // ---- 검색 / 필터 / 정렬 -> 그룹별 카테고리 행 ----
  const { upcomingRows, pastRows, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = todayISO(); // 로컬(KST) 기준. toISOString()은 오전 9시 이전에 하루 밀린다.

    // 검색 대상은 제목 + 주최 + 카테고리 표시명 (프로토타입 905줄). 설명은 대상이 아니다.
    // 줄바꿈으로 잇는다 — 그냥 이어붙이면 제목 끝과 주최 시작에 걸친 문자열이 우연히 매칭되는 오탐이 난다.
    const match = (p) =>
      !q || [p.title, p.org, catOf(p.category).name].join('\n').toLowerCase().includes(q);
    const trackOk = (p) => trackFilter === 'all' || p.career_track === trackFilter;

    const visible = programs.filter((p) => match(p) && trackOk(p));
    const sortAll = (list) => [...list].sort(COMPARE[sortMode]);

    const buildRows = (source) =>
      ALL_CATS.filter((catKey) => typeFilter === 'all' || catKey === typeFilter)
        .map((catKey) => ({
          catKey,
          label: CAT[catKey].name,
          list: sortAll(source.filter((p) => p.category === catKey)),
        }))
        // 프로그램이 0개인 카테고리 행은 렌더하지 않는다
        .filter((row) => row.list.length > 0);

    // [기간제] "지난"의 기준은 종료일이다 — 시작일이 지났어도 기간 중이면 여전히 참여할 수 있는 쪽이다.
    // [is_tutorial — ADR 0021] 튜토리얼 프로그램은 date 값 자체에 의미가 없다("상시 진행") — 어떤
    // 날짜를 넣어도 "지난 프로그램"으로 떨어지지 않게 항상 upcoming 쪽으로 분류한다.
    const endOf = (p) => p.end_date ?? p.date;
    const isPastProgram = (p) => !p.is_tutorial && endOf(p) < today;
    const nextUpcomingRows = buildRows(visible.filter((p) => !isPastProgram(p)));
    const nextPastRows = buildRows(visible.filter((p) => isPastProgram(p)));

    const count =
      nextUpcomingRows.reduce((m, r) => m + r.list.length, 0) +
      nextPastRows.reduce((m, r) => m + r.list.length, 0);

    return { upcomingRows: nextUpcomingRows, pastRows: nextPastRows, total: count };
  }, [programs, query, sortMode, typeFilter, trackFilter]);

  // 빈 상태 문구 (프로토타입 939줄 카피). 선택한 조건을 ` · `로 연결해 앞에 붙인다.
  // [이름만으로 충분하다 — ADR 0014] 예전에는 '대회'(hdc/edc)와 '기타'(het/eet)가 각각 둘씩이라
  // 그룹까지 붙여야 어느 칩을 눌렀는지 구분됐다. 4종에는 같은 이름이 없다.
  const emptyCond = [
    query.trim() && `'${query.trim()}'`,
    typeFilter !== 'all' && CAT[typeFilter]?.name,
    trackFilter !== 'all' && TRACK[trackFilter]?.name,
  ].filter(Boolean);

  // 안정된 참조로 넘겨야 Toast 내부의 자동 닫힘 타이머가 부모 리렌더마다 초기화되지 않는다.
  const dismissToast = useCallback(() => setToast(null), []);

  // 신청/취소 후 참여 상태 + 신청자 수를 다시 읽어 화면을 서버와 맞춘다. 낙관적 패치를 하지 않는 이유는
  // 둘 다 같다 — waitlisted로 등록될지 applied로 확정될지, 취소가 누군가를 승격시킬지는 서버만 안다.
  const refreshParticipation = useCallback(async () => {
    const [participation, counts, positions] = await Promise.all([
      fetchMyParticipationsByProgram(),
      fetchApplicantCounts(),
      fetchMyWaitlistPositions(),
    ]);
    setParticipationByProgram(participation);
    setApplicantCounts(counts);
    setWaitlistPositions(positions);
  }, []);

  // [신청자 수 신선도 — ADR 0018, 2026-08-11] 목록 로드 시점 스냅샷이라 페이지를 오래 열어 두면 다른 학생의
  // 신청·취소가 반영되지 않는다. 팝업을 열 때마다(가장 관심 있게 보는 순간) 조용히 다시 읽는다 —
  // 팝업 자체는 즉시 뜨고, 숫자만 몇백ms 뒤에 최신값으로 갱신된다. 실패해도 무시한다(기존 값 유지 —
  // fetchApplicantCounts/fetchMyParticipationsByProgram가 이미 실패를 삼키므로 여기선 던질 일이 없다).
  const handleOpenProgram = useCallback(
    (program) => {
      setOpenProgram(program);
      refreshParticipation();
    },
    [refreshParticipation]
  );

  const handleApply = useCallback(
    async (program) => {
      if (!studentId) throw new Error('로그인 세션이 없어 신청할 수 없습니다.');
      try {
        const result = await applyToProgram({ studentId, programId: program.id });

        // duplicate는 참여 행이 새로 생기지 않았으므로 재조회할 게 없다.
        if (result !== 'duplicate') await refreshParticipation();

        // ADR 0016: waitlisted도 이제 "거부"가 아니라 행이 실제로 생긴 성공 케이스다 — created와
        // 같은 흐름(팝업 닫힘 + 토스트)을 타고, 메시지만 갈린다.
        setOpenProgram(null);
        setToast({
          id: Date.now(),
          message:
            result === 'duplicate'
              ? '이미 신청한 프로그램이에요' // ADR 0004 구현 가이드 2번 — 에러 팝업 없이 상태만 맞춘다.
              : result === 'waitlisted'
                ? '정원이 가득 차 대기 명단에 등록됐어요'
                // [ADR 0018, 2026-08-11] "신청됐다"만 알리면 그다음 뭘 해야 하는지 몰라 QR 인증을 놓치는
                // 학생이 생긴다 — JoinModal의 안내문과 같은 이유로 QR 위치를 짧게 덧붙인다.
                : '신청이 완료되었어요 · 마이페이지에서 QR을 확인하세요',
        });
        return result;
      } catch (err) {
        // 정상 사용에선 발생하지 않는다(발생하면 RLS 위반 42501 또는 네트워크). 원본을 콘솔에 남기고
        // 팝업이 사용자에게 실패를 알리도록 다시 던진다.
        console.error('[StudentPrograms] 신청 실패:', err);
        throw err;
      }
    },
    [studentId, refreshParticipation]
  );

  // 신청 취소 (ADR 0016). too_late/already_started는 throw가 아니라 {ok:false} 로 오므로 팝업이
  // 열린 채 사유를 보여줄 수 있다 — 여기서는 그 경우 조용히 결과만 돌려주고 토스트를 띄우지 않는다.
  const handleCancel = useCallback(
    async (participationId) => {
      try {
        const result = await cancelMyParticipation(participationId);
        if (!result.ok) return result;

        await refreshParticipation();
        setOpenProgram(null);
        setToast({
          id: Date.now(),
          message: result.promoted
            ? '신청을 취소했어요 · 대기 중이던 학생이 자리를 이어받았어요'
            : '신청을 취소했어요',
        });
        return result;
      } catch (err) {
        console.error('[StudentPrograms] 취소 실패:', err);
        throw err;
      }
    },
    [refreshParticipation]
  );

  return (
    <section className="screen">
      <div className="sec-head programs-head">
        <div>
          <div className="eyebrow">Explore</div>
          <h2 className="sec">프로그램 선택</h2>
          <div className="sec-sub">카테고리를 가로로 넘기며 둘러보세요</div>
        </div>
      </div>

      {/* ===== 툴바: 검색 + 정렬 ===== */}
      <div className="toolbar">
        <div className="search">
          <span className="si">
            <Icon name="ic-search" size={20} />
          </span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="프로그램, 주최, 키워드 검색"
            aria-label="프로그램 검색"
          />
        </div>
        <SortSelect value={sortMode} onChange={setSortMode} />
      </div>

      {/* ===== 필터바: 유형(CAT) / 계열(TRACK) — 두 축은 AND로 결합 ===== */}
      <div className="filterbar">
        <FilterGroup
          icon="ic-grid"
          label="유형"
          value={typeFilter}
          onChange={setTypeFilter}
          options={Object.entries(CAT).map(([k, c]) => ({ key: k, name: c.name, color: c.color }))}
        />
        <FilterGroup
          icon="ic-target"
          label="계열"
          value={trackFilter}
          onChange={setTrackFilter}
          options={Object.entries(TRACK).map(([k, t]) => ({ key: k, name: t.name, color: t.color }))}
        />
      </div>

      {/* ===== 카테고리 영역 ===== */}
      {state === 'loading' && <div className="empty">프로그램을 불러오는 중…</div>}

      {state === 'error' && (
        <div className="empty">
          프로그램을 불러오지 못했어요.
          <br />
          잠시 후 다시 시도해 주세요.
        </div>
      )}

      {state === 'ready' && total === 0 && (
        <div className="empty">
          {emptyCond.length > 0 && `${emptyCond.join(' · ')} `}
          검색 결과가 없습니다. 다른 키워드나 필터를 확인해보세요.
        </div>
      )}

      {/* [그룹이 하나다 — ADR 0014] 교내/교외 두 묶음이 사라지고 "참여할 수 있는 프로그램" 하나만 남았다.
          아래 "날짜 지난 프로그램"과의 대비가 학생이 실제로 신경 쓰는 유일한 구분이다. */}
      {state === 'ready' && upcomingRows.length > 0 && (
        <div className="catgroup">
          <div className="gl">
            <Icon name="ic-compass" size={16} />
            참여할 수 있는 프로그램
          </div>
          {upcomingRows.map((row) => (
            <CatRow
              key={row.catKey}
              row={row}
              participationByProgram={participationByProgram}
              applicantCounts={applicantCounts}
              waitlistPositions={waitlistPositions}
              onOpen={handleOpenProgram}
              past={false}
            />
          ))}
        </div>
      )}

      {state === 'ready' && pastRows.length > 0 && (
        <div className="catgroup past">
          <div className="gl">
            <Icon name="ic-clock" size={16} />
            날짜 지난 프로그램
          </div>
          {pastRows.map((row) => (
            <CatRow
              key={row.catKey}
              row={row}
              participationByProgram={participationByProgram}
              applicantCounts={applicantCounts}
              waitlistPositions={waitlistPositions}
              onOpen={handleOpenProgram}
              past
            />
          ))}
        </div>
      )}

      {openProgram && (
        <JoinModal
          program={openProgram}
          participation={participationByProgram.get(openProgram.id)}
          applicantCount={applicantCounts.get(openProgram.id) ?? 0}
          waitlistPosition={waitlistPositions.get(openProgram.id) ?? null}
          onClose={() => setOpenProgram(null)}
          onApply={handleApply}
          onCancel={handleCancel}
        />
      )}

      {toast && <Toast key={toast.id} message={toast.message} onDone={dismissToast} />}
    </section>
  );
}

/* ---------- 정렬 드롭다운 (프로토타입 .sort 176~183줄 / toggleSort·setSort 882줄) ---------- */
function SortSelect({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = SORTS.find((s) => s.key === value) ?? SORTS[0];

  // 바깥 클릭 시 닫기 (프로토타입 886줄 document click 핸들러)
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);

  return (
    <div className="sort">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Icon name="ic-sort" size={18} />
        <span>{current.label}</span>
      </button>
      {open && (
        <div className="pop" role="listbox">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              role="option"
              aria-selected={s.key === value}
              className={s.key === value ? 'on' : undefined}
              onClick={() => {
                onChange(s.key);
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- 필터 칩 줄 (프로토타입 buildFilterBar 867줄) ---------- */
function FilterGroup({ icon, label, value, onChange, options }) {
  return (
    <div className="filtergroup">
      <div className="fg-label">
        <Icon name={icon} size={13} />
        {label}
      </div>
      <div className="chiprow">
        <button
          type="button"
          className={value === 'all' ? 'chip on' : 'chip'}
          aria-pressed={value === 'all'}
          onClick={() => onChange('all')}
        >
          전체
        </button>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className={value === o.key ? 'chip on' : 'chip'}
            aria-pressed={value === o.key}
            onClick={() => onChange(o.key)}
          >
            <i className="chipdot" style={{ background: o.color }} />
            {o.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- 카테고리 행: 헤더 + 가로 스크롤 스트립 (프로토타입 catRow 891줄) ---------- */
function CatRow({ row, participationByProgram, applicantCounts, waitlistPositions, onOpen, past }) {
  const c = CAT[row.catKey];
  return (
    <div className="catrow">
      <div className="ch">
        <div className="nm">
          <span className="dot" style={{ background: c.color }} />
          {row.label}
        </div>
        {/* 카테고리에 담긴 프로그램 수. 순위가 아니다 (원칙 1) */}
        <div className="cnt">{row.list.length}개 프로그램</div>
      </div>
      <Strip>
        {row.list.map((p) => (
          <ProgramCard
            key={p.id}
            program={p}
            participation={participationByProgram.get(p.id)}
            applicantCount={applicantCounts.get(p.id) ?? 0}
            waitlistPosition={waitlistPositions.get(p.id) ?? null}
            past={past}
            onOpen={() => onOpen(p)}
          />
        ))}
      </Strip>
    </div>
  );
}

/* ---------- 가로 스크롤 + 마우스 드래그 (프로토타입 enableDrag 943줄) ---------- */
function Strip({ children }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;

    let down = false;
    let moved = false;
    let startX = 0;
    let startLeft = 0;

    const onDown = (e) => {
      // [중요] moved 리셋은 아래 early-return보다 먼저 해야 한다.
      //   드래그를 .strip 바깥에서 mouseup 하면 click이 .strip을 통과하지 않아 onClickCapture가 실행되지
      //   않고, moved=true 가 그대로 남는다. 그러면 그 다음 정상 클릭 1회가 capture 단계에서 삼켜져
      //   팝업이 안 열린다. 모든 클릭에는 mousedown이 선행하므로 여기서 리셋하면 stale 상태가 항상 정리된다.
      moved = false;
      // 버튼 위에서 시작한 드래그는 무시한다 (프로토타입 946줄) — '참여' 버튼 클릭을 방해하지 않도록.
      if (e.button !== 0 || e.target.closest('button')) return;
      down = true;
      startX = e.pageX;
      startLeft = el.scrollLeft;
      el.classList.add('drag');
    };
    const onMove = (e) => {
      if (!down) return;
      e.preventDefault();
      const dx = e.pageX - startX;
      if (Math.abs(dx) > 4) moved = true;
      el.scrollLeft = startLeft - dx;
    };
    const onUp = () => {
      if (!down) return;
      down = false;
      el.classList.remove('drag');
    };
    // 드래그로 끝난 mouseup이 카드 클릭(=팝업 열기)으로 이어지지 않게 한 번만 삼킨다.
    const onClickCapture = (e) => {
      if (!moved) return;
      moved = false;
      e.stopPropagation();
      e.preventDefault();
    };

    el.addEventListener('mousedown', onDown);
    el.addEventListener('mousemove', onMove);
    el.addEventListener('click', onClickCapture, true);
    window.addEventListener('mouseup', onUp);
    return () => {
      el.removeEventListener('mousedown', onDown);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('click', onClickCapture, true);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  return (
    <div className="strip" ref={ref}>
      {children}
    </div>
  );
}
