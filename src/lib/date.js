// Accumu v2 — 날짜 유틸 (로컬 타임존 기준)
//
// [왜 별도 모듈인가] "오늘"의 소스가 한 곳이어야 한다.
//   - 캘린더 기본값 = 실제 오늘 (CLAUDE.md 9장, docs/specs/student-home.md 인수 조건)
//   - 추천 쿼리의 `date >= 오늘` (ADR 0003 6번)
//   - 마일스톤 스택의 최근 5개월 캡션 (스펙 확정 G)
// 세 곳이 각자 오늘을 계산하면 서로 어긋날 수 있어 여기로 모은다.
//
// [toISOString() 금지] `new Date().toISOString().slice(0,10)`은 UTC로 변환하므로
//   KST 오전 9시 이전에 날짜가 하루 밀린다. 아래 todayISO()는 로컬 필드(getFullYear 등)만 쓴다.
//   ADR 0003 6번 "타임존 주의" 참고.

const DOW = ['일', '월', '화', '수', '목', '금', '토'];

const pad2 = (n) => String(n).padStart(2, '0');

/** 로컬(KST) 기준 오늘 'YYYY-MM-DD'. Postgres `date` 컬럼과 문자열 비교에 그대로 쓴다. */
export function todayISO(base = new Date()) {
  return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}-${pad2(base.getDate())}`;
}

/**
 * 'YYYY-MM-DD' -> '7월 16일 (목)' (Accumu_prototype.html 718줄 fmtDate 재현)
 * DB의 date 값은 프런트에서 이 포맷으로 만든다 (ADR 0003 5번).
 */
export function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return '';
  // 로컬 자정으로 생성 — new Date('2026-07-16')은 UTC 파싱이라 요일이 밀릴 수 있다.
  const dt = new Date(y, m - 1, d);
  return `${m}월 ${d}일 (${DOW[dt.getDay()]})`;
}

/**
 * 'YYYY-MM-DD' 시작 + 'YYYY-MM-DD'|null|undefined 종료 -> 단일 일자면 fmtDate 그대로,
 * 기간제(끝나는 날짜가 있고 시작일과 다름)면 '7월 16일 (목) ~ 8월 20일 (목)'.
 * 카드/참여 팝업/아카이브/QR 센터가 공유하는 날짜 표시 조립 지점 — 기간제 프로그램(programs.end_date)의
 * 표시 형식을 여기 한 곳에서만 정의한다. 컴포넌트가 각자 '~'로 이어붙이지 않는다.
 */
export function fmtDateRange(startIso, endIso) {
  if (!endIso || endIso === startIso) return fmtDate(startIso);
  return `${fmtDate(startIso)} ~ ${fmtDate(endIso)}`;
}

/** '2026년 7월' — 캘린더 팝업 헤더용. 기준일은 항상 실제 오늘(하드코딩 금지). */
export function monthTitle(base = new Date()) {
  return `${base.getFullYear()}년 ${base.getMonth() + 1}월`;
}

/**
 * 실제 오늘 기준 최근 count개월. `[{ key: 'YYYY-MM', caption: '3월'|'이번 달' }]` (마지막이 이번 달).
 *
 * 마일스톤 스택(StackViz)이 월 버킷을 만들 때 쓴다. 버킷 키는 programs.date 에서 뽑은 monthKey 와 맞춘다
 * (ADR 0005 결정 5: 월 판정 기준은 exit_at 이 아니라 programs.date = "활동이 일어난 달").
 * 캡션은 항상 실제 오늘 기준으로 계산한다 — 하드코딩 금지 (CLAUDE.md 9장).
 */
export function recentMonths(count = 5, base = new Date()) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
      caption: i === 0 ? '이번 달' : `${d.getMonth() + 1}월`,
    });
  }
  return out;
}

/** 'YYYY-MM-DD' -> 'YYYY-MM'. 문자열 절단이라 타임존 변환이 끼어들 자리가 없다. */
export function monthKey(iso) {
  return typeof iso === 'string' && iso.length >= 7 ? iso.slice(0, 7) : '';
}

/** 'YYYY-MM-DD'|'YYYY-MM' -> '2026년 7월'. 아카이브 활동 기간 표시용(문자열 절단, 타임존 무관). */
export function monthLabel(iso) {
  const key = monthKey(iso);
  if (!key) return '';
  const [y, m] = key.split('-');
  return `${Number(y)}년 ${Number(m)}월`;
}

/**
 * timestamptz(예: participations.exit_at) -> 로컬(KST) 'YYYY-MM-DD'.
 *
 * [toISOString() 금지] UTC로 넘어가면 KST 오전 9시 이전 인증이 전날로 표시된다.
 *   Date로 파싱한 뒤 로컬 필드만 읽는 todayISO()를 재사용한다.
 * 게시중단된 프로그램의 완료 기록은 programs.date 를 읽을 수 없어 이 값이 날짜 대체 표시가 된다
 * (ADR 0005 결정 7-4).
 */
export function localDateOf(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  return Number.isNaN(d.getTime()) ? '' : todayISO(d);
}

/** timestamptz -> '7월 16일 (목) 15:42' (로컬). 아카이브의 "참여 확인 일시" 표시용. */
export function fmtDateTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return `${fmtDate(todayISO(d))} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** timestamptz -> 'HH:MM' (로컬, 날짜 없이 시각만). 같은 줄에서 exit_at이 이미 날짜를 보여줄 때
 *  entry_at을 나란히 붙이는 용도(아카이브 "입장/퇴장" 줄) — 날짜를 두 번 반복하지 않는다. */
export function fmtTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/* ==========================================================================
   프로그램이 "끝났는가" — 앱 전체에서 이 두 함수만 쓴다 (2026-08-21)

   [★ 왜 한 곳에 모았나]
     같은 판정이 다섯 군데에 각각 적혀 있었고, 그중 일부는 `date` 만 봐서 **진행 중인 기간제
     프로그램을 "지난 것"으로 분류**했다(8/1~8/30 짜리를 8/15 에 열면 지남). 한 곳을 고쳐도 나머지가
     남아 화면마다 다른 답을 내는 상태였다.
     >>> 새로 "지났는가"를 판단할 자리가 생기면 여기 두 함수를 import 할 것. 식을 다시 쓰지 말 것.
     >>> 서버 트리거 programs_lock_after_end(20260821120000)도 같은 식이다 — 한쪽을 바꾸면 같이 볼 것.

   [기준] coalesce(end_date, date) < 오늘.
     - 기간제(end_date 있음)는 **종료일**이 기준이다. 시작일이 지났어도 기간 중이면 진행 중이다.
     - 단일 일자는 그 날짜 하루가 곧 시작이자 끝이다.
     - 튜토리얼(is_tutorial)은 date 가 자리표시자라 "상시 진행"이다 — 끝나지 않는다(ADR 0021).
   ========================================================================== */

/** 프로그램이 끝나는 날짜('YYYY-MM-DD'). 기간제는 종료일, 단일 일자는 그 날짜. */
export function endOfProgram(program) {
  // [?? 가 아니라 || 인 이유] 폼 상태(ProgramFormModal)의 end_date 는 "기간제 아님"을 빈 문자열로
  //   표현한다. ?? 는 ''을 통과시켜서 '' < '2026-08-21' 이 참이 되고, 모든 단일 일자 프로그램이
  //   "끝났다"로 판정된다. DB 행(null)과 폼 값('') 둘 다 여기서 같은 뜻이어야 한다.
  return String(program?.end_date || program?.date || '');
}

/**
 * 진행이 끝났는가.
 * @param {object} program end_date / date / is_tutorial 을 가진 객체 (DB 행 또는 폼 값)
 * @param {string} today   'YYYY-MM-DD' (todayISO())
 */
export function isProgramOver(program, today) {
  if (!program || program.is_tutorial) return false;
  const end = endOfProgram(program);
  return Boolean(end) && end < today;
}
