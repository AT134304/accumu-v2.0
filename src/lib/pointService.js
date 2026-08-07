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
import { fmtDate, localDateOf, monthLabel } from './date';

/** 원장 표시 상한. 페이징을 만들지 않는 대신 "최근 50건" 캡션과 함께 상한을 둔다(스펙 B-2 4번). */
export const LEDGER_LIMIT = 50;

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
    .select('id, type, amount, related_participation_id, settled_month, created_at')
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
  // 전환 행의 제목은 "무엇을 정산한 것인가"다. settled_month 가 있으면 그 달을 밝힌다(ADR 0012).
  // NULL 인 전환 행은 ADR 0007 시절의 수동 전환이라 밝힐 달이 없다 — 없는 값을 지어내지 않는다.
  const convertTitle = tx?.settled_month
    ? `${monthLabel(tx.settled_month)} 적립분 지역화폐 전환`
    : '지역화폐 전환';
  return {
    earned,
    typeLabel: earned ? '적립' : '전환',
    // 적립인데 프로그램을 못 읽은 경우 = 게시중단(결정 7-4). 행을 지우지 않고 사실대로 적는다.
    title: earned ? tx?.activityTitle ?? '게시가 중단된 프로그램' : convertTitle,
    dateLabel: fmtDate(localDateOf(tx?.created_at)),
    // U+2212(−). 하이픈보다 숫자와 폭이 맞는다.
    amountLabel: `${earned ? '+' : '−'}${amount.toLocaleString()}P`,
  };
}

/* ==========================================================================
   지역화폐 정산 (ADR 0012 — 월 단위 자동 전환, 절대 원칙 3 시뮬레이션)

   [학생이 전환을 실행하는 함수가 이 파일에 없다]
     M월 적립분 전액이 (M+1)월 말일에 자동 전환된다. 금액을 고르는 인자도, 전환을 지시하는 함수도 없다.
     ADR 0007 의 convertToCurrency() / CONVERT_MIN / CONVERT_PRESETS 는 전부 제거됐고, 서버의
     convert_points_to_currency() 도 drop 됐다(마이그레이션 20260807120000). 되살리지 말 것.
   ========================================================================== */

/**
 * 정산 실행 + 예정 목록 조회. 학생 화면이 마운트될 때 호출한다.
 *
 * [화면에 들어올 때마다 불러도 안전하다] 서버가 멱등이다 — 같은 달의 두 번째 정산은
 *   unique (student_id, settled_month) 가 막는다. 프런트가 "이미 정산했는지" 를 기억하지 않는다.
 * [프런트가 정산 여부를 판정하지 않는다] 말일 계산·월 경계(KST)·대상 선정이 전부 서버 몫이다.
 *   여기서 날짜를 비교하기 시작하면 서버와 클라이언트가 서로 다른 "이번 달"을 갖게 된다.
 * [잔액을 계산하지 않는다] 응답의 points_balance/currency_balance 를 그대로 쓴다(절대 원칙 3).
 *
 * @returns {Promise<{ok:true, settled:Array<{month:string, amount:number, settle_on:string}>,
 *                    pending:Array<{month:string, amount:number, settle_on:string}>,
 *                    points_balance:number, points_total:number, currency_balance:number}>}
 * @throws 42501(비로그인/관리자 호출) 및 네트워크 오류는 그대로 던진다 — 호출부가 처리한다.
 */
export async function settleMyPoints() {
  const { data, error } = await supabase.rpc('settle_my_points');
  if (error) throw error;
  if (!data) throw new Error('정산 응답이 비어 있습니다.');
  return data;
}

/**
 * 정산 예정 1건 → 화면 문구. "8월에 모은 4,200P · 9월 30일 전환 예정"
 *
 * [진척 표현을 만들지 않는다 — 원칙 1] "얼마 남았다 / 며칠 남았다 / 몇 % 달성" 을 쓰지 않는다.
 *   여기 있는 것은 "언제 얼마가 전환된다"는 사실 두 개뿐이고, 이 함수가 그 형태를 고정한다.
 */
export function describePending(row) {
  const amount = Number(row?.amount ?? 0);
  return {
    earnedLabel: `${monthLabel(row?.month)}에 모은 ${amount.toLocaleString()}P`,
    settleLabel: `${fmtDate(row?.settle_on)} 전환 예정`,
    amount,
  };
}
