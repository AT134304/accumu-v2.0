// Accumu v2 — QR 이중 인증 서비스 (docs/adr/0005 "구현 가이드 → frontend-agent" 1번)
//
// 이 파일이 QR 관련 Supabase 호출의 유일한 소유자다. 컴포넌트는 supabase 클라이언트를 직접 만지지 않는다.
//
// [경계 요약 — 이 레이어에서 절대 하지 않는 것]
//   1. participations 를 update 하지 않는다. 상태 전이는 verify_participation_qr() RPC 안에서만 일어난다
//      (RLS update 정책이 학생·관리자 모두 0개다 — ADR 0005 결정 2).
//   2. profiles.points_* / point_transactions 를 쓰지 않는다. 포인트는 서버가 지급한다
//      (CLAUDE.md 2장 3번, ADR 0005 결정 3-4).
//   3. QR payload 의 expires_at 을 판정에 쓰지 않는다. 그 값은 학생 기기에 있는 표시용 값이라 위조 가능하다.
//      만료 판정은 서버가 DB 컬럼(*_token_expires_at)으로만 한다 (ADR 0005 결정 1-3).
import { supabase } from './supabaseClient';

/** QR 목록/스택 렌더에 필요한 프로그램 필드. 학생 RLS(programs_select_published)로 조회된다.
 *  end_date — 기간제 프로그램 판별(not null)과 QR 센터의 "오늘 세션" 범위 계산에 쓴다.
 *  attendance_payout_mode — QR 센터가 "이번 퇴장에서 포인트가 지급되는가"를 판정할 때 쓴다
 *  (20260809160000). min_attendance_days는 QR 센터 화면에 노출하지 않는다(원칙 1 — 남은 일수 게이지 금지). */
const PROGRAM_FIELDS = 'id, category, title, date, end_date, time, points, attendance_payout_mode';

/* ==========================================================================
   조회
   ========================================================================== */

/**
 * 내 참여 목록 + 프로그램 정보(클라이언트 결합).
 *
 * [뷰/embed 금지] PostgREST embed 나 DB 뷰로 조인하면 정의자 권한 함정에 빠진다
 *   (ADR 0003 6번 / ADR 0004 5번). 병렬 2쿼리 + 클라이언트 Map 결합으로 끝낸다.
 * [student_id 필터를 걸지 않는다] RLS(participations_select_own)가 본인 행만 내려준다.
 * [방어적 렌더 — ADR 0005 결정 7-4] 게시중단(is_published=false)된 프로그램은 학생이 select 할 수 없다.
 *   그 참여 건은 `program: null` 로 내려가며, 화면은 이 경우에도 죽지 않아야 한다(알려진 틈으로 수용됨).
 *
 * @returns {Promise<Array<{id, program_id, status, entry_at, exit_at, program: object|null}>>}
 */
export async function fetchMyParticipationsWithProgram() {
  const { data, error } = await supabase
    .from('participations')
    .select('id, program_id, status, entry_at, exit_at');
  if (error) throw error;

  const rows = data ?? [];
  const ids = [...new Set(rows.map((r) => r.program_id).filter(Boolean))];

  let byId = new Map();
  if (ids.length > 0) {
    const { data: programs, error: pErr } = await supabase
      .from('programs')
      .select(PROGRAM_FIELDS)
      .in('id', ids);
    if (pErr) {
      // 프로그램 조회 실패는 참여 목록 전체를 죽일 이유가 아니다. 제목 자리에 대체 문구가 뜬다.
      console.warn('[participationService] 프로그램 정보 조회 실패 — 제목 없이 진행합니다:', pErr);
    } else {
      byId = new Map((programs ?? []).map((p) => [p.id, p]));
    }
  }

  return rows.map((r) => ({ ...r, program: byId.get(r.program_id) ?? null }));
}

/**
 * 폴링 전용 경량 조회 — participations 만 본다.
 *
 * [왜 별도 함수인가] QR 모달의 10초 폴링은 "관리자가 스캔했는가"만 알면 된다. 여기서 programs 까지
 *   같이 긁으면 10초마다 불필요한 왕복이 는다. ADR 0005 구현 가이드도 "폴링은 participations 만 조회한다"로
 *   못박았다. Supabase realtime 구독은 도입하지 않는다(폴링으로 충분 — 스펙 명시).
 */
export async function fetchParticipationStatuses() {
  const { data, error } = await supabase.from('participations').select('id, status');
  if (error) throw error;
  return data ?? [];
}

/**
 * 완료된 활동만 (홈 마일스톤 스택 데이터 소스 — ADR 0005 결정 5, 확정 B-1).
 * 월 버킷 기준은 programs.date 이므로 program 이 없는 행은 화면에서 버킷을 결정할 수 없다(알려진 틈).
 */
export async function fetchCompletedActivities() {
  const rows = await fetchMyParticipationsWithProgram();
  return rows.filter((r) => r.status === 'completed');
}

/* ==========================================================================
   QR 발급 (학생 본인)
   ========================================================================== */

/**
 * 입장/퇴장 토큰 발급. 호출할 때마다 새 토큰으로 덮어쓴다(= 이전 토큰 즉시 무효, 만료 30분 재시작).
 * "다시 발급받기"와 목록의 QR 버튼이 같은 동작이라 분기가 없다 (ADR 0005 결정 1-4).
 *
 * @param {{participationId: string, type: 'entry'|'exit'}} args
 * @returns {Promise<{ok:true, participation_id, type, token, expires_at} | {ok:false, reason:'already_completed'|'wrong_order'}>}
 * @throws 42501(남의 참여 건/비로그인) 및 네트워크 오류는 그대로 던진다 — 호출부가 사용자에게 알린다.
 */
export async function issueQr({ participationId, type }) {
  const { data, error } = await supabase.rpc('issue_participation_qr', {
    p_participation_id: participationId,
    p_type: type,
  });
  if (error) throw error;
  return data ?? { ok: false, reason: 'unknown' };
}

/**
 * QR 로 인코딩할 payload = **토큰 문자열 하나**.
 *
 * [2026-08-07 변경 — 4필드 JSON 에서 토큰 1개로 줄였다]
 *   이전에는 {participation_id, type, expires_at, token} 을 JSON 으로 담았다(CLAUDE.md 6장 초안).
 *   그런데 그 3개는 **어디에서도 읽히지 않았다**:
 *     - participation_id / type : extractToken() 이 명시적으로 버린다(아래 함수 주석 — 위조 가능한 값이라
 *       검증에 넣지 않는다). 서버 verify_participation_qr(p_token) 은 인자가 토큰 하나뿐이다.
 *     - expires_at : 학생 화면의 30분 카운트다운은 QR 이 아니라 발급 응답(issued)에서 읽는다.
 *       만료 판정의 소유자는 서버의 *_token_expires_at 컬럼이다(ADR 0005 결정 1-3).
 *   즉 세 필드는 QR 을 촘촘하게 만들기만 했다: 약 136바이트 = QR 버전 7(45×45 모듈).
 *   토큰만 담으면 10자 영숫자 = **버전 1(21×21 모듈)** 이다. 한 변 모듈 수가 절반 이하가 되어
 *   같은 화면 크기에서 모듈 하나가 2배 커지고, 그만큼 카메라가 빨리 잡는다.
 *
 * [보안 경계는 그대로다] 서버가 읽지 않던 값을 빼는 것이라 검증에 쓰이는 정보가 줄지 않는다.
 *   토큰은 여전히 서버만 만들고(qr_generate_token 은 grant 0개), 1회용이며, 30분 만료다.
 * [덤] 화면 아래 수동 입력용으로 이미 보여주던 "코드 XXXXXXXXXX" 와 QR 내용이 글자 단위로 같아진다.
 *   카메라 경로와 수동 입력 경로가 같은 문자열을 지난다(확정 D-1 이 의도한 모양).
 */
export function buildQrPayload(issued) {
  return issued.token;
}

/* ==========================================================================
   기간제 프로그램 — 일별 출석 (attendance_sessions, 20260809140000 마이그레이션)
   ========================================================================== */

/**
 * 기간제 프로그램의 "오늘" 세션 입장/퇴장 토큰 발급. issueQr()의 기간제 버전 — 서버가 날짜를 정한다
 * (클라이언트는 어떤 날짜인지 고를 수 없다).
 *
 * @param {{participationId: string, type: 'entry'|'exit'}} args
 * @returns {Promise<{ok:true, participation_id, session_date, type, token, expires_at} |
 *                    {ok:false, reason:'already_completed'|'wrong_order'|'out_of_range'|'not_period_program'}>}
 */
export async function issueAttendanceQr({ participationId, type }) {
  const { data, error } = await supabase.rpc('issue_attendance_qr', {
    p_participation_id: participationId,
    p_type: type,
  });
  if (error) throw error;
  return data ?? { ok: false, reason: 'unknown' };
}

/**
 * 참여 1건의 날짜별 출석 기록(오래된 날짜부터). 단일 일자 프로그램은 항상 빈 배열이다.
 * RLS(attendance_sessions_select_own)가 본인 참여 건만 내려준다.
 *
 * @param {string} participationId
 * @returns {Promise<Array<{id, session_date, status, entry_at, exit_at}>>}
 */
export async function fetchAttendanceSessions(participationId) {
  const { data, error } = await supabase
    .from('attendance_sessions')
    .select('id, session_date, status, entry_at, exit_at')
    .eq('participation_id', participationId)
    .order('session_date', { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/* ==========================================================================
   QR 검증 (관리자)
   ========================================================================== */

/**
 * 스캔 문자열에서 토큰만 꺼낸다.
 *
 * [이 한 줄이 "카메라와 수동 입력이 같은 경로"를 만든다 — 확정 D-1]
 *   카메라와 수동 입력을 여기서 같은 문자열로 만든 뒤 같은 verify_participation_qr() 하나를 호출한다.
 *   인증 단계를 줄이는 게 아니라 입력 수단만 다르다(절대 원칙 5의 "단순화"에 해당하지 않는다).
 *   buildQrPayload() 가 토큰만 담게 된 뒤로는 두 경로의 입력이 애초에 같은 문자열이다.
 * [JSON 분기는 남겨 둔다] 이전 형식(4필드 JSON)으로 이미 떠 있는 화면·캡처본이 그대로 인식되게 하는
 *   호환 경로이고, 유지 비용이 if 한 줄이다. 여기서 얻는 값은 여전히 token 뿐이다.
 * [payload 의 participation_id / type 은 버린다] 위조 가능한 값이라 검증에 넣지 않는다.
 *   종류(입장/퇴장)는 서버가 "어느 컬럼에 매칭됐는가"로만 결정한다.
 * 대소문자·하이픈·공백 섞임은 서버 qr_normalize_token() 이 처리하므로 여기서 손대지 않는다.
 */
export function extractToken(rawScanned) {
  if (typeof rawScanned !== 'string') return '';
  const s = rawScanned.trim();
  if (!s) return '';
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj.token === 'string' && obj.token.trim()) return obj.token.trim();
    } catch {
      // JSON 이 아니면 문자열 전체를 토큰으로 취급한다(수동 입력 경로).
    }
  }
  return s;
}

/** verifyQr() 결과 분류. 인증 거부(rejected)와 기술 오류(error)를 절대 섞지 않는다 (스펙 E절 명시). */
export const VERIFY = {
  SUCCESS: 'success',
  REJECTED: 'rejected',
  ERROR: 'error',
};

/**
 * 관리자 QR 검증. 카메라 스캔과 수동 코드 입력이 모두 이 함수 하나를 호출한다.
 *
 * [단일 일자 + 기간제를 여기서 함께 흡수한다 — AdminScanPage 는 두 종류를 몰라도 된다]
 *   verify_participation_qr(단일 일자) 을 먼저 시도하고, 그 사유가 'not_found'일 때만
 *   verify_attendance_qr(기간제) 을 시도한다. 토큰은 두 테이블을 합쳐 전역적으로 유일하므로
 *   (issue_attendance_qr 이 발급 시 양쪽 테이블을 모두 확인한다) 한 토큰이 두 함수 모두에서
 *   not_found 가 아닌 경우는 없다 — 순서를 뒤집어도 안전하지만, 단일 일자가 절대다수이므로
 *   이 순서가 왕복을 최소화한다.
 *
 * @param {string} rawScanned QR 원문(JSON payload) 또는 사람이 친 토큰 문자열
 * @returns {Promise<{outcome:'success'|'rejected'|'error', reason?:string, errorKind?:'permission'|'network',
 *                    type?:'entry'|'exit', student_name?:string, program_title?:string,
 *                    points_awarded?:number, at?:string, final?:boolean, session_date?:string}>}
 */
export async function verifyQr(rawScanned) {
  const token = extractToken(rawScanned);
  if (!token) {
    // 빈 입력은 서버까지 갈 필요가 없다. 서버와 같은 사유로 맞춘다(정규화 후 길이≠10 → not_found).
    return { outcome: VERIFY.REJECTED, reason: 'not_found' };
  }

  const first = await callVerifyRpc('verify_participation_qr', token);
  if (first.outcome !== VERIFY.REJECTED || first.reason !== 'not_found') {
    return first;
  }
  // 단일 일자 테이블에 없는 토큰 — 기간제 출석 세션에서 다시 찾는다.
  return callVerifyRpc('verify_attendance_qr', token);
}

async function callVerifyRpc(fnName, token) {
  const { data, error } = await supabase.rpc(fnName, { p_token: token });

  if (error) {
    // 42501 = 학생이 호출했거나 비로그인. 정상 사용에서는 발생하지 않는다(발생하면 버그).
    // 인증 거부와 혼동시키지 않기 위해 별도 분류로 올린다 (ADR 0005 결정 4).
    const kind = error.code === '42501' ? 'permission' : 'network';
    console.error(`[participationService] QR 검증 호출 실패(${fnName}):`, error);
    return { outcome: VERIFY.ERROR, errorKind: kind, reason: error.message };
  }

  if (!data) return { outcome: VERIFY.ERROR, errorKind: 'network', reason: '빈 응답' };

  return data.ok
    ? { ...data, outcome: VERIFY.SUCCESS }
    : { ...data, outcome: VERIFY.REJECTED };
}

/* ==========================================================================
   사유 → 사람이 읽는 문구
   ========================================================================== */

/**
 * 관리자 스캔 화면의 거부 사유 문구 (docs/specs/qr-dual-auth.md E절 표 그대로).
 * 서버(verify_participation_qr)가 돌려주는 reason 문자열이 키다.
 */
export const REJECT_TEXT = {
  expired: { title: '만료된 QR입니다', hint: '학생에게 다시 발급을 요청하세요' },
  used: { title: '이미 사용된 QR입니다', hint: '이 코드로는 더 이상 인증되지 않습니다' },
  not_found: { title: '인식할 수 없는 코드입니다', hint: '재발급으로 무효가 된 코드일 수 있습니다' },
  wrong_order: { title: '입장 인증이 먼저 필요합니다', hint: '입장 QR을 먼저 인증해 주세요' },
  already_completed: { title: '이미 참여가 완료된 건입니다', hint: '포인트는 한 번만 지급됩니다' },
  not_authorized: { title: '이 프로그램의 담당 관리자가 아닙니다', hint: '내가 올린 프로그램의 QR만 인증할 수 있습니다' },
};

export function rejectText(reason) {
  return (
    REJECT_TEXT[reason] ?? {
      title: '인증하지 못했습니다',
      hint: '알 수 없는 사유입니다. 학생에게 다시 발급을 요청하세요',
    }
  );
}

/** 학생 발급 화면의 사유 문구. 서버와 화면 상태가 어긋났다는 신호라 "목록 새로고침"으로 이어진다. */
export function issueRejectText(reason) {
  if (reason === 'already_completed') return '이미 참여가 완료된 활동입니다.';
  if (reason === 'wrong_order') return '입장 인증을 먼저 완료해 주세요.';
  // 기간제 프로그램(issueAttendanceQr) 전용 사유 — CLAUDE.md 6장/ADR 신규.
  if (reason === 'out_of_range') return '아직 참여 기간이 아니거나 이미 끝났습니다.';
  if (reason === 'not_period_program') return '기간제 프로그램이 아닙니다. 새로고침 후 다시 시도해 주세요.';
  return 'QR을 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}
