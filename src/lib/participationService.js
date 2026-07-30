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

/** QR 목록/스택 렌더에 필요한 프로그램 필드. 학생 RLS(programs_select_published)로 조회된다. */
const PROGRAM_FIELDS = 'id, category, title, date, time, points';

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
 * QR 로 인코딩할 payload. 구조는 CLAUDE.md 6장 그대로 {participation_id, type, expires_at, token}.
 *
 * [expires_at 은 표시용이다] 학생 화면의 30분 카운트다운을 그리기 위해서만 들어간다.
 *   서버는 이 값을 읽지 않는다(읽으면 학생이 만료를 위조할 수 있다 — ADR 0005 결정 1-3).
 */
export function buildQrPayload(issued) {
  return JSON.stringify({
    participation_id: issued.participation_id,
    type: issued.type,
    expires_at: issued.expires_at,
    token: issued.token,
  });
}

/* ==========================================================================
   QR 검증 (관리자)
   ========================================================================== */

/**
 * 스캔 문자열에서 토큰만 꺼낸다.
 *
 * [이 한 줄이 "카메라와 수동 입력이 같은 경로"를 만든다 — 확정 D-1]
 *   카메라는 JSON payload 를 읽고, 수동 입력은 토큰 문자열만 받는다. 둘을 여기서 같은 문자열로 만든 뒤
 *   같은 verify_participation_qr() 하나를 호출한다. 인증 단계를 줄이는 게 아니라 입력 수단만 다르다
 *   (절대 원칙 5의 "단순화"에 해당하지 않는다).
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
 * @param {string} rawScanned QR 원문(JSON payload) 또는 사람이 친 토큰 문자열
 * @returns {Promise<{outcome:'success'|'rejected'|'error', reason?:string, errorKind?:'permission'|'network',
 *                    type?:'entry'|'exit', student_name?:string, program_title?:string,
 *                    points_awarded?:number, at?:string}>}
 */
export async function verifyQr(rawScanned) {
  const token = extractToken(rawScanned);
  if (!token) {
    // 빈 입력은 서버까지 갈 필요가 없다. 서버와 같은 사유로 맞춘다(정규화 후 길이≠10 → not_found).
    return { outcome: VERIFY.REJECTED, reason: 'not_found' };
  }

  const { data, error } = await supabase.rpc('verify_participation_qr', { p_token: token });

  if (error) {
    // 42501 = 학생이 호출했거나 비로그인. 정상 사용에서는 발생하지 않는다(발생하면 버그).
    // 인증 거부와 혼동시키지 않기 위해 별도 분류로 올린다 (ADR 0005 결정 4).
    const kind = error.code === '42501' ? 'permission' : 'network';
    console.error('[participationService] QR 검증 호출 실패:', error);
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
  return 'QR을 발급하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}
