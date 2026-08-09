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
