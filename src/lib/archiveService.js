// Accumu v2 — 아카이브 조회 + 집계 서비스
//
// [공유 파일 — docs/specs/student-archive-mypage.md 이슈 1]
//   학생 아카이브(/student/archive)와 관리자 담당 학생 아카이브(docs/specs/admin-students.md B절)가
//   같은 문서를 그리므로 결합·집계 로직을 한 파일에 둔다. "먼저 구현되는 쪽이 만들고 나중 쪽이 확장한다"
//   규칙에 따라 학생 쪽이 먼저 만들었다. 관리자 함수는 아래 "관리자 확장 지점"에 추가한다.
//
// [경계 요약 — 이 레이어에서 하지 않는 것]
//   1. 뷰/embed 로 조인하지 않는다. 뷰는 정의자(owner) 권한으로 돌아 다른 학생의 참여가 새는 뷰가 된다
//      (ADR 0003 6번 / ADR 0004 5번 / ADR 0005 결정 5). 병렬 쿼리 + 클라이언트 Map 결합으로 끝낸다.
//   2. student_id 필터를 클라이언트에서 걸지 않는다 — participations_select_own 이 소유자다.
//   3. programs.points 를 읽지 않는다. 표시할 포인트는 지급 시점 스냅샷인 point_transactions.amount 다
//      (ADR 0005 결정 3-6). 관리자가 프로그램 포인트를 수정해도 지급액은 변하지 않아야 하므로,
//      programs.points 로 대신 그리면 "틀린 숫자"가 된다.
//   4. 새 RLS 정책/마이그레이션이 필요한 조회를 하지 않는다. 여기 있는 쿼리는 전부 기존 권한으로 성립한다.
import { supabase } from './supabaseClient';
import { CAT, TRACK, catOf } from './taxonomy';
import { fmtDate, localDateOf, monthLabel } from './date';

/**
 * 아카이브 문서에 필요한 프로그램 필드.
 * [points 를 가져오지 않는다] 위 경계 3번. 필드를 늘리기 전에 그 값의 소유자가 정말 programs 인지 확인할 것.
 */
export const ARCHIVE_PROGRAM_FIELDS = 'id, category, title, org, date, time, career_track';

/** 참여 행 필드. 상태 전이·토큰 컬럼은 화면이 쓰지 않으므로 가져오지 않는다. */
const PARTICIPATION_FIELDS = 'id, program_id, status, entry_at, exit_at';

/** 데모 규모(수 건)에 비해 넉넉한 안전 상한. 페이징을 만들지 않는 대신 상한을 둔다(기존 관례). */
const SAFE_LIMIT = 200;

/* ==========================================================================
   결합 — 누구의 참여인지 알지 못한다 (학생/관리자 공용)
   ========================================================================== */

/**
 * 참여 행 배열에 programs 정보를 붙인다.
 *
 * [방어적 렌더 — ADR 0005 결정 7-4] 게시중단(is_published=false)된 프로그램은 학생이 select 할 수 없다.
 *   그 행은 `program: null` 로 내려가며 화면이 죽지 않아야 한다. programs 조회가 통째로 실패해도
 *   목록 자체는 살린다(전 행이 대체 문구가 될 뿐이다).
 *
 * @param {Array<object>} rows participations 행
 * @returns {Promise<Array<object & {program: object|null}>>}
 */
export async function attachPrograms(rows) {
  const list = rows ?? [];
  const ids = [...new Set(list.map((r) => r.program_id).filter(Boolean))];
  if (ids.length === 0) return list.map((r) => ({ ...r, program: null }));

  let byId = new Map();
  const { data, error } = await supabase.from('programs').select(ARCHIVE_PROGRAM_FIELDS).in('id', ids);
  if (error) {
    console.warn('[archiveService] 프로그램 정보 조회 실패 — 대체 표시로 진행합니다:', error);
  } else {
    byId = new Map((data ?? []).map((p) => [p.id, p]));
  }

  return list.map((r) => ({ ...r, program: byId.get(r.program_id) ?? null }));
}

/* ==========================================================================
   조회
   ========================================================================== */

/**
 * 내 완료 활동 (아카이브 목록의 소스).
 *
 * status='completed' 는 QR 퇴장 인증으로만 생긴다 — 즉 아카이브에 뜨는 활동은 전부 2회 인증을 통과한 것이다.
 * 신청만 하고 안 간 활동(applied/entered)은 아카이브가 아니라 QR 센터의 몫이라 여기서 거른다.
 * (서버 필터지만 대상은 여전히 RLS 가 내려준 "본인 행"이다 — 소유자 판정을 클라이언트가 하는 게 아니다.)
 */
export async function fetchMyCompletedActivities() {
  const { data, error } = await supabase
    .from('participations')
    .select(PARTICIPATION_FIELDS)
    .eq('status', 'completed')
    .limit(SAFE_LIMIT);
  if (error) throw error;

  return sortActivities(await attachPrograms(data ?? []));
}

/* ==========================================================================
   관리자 — 담당 학생 (docs/specs/admin-students.md 조회 설계)
   ========================================================================== */

/**
 * 담당 학생 조회 시 가져오는 컬럼.
 *
 * [★ points_balance / points_total / currency_balance 를 넣지 말 것 — 확정 K-1 / 이슈 4]
 *   RLS 는 담당 학생 행의 **모든 컬럼**을 열어준다. 열려 있다는 것과 보여준다는 것은 다르다.
 *   컬럼을 싣는 순간 화면 어딘가에 "이왕 온 김에" 표시하고 싶어지고, 그건 관리자 화면이
 *   "누가 얼마 벌었나"를 읽는 순간이다(원칙 4). 이 목록은 보안 경계가 아니라 **선언**이다.
 * [role / created_at 도 제외] 쓸 곳이 없다. admin-programs 가 popularity 를 뺀 것과 같은 규율.
 */
const MENTORED_STUDENT_FIELDS = 'id, code, name, career_interest';

/**
 * 담당 학생 5명 + "완료 활동이 있는가" 여부.
 *
 * [3개 쿼리를 클라이언트에서 결합한다] embed·뷰 금지 — 뷰는 정의자 권한으로 돌아 담당이 아닌 학생까지
 *   새는 경로가 된다(ADR 0003 6번 / 0004 5번 / 0005 결정 5).
 * [admin_id 필터를 걸지 않는다] mentor_students_select_own_as_admin 이 소유자다. 클라이언트 필터를
 *   덧붙이면 "경계는 정책이 판정한다"는 구조가 흐려진다.
 * [profiles 에는 관리자 본인 행이 섞여 온다] profiles_select_own 때문이다. mentor_students 집합으로
 *   거르면 자동으로 빠진다 — **role 로 거르지 말 것**(경계의 소유자를 흐린다).
 * [★ 건수를 세지 않고 Set 만 만든다 — 결정 B] 완료 건수를 반환하면 화면이 그 숫자를 표시하게 되고,
 *   5명이 나란히 놓인 목록에 숫자가 붙는 순간 그건 비교표다. 숫자를 만들지 않으면 새어나갈 수도 없다.
 *
 * @returns {Promise<{students: Array<object>, hasActivity: Set<string>}>}
 */
export async function fetchMentoredStudents() {
  const { data: maps, error } = await supabase.from('mentor_students').select('student_id').limit(SAFE_LIMIT);
  if (error) throw error;

  const ids = [...new Set((maps ?? []).map((m) => m.student_id).filter(Boolean))];
  if (ids.length === 0) return { students: [], hasActivity: new Set() };

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select(MENTORED_STUDENT_FIELDS)
    .in('id', ids)
    .limit(SAFE_LIMIT);
  if (profileError) throw profileError;

  // 완료 활동 유무는 부속 정보다 — 실패해도 목록은 뜬다("활동 기록 없음" 배지만 안 붙는다).
  let hasActivity = new Set();
  const { data: parts, error: partError } = await supabase
    .from('participations')
    .select('student_id')
    .limit(SAFE_LIMIT);
  if (partError) {
    console.warn('[archiveService] 담당 학생 활동 유무 조회 실패 — 배지 없이 표시합니다:', partError);
  } else {
    // 관리자에게는 정책이 "담당 5명의 completed" 만 내려준다 — 클라이언트 status 필터가 필요 없다.
    hasActivity = new Set((parts ?? []).map((p) => p.student_id));
  }

  const known = new Set(ids);
  const students = (profiles ?? [])
    .filter((p) => known.has(p.id))
    // 학번 오름차순 고정 — 성취와 무관한 축이라 정렬 자체가 순위가 되지 않는다(결정 B). 정렬 UI 없음.
    .sort((a, b) => String(a.code ?? '').localeCompare(String(b.code ?? '')));

  return { students, hasActivity };
}

/**
 * 담당 학생 1명의 프로필 (상세 화면 헤더용).
 *
 * [0행 = 담당이 아니거나 없는 학생] 에러가 아니라 null 을 돌려준다. 화면은 안내 + 돌아가기 버튼을 띄운다
 *   — 404 로 뭉개지 말 것(스펙 에러 처리 표). 담당 경계 판정은 여기가 아니라 RLS 가 한다.
 */
export async function fetchMentoredStudent(studentId) {
  const { data, error } = await supabase
    .from('profiles')
    .select(MENTORED_STUDENT_FIELDS)
    .eq('id', studentId)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * 담당 학생 1명의 완료 활동 (상세 목록).
 * participations_select_mentored_as_admin 이 이미 "담당 5명 + completed" 로 좁혀 두었고,
 * 여기서는 화면에 띄울 학생 1명으로만 더 좁힌다.
 */
export async function fetchCompletedActivitiesOf(studentId) {
  const { data, error } = await supabase
    .from('participations')
    .select(PARTICIPATION_FIELDS)
    .eq('student_id', studentId)
    .eq('status', 'completed')
    .limit(SAFE_LIMIT);
  if (error) throw error;
  return sortActivities(await attachPrograms(data ?? []));
}

/* ==========================================================================
   정렬 / 집계 / 표시 — 순수 함수 (누구의 기록인지 알지 못한다)
   ========================================================================== */

/**
 * 정렬 키 = 활동이 일어난 날(programs.date).
 * 프로그램을 못 찾은 건은 exit_at 의 로컬 날짜로 대체한다 — 목록 맨 끝으로 밀리지 않고 시간순에 자연스럽게 낀다.
 */
function sortKeyOf(a) {
  return a?.program?.date ?? localDateOf(a?.exit_at) ?? '';
}

/** programs.date 내림차순(최근 먼저), 같은 날짜는 exit_at 내림차순. */
export function sortActivities(list = []) {
  return [...list].sort((a, b) => {
    const d = String(sortKeyOf(b)).localeCompare(String(sortKeyOf(a)));
    if (d !== 0) return d;
    return String(b?.exit_at ?? '').localeCompare(String(a?.exit_at ?? ''));
  });
}

/**
 * 활동 1건의 표시 값. 게시중단으로 프로그램을 못 읽은 건도 여기서 전부 대체 문구를 갖는다.
 * 화면 컴포넌트가 `program?.x ?? '...'` 를 각자 흩뿌리지 않게 한 곳으로 모은다.
 */
export function describeActivity(activity) {
  const p = activity?.program ?? null;
  const known = Boolean(p);
  const cat = catOf(p?.category); // 미발견이면 회색 ic-grid fallback
  const dateISO = p?.date ?? localDateOf(activity?.exit_at);

  return {
    known,
    program: p,
    cat,
    // 학생은 미게시 programs 행을 읽을 수 없다. 행을 지우는 대신 사실대로 적는다 (ADR 0005 결정 7-4).
    title: p?.title ?? '게시가 중단된 프로그램',
    catLabel: known ? `${cat.group} · ${cat.name}` : '분류 없음',
    org: p?.org ?? '',
    dateISO,
    dateLabel: dateISO ? fmtDate(dateISO) : '',
    time: p?.time ?? '',
    careerTrack: p?.career_track ?? null,
  };
}

/**
 * 요약 집계 (결정 C — 사실 기술 텍스트).
 *
 * [원칙 1 가드] 여기서 나오는 값은 개수뿐이다. 퍼센트·달성률·등급·최대치 대비 비율을 계산하지 않는다
 *   (계산해두면 화면이 게이지를 그리게 된다).
 * [원칙 4 가드] 요약은 "활동 수"다. 포인트 총액을 이 함수가 다루지 않는다.
 * [M-2 이후에도 유지] 계열 레이더(summarizeByTrack)가 추가됐지만 이 텍스트 요약을 대체하지 않는다.
 *   그래프가 유일한 정보원이 되면 인쇄·모바일·스크린리더에서 정보가 통째로 사라진다.
 *
 * @returns {{total:number, inCount:number, exCount:number, unknown:number,
 *            byCat: Array<{key:string, label:string, count:number, color:string}>,
 *            periodLabel: string}}
 */
export function summarizeActivities(activities = []) {
  let inCount = 0;
  let exCount = 0;
  let unknown = 0;
  const counts = new Map();
  const months = [];

  for (const a of activities) {
    const key = a?.program?.category;
    const c = key ? CAT[key] : null;
    if (c) {
      if (c.group === '교외') exCount += 1;
      else inCount += 1;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      // 조용히 빼지 않는다 — 총합과 분포가 어긋나면 학생이 "기록이 사라졌다"고 읽는다.
      unknown += 1;
    }
    const d = a?.program?.date;
    if (d) months.push(d);
  }

  // CAT 선언 순서(교내 4 → 교외 4)를 유지해 화면마다 순서가 달라지지 않게 한다.
  const byCat = Object.keys(CAT)
    .filter((k) => counts.has(k))
    .map((k) => ({ key: k, label: CAT[k].name, count: counts.get(k), color: CAT[k].color }));

  months.sort();
  const first = months[0] ? monthLabel(months[0]) : '';
  const last = months[months.length - 1] ? monthLabel(months[months.length - 1]) : '';

  return {
    total: activities.length,
    inCount,
    exCount,
    unknown,
    byCat,
    periodLabel: !first ? '' : first === last ? first : `${first} ~ ${last}`,
  };
}

/**
 * 진로 계열별 참여 건수 (확정 M-2 — 레이더 차트의 유일한 데이터 소스).
 *
 * [축은 TRACK 5종이지 CAT 8종이 아니다] "계열"은 `programs.career_track`(이공계/IT/인문/경영/예술)이고,
 *   `programs.category`(방과후·동아리·봉사…)는 활동 "유형"이다. 둘은 별개 축이다(taxonomy.js).
 *   유형 분포는 summarizeActivities().byCat 이 이미 텍스트로 담당한다 — 여기서 겹쳐 세지 않는다.
 *
 * [축 순서 고정] TRACK 객체의 선언 순서를 그대로 쓴다. 값 크기순으로 정렬하면 그 순간 순위표가 되고
 *   (원칙 1), 화면을 다시 그릴 때마다 축이 회전해 같은 학생의 도형을 비교할 수 없게 된다.
 *
 * [0인 계열도 뺀 배열을 만들지 않는다] byCat 과 달리 `filter(count > 0)` 을 하지 않는다.
 *   레이더는 "무엇을 아직 안 했는가"까지 읽히는 게 값이라 축 5개가 항상 전부 있어야 한다.
 *
 * [분류 불가 건] 게시중단된 프로그램은 학생이 programs 행을 읽을 수 없어 계열을 알 수 없다
 *   (ADR 0005 결정 7-4). 그 건은 **어느 축에도 더하지 않고** unknown 으로만 센다 —
 *   임의의 축에 얹으면 없는 사실을 그리는 것이 된다. 화면은 각주로 제외 사실을 밝힌다.
 *
 * [원칙 1 가드] 퍼센트·달성률·목표치·"N/5"를 계산하지 않는다. max 는 눈금 계산용 최댓값일 뿐
 *   "최고 기록"이 아니며, 화면이 그것을 라벨로 노출하지 않는다.
 *
 * @param {Array<{program: {career_track?: string}|null}>} activities 완료 활동(프로그램 결합본)
 * @returns {{axes: Array<{key:string, label:string, count:number}>,
 *            plotted:number, unknown:number, max:number}}
 */
export function summarizeByTrack(activities = []) {
  const keys = Object.keys(TRACK);
  const counts = new Map(keys.map((k) => [k, 0]));
  let unknown = 0;

  for (const a of activities) {
    // programs.career_track 은 DB에서 not null 이다(20260716120000 마이그레이션).
    // 따라서 여기서 걸리는 건 사실상 "프로그램 행 자체를 못 읽은 경우"뿐이다.
    const key = a?.program?.career_track;
    if (key && counts.has(key)) counts.set(key, counts.get(key) + 1);
    else unknown += 1;
  }

  const axes = keys.map((k) => ({ key: k, label: TRACK[k].name, count: counts.get(k) }));
  let plotted = 0;
  let max = 0;
  for (const a of axes) {
    plotted += a.count;
    if (a.count > max) max = a.count;
  }

  return { axes, plotted, unknown, max };
}
