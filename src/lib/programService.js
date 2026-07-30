// Accumu v2 — programs / participations 서비스 (ADR 0003 6번, ADR 0004 "구현 가이드 → frontend-agent")
// 컴포넌트가 supabase 쿼리를 직접 들고 있지 않도록 이 레이어에 모은다.
import { supabase } from './supabaseClient';
import { todayISO } from './date';

// ADR 0003 6번의 select 목록 그대로. 홈 카드가 그리는 필드만 가져온다.
const CARD_FIELDS = 'id, category, title, org, date, time, points, career_track, status';

// 프로그램 선택 화면용. 카드 필드 + 팝업(description) + 클라이언트 정렬 입력(popularity/created_at).
//
// [정렬을 클라이언트에서 하므로 popularity/created_at을 페이로드에 실어야 한다]
//   서버 .order()로 처리하면 정렬을 바꿀 때마다 재조회가 된다(20행 규모에 불필요한 왕복).
// [원칙 가드 — popularity] 이 값은 "인기순" 정렬의 입력으로만 쓴다.
//   숫자를 화면에 렌더하지 않는다. "TOP 3"/"인기 1위"/"N명 신청" 같은 순위·과열 라벨도 만들지 않는다
//   (docs/specs/student-programs.md "절대 원칙 체크", CLAUDE.md 2장 1번).
//   홈(fetchRecommendedPrograms)은 이 필드를 계속 가져오지 않는다 — 거기선 정렬 기준이 아니다.
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
 * [status를 화면 로직에 쓰지 않는다] 이번 스코프에서 값은 항상 'applied'이고, 이 컬럼의 의미는 QR 스펙에서
 *   확정된다. "신청됨" 판정은 오로지 행의 존재 여부로만 한다 (ADR 0004 구현 가이드 4번).
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
 * 참여 신청.
 *
 * [보내는 컬럼은 student_id / program_id 둘뿐이다 — 다른 컬럼을 추가하지 말 것]
 *   RLS participations_insert_own 의 with check 가 status='applied', entry_at/exit_at/entry_token/exit_token
 *   is null 을 요구한다. status 는 DB default('applied')가 채우고, created_at 도 DB default 에 맡긴다.
 *   여기에 컬럼을 하나 더 실으면 원인 불명의 403(42501)이 난다 (ADR 0004 "알려진 틈" / 구현 가이드 1번).
 * [포인트를 건드리지 않는다] 신청만으로는 1P도 지급되지 않는다. 지급 시점은 QR 퇴장 인증
 *   (CLAUDE.md 2장 3번 / 6장 3번). 이 함수에 points_balance/point_transactions 경로를 만들지 말 것.
 *
 * @param {{studentId: string, programId: string}} args studentId 는 AuthContext 의 본인 id (= auth.uid())
 * @returns {Promise<'created'|'duplicate'|'full'>}
 *   'duplicate' = DB unique 제약(23505/409). 에러가 아니라 상태 동기화 신호로 다룬다.
 *   'full'      = 정원 게이트 트리거 거부(P0001 / hint='capacity_full' / 400). ADR 0006 결정 5.
 * @throws 그 외 실패(RLS 42501 / 네트워크 등)는 그대로 던진다 — 호출부가 사용자에게 알린다.
 */
export async function applyToProgram({ studentId, programId }) {
  const { error } = await supabase
    .from('participations')
    .insert({ student_id: studentId, program_id: programId });

  if (!error) return 'created';

  // 정원 마감: before insert 트리거 participations_capacity_guard 의 거부 (ADR 0006).
  //
  // [판별은 code 가 아니라 hint 로 한다] P0001 은 plpgsql `raise exception` 의 범용 코드라 앞으로 다른
  //   도메인 예외가 생기면 구분되지 않는다. `hint = 'capacity_full'` 이 backend 와의 명시적 계약이다
  //   (ADR 0006 결정 5-1). 한국어 message 를 파싱하지 않는다.
  // [응답에 숫자가 없다] 신청자 수·남은 자리는 서버가 내보내지 않는다(결정 6-1). 화면에서 파생 계산도 금지 —
  //   "남은 자리 N석"/"N/20명"/"마감 임박"/게이지를 만들 데이터 자체가 존재하지 않는다.
  if (error.hint === 'capacity_full') return 'full';

  // 중복 신청: 클라이언트 방어(버튼 비활성)를 새로고침·두 탭·개발자도구로 우회해도 DB가 막는다.
  // 사용자에게 실패 팝업을 띄울 상황이 아니라 "이미 신청됨"으로 화면을 맞추면 되는 상황이다.
  //
  // [정원이 찬 프로그램에 이미 신청한 학생도 여기로 온다] 트리거가 with check·unique 보다 먼저 실행되지만,
  //   트리거 4단계(같은 학생의 기존 행이면 통과 — 결정 5-2)가 duplicate 사유를 보존한다.
  //   'full' 로 나온다면 backend 가 그 단계를 빠뜨린 것이다.
  if (error.code === '23505') return 'duplicate';

  // 42501(RLS 거부)을 'full' 로 뭉개지 말 것. 권한 오류는 정상 사용에서 발생하지 않는다 = 버그 신호이고,
  // 마감으로 표시하면 진짜 버그가 영원히 숨는다 (ADR 0005 결정 4 / ADR 0006 결정 5-4).
  throw error;
}

/* ==========================================================================
   관리자 홈 (ADR 0005 결정 7-5 — 새 RLS 정책 0개)
   ========================================================================== */

// 관리자 홈이 그리는 필드 + created_by(본인 필터용). is_published 는 상태 표시가 아니라
// "왜 이 행이 보이는가"를 코드에서 설명하기 위해 함께 가져온다.
const ADMIN_FIELDS = 'id, category, title, org, date, time, points, is_published, created_by';

/**
 * 관리자 홈용 프로그램 조회 — "오늘 진행" + "예정".
 *
 * [새 정책 없이 성립한다] 기존 programs_select_published + programs_select_own_as_admin 로 충분하다.
 * [created_by 필터를 프런트가 거는 이유] 확정 H-1 때문에 남의 프로그램은 스캔이 항상 실패한다.
 *   목록에 띄우면 "누르면 반드시 실패하는 버튼"이 된다 (ADR 0005 결정 7-5).
 * [날짜는 todayISO()(로컬/KST)로 거른다] DB 의 current_date 로 거르지 않는다 — 그러면 "오늘"의 소스가
 *   프런트와 DB 로 갈린다 (ADR 0003 6번 / ADR 0004 타임존 판단 유지).
 * [원칙 1·6 가드] 참여자 수·신청자 명단·출석률·랭킹을 조회하지 않는다. 관리자에게 그 데이터를 주는
 *   RLS 정책 자체가 없다 (ADR 0005 결정 7-2(d)).
 *
 * @param {string} adminId 로그인한 관리자의 profile id (= auth.uid())
 * @returns {Promise<{today: object[], upcoming: object[]}>}
 */
export async function fetchAdminHomePrograms(adminId) {
  const { data, error } = await supabase.from('programs').select(ADMIN_FIELDS).limit(200);
  if (error) throw error;

  const iso = todayISO();
  const mine = (data ?? []).filter((p) => p.created_by && p.created_by === adminId);

  const byDateAsc = (a, b) => String(a.date).localeCompare(String(b.date));
  return {
    today: mine.filter((p) => p.date === iso).sort(byDateAsc),
    upcoming: mine.filter((p) => String(p.date) > iso).sort(byDateAsc).slice(0, 5),
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
  'id, category, title, org, description, date, time, capacity, points, career_track, status, is_published, created_by, created_at';

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
 * [원칙 1·6 가드] 참여자 수·신청자 명단·출석률·랭킹을 조회하지 않는다. 애초에 관리자에게 그 데이터를 주는
 *   정책이 없다(ADR 0005 결정 7-2(d)).
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
      .gte('date', todayISO())
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
