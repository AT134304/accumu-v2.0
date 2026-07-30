// Accumu v2 — 프로그램 선택 화면 (docs/specs/student-programs.md A절 / 확정 A-1~H-1)
// Accumu_prototype.html screen-programs(584~602줄) + renderPrograms()(900줄) 재현.
//
// [홈과 다른 점] `date >= 오늘`로 거르지 않는다. 지난 프로그램도 조회해서 "날짜 지난 프로그램" 그룹으로
//   따로 보여준다 (fetchAllPrograms).
// [원칙 1 가드] popularity는 "인기순" 정렬의 입력으로만 쓴다. 숫자·순위 라벨·신청자 수를 화면에 내지 않는다.
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
import { applyToProgram, fetchAllPrograms, fetchAppliedProgramIds } from '../lib/programService';
import '../styles/StudentPrograms.css';

// 카테고리 그룹 2종 (프로토타입 904줄 groups). "날짜 지난 프로그램"은 8종을 한 그룹에 모은다.
const GROUPS = [
  { key: '교내', label: '학교 내 활동', icon: 'ic-school', cats: ['hbk', 'hdo', 'hdc', 'het'] },
  { key: '교외', label: '학교 외 활동', icon: 'ic-globe', cats: ['ecp', 'evo', 'edc', 'eet'] },
];
const ALL_CATS = GROUPS.flatMap((g) => g.cats);

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
  const [appliedIds, setAppliedIds] = useState(() => new Set());
  // 정원 마감으로 거부당한 프로그램 (ADR 0006). **조회로 채우지 않는다** — 신청을 눌러 거부당한 것만 담긴다.
  // 확정 K-1(사후 거부): 신청자 수를 셀 권한이 없어 사전 마감 표시는 만들 수 없다.
  const [fullIds, setFullIds] = useState(() => new Set());
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
        // 병렬 2쿼리 (ADR 0004 5번 — 조인 뷰/embed 기각).
        // fetchAppliedProgramIds는 participations 조회 실패를 빈 Set으로 축약하므로,
        // 마이그레이션 미적용 환경에서도 목록 자체는 뜬다.
        const [rows, applied] = await Promise.all([fetchAllPrograms(), fetchAppliedProgramIds()]);
        if (cancelled) return;
        setPrograms(rows);
        setAppliedIds(applied);
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
  const { groupRows, pastRows, total } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const today = todayISO(); // 로컬(KST) 기준. toISOString()은 오전 9시 이전에 하루 밀린다.

    // 검색 대상은 제목 + 주최 + 카테고리 표시명 (프로토타입 905줄). 설명은 대상이 아니다.
    // 줄바꿈으로 잇는다 — 그냥 이어붙이면 제목 끝과 주최 시작에 걸친 문자열이 우연히 매칭되는 오탐이 난다.
    const match = (p) =>
      !q || [p.title, p.org, catOf(p.category).name].join('\n').toLowerCase().includes(q);
    const trackOk = (p) => trackFilter === 'all' || p.career_track === trackFilter;

    const visible = programs.filter((p) => match(p) && trackOk(p));
    const sortAll = (list) => [...list].sort(COMPARE[sortMode]);

    const buildRows = (cats, source, pastLabel) =>
      cats
        .filter((catKey) => typeFilter === 'all' || catKey === typeFilter)
        .map((catKey) => ({
          catKey,
          // "날짜 지난 프로그램" 그룹은 교내/교외 구분이 사라지므로 라벨을 `그룹 · 이름`으로 (프로토타입 893줄)
          label: pastLabel ? `${CAT[catKey].group} · ${CAT[catKey].name}` : CAT[catKey].name,
          list: sortAll(source.filter((p) => p.category === catKey)),
        }))
        // 프로그램이 0개인 카테고리 행은 렌더하지 않는다
        .filter((row) => row.list.length > 0);

    const upcoming = visible.filter((p) => p.date >= today);
    const past = visible.filter((p) => p.date < today);

    const nextGroupRows = GROUPS.map((g) => ({ ...g, rows: buildRows(g.cats, upcoming, false) })).filter(
      (g) => g.rows.length > 0 // 행이 하나도 없는 그룹은 통째로 렌더하지 않는다
    );
    const nextPastRows = buildRows(ALL_CATS, past, true);

    const count =
      nextGroupRows.reduce((n, g) => n + g.rows.reduce((m, r) => m + r.list.length, 0), 0) +
      nextPastRows.reduce((m, r) => m + r.list.length, 0);

    return { groupRows: nextGroupRows, pastRows: nextPastRows, total: count };
  }, [programs, query, sortMode, typeFilter, trackFilter]);

  // 빈 상태 문구 (프로토타입 939줄 카피). 선택한 조건을 ` · `로 연결해 앞에 붙인다.
  // 유형은 칩 라벨과 같은 `그룹 이름` 형태로 — CAT 에 '대회'(hdc/edc)와 '기타'(het/eet)가 각각 둘씩 있어
  // 이름만 쓰면 어느 칩을 눌렀는지 문구로 구분되지 않는다.
  const emptyCond = [
    query.trim() && `'${query.trim()}'`,
    typeFilter !== 'all' && CAT[typeFilter] && `${CAT[typeFilter].group} ${CAT[typeFilter].name}`,
    trackFilter !== 'all' && TRACK[trackFilter]?.name,
  ].filter(Boolean);

  // 안정된 참조로 넘겨야 Toast 내부의 자동 닫힘 타이머가 부모 리렌더마다 초기화되지 않는다.
  const dismissToast = useCallback(() => setToast(null), []);

  const handleApply = useCallback(
    async (program) => {
      if (!studentId) throw new Error('로그인 세션이 없어 신청할 수 없습니다.');
      try {
        // 낙관적 업데이트를 하지 않는다 — 성공한 뒤에만 "신청됨"으로 바꾸므로 롤백이 필요 없고,
        // 새로고침해도 화면과 DB가 어긋나지 않는다 (인수 조건).
        const result = await applyToProgram({ studentId, programId: program.id });

        // 정원 마감(ADR 0006) — 신청되지 않았으므로 appliedIds 를 건드리지 않는다.
        // 그 카드/팝업만 즉시 마감 상태로 로컬 갱신한다(목록 전체 리로드 없음. 재조회해도 정원 정보는 오지 않는다).
        // 팝업은 닫지 않는다 — 버튼이 '마감'으로 바뀌는 것과 사유 문구를 같은 자리에서 보여준다.
        if (result === 'full') {
          setFullIds((prev) => new Set(prev).add(program.id));
          return result;
        }

        setAppliedIds((prev) => new Set(prev).add(program.id));
        setOpenProgram(null);
        setToast({
          id: Date.now(),
          // 중복(23505/409)은 에러 팝업 없이 "이미 신청됨"으로 화면을 맞추는 상황이다 (ADR 0004 구현 가이드 2번).
          // [마감과 다르게 취급한다] 정원 1짜리를 본인이 채운 학생의 재신청이 여기로 온다 —
          //   "마감"으로 표시하면 거짓말이 된다 (ADR 0006 결정 5-2).
          message: result === 'duplicate' ? '이미 신청한 프로그램이에요' : '신청이 완료되었어요',
        });
        return result;
      } catch (err) {
        // 정상 사용에선 발생하지 않는다(발생하면 RLS 위반 42501 또는 네트워크). 원본을 콘솔에 남기고
        // 팝업이 사용자에게 실패를 알리도록 다시 던진다.
        console.error('[StudentPrograms] 신청 실패:', err);
        throw err;
      }
    },
    [studentId]
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
          options={Object.entries(CAT).map(([k, c]) => ({
            key: k,
            name: `${c.group} ${c.name}`,
            color: c.color,
          }))}
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

      {state === 'ready' &&
        groupRows.map((g) => (
          <div className="catgroup" key={g.key}>
            <div className="gl">
              <Icon name={g.icon} size={16} />
              {g.label}
            </div>
            {g.rows.map((row) => (
              <CatRow
                key={row.catKey}
                row={row}
                appliedIds={appliedIds}
                fullIds={fullIds}
                onOpen={setOpenProgram}
                past={false}
              />
            ))}
          </div>
        ))}

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
              appliedIds={appliedIds}
              fullIds={fullIds}
              onOpen={setOpenProgram}
              past
            />
          ))}
        </div>
      )}

      {openProgram && (
        <JoinModal
          program={openProgram}
          joined={appliedIds.has(openProgram.id)}
          full={fullIds.has(openProgram.id)}
          onClose={() => setOpenProgram(null)}
          onApply={handleApply}
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
function CatRow({ row, appliedIds, fullIds, onOpen, past }) {
  const c = CAT[row.catKey];
  return (
    <div className="catrow">
      <div className="ch">
        <div className="nm">
          <span className="dot" style={{ background: c.color }} />
          {row.label}
        </div>
        {/* 카테고리에 담긴 프로그램 수. 신청자 수/순위가 아니다 (원칙 1) */}
        <div className="cnt">{row.list.length}개 프로그램</div>
      </div>
      <Strip>
        {row.list.map((p) => (
          <ProgramCard
            key={p.id}
            program={p}
            joined={appliedIds.has(p.id)}
            full={fullIds.has(p.id)}
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
