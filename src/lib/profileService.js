// Accumu v2 — 학생 본인 프로필 쓰기 (ADR 0007 결정 4 / docs/specs/student-archive-mypage.md B-1 3번)
//
// [profiles 의 update 정책은 여전히 0개다] 학생이 자기 행을 고치는 유일한 경로가 이 RPC 하나다.
//   정책을 열면(컬럼 grant 를 함께 걸어도) points_* 까지 열리므로 검토 대상이 아니다(ADR 0007 결정 4-3).
//   그래서 이 파일에는 supabase.from('profiles').update(...) 가 존재하지 않는다 — 앞으로도 추가하지 말 것.
import { supabase } from './supabaseClient';

/**
 * 관심 진로 계열 저장/해제.
 *
 * [해제는 null 을 "명시적으로" 보낸다] 키를 생략하면 인자 없는 시그니처를 찾다가 실패한다
 *   (ADR 0007 결정 4-1 / 마이그레이션 주석). track 이 falsy 면 null 로 정규화해 항상 키를 싣는다.
 * [값 검증을 여기서 하지 않는다] 인자 타입이 career_track enum 이라 5종 외의 값은 PostgREST 캐스팅
 *   단계에서 22P02 로 걸린다. 프런트가 5종 목록을 다시 적으면 taxonomy 와 갈라진다(드리프트).
 *
 * @param {'sci'|'it'|'hum'|'biz'|'art'|null} track
 * @returns {Promise<{ok:true, career_interest:string|null}>}
 * @throws 권한(42501)·네트워크 오류는 그대로 던진다 — 호출부가 칩을 이전 값으로 롤백하고 사유를 띄운다.
 */
export async function setCareerInterest(track) {
  const { data, error } = await supabase.rpc('set_career_interest', { p_track: track || null });
  if (error) throw error;
  return data ?? { ok: true, career_interest: track || null };
}

/* ==========================================================================
   계정 연동 (docs/specs/auth-signup.md 확정 D / ADR 0008 결정 5)
   ========================================================================== */

/**
 * 개인 계정 → 학교 계정. 초대코드가 가리키는 관리자의 담당 학생이 된다.
 *
 * [한 방향뿐이다] 해제(school → personal)는 만들지 않는다 — mentor_students delete 경로가 필요하고,
 *   그건 학생이 자기 기록을 관리자 시야에서 지울 수 있게 만드는 일이다.
 * [학생 id 를 인자로 받지 않는다] 대상은 언제나 auth.uid() 본인이라 남을 남의 담당에 넣을 수 없다.
 *
 * @returns {Promise<{ok:true, account_type:'school'} | {ok:false, reason:'already_linked'|'invalid_invite'}>}
 * @throws 권한(42501)·네트워크 오류는 그대로 던진다 — 호출부가 입력값을 보존한 채 사유를 띄운다.
 */
export async function linkSchoolAccount(invite) {
  const { data, error } = await supabase.rpc('link_school_account', { p_invite: invite });
  if (error) throw error;
  return data ?? { ok: false, reason: 'unknown' };
}

/**
 * 관리자 본인의 학교 초대코드 1행 (스펙 D — 표시 전용).
 *
 * [정책이 본인 축뿐이다] invite_codes_select_own_as_admin 이 kind='school' and admin_id=auth.uid() 로
 *   좁혀 두었으므로 admin_id 필터를 클라이언트에서 걸지 않는다. 다른 관리자의 코드도, 관리자 승격용
 *   코드도 이 조회로는 나오지 않는다.
 * [발급·재발급 함수를 만들지 않는다] insert/update 정책이 0개다(스펙 확정 C).
 */
export async function fetchMyInviteCode() {
  const { data, error } = await supabase.from('invite_codes').select('code').limit(1);
  if (error) throw error;
  return data?.[0]?.code ?? null;
}
