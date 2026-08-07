// Accumu v2 — 인앱 알림 서비스 (마이그레이션 20260806120000)
//
// 이 파일이 notifications 관련 Supabase 호출의 유일한 소유자다. 컴포넌트는 supabase 를 직접 만지지 않는다.
//
// [경계 요약 — 이 레이어에서 절대 하지 않는 것]
//   1. 알림을 만들지 않는다. insert 정책이 0개이고 행은 트리거만 만든다. 알림은 "서버가 관측한 사실"이다.
//      화면이 알림을 쓸 수 있으면 그 알림은 아무것도 증명하지 못한다.
//   2. is_read 를 직접 update 하지 않는다. update 정책도 0개다 — mark_notifications_read() RPC 로만 간다.
//   3. recipient_id 로 필터하지 않는다. RLS(notifications_select_own)가 본인 행만 내려준다.
//      >>> 이 규율 덕분에 관리자 알림(ADR 0013)이 붙을 때 이 파일에서 바꿀 것이 한 줄도 없었다.
//      학생 화면과 관리자 화면이 같은 함수를 부르고, 누구의 알림인지는 서버가 정한다.
import { supabase } from './supabaseClient';

/** 팝업 1회 조회량. 데모 규모에서 이보다 많이 쌓이면 그 아래는 스크롤로도 의미가 없다. */
const PAGE_SIZE = 30;

/**
 * 내 알림 최신순.
 * @returns {Promise<Array<{id, type, message, detail, program_id, is_read, created_at}>>}
 */
export async function fetchMyNotifications() {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, message, detail, program_id, is_read, created_at')
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (error) throw error;
  return data ?? [];
}

/**
 * 안 읽은 알림 개수. 종 아이콘 배지 전용이라 행 본문을 받지 않는다(head: true).
 *
 * [근거 없는 dot 을 띄우지 않는다] student-home.md 확정 C 가 테이블이 없던 시절 dot 을 금지한 이유가
 *   "가짜 표시"였다. 이제 실제 개수를 세므로 그 금지의 전제가 사라졌다.
 */
export async function fetchUnreadCount() {
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
}

/**
 * 내 알림을 모두 읽음 처리한다.
 *
 * [인자가 없다] 대상은 언제나 호출자 본인이다. recipient_id 를 인자로 받는 순간 남의 알림을 건드릴
 *   경로가 생긴다 — 서버 함수도 auth.uid() 만 본다.
 * [2026-08-08] "모두 읽음" 버튼이 사라지고 팝업을 여는 순간 호출된다(케빈 요청). 서버 규칙은 그대로다.
 * @returns {Promise<number>} 읽음으로 바뀐 개수
 */
export async function markNotificationsRead() {
  const { data, error } = await supabase.rpc('mark_notifications_read');
  if (error) throw error;
  return data ?? 0;
}

/**
 * 일정이 지났는데 아직 게시중인 내 프로그램에 대해 "내려도 괜찮아요" 알림을 만든다 (관리자 전용, ADR 0013).
 *
 * [화면에 들어올 때마다 불러도 안전하다] 서버가 멱등이다 — 프로그램당 1행을 부분 unique 인덱스가 보장한다.
 * [프런트가 "지났는지" 판정하지 않는다] 날짜 비교는 서버(KST) 몫이다. 여기서 비교하기 시작하면
 *   화면과 서버가 서로 다른 "오늘"을 갖게 된다(settleMyPoints 와 같은 규율).
 * @returns {Promise<number>} 새로 만들어진 알림 수 (0이면 새로 생긴 것이 없다는 뜻이지 실패가 아니다)
 */
export async function syncStaleProgramNotices() {
  const { data, error } = await supabase.rpc('sync_stale_program_notices');
  if (error) throw error;
  return data ?? 0;
}
