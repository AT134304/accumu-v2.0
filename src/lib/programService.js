// Accumu v2 — programs / participations 서비스 (ADR 0003 6번, ADR 0004 "구현 가이드 → frontend-agent")
// 컴포넌트가 supabase 쿼리를 직접 들고 있지 않도록 이 레이어에 모은다.
import { supabase } from './supabaseClient';
import { todayISO } from './date';

// ADR 0003 6번의 select 목록 그대로. 홈 카드가 그리는 필드만 가져온다.
// [end_date — 기간제 프로그램] NULL이면 단일 일자(date 하루), 아니면 date~end_date 기간이다.
//   카드/팝업은 이 값의 유무로 날짜를 하루로 찍을지 범위로 찍을지 고른다 (date.js fmtDateRange).
// [attendance_payout_mode/min_attendance_days — 지급 방식 3종, 20260809160000] 기간제일 때만 값이 있다.
//   카드에는 표시하지 않는다(원칙 1 — 지급 시점을 카드에서 강조하지 않는다). JoinModal 안내문과
//   QrCenterModal의 완료 판정이 이 값을 쓴다.
// [session_dates — 실제 진행일 목록, 20260809180000] 기간제일 때만 값이 있다. JoinModal의 "총 N일 진행"
//   안내에 쓴다. 카드 자체에는 표시하지 않는다(칩 하나에 다 못 담긴다 — 팝업에서 자세히 보여준다).
// [capacity — ADR 0016] 이전에는 "정원은 조회하지 않는다"가 원칙이었다(ADR 0006 결정 6-1 — 응답에
//   숫자가 없다). 취소·대기열이 생기며 그 결정의 "재검토 시점"이 왔고, 케빈이 "신청자 수를 보이게 해"로
//   명시적으로 뒤집었다. JoinModal이 신청자 수와 나란히 보여준다 — 카드에는 여전히 안 찍는다.
const CARD_FIELDS =
  'id, category, title, org, date, end_date, time, points, capacity, career_track, status, attendance_payout_mode, min_attendance_days, session_dates';

// 프로그램 선택 화면용. 카드 필드 + 팝업(description) + 클라이언트 정렬 입력(popularity/created_at).
//
// [정렬을 클라이언트에서 하므로 popularity/created_at을 페이로드에 실어야 한다]
//   서버 .order()로 처리하면 정렬을 바꿀 때마다 재조회가 된다(20행 규모에 불필요한 왕복).
// [원칙 가드 — popularity] 이 값은 "인기순" 정렬의 입력으로만 쓴다.
//   숫자를 화면에 렌더하지 않는다. "TOP 3"/"인기 1위" 같은 순위·과열 라벨도 만들지 않는다
//   (docs/specs/student-programs.md "절대 원칙 체크", CLAUDE.md 2장 1번).
//   [popularity와 헷갈리지 말 것] "N명 신청"은 이 필드가 아니라 applicantCounts(program_applicant_counts
//   RPC)에서 온다 — ADR 0016으로 예외가 열린 건 신청자 수뿐이고, popularity 숫자 노출 금지는 그대로다.
//   홈(fetchRecommendedPrograms)은 popularity 를 계속 가져오지 않는다 — 거기선 정렬 기준이 아니다.
const LIST_FIELDS = `${CARD_FIELDS}, description, popularity, created_at`;

/**
 * 프로그램 선택 화면용 전체 목록.
 *
 * [홈과 다른 점] `date >= 오늘` 필터를 걸지 않는다 — 지난 프로그램을 별도 그룹("날짜 지난 프로그램")으로
 * 보여줘야 하기 때문이다 (docs/specs/student-programs.md A절).
 * 검색·필터·정렬은 전부 클라이언트에서 한다 (데모 20행 규모. Supabase full-text 도입 금지 — ADR 0003 6번).
 */
export async function fetchAllPrograms() {
  const { data, error } = await supabase
    .from('programs')
    .select(LIST_FIELDS)
    // is_published 조건은 RLS(programs_select_published)와 중복이지만 의도를 코드에 명시한다 (이중 안전장치).
    .eq('is_published', true)
    .limit(200); // 안전 상한. 데모 실제 행 수는 16~20.

  if (error) throw error;
  return data ?? [];
}

/**
 * 본인의 신청 목록.
 *
 * [student_id 필터를 클라이언트에서 걸지 않는다] RLS(participations_select_own)가 본인 행만 내려준다.
 *   걸어도 무해하지만 경계의 소유자는 RLS라는 점을 코드에서 흐리지 않는다 (ADR 0004 구현 가이드).
 * [status — ADR 0016 이후로 화면 로직에 쓴다] applied/waitlisted/entered/completed 4종.
 *   "신청됨"과 "대기중"을 구분해야 해서 더 이상 존재 여부만으로 충분하지 않다 — 아래
 *   fetchMyParticipationsByProgram() 이 이 구분을 쓴다.
 */
export async function fetchMyParticipations() {
  const { data, error } = await supabase.from('participations').select('id, program_id, status');
  if (error) throw error;
  return data ?? [];
}

/**
 * 이미 신청한 program_id Set. 조회 실패 시 화면 전체를 죽이지 않고 빈 Set으로 축약한다.
 *
 * [왜 실패를 삼키나] participations 마이그레이션이 아직 적용되지 않은 환경에서도 프로그램 목록/홈 추천은
 *   떠야 한다. "신청됨" 표시가 빠지는 것은 열화된 표시일 뿐이고, 실제 중복 신청 방어는
 *   DB unique 제약(23505/409)이 담당하므로 안전 경계가 무너지지 않는다.
 *   대신 조용히 넘어가지 않도록 콘솔에 원본 에러를 남긴다.
 */
export async function fetchAppliedProgramIds() {
  try {
    const rows = await fetchMyParticipations();
    return new Set(rows.map((r) => r.program_id));
  } catch (err) {
    console.warn('[programService] 신청 목록 조회 실패 — "신청됨" 표시 없이 진행합니다:', err);
    return new Set();
  }
}

/**
 * program_id -> {id, status} 맵. JoinModal/ProgramCard 가 "신청됨(applied)"과 "대기중(waitlisted)"을
 * 구분하고, 취소 버튼에 넘길 participation id 를 얻는 데 쓴다(ADR 0016).
 * [실패를 삼킨다] fetchAppliedProgramIds() 와 같은 이유 — 이 줄이 실패해도 목록 자체는 떠야 한다.
 */
export async function fetchMyParticipationsByProgram() {
  try {
    const rows = await fetchMyParticipations();
    return new Map(rows.map((r) => [r.program_id, { id: r.id, status: r.status }]));
  } catch (err) {
    console.warn('[programService] 신청 상태 조회 실패 — 상태 표시 없이 진행합니다:', err);
    return new Map();
  }
}

/**
 * 참여 신청.
 *
 * [보내는 컬럼은 student_id / program_id 둘뿐이다 — 다른 컬럼을 추가하지 말 것]
 *   RLS participations_insert_own 의 with check 가 status in ('applied','waitlisted')(ADR 0016),
 *   entry_at/exit_at/entry_token/exit_token is null 을 요구한다. status 는 DB default('applied')가
 *   채우거나 정원 게이트 트리거가 'waitlisted'로 바꾼다 — 학생은 어느 쪽도 직접 고를 수 없다.
 *   여기에 컬럼을 하나 더 실으면 원인 불명의 403(42501)이 난다 (ADR 0004 "알려진 틈" / 구현 가이드 1번).
 * [포인트를 건드리지 않는다] 신청만으로는 1P도 지급되지 않는다. 지급 시점은 QR 퇴장 인증
 *   (CLAUDE.md 2장 3번 / 6장 3번). 이 함수에 points_balance/point_transactions 경로를 만들지 말 것.
 *
 * @param {{studentId: string, programId: string}} args studentId 는 AuthContext 의 본인 id (= auth.uid())
 * @returns {Promise<'created'|'waitlisted'|'duplicate'>}
 *   'created'    = status='applied'로 확정 — 자리를 확보했다.
 *   'waitlisted' = 정원이 차 있어 status='waitlisted'로 등록됐다(ADR 0016 — 예전에는 여기가 'full' 거부였다).
 *   'duplicate'  = DB unique 제약(23505/409). 에러가 아니라 상태 동기화 신호로 다룬다.
 * @throws 그 외 실패(RLS 42501 / 네트워크 등)는 그대로 던진다 — 호출부가 사용자에게 알린다.
 */
export async function applyToProgram({ studentId, programId }) {
  // [.select() 가 필요한 이유] 정원 게이트가 더 이상 거부하지 않으므로(ADR 0016), 결과가 applied인지
  // waitlisted인지는 서버가 실제로 채운 값을 봐야 안다 — 클라이언트가 보낸 값(무엇도 안 보냄)으로는 알 수 없다.
  const { data, error } = await supabase
    .from('participations')
    .insert({ student_id: studentId, program_id: programId })
    .select('status')
    .single();

  if (!error) return data.status === 'waitlisted' ? 'waitlisted' : 'created';

  // 중복 신청: 클라이언트 방어(버튼 비활성)를 새로고침·두 탭·개발자도구로 우회해도 DB가 막는다.
  // 사용자에게 실패 팝업을 띄울 상황이 아니라 "이미 신청됨"으로 화면을 맞추면 되는 상황이다.
  if (error.code === '23505') return 'duplicate';

  // [ADR 0016] 'capacity_full'(hint) 분기는 더 이상 없다 — 정원 게이트가 거부 대신 waitlisted를
  // 반환하도록 바뀌었다(participations_capacity_guard). 이 에러가 여전히 나온다면 마이그레이션
  // 20260810180000 이 적용되지 않은 것이다 — throw 로 떨어져 "권한 오류"로 잘못 보이는 게 오히려
  // 그 사실을 드러낸다.
  // 42501(RLS 거부) 등은 정상 사용에서 발생하지 않는다 = 버그 신호(ADR 0005 결정 4).
  throw error;
}

/**
 * 신청 취소 (ADR 0016).
 *
 * [왜 RPC 인가 — update/delete 정책이 아니라] 취소는 "내 행을 지운다"에서 끝나지 않는다.
 *   내가 'applied'였다면 정원 한 자리가 비고, 그 자리를 가장 먼저 신청한 'waitlisted' 행이 있으면
 *   그 행을 'applied'로 승격해야 한다 — 두 행에 걸친 원자적 연산이라 RLS 정책 하나로 표현할 수 없다
 *   (ADR 0006 "재검토 시점"이 예고한 바로 그 상황). security definer + for update 잠금으로 서버가 처리한다.
 * [날짜 판정은 서버가 한다] "시작 전날까지만" 을 클라이언트에서 막아도 새로고침·다른 탭으로 우회되므로
 *   진짜 경계는 함수 안 today_kst() >= programs.date 체크다. 프런트의 버튼 비활성은 UX일 뿐이다.
 *
 * @param {string} participationId
 * @returns {Promise<{ok: true, promoted: boolean} | {ok: false, reason: 'not_found'|'already_started'|'too_late'}>}
 *   reason 은 사용자에게 보여줄 문구를 호출부가 고르기 위한 것이다 — 이 함수는 에러를 던지지 않는다
 *   (실패가 "잘못된 상태"가 아니라 "이미 늦었다/이미 시작했다"처럼 정상적으로 발생하는 흐름이라서다).
 * @throws 로그인 안 됨(42501)·네트워크 등 진짜 예외만 던진다.
 */
export async function cancelMyParticipation(participationId) {
  const { data, error } = await supabase.rpc('cancel_my_participation', {
    p_participation_id: participationId,
  });
  if (error) throw error;
  return data;
}

/**
 * 프로그램별 신청자 수 (ADR 0016).
 *
 * [applied/entered/completed 만 센다 — waitlisted 는 빼고] "신청자 수"는 자리를 차지한 사람 수다.
 *   대기 인원까지 더하면 정원(capacity)과 비교했을 때 숫자가 어긋나 보인다 — 서버 RPC
 *   program_applicant_counts() 가 이미 이 규칙으로 집계해 보낸다(원칙 1 — 등수·비율이 아니라 단순 카운트).
 *
 * @returns {Promise<Map<string, number>>} program_id -> 신청자 수. 조회 실패 시 빈 Map(열화 표시).
 */
export async function fetchApplicantCounts() {
  const { data, error } = await supabase.rpc('program_applicant_counts');
  if (error) {
    console.warn('[programService] 신청자 수 조회 실패 — 표시 없이 진행합니다:', error);
    return new Map();
  }
  return new Map((data ?? []).map((row) => [row.program_id, row.applicant_count]));
}

/**
 * 내가 대기 중인 프로그램마다 몇 번째로 대기 중인지 (ADR 0018).
 *
 * [순번을 보여주는 이유] ADR 0016 때는 "순번은 순위처럼 읽힐 수 있다"며 의도적으로 숨겼지만, 케빈이
 *   명시적으로 뒤집었다 — "내가 몇 번째인가"는 다른 학생과 겨루는 순위가 아니라 내 상황에 대한
 *   사실 하나다(신청자 수를 연 것과 같은 논리, ADR 0016 결정 3).
 *
 * @returns {Promise<Map<string, number>>} program_id -> 순번(1부터). 대기 중이 아닌 프로그램은 없음.
 *   조회 실패 시 빈 Map(열화 표시) — fetchApplicantCounts()와 같은 이유.
 */
export async function fetchMyWaitlistPositions() {
  const { data, error } = await supabase.rpc('my_waitlist_positions');
  if (error) {
    console.warn('[programService] 대기 순번 조회 실패 — 표시 없이 진행합니다:', error);
    return new Map();
  }
  return new Map((data ?? []).map((row) => [row.program_id, row.waitlist_position]));
}

/* ==========================================================================
   관리자 홈 (ADR 0005 결정 7-5 — 새 RLS 정책 0개)
   ========================================================================== */

// 관리자 홈이 그리는 필드 + created_by(본인 필터용). is_published 는 상태 표시가 아니라
// "왜 이 행이 보이는가"를 코드에서 설명하기 위해 함께 가져온다.
const ADMIN_FIELDS = 'id, category, title, org, date, end_date, time, points, is_published, created_by';

/**
 * 관리자 홈용 프로그램 조회 — "오늘 진행" + "예정".
 *
 * [새 정책 없이 성립한다] 기존 programs_select_published + programs_select_own_as_admin 로 충분하다.
 * [created_by 필터를 프런트가 거는 이유] 확정 H-1 때문에 남의 프로그램은 스캔이 항상 실패한다.
 *   목록에 띄우면 "누르면 반드시 실패하는 버튼"이 된다 (ADR 0005 결정 7-5).
 * [날짜는 todayISO()(로컬/KST)로 거른다] DB 의 current_date 로 거르지 않는다 — 그러면 "오늘"의 소스가
 *   프런트와 DB 로 갈린다 (ADR 0003 6번 / ADR 0004 타임존 판단 유지).
 * [원칙 1·6 가드] 신청자 명단·출석률·랭킹을 조회하지 않는다. [ADR 0016] 신청자 수는 program_applicant_counts()
 *   RPC로 관리자도 이제 조회할 수 있지만, 이 홈 요약 카드에는 일부러 싣지 않는다 — "프로그램 관리"
 *   목록(AdminProgramsPage)에서만 보여주기로 케빈이 확정한 범위다(2026-08-10). 홈까지 넓히려면 그때 다시 정한다.
 *
 * @param {string} adminId 로그인한 관리자의 profile id (= auth.uid())
 * @returns {Promise<{today: object[], upcoming: object[]}>}
 */
export async function fetchAdminHomePrograms(adminId) {
  const { data, error } = await supabase.from('programs').select(ADMIN_FIELDS).limit(200);
  if (error) throw error;

  const iso = todayISO();
  const mine = (data ?? []).filter((p) => p.created_by && p.created_by === adminId);

  // [기간제 — end_date 가 있으면 "오늘"은 date~end_date 범위로 판정한다]
  //   공유학교처럼 여러 날 진행되는 프로그램은 시작일이 지난 뒤에도 기간 내내 "오늘 진행"에 남아야
  //   관리자가 그날의 QR 스캔을 준비할 수 있다. 단일 일자 프로그램은 기존과 동일하게 date === 오늘.
  const isToday = (p) => (p.end_date ? iso >= p.date && iso <= p.end_date : p.date === iso);
  const byDateAsc = (a, b) => String(a.date).localeCompare(String(b.date));
  return {
    today: mine.filter(isToday).sort(byDateAsc),
    upcoming: mine.filter((p) => !isToday(p) && String(p.date) > iso).sort(byDateAsc).slice(0, 5),
  };
}

/* ==========================================================================
   관리자 프로그램 관리 (docs/specs/admin-programs.md — 새 RLS 정책 0개)

   기존 정책 3개로 성립한다: programs_select_own_as_admin / programs_insert_own_as_admin /
   programs_update_own_as_admin. 행 경계는 전부 created_by = auth.uid() (ADR 0005 결정 7-0 축 A).
   [delete 경로를 만들지 않는다] delete 정책이 0개다 — "내리기"는 is_published=false 토글이지 삭제가 아니다.
   ========================================================================== */

// 관리 목록은 수정 폼을 채워야 하므로 ADMIN_FIELDS(관리자 홈용)보다 넓다.
// [popularity 를 가져오지 않는다] 화면에 쓰지 않는 값을 페이로드에 싣지 않는다 — 원칙 가드를 코드로 표현한 것이다
//   (표시도 편집도 하지 않는다: 컬럼 주석 / 스펙 이슈 3).
const ADMIN_MANAGE_FIELDS =
  'id, category, title, org, description, date, end_date, time, capacity, points, career_track, status, is_published, created_by, created_at, attendance_payout_mode, min_attendance_days, session_dates';

// 폼이 소유하는 컬럼 화이트리스트. insert/update 페이로드는 반드시 이 목록을 통과한다.
//
// [화이트리스트인 이유 — 빼기가 아니라 더하기로 막는다]
//   is_published: 수정 저장이 게시 상태를 바꾸면 안 된다(확정 D). 게시 상태를 바꾸는 유일한 경로는
//                 setProgramPublished 다.
//   created_by  : 소유권 이전은 with check 가 막지만, 애초에 보내지 않는 것이 경계다.
//   popularity  : 원칙 1 가드. id/created_at 은 DB 소유.
const FORM_COLUMNS = [
  'category',
  'title',
  'org',
  'description',
  'date',
  'end_date', // 기간제 프로그램의 종료일. 단일 일자면 null (ProgramFormModal 이 그 분기를 만든다).
  'attendance_payout_mode', // 기간제 지급 방식 3종(20260809160000). 단일 일자면 null.
  'min_attendance_days', // attendance_payout_mode='threshold'일 때만. 그 외엔 null.
  'session_dates', // 실제 진행일 목록(20260809180000). 단일 일자면 null.
  'time',
  'career_track',
  'points',
  'capacity',
  'status',
];

const pickFormColumns = (fields) => {
  const out = {};
  for (const key of FORM_COLUMNS) {
    if (key in fields) out[key] = fields[key];
  }
  return out;
};

/**
 * update 가 0행으로 끝났을 때의 에러 (스펙 이슈 1).
 * RLS using 절에 걸린 update 는 **에러가 아니라 "0행 영향"**으로 끝나고 supabase-js 는 error: null 을 준다.
 * 그대로 두면 "권한 밖 행을 못 고쳐놓고 성공 토스트를 띄우는 화면"이 된다.
 */
export class ProgramNotAffectedError extends Error {
  constructor() {
    super('이 프로그램을 수정할 권한이 없거나 목록이 오래됐습니다. 새로고침해 주세요.');
    this.name = 'ProgramNotAffectedError';
    this.code = 'ACCUMU_NO_ROWS';
  }
}

/**
 * 관리자 프로그램 관리 목록.
 *
 * [is_published 필터를 걸지 않는다] RLS 가 "게시된 전부 + 본인 미게시"를 내려준다. 미게시 본인 행이
 *   목록에 나와야 "올리기"가 가능하다(programs_select_own_as_admin).
 * [created_by 필터를 프런트가 거는 이유] 조회 결과에는 남의 게시 프로그램과 created_by IS NULL 행이 섞여 온다.
 *   축 A 때문에 그 행들은 수정도 스캔도 항상 실패한다 → 띄우면 "누르면 반드시 실패하는 버튼"이 된다.
 * [원칙 1·6 가드] 신청자 명단·출석률·랭킹을 조회하지 않는다. [ADR 0016 예외] 신청자 수는 이 함수가 아니라
 *   fetchApplicantCounts()(program_applicant_counts RPC)로 별도 조회한다 — "몇 명"은 이제 관리자에게도
 *   열렸지만 "누가"(명단)는 여전히 ADR 0005 결정 7-2(d)로 닫혀 있다.
 *
 * @param {string} adminId 로그인한 관리자의 profile id (= auth.uid())
 * @returns {Promise<object[]>} 정렬·그룹은 화면이 한다(20행 규모. 페이징·검색·서버 정렬 없음 — ADR 0003 6번)
 */
export async function fetchAdminPrograms(adminId) {
  const { data, error } = await supabase.from('programs').select(ADMIN_MANAGE_FIELDS).limit(200);
  if (error) throw error;
  return (data ?? []).filter((p) => p.created_by && p.created_by === adminId);
}

/**
 * 프로그램 등록 — **초안(미게시)으로 저장한다** (확정 D).
 *
 * [is_published: false 를 지우지 말 것]
 *   public.programs.is_published 의 DB default 는 true 다. payload 에서 이 컬럼을 생략하면 default 가 먹어서
 *   "초안 저장"이 조용히 "즉시 게시"가 된다 — 화면·토스트·배지는 전부 초안이라고 말하는데 학생에게는 이미
 *   보이는 상태. default 는 방어가 아니다(ADR 0004 주의 4). 방어는 이 명시적 전송이다.
 * [created_by 도 명시적으로 보낸다] 같은 이유. 정책의 with check 가 created_by = auth.uid() 를 요구한다.
 *
 * @param {string} adminId 본인 profile id
 * @param {object} fields  폼 값 (FORM_COLUMNS 만 전송된다)
 * @returns {Promise<object>} 서버가 돌려준 행 (낙관적 삽입 금지 — 화면은 이 행으로 갱신한다)
 */
export async function createProgram(adminId, fields) {
  const { data, error } = await supabase
    .from('programs')
    .insert({ ...pickFormColumns(fields), created_by: adminId, is_published: false })
    .select(ADMIN_MANAGE_FIELDS)
    .single();

  if (error) throw error;
  return data;
}

/** update 공통부. `.select()` 로 영향 행 수를 확인한다 (스펙 이슈 1). */
async function patchProgramRow(programId, patch) {
  const { data, error } = await supabase
    .from('programs')
    .update(patch)
    .eq('id', programId)
    .select(ADMIN_MANAGE_FIELDS);

  if (error) throw error;

  // 0행 = RLS using 절에 걸렸거나(권한 밖) 행이 사라졌다. 에러가 오지 않으므로 여기서 판정한다.
  const rows = data ?? [];
  if (rows.length !== 1) throw new ProgramNotAffectedError();
  return rows[0];
}

/**
 * 프로그램 내용 수정. **게시 상태를 바꾸지 않는다** (확정 D — is_published 는 FORM_COLUMNS 에 없다).
 */
export async function updateProgram(programId, fields) {
  return patchProgramRow(programId, pickFormColumns(fields));
}

/**
 * 올리기 / 내리기 토글.
 *
 * [is_published 외 다른 컬럼을 함께 보내지 않는다] 목록이 들고 있는 오래된 값으로 다른 컬럼을 덮어쓰면
 *   다른 탭에서 수정한 내용을 조용히 되돌리는 사고가 난다.
 * [삭제가 아니다] delete 정책 0개. 내려도 학생의 참여 기록·QR 인증은 그대로 동작한다(ADR 0005 결정 7-4).
 */
export async function setProgramPublished(programId, nextPublished) {
  return patchProgramRow(programId, { is_published: nextPublished });
}

/**
 * 스캔 화면의 문맥 표시용 프로그램 1건. 조회에 실패해도 스캔은 그대로 동작해야 하므로 null 로 축약한다.
 * (검증은 토큰 하나로만 이뤄지며 program_id 를 서버에 넘기지 않는다 — ADR 0005 "대안으로 고려했던 것".)
 */
export async function fetchProgramBrief(programId) {
  if (!programId) return null;
  const { data, error } = await supabase
    .from('programs')
    .select('id, title, date, time, category')
    .eq('id', programId)
    .maybeSingle();
  if (error) {
    console.warn('[programService] 프로그램 조회 실패 — 문맥 표시 없이 진행합니다:', error);
    return null;
  }
  return data ?? null;
}

/**
 * 홈 추천 프로그램 목록.
 *
 * 정렬 규칙 (스펙 확정 E + ADR 0003 "케빈 확인 필요 1번 해소"):
 *   (1) profiles.career_interest 와 career_track 이 일치하는 것 우선
 *   (2) 그룹 내부는 최신순(created_at desc) 유지 — 인기순(popularity) 아님
 *   career_interest 가 비어 있으면(NULL) 그대로 최신순 fallback.
 *
 * 확정 D-1: 이미 신청한 프로그램은 추천에서 제외한다
 *   (안 하면 신청한 활동이 홈에 계속 "참여" 버튼으로 떠서 명백한 결함으로 보인다).
 *
 * @param {{career_interest?: string|null}|null} profile AuthContext의 본인 profile
 * @param {number} limit 렌더할 카드 수 (프로토타입 recommended(8)와 동일)
 * @returns {Promise<Array<object & {isMatched: boolean}>>} isMatched = "내 관심 계열" 배지 판단용
 */
export async function fetchRecommendedPrograms(profile, limit = 8) {
  const iso = todayISO();
  // ADR 0004 5번: 조인 뷰/PostgREST embed 대신 병렬 2쿼리 + 클라이언트 Set 필터.
  //   (뷰는 기본이 정의자 권한이라 participations_select_own 경계를 우회해 남의 신청 내역이 샌다.)
  const [{ data, error }, appliedIds] = await Promise.all([
    supabase
      .from('programs')
      .select(CARD_FIELDS)
      // is_published 조건은 RLS(programs_select_published)와 중복이지만 의도를 코드에 명시한다 (이중 안전장치).
      .eq('is_published', true)
      // 지난 날짜 제외. todayISO()는 로컬(KST) 기준 — toISOString()을 쓰면 KST 오전 9시 이전에 하루 밀린다.
      // `date >= 오늘`이라 "오늘 이미 끝난 프로그램"은 노출된다 — 프로토타입과 동일한 의도적 동작(ADR 0003 6번).
      // [기간제 — or 조건] date >= 오늘(아직 시작 안 함) 이거나 end_date >= 오늘(진행 중 또는 끝나지 않음).
      //   단일 일자 프로그램은 end_date 가 NULL 이라 뒷 조건이 항상 거짓이 되어 기존 동작과 같다.
      .or(`date.gte.${iso},end_date.gte.${iso}`)
      .order('created_at', { ascending: false })
      .limit(50), // 안전 상한. 데모 실제 행 수는 16~20.
    fetchAppliedProgramIds(),
  ]);

  if (error) throw error;

  // [제외 기준은 program_id 존재 여부이며 status를 보지 않는다]
  //   지금은 applied 뿐이라 결과가 같지만, QR 스펙에서 entered/completed 가 생겨도 그것들 역시 추천에서
  //   빠져야 맞다(프로토타입 recommended()의 !isJoined && !isCompleted 와 같은 의미). ADR 0004 5번.
  // [필터는 slice(0, limit) 앞에서 한다] 뒤에서 하면 신청한 만큼 홈 카드가 8장 미만으로 줄어든다.
  const rows = (data ?? []).filter((row) => !appliedIds.has(row.id));
  const interest = profile?.career_interest ?? null;

  if (!interest) {
    // 계열 미설정 -> 최신순 그대로. 배지도 붙지 않는다.
    return rows.slice(0, limit).map((row) => ({ ...row, isMatched: false }));
  }

  // 계열 일치를 앞으로 당긴다. 두 배열 모두 위 order의 최신순을 그대로 물려받는다(안정 분할).
  const matched = [];
  const others = [];
  for (const row of rows) {
    const isMatched = row.career_track === interest;
    (isMatched ? matched : others).push({ ...row, isMatched });
  }
  return matched.concat(others).slice(0, limit);
}
