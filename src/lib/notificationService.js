// Accumu v2 — 인앱 알림 서비스 (마이그레이션 20260806120000)
//
// 이 파일이 notifications 관련 Supabase 호출의 유일한 소유자다. 컴포넌트는 supabase 를 직접 만지지 않는다.
//
// [경계 요약 — 이 레이어에서 절대 하지 않는 것]
//   1. 알림을 만들지 않는다. insert 정책이 0개이고 행은 트리거만 만든다. 알림은 "서버가 관측한 사실"이다.
//      화면이 알림을 쓸 수 있으면 그 알림은 아무것도 증명하지 못한다.
//   2. is_read 를 직접 update 하지 않는다. update 정책도 0개다 — mark_notifications_read() RPC 로만 간다.
//   3. student_id 로 필터하지 않는다. RLS(notifications_select_own)가 본인 행만 내려준다.
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
 * [인자가 없다] 대상은 언제나 호출자 본인이다. student_id 를 인자로 받는 순간 남의 알림을 건드릴
 *   경로가 생긴다 — 서버 함수도 auth.uid() 만 본다.
 * @returns {Promise<number>} 읽음으로 바뀐 개수
 */
export async function markNotificationsRead() {
  const { data, error } = await supabase.rpc('mark_notifications_read');
  if (error) throw error;
  return data ?? 0;
}
