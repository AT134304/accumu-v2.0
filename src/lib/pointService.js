// Accumu v2 — 포인트 원장 조회 + 지역화폐 전환 (ADR 0007 결정 1·3 / docs/specs/student-archive-mypage.md B-2·B-3)
//
// [경계 요약 — 이 레이어에서 하지 않는 것]
//   1. student_id 필터를 클라이언트에서 걸지 않는다 — point_transactions_select_own 이 소유자다.
//   2. 포인트를 늘리는 코드가 이 파일에 한 줄도 없다. 적립은 verify_participation_qr() 안에서만 일어난다
//      (ADR 0005 결정 3-4 / 0007 결정 3-6). 여기 있는 쓰기 경로는 "줄이는" 전환 RPC 하나뿐이다.
//   3. 전환 후 잔액을 프런트가 빼서 만들지 않는다. RPC 응답에 실려 오는 서버 값을 그대로 쓴다
//      (직접 계산하면 동시 요청·거부 경로에서 서버와 어긋난다).
//   4. 실제 결제·계좌·외부 API 호출 0줄 (CLAUDE.md 2장 3번). 전환은 잔액 이동 + 원장 1행이 전부다.
//   5. 뷰/embed 로 조인하지 않는다 — 정의자 권한 함정(ADR 0003 6번). 병렬 쿼리 + 클라이언트 Map 결합.
import { supabase } from './supabaseClient';
import { attachPrograms } from './archiveService';
import { fmtDate, localDateOf } from './date';

/** 원장 표시 상한. 페이징을 만들지 않는 대신 "최근 50건" 캡션과 함께 상한을 둔다(스펙 B-2 4번). */
export const LEDGER_LIMIT = 50;

/* 전환 규칙 — 확정 F. 서버(convert_points_to_currency)와 같은 값이며 서버가 최종 판정자다.
   여기 상수는 "화면이 잘못된 금액을 만들지 않게" 하는 것이고, 우회는 서버가 22023 으로 막는다. */
export const CONVERT_MIN = 100; // 최소 100P — 최소 적립액(150P)보다 낮아 첫 활동 1건으로도 시연된다
export const CONVERT_UNIT = 10; // 10P 단위 — 적립액이 항상 10의 배수라 "전액 전환"이 정확히 떨어진다
/** 프리셋 눈금. 프로토타입은 [1000,3000,5000,10000] 이었지만 데모 잔액이 수백~수천P라 눈금을 낮췄다(확정 F). */
export const CONVERT_PRESETS = [500, 1000, 3000];

/* ==========================================================================
   조회 — 포인트 내역 (원장)
   ========================================================================== */

/**
 * 내 포인트 원장 원본 50건 (created_at 내림차순).
 *
 * [student_id 를 걸지 않는다] point_transactions_select_own 이 본인 행만 내려준다. 클라이언트 필터를
 *   덧붙이면 "권한은 정책이 판정한다"는 구조가 화면 코드로 새어 나온다(archiveService 와 같은 규율).
 */
export async function fetchMyPointTransactions() {
  const { data, error } = await supabase
    .from('point_transactions')
    .select('id, type, amount, related_participation_id, created_at')
    .order('created_at', { ascending: false })
    .limit(LEDGER_LIMIT);
  if (error) throw error;
  return data ?? [];
}

/**
 * 원장 행에 활동명을 붙인다. 2단 결합이다:
 *   point_transactions.related_participation_id -> participations.program_id -> programs.title
 *
 * [전환 행은 이 축이 NULL 이다] point_transactions_source_rule CHECK 가 (type='전환' => related is null)을
 *   보장한다. 그래서 undefined 접근으로 죽지 않게 하는 게 아니라, 애초에 결합 대상에서 빠진다.
 * [실패해도 행이 사라지지 않는다] 결합에 필요한 두 조회 중 어느 쪽이 실패하든 금액·유형·날짜는
 *   원장 자신이 갖고 있다. 활동명만 대체 문구가 된다(스펙 "방어적 렌더" — 포인트 내역은 영향받지 않는다).
 */
async function attachActivityTitles(rows) {
  const list = rows ?? [];
  const ids = [...new Set(list.map((r) => r.related_participation_id).filter(Boolean))];
  if (ids.length === 0) return list.map((r) => ({ ...r, activityTitle: null }));

  let titleByParticipation = new Map();
  const { data, error } = await supabase.from('participations').select('id, program_id').in('id', ids);
  if (error) {
    console.warn('[pointService] 참여 정보 조회 실패 — 활동명 없이 내역만 표시합니다:', error);
  } else {
    // attachPrograms 는 게시중단(select 불가) 프로그램을 program:null 로 내려준다 (ADR 0005 결정 7-4).
    const joined = await attachPrograms(data ?? []);
    titleByParticipation = new Map(joined.map((p) => [p.id, p.program?.title ?? null]));
  }

  return list.map((r) => ({
    ...r,
    activityTitle: r.related_participation_id ? titleByParticipation.get(r.related_participation_id) ?? null : null,
  }));
}

/** 화면이 쓰는 형태의 포인트 내역. 조회 실패는 throw 한다 — 잔액은 살리고 내역 영역만 에러로 표시한다. */
export async function fetchMyPointLedger() {
  return attachActivityTitles(await fetchMyPointTransactions());
}

/**
 * 참여 id → 지급된 포인트 (아카이브 활동 행 표시용 — 확정 L-1).
 *
 * [★ programs.points 를 쓰지 않는 이유] 표시할 값은 "그때 실제로 지급된 금액"이다. 관리자가 프로그램의
 *   포인트를 나중에 수정하면 programs.points 는 바뀌지만 이미 지급된 금액은 바뀌지 않는다 —
 *   programs.points 로 그리면 원장과 어긋난 "틀린 숫자"가 된다(ADR 0005 결정 3-6).
 * [원장 목록과 별도 쿼리인 이유] 내역은 최근 50건 상한이지만 아카이브는 완료 활동 전부를 그린다.
 *   50건 상한을 공유하면 오래된 활동의 포인트만 조용히 사라진다.
 */
export async function fetchMyEarnedAmounts() {
  const { data, error } = await supabase
    .from('point_transactions')
    .select('amount, related_participation_id')
    .eq('type', '적립')
    .limit(200); // archiveService.SAFE_LIMIT 과 같은 성격의 안전 상한
  if (error) throw error;

  const map = new Map();
  for (const row of data ?? []) {
    // 전환 행은 related 가 NULL 이라 애초에 걸리지 않지만, 방어적으로 한 번 더 거른다.
    if (row.related_participation_id) map.set(row.related_participation_id, row.amount);
  }
  return map;
}

/**
 * 원장 1행의 표시 값. 화면 컴포넌트가 유형 분기를 흩뿌리지 않게 한 곳으로 모은다.
 *
 * [부호는 type 이 정한다] DB 의 amount 는 적립·전환 모두 양수다(point_transactions_amount_positive).
 *   화면의 +/− 는 여기서만 만든다 — 음수를 저장하는 경로가 생기면 그게 곧 포인트 자가 발행이다.
 */
export function describeTransaction(tx) {
  const earned = tx?.type === '적립';
  const amount = Number(tx?.amount ?? 0);
  return {
    earned,
    typeLabel: earned ? '적립' : '전환',
    // 적립인데 프로그램을 못 읽은 경우 = 게시중단(결정 7-4). 행을 지우지 않고 사실대로 적는다.
    title: earned ? tx?.activityTitle ?? '게시가 중단된 프로그램' : '지역화폐 전환',
    dateLabel: fmtDate(localDateOf(tx?.created_at)),
    // U+2212(−). 하이픈보다 숫자와 폭이 맞는다.
    amountLabel: `${earned ? '+' : '−'}${amount.toLocaleString()}P`,
  };
}

/* ==========================================================================
   전환 (절대 원칙 3 — 시뮬레이션)
   ========================================================================== */

/**
 * 잔액에서 고를 수 있는 전환 금액 목록.
 * 프리셋은 잔액 이하만 남기고, "전액 전환"은 잔액이 최소 단위를 넘으면 항상 있다(확정 F).
 * 잔액은 언제나 10의 배수라(원칙 7) 전액이 10P 단위를 벗어날 일이 없다.
 */
export function convertOptions(balance) {
  const avail = Number(balance ?? 0);
  if (avail < CONVERT_MIN) return [];
  const presets = CONVERT_PRESETS.filter((v) => v <= avail && v !== avail);
  return [...presets, avail];
}

/** convertToCurrency() 결과 분류. 도메인 거부(rejected)와 기술/권한 오류(error)를 절대 섞지 않는다. */
export const CONVERT = {
  SUCCESS: 'success',
  REJECTED: 'rejected',
  ERROR: 'error',
};

/**
 * 포인트 → 지역화폐 전환.
 *
 * [멱등이 아니다] 두 번 호출하면 두 번 차감되는 것이 정상 도메인이다(ADR 0007 결정 3-5).
 *   그래서 더블클릭 방어는 호출부의 버튼 잠금이 진다 — 여기서 재시도를 자동으로 하지 않는다.
 * [잔액 부족은 에러가 아니다] 서버가 예외 대신 { ok:false, reason:'insufficient_balance' } 로 돌려주며,
 *   응답에 최신 잔액 3종이 함께 실린다. 42501(권한)과 절대 같은 문구로 묶지 말 것(스펙 에러 처리 표).
 *
 * @param {number} amount 10P 단위, 100P 이상, 잔액 이하 (최종 판정은 서버)
 * @returns {Promise<{outcome:'success'|'rejected'|'error', reason?:string,
 *                    errorKind?:'permission'|'invalid_amount'|'network',
 *                    amount?:number, points_balance?:number, points_total?:number, currency_balance?:number}>}
 */
export async function convertToCurrency(amount) {
  const { data, error } = await supabase.rpc('convert_points_to_currency', { p_amount: amount });

  if (error) {
    // 42501 = 비로그인/관리자 호출. 22023 = 금액 규칙 위반(정상 UI 에서는 발생하지 않는다 — 발생하면 우회나 버그).
    const errorKind =
      error.code === '42501' ? 'permission' : error.code === '22023' ? 'invalid_amount' : 'network';
    console.error('[pointService] 전환 RPC 호출 실패:', error);
    return { outcome: CONVERT.ERROR, errorKind, reason: error.message };
  }

  if (!data) return { outcome: CONVERT.ERROR, errorKind: 'network', reason: '빈 응답' };

  return data.ok ? { ...data, outcome: CONVERT.SUCCESS } : { ...data, outcome: CONVERT.REJECTED };
}

/**
 * 실패 사유 → 화면 문구 (스펙 "에러 처리" 표 그대로).
 * 잔액 부족 / 권한 오류 / 금액 규칙 / 네트워크가 서로 다른 문장을 갖는 것이 이 함수의 목적이다.
 */
export function convertFailText(result) {
  if (result?.outcome === CONVERT.REJECTED) {
    return result.reason === 'insufficient_balance'
      ? '포인트가 부족합니다. 잔액을 다시 확인해 주세요.'
      : '전환하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
  switch (result?.errorKind) {
    case 'permission':
      return '권한 오류 · 다시 로그인해 주세요.';
    case 'invalid_amount':
      return '전환 금액은 100P 이상, 10P 단위여야 합니다.';
    default:
      return '전환하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}
