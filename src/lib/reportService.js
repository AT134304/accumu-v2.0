// Accumu v2 — 프로그램 신고 (ADR 0025 → ADR 0026 / 20260822120000)
//
// [무엇을 견제하는가] 관리자가 아무 프로그램이나 올려도 막을 방법이 없었다. 1인 시연이라 승인자를
//   둘 수 없으므로, 승인 대신 **아래로부터의 제동**을 둔다 — 서로 다른 학생 3명이 신고하면 서버가
//   자동으로 게시를 중단한다. 사람이 처리하지 않는다.
//
// [★ 신고는 두 종류다 — ADR 0026]
//   공개(open)         : 공고 텍스트만 봐도 판단할 수 있는 것. 참여하지 않은 학생도 신고할 수 있다.
//   참여자(participant): 실제로 그 자리에 있어야 아는 것. QR 입장 인증을 마친 학생만 신고할 수 있다.
//
//   그리고 **공개 신고 3종은 관리자가 게시 전에 체크하는 3문장과 정확히 같다**(PublishConfirm).
//   "네가 올리며 확인한 것이 곧 학생이 신고할 수 있는 것"이라서, 신고가 취향 차이가 아니라
//   **약속 위반**을 가리킨다. >>> 한쪽을 바꾸면 다른 쪽(AdminProgramsPage 체크리스트)도 바꿀 것.
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

/* 이유 서술 길이 — DB CHECK(program_reports_detail_shape) / report_my_program() 과 같은 값이다.
   >>> 한쪽을 바꾸면 마이그레이션도 같이 바꿀 것.

   [★ 왜 하한이 두 개인가 — ADR 0026]
     신고의 비용 = **진입장벽 + 글자 수**다. 두 신고는 진입장벽이 다르다.
       공개    : 목록만 봐도 누를 수 있다     -> 장벽이 없으니 글자 수로 비용을 만든다
       참여자  : QR 입장 인증까지 마쳐야 한다 -> 이미 큰 장벽을 통과했다
     같은 하한을 걸면 실제로 피해를 겪은 학생이 오히려 더 손해를 본다 — 겪은 사람이 귀찮아서
     포기하면 이 기능은 있으나 마나가 된다.
   [숫자] 처음 값 30자는 한국어로 짧은 한 문장이라 "아무 말"이 통과했다(케빈 지적, 2026-08-21).
     공개 150자 = 3~4문장 / 참여자 80자 = 2문장. 상한은 300 -> 500 으로 함께 넓혔다.
   >>> 공개 하한을 낮추지 말 것. 참여하지 않고 누르는 신고의 유일한 비용이다. */
export const REPORT_DETAIL_MIN = { open: 150, participant: 80 };
export const REPORT_DETAIL_MAX = 500;

/** 신고 사유 7종 — DB enum public.report_reason 과 키까지 같다(CAT/TRACK 와 같은 관례).
 *  `scope` 는 서버 report_reason_scope() 의 **표시용 사본**이다. 최종 판정은 서버가 한다.
 *  값의 출처는 CLAUDE.md 의 절대 원칙이다. "그냥 마음에 안 든다"는 사유가 없는 것이 의도다.
 *  [순서] 공개 3종을 먼저 둔다 — 누구에게나 열린 항목이 위에 있어야 잠긴 항목이 예외로 읽힌다. */
export const REPORT_REASONS = [
  {
    key: 'irrelevant',
    scope: 'open',
    label: '진로·커리어 활동이 아니에요',
    hint: '자습·문제풀이 등 학업 활동',
  },
  { key: 'paid', scope: 'open', label: '참여에 비용이 들어요', hint: '수강료·재료비 등이 필요한 활동' },
  {
    key: 'inappropriate',
    scope: 'open',
    label: '부적절한 내용이 있어요',
    hint: '고등학생 대상 활동으로 보기 어려운 내용',
  },
  { key: 'not_real', scope: 'participant', label: '실제로 열리지 않았어요', hint: '공고만 있고 진행되지 않음' },
  {
    key: 'mismatch',
    scope: 'participant',
    label: '설명과 실제 내용이 달라요',
    hint: '일정·장소·내용이 공고와 다름',
  },
  {
    key: 'unpunctual',
    scope: 'participant',
    label: '시간이 지켜지지 않았어요',
    hint: '시작이 늦거나 예정보다 일찍 끝남',
  },
  { key: 'other', scope: 'participant', label: '기타', hint: '위 항목에 해당하지 않는 문제' },
];

/** 사유 키 -> 'open' | 'participant'. 없는 키는 가장 좁은 쪽으로 본다(fail-closed). */
export const reasonScope = (key) => REPORT_REASONS.find((r) => r.key === key)?.scope ?? 'participant';

/** 그 사유에 필요한 최소 글자 수. */
export const reasonMinLength = (key) => REPORT_DETAIL_MIN[reasonScope(key)];

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

/** 실패 사유 → 화면 문구. 사유별로 다른 문장을 갖는 것이 이 맵의 목적이다.
 *  [min 을 서버가 함께 보낸다] 길이 사유는 "어느 하한에 걸렸는가"가 사유의 절반이라, 문구를 만들 때
 *  프런트 상수가 아니라 **서버가 준 값**을 쓴다(둘이 어긋나면 서버가 옳다). */
function reasonText(payload) {
  const min = payload?.min;
  switch (payload?.reason) {
    case 'already':
      return '이미 신고한 프로그램이에요.';
    case 'bad_reason':
      return '신고 사유를 다시 선택해 주세요.';
    case 'not_participant':
      return '이 사유는 활동에 참여한 학생만 신고할 수 있어요.';
    case 'detail_required':
      return `신고 이유를 ${min ?? REPORT_DETAIL_MIN.participant}자 이상 적어주세요.`;
    case 'detail_length':
      return `신고 이유는 ${min ?? REPORT_DETAIL_MIN.participant}자 이상 ${
        payload?.max ?? REPORT_DETAIL_MAX
      }자 이하로 적어주세요.`;
    case 'not_found':
      return '지금은 신고할 수 없는 프로그램이에요. 화면을 새로고침해 주세요.';
    default:
      return '신고를 접수하지 못했어요.';
  }
}

/**
 * 신고 제출.
 *
 * [student_id 를 보내지 않는다] 서버가 auth.uid() 로 정한다. 정책이 이미 위조를 막지만, 애초에
 *   보내지 않는 것이 경계다(participations 의 컬럼 grant 와 같은 태도).
 * [중복은 에러가 아니다] {ok:false, reason:'already'} 로 온다 — 화면이 조용히 "신고됨"으로 맞춘다.
 * [참여 자격도 서버가 판정한다] 화면이 참여자 전용 사유를 잠그지만 그건 UX 다 — 우회하면
 *   서버가 not_participant 로 거부한다.
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
  return { ok: false, message: reasonText(data) };
}
