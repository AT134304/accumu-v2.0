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
import { fmtDateRange, localDateOf, monthKey, monthLabel } from './date';

/**
 * 아카이브 문서에 필요한 프로그램 필드.
 * [points 를 가져오지 않는다] 위 경계 3번. 필드를 늘리기 전에 그 값의 소유자가 정말 programs 인지 확인할 것.
 * [end_date — 기간제 프로그램, 20260809140000] NULL이면 단일 일자. 있으면 dateLabel이 범위로 찍히고
 *   summarizeActivities()의 monthSpan/periodLabel이 시작월~종료월 전체를 센다(아래 monthsBetween 참고).
 */
// [image_url — ADR 0022] 아카이브 행의 아이콘 자리에 대표 사진을 그린다. NULL 이면 지금까지처럼
//   카테고리 아이콘이다(폐기가 아니라 fallback). 아카이브는 포트폴리오 화면이라 활동 사진이
//   들어가는 것이 원칙 4(포트폴리오 우선)와 같은 방향이다.
export const ARCHIVE_PROGRAM_FIELDS =
  'id, category, title, org, date, end_date, time, career_track, image_url';

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
 * 담당 학생 "목록"(5명 나란히) 조회 시 가져오는 컬럼.
 *
 * [★ points_balance / points_total 을 여기 넣지 말 것 — 결정 B, ADR 0015 이후에도 유효]
 *   5명이 나란히 놓이는 이 화면에 숫자가 붙는 순간 비교표가 된다(원칙 1). 포인트를 보여주기로
 *   한 결정(ADR 0015)은 "학생 1명" 상세 화면에만 적용된다 — 아래 MENTORED_STUDENT_DETAIL_FIELDS가
 *   그 경계다. 이 상수에 옮겨 담지 말 것.
 * [role / created_at 도 제외] 쓸 곳이 없다. admin-programs 가 popularity 를 뺀 것과 같은 규율.
 */
const MENTORED_STUDENT_FIELDS = 'id, code, name, career_interest';

/**
 * 담당 학생 "상세"(1명) 조회 시 가져오는 컬럼 — 목록과 다르다.
 *
 * [ADR 0015 — 2026-08-10, 케빈 요청으로 원칙 4 개정] points_balance/points_total을 연다.
 *   RLS(profiles_select_mentored_students_as_admin, 20260723120000)는 애초에 담당 학생 행의
 *   모든 컬럼을 열어줬다 — 지금까지 안 보여준 건 이 select 목록(프런트 선택)이었지 권한 경계가 아니었다.
 * [currency_balance는 여전히 제외] 요청받은 것은 포인트뿐이다. 지역화폐까지 넓히는 것은 별도 결정이
 *   필요하다 — 넣지 않은 게 실수가 아니라는 것을 밝혀 둔다.
 * [화면 쪽 가드는 여전히 산다] 이 필드가 담당 학생 "목록"으로 새면 결정 B가 깨진다 — 그래서 목록 조회
 *   (fetchMentoredStudents)는 여전히 MENTORED_STUDENT_FIELDS만 쓴다. 상세(fetchMentoredStudent)만
 *   이 확장판을 쓴다.
 */
const MENTORED_STUDENT_DETAIL_FIELDS = `${MENTORED_STUDENT_FIELDS}, points_balance, points_total`;

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
 * [ADR 0015] MENTORED_STUDENT_DETAIL_FIELDS 를 쓴다 — 목록 조회와 다른 필드 집합이다(위 주석 참고).
 */
export async function fetchMentoredStudent(studentId) {
  const { data, error } = await supabase
    .from('profiles')
    .select(MENTORED_STUDENT_DETAIL_FIELDS)
    .eq('id', studentId)
    .limit(1);
  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * 담당 해제("추방") — mentor_students 매핑 1행을 지운다 (ADR 0015).
 *
 * [원칙 6 개정 — 이 함수가 그 4번째 동작이다] 관리자 기능이 프로그램 관리·담당 학생 조회·QR 스캔
 *   3종에서 4종으로 늘었다. mentor_students_delete_own_as_admin(20260810120000)이 유일한 경계다 —
 *   admin_id = auth.uid() 인 행만 지워진다. student_id 로만 필터해도 RLS 가 "내 담당" 밖의 매핑에는
 *   아예 도달하지 못한다(0행 영향으로 조용히 끝난다 — 아래에서 그 경우를 감지한다).
 * [학생 기록은 지워지지 않는다] 지우는 것은 관계 1행뿐이다. participations/point_transactions/profiles는
 *   이 테이블을 참조하지 않는다 — 해제해도 학생의 활동 기록·포인트는 그대로다.
 * [되돌릴 수 있다] link_school_account()가 이제 "mentor_students 존재 여부"로 이미 연동됨을 판정하므로
 *   (ADR 0015), 해제된 학생은 초대코드를 다시 입력해 (같은/다른 관리자에게) 재연동될 수 있다.
 *
 * @param {string} studentId
 * @throws {Error} 이미 담당이 아니거나(레이스) 권한이 없어 0행 영향으로 끝난 경우
 */
export async function removeMentee(studentId) {
  const { error, count } = await supabase
    .from('mentor_students')
    .delete({ count: 'exact' })
    .eq('student_id', studentId);
  if (error) throw error;
  // 0행 = RLS 가 막았거나(내 담당이 아님) 이미 지워진 경우. update 계열이 흔히 겪는 "성공했다는데
  // 아무 일도 안 일어난" 함정과 같다(programService.js ProgramNotAffectedError 와 같은 패턴).
  if (!count) {
    throw new Error('이미 담당 학생 목록에 없거나 해제할 권한이 없습니다.');
  }
}

/**
 * 담당 학생 비밀번호 초기화 (ADR 0019 — 관리자 기능 5번째).
 *
 * [왜 RPC가 아니라 Edge Function인가] 비밀번호는 auth.users(Supabase Auth 내부 스키마) 소관이라
 *   일반 SQL로 안전하게 못 건드린다 — 이 앱의 계정 생성도 전부 Admin API(scripts/seed-accounts.mjs,
 *   naver-auth/google-auth)를 거친다. 같은 원칙으로 비밀번호 변경도 admin.auth.admin.updateUserById를
 *   쓰는 Edge Function(admin-reset-student-password)이 유일한 경로다.
 * [권한 경계는 함수 안에 있다] 이 함수 자체는 호출만 할 뿐 권한을 검사하지 않는다 — Edge Function이
 *   호출자의 JWT로 mentor_students를 다시 읽어 "진짜 내 담당 학생인가"를 확인한다(RLS 재사용).
 * [비밀번호를 프런트가 만들지 않는다] 서버가 임의 생성해 1회 응답으로 돌려준다. 화면은 그 값을
 *   저장하지 않고 한 번 보여준 뒤 버린다(state를 모달이 닫히면 버림).
 *
 * @param {string} studentId
 * @returns {Promise<{ok:true, temp_password:string} | {ok:false, reason:'not_your_student'|'update_failed'}>}
 * @throws 네트워크/함수 미배포 등 진짜 예외만 던진다.
 */
export async function resetStudentPassword(studentId) {
  const { data, error } = await supabase.functions.invoke('admin-reset-student-password', {
    body: { student_id: studentId },
  });
  if (error) {
    console.error('[archiveService] admin-reset-student-password 호출 실패:', error);
    throw error;
  }
  return data ?? { ok: false, reason: 'unknown' };
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
    // group(교내/교외)이 사라져 유형 이름 하나다 — ADR 0014
    catLabel: known ? cat.name : '분류 없음',
    org: p?.org ?? '',
    dateISO,
    // 기간제(p.end_date 있음)는 "7월 16일 (목) ~ 8월 20일 (목)"로 찍힌다. 게시중단으로 p 를 모르면
    // end_date 도 알 수 없어 fmtDateRange(dateISO, undefined) = fmtDate(dateISO)와 같다(자동 축약).
    dateLabel: dateISO ? fmtDateRange(dateISO, p?.end_date) : '',
    time: p?.time ?? '',
    careerTrack: p?.career_track ?? null,
    // 대표 사진(ADR 0022). 게시중단으로 p 를 못 읽은 건은 null 이라 자동으로 아이콘이 그려진다.
    imageUrl: p?.image_url ?? null,
  };
}

/**
 * date~end_date(둘 다 'YYYY-MM-DD') 사이 모든 달의 대표일('YYYY-MM-01')을 만든다.
 * summarizeActivities()의 monthSpan/periodLabel 전용 — 실제 날짜가 아니라 "그 달에 걸쳐 있었다"는
 * 사실만 필요하므로 1일로 고정한다(monthKey()가 앞 7자만 쓰므로 일자 값 자체는 버려진다).
 */
function monthsBetween(startIso, endIso) {
  const out = [];
  let [y, m] = startIso.split('-').map(Number);
  const [ey, em] = endIso.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}-01`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
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
 * [inCount/exCount 가 없다 — ADR 0014] 교내/교외 축이 폐지되면서 그 두 값의 근거가 사라졌다.
 *   대신 catKinds(경험한 유형 수)와 monthSpan(활동 개월 수)을 준다. 둘 다 분모가 없는 개수라
 *   "4종 중 3종" 같은 달성률로 읽힐 자리가 없다(원칙 1).
 *
 * @returns {{total:number, catKinds:number, monthSpan:number, unknown:number,
 *            byCat: Array<{key:string, label:string, count:number, color:string}>,
 *            periodLabel: string}}
 */
export function summarizeActivities(activities = []) {
  let unknown = 0;
  const counts = new Map();
  const months = [];

  for (const a of activities) {
    const key = a?.program?.category;
    const c = key ? CAT[key] : null;
    if (c) {
      counts.set(key, (counts.get(key) ?? 0) + 1);
    } else {
      // 조용히 빼지 않는다 — 총합과 분포가 어긋나면 학생이 "기록이 사라졌다"고 읽는다.
      unknown += 1;
    }
    const d = a?.program?.date;
    const endD = a?.program?.end_date;
    // [기간제 — 시작월만 세지 않는다] 5개월짜리 공유학교를 3월 하루로만 세면 monthSpan/periodLabel이
    //   실제보다 짧게 나온다. 시작월~종료월 사이 모든 달의 대표일을 넣어 "그 달에 걸쳐 있었다"를 반영한다.
    if (d && endD && endD > d) months.push(...monthsBetween(d, endD));
    else if (d) months.push(d);
  }

  // CAT 선언 순서를 유지해 화면마다 순서가 달라지지 않게 한다.
  const byCat = Object.keys(CAT)
    .filter((k) => counts.has(k))
    .map((k) => ({ key: k, label: CAT[k].name, count: counts.get(k), color: CAT[k].color }));

  months.sort();
  const first = months[0] ? monthLabel(months[0]) : '';
  const last = months[months.length - 1] ? monthLabel(months[months.length - 1]) : '';

  // 활동이 걸쳐 있는 개월 수. 같은 달에 몰려 있으면 1이다("몇 달에 걸쳐 꾸준히 했는가"의 사실 표시).
  const monthSpan = new Set(months.map((d) => monthKey(d))).size;

  return {
    total: activities.length,
    catKinds: counts.size, // 경험한 유형 수. 분모(4)를 함께 내보내지 않는다 — 내보내면 화면이 게이지를 그린다.
    monthSpan,
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
