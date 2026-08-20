// Accumu v2 — 만족도 평가(별점 + 한줄평) 저장/조회 (ADR 0007 결정 2 / CLAUDE.md 6장 3번)
//
// [경계 요약 — 정책이 이미 표현한 것을 여기서 다시 하지 않는다]
//   1. participation_id 로만 소유자가 결정된다. student_id 컬럼이 없고 클라이언트 필터도 걸지 않는다
//      (reviews_select_own 이 "본인 참여의 리뷰"로 이미 좁힌다).
//   2. insert 에 participation_id / rating / comment 외 어떤 컬럼도 보내지 않는다. update 에는
//      participation_id 를 포함하지 않는다 — 컬럼 grant 위반은 정책 위반과 같은 42501 이라 원인 파악이 어렵다.
//   3. 삭제 경로를 만들지 않는다(정책 0개). 수정으로 갈음한다 — 스펙 결정 D-4.
//   4. 평균 별점·리뷰 수·다른 학생 리뷰를 만들지 않는다. 정책상 데이터를 얻을 수도 없다(원칙 1).
//   5. 리뷰 저장은 participations / point_transactions / profiles 를 건드리지 않는다
//      = 평가를 남겨도 포인트가 늘지 않는다.
import { supabase } from './supabaseClient';

/* 한줄평 길이 규칙 (ADR 0025 / 20260821120000) — DB CHECK(reviews_comment_shape)와 **같은 값**이다.
   >>> 한쪽을 바꾸면 마이그레이션도 함께 바꿀 것. 프런트는 우회 가능하므로 최종 판정자는 DB 다.

   [상한 60 -> 500, 하한 신설 20]
     상한 60자는 포트폴리오에 남길 글로는 너무 짧았고, 반대로 한두 글자짜리 성의 없는 평을 막을
     장치는 없었다. 케빈 요청(2026-08-20)으로 둘을 맞바꿨다.
   [하한은 "쓰기로 한 사람"에게만 적용된다] 한줄평은 여전히 **선택**이다. 비우면 null 이고 아무
     제약도 걸리지 않는다 — 평가를 강제하면 QR 흐름의 마지막이 막힌다(스펙 D-2 "건너뛰기는 필수"). */
export const REVIEW_COMMENT_MIN = 20;
export const REVIEW_COMMENT_MAX = 500;

const REVIEW_FIELDS = 'id, participation_id, rating, comment, created_at';

/**
 * 내 리뷰 전체 → participation_id 를 키로 하는 Map.
 *
 * [건별 조회 금지] 활동 목록이 N건이면 N번 왕복하게 된다. 한 번에 읽어 Map 으로 결합한다
 *   (archiveService 의 programs 결합과 같은 방식 — 뷰/embed 를 쓰지 않는 이유도 같다).
 */
export async function fetchMyReviews() {
  const { data, error } = await supabase.from('reviews').select(REVIEW_FIELDS);
  if (error) throw error;
  return new Map((data ?? []).map((r) => [r.participation_id, r]));
}

/** 실패 코드 → 화면 문구. 권한 오류와 입력 오류를 섞지 않는다. */
function failText(error) {
  switch (error?.code) {
    case '42501':
      // 정책 위반(남의 참여/미완료 참여) 또는 컬럼 grant 위반. 정상 UI 에서는 발생하지 않는다.
      return '이 활동에는 평가를 남길 수 없어요. 화면을 새로고침해 주세요.';
    case '23514':
      // 제약이 하나(reviews_comment_shape)라 어느 쪽을 넘겼는지는 사유 문자열에 없다.
      // 정상 UI 에서는 폼이 먼저 막으므로 여기는 폼을 우회한 요청이다 — 규칙 전체를 말해준다.
      return `한 줄 평은 비워두거나 ${REVIEW_COMMENT_MIN}자 이상 ${REVIEW_COMMENT_MAX}자 이하로 써주세요.`;
    default:
      return '평가를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}

/**
 * 평가 저장 — 없으면 작성, 있으면 수정. 참여 1건 = 리뷰 1행(unique)이 이 함수의 전제다.
 *
 * [중복은 에러가 아니라 분기다] unique 위반(23505)은 "이미 평가한 활동"이라는 뜻이므로 사용자에게
 *   실패로 보이면 안 된다 — 조용히 update 로 전환한다(스펙 에러 처리 표).
 * [★ .update() 는 0행이어도 error === null 이다] 반드시 .select() 로 영향 행을 확인한다.
 *   확인하지 않으면 정책에 막혀 아무것도 저장되지 않았는데 "저장됐어요" 토스트가 뜬다
 *   (admin-programs 이슈 1 에서 이미 겪은 함정).
 *
 * @returns {Promise<{ok:true, review:object} | {ok:false, message:string}>}
 */
export async function upsertMyReview({ participationId, rating, comment }) {
  if (!participationId) return { ok: false, message: '평가할 활동을 찾을 수 없어요.' };
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, message: '별점을 먼저 선택해 주세요.' };
  }

  // 빈 한줄평은 '' 이 아니라 null 로 보낸다 — 빈 문자열이 저장되면 "한 줄 평 없음" 과 "빈 문자열"
  // 두 상태가 갈라진다. (이제는 ''이 들어와도 DB CHECK 가 함께 잡는다 — 방어선이 하나 늘었다.)
  //
  // [★ slice() 로 잘라내지 않는다 — ADR 0025]
  //   예전에는 상한을 넘으면 조용히 잘라 보냈다. 상한이 60자일 때는 "어차피 폼이 막는다"였지만,
  //   하한이 생긴 지금 잘라내기는 위험한 습관이다: 자른 결과가 하한 아래로 떨어질 수 있고, 무엇보다
  //   **사용자가 쓴 글을 말없이 바꿔서 저장**하는 동작이다. 길이 판정은 폼이 하고, 최종 거부는 DB 가 한다.
  const text = (comment ?? '').trim();
  const payload = { rating, comment: text ? text : null };

  // 폼을 우회한 호출이 23514 로 떨어지기 전에 같은 문구로 먼저 막는다(사유가 분명해진다).
  if (text && (text.length < REVIEW_COMMENT_MIN || text.length > REVIEW_COMMENT_MAX)) {
    return {
      ok: false,
      message: `한 줄 평은 비워두거나 ${REVIEW_COMMENT_MIN}자 이상 ${REVIEW_COMMENT_MAX}자 이하로 써주세요.`,
    };
  }

  const ins = await supabase
    .from('reviews')
    .insert({ participation_id: participationId, ...payload }) // 컬럼 grant 3개와 정확히 일치
    .select(REVIEW_FIELDS)
    .single();

  if (!ins.error) return { ok: true, review: ins.data };

  if (ins.error.code !== '23505') {
    console.error('[reviewService] 평가 작성 실패:', ins.error);
    return { ok: false, message: failText(ins.error) };
  }

  // 여기부터는 "이미 평가한 활동" 경로다.
  const upd = await supabase
    .from('reviews')
    .update(payload) // participation_id 를 넣지 않는다 — update 컬럼 grant 에 없다(리뷰 이동 차단)
    .eq('participation_id', participationId)
    .select(REVIEW_FIELDS);

  if (upd.error) {
    console.error('[reviewService] 평가 수정 실패:', upd.error);
    return { ok: false, message: failText(upd.error) };
  }
  if (!upd.data || upd.data.length === 0) {
    return { ok: false, message: '저장 권한이 없거나 기록이 오래됐습니다. 새로고침해 주세요.' };
  }
  return { ok: true, review: upd.data[0] };
}
