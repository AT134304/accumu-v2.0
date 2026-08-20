// Accumu v2 — 프로그램 신고 (ADR 0025 / 20260821140000)
//
// [무엇을 견제하는가] 관리자가 아무 프로그램이나 올려도 막을 방법이 없었다. 1인 시연이라 승인자를
//   둘 수 없으므로, 승인 대신 **아래로부터의 제동**을 둔다 — 서로 다른 학생 3명이 신고하면 서버가
//   자동으로 게시를 중단한다. 사람이 처리하지 않는다.
//
// [★ 이 파일이 절대 하지 않는 것]
//   1. 신고 수를 세지 않는다. RLS(program_reports_select_own)가 본인 행 1개만 내려주므로 애초에
//      셀 수도 없고, 셀 수 있게 되더라도 세지 않는다 — "임계치까지 몇 명 남았나"가 보이는 순간
//      신고가 게임이 된다(원칙 1).
//   2. 신고 결과를 알려주지 않는다. 내 신고로 프로그램이 내려갔는지 여부는 학생에게 돌려주지 않는다.
//      알려주면 그 학생이 "내가 내렸다"를 알게 되고, 그건 관리자와의 관계에서 위험한 정보다.
//   3. 관리자에게 아무것도 노출하지 않는다. 이 파일에는 관리자용 조회 함수가 없고, 만들 수도 없다
//      (그 정책 자체가 존재하지 않는다).
//   >>> 위 셋 중 하나라도 요청이 들어오면 ADR 0025 "결정 3"을 먼저 다시 읽을 것.
import { supabase } from './supabaseClient';

/** 신고 사유 — DB enum public.report_reason 과 키까지 같다(CAT/TRACK 와 같은 관례).
 *  값의 출처는 CLAUDE.md 의 절대 원칙이다. "그냥 마음에 안 든다"는 사유가 없는 것이 의도다. */
export const REPORT_REASONS = [
  { key: 'not_real', label: '실제로 열리지 않았어요', hint: '공고만 있고 진행되지 않은 활동' },
  { key: 'mismatch', label: '설명과 실제 내용이 달라요', hint: '일정·장소·내용이 공고와 다름' },
  { key: 'irrelevant', label: '진로·커리어 활동이 아니에요', hint: '자습·문제풀이 등 학업 활동' },
  { key: 'paid', label: '참여에 비용이 들어요', hint: '수강료·재료비 등이 필요한 활동' },
  { key: 'other', label: '기타', hint: '아래에 이유를 적어주세요' },
];

/** 자유 서술 길이 — DB CHECK(program_reports_detail_shape)와 같은 값이다. */
export const REPORT_DETAIL_MIN = 10;
export const REPORT_DETAIL_MAX = 300;

/**
 * 내가 이 프로그램을 이미 신고했는가.
 *
 * [실패를 삼킨다] 이 값은 버튼 문구를 정하는 용도다. 조회에 실패했다고 팝업 전체를 막을 이유가 없고,
 *   중복 신고는 어차피 서버 unique 가 'already' 로 돌려준다(경계는 DB 다).
 *
 * @returns {Promise<boolean>}
 */
export async function hasReportedProgram(programId) {
  if (!programId) return false;
  const { data, error } = await supabase
    .from('program_reports')
    .select('id')
    .eq('program_id', programId)
    .maybeSingle();
  if (error) {
    console.warn('[reportService] 신고 이력 조회 실패 — 신고하기를 그대로 보여줍니다:', error);
    return false;
  }
  return Boolean(data);
}

/** 실패 사유 → 화면 문구. 사유별로 다른 문장을 갖는 것이 이 맵의 목적이다. */
const REASON_TEXT = {
  already: '이미 신고한 프로그램이에요.',
  bad_reason: '신고 사유를 다시 선택해 주세요.',
  detail_required: '기타를 선택했다면 이유를 적어주세요.',
  detail_length: `이유는 ${REPORT_DETAIL_MIN}자 이상 ${REPORT_DETAIL_MAX}자 이하로 적어주세요.`,
  not_found: '지금은 신고할 수 없는 프로그램이에요. 화면을 새로고침해 주세요.',
};

/**
 * 신고 제출.
 *
 * [student_id 를 보내지 않는다] 서버가 auth.uid() 로 정한다. 정책이 이미 위조를 막지만, 애초에
 *   보내지 않는 것이 경계다(participations 의 컬럼 grant 와 같은 태도).
 * [중복은 에러가 아니다] {ok:false, reason:'already'} 로 온다 — 화면이 조용히 "신고됨"으로 맞춘다.
 *
 * @returns {Promise<{ok:true} | {ok:false, message:string}>}
 */
export async function reportProgram({ programId, reason, detail }) {
  const text = (detail ?? '').trim();
  const { data, error } = await supabase.rpc('report_my_program', {
    p_program_id: programId,
    p_reason: reason,
    p_detail: text ? text : null,
  });

  if (error) {
    console.error('[reportService] 신고 실패:', error);
    // 42501 = 관리자 세션이거나 로그인이 풀렸다. 정상 사용에서는 발생하지 않는다.
    if (error.code === '42501') {
      return { ok: false, message: '학생 계정으로 로그인한 뒤 신고할 수 있어요.' };
    }
    return { ok: false, message: '신고를 접수하지 못했어요. 잠시 후 다시 시도해 주세요.' };
  }

  if (data?.ok) return { ok: true };
  return { ok: false, message: REASON_TEXT[data?.reason] ?? '신고를 접수하지 못했어요.' };
}
