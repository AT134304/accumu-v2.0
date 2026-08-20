// Accumu v2 — 관리자 프로그램 관리의 저장/토글 실패 해석 (docs/specs/admin-programs.md "에러 처리")
//
// [왜 별도 모듈인가] 폼 모달과 목록 화면이 같은 실패를 서로 다른 문구로 말하면 안 된다.
//   그리고 컴포넌트 파일에서 비컴포넌트를 export 하면 react-refresh 규칙에 걸린다.
//
// [공통 규율] 실패를 조용히 삼키지 않는다. 단 화면 전체를 죽이지도 않는다 —
//   원본 에러는 호출부가 console 에 남기고, 여기서는 "사용자에게 보일 한 줄"만 만든다.

/** CLAUDE.md 7장 = DB CHECK(programs_points_rule)와 같은 규칙. 프런트 검증과 서버 거부가 같은 문구를 쓴다. */
export const POINTS_RULE_MSG = '포인트는 150~3,000P 사이의 10원 단위여야 합니다.';
export const CAPACITY_RULE_MSG = '정원은 1~1,000명 사이이거나 비워두세요.';
export const END_DATE_RULE_MSG = '종료일은 시작일보다 빠를 수 없습니다.';
export const MIN_DAYS_RULE_MSG = '최소 참여일수는 1일 이상, 전체 기간 이하여야 합니다.';
/* [2026-08-20 / 20260820140000] 텍스트 4종·날짜의 DB CHECK.
   폼의 maxLength 와 **같은 숫자**를 말한다 — 한쪽을 바꾸면 이 문구와 마이그레이션도 함께 바꿀 것.
   정상 경로로는 오지 않는다(폼이 먼저 막는다). 여기 걸렸다면 폼을 우회한 요청이다. */
export const TEXT_RULE_MSG = {
  title: '제목은 공백만으로 둘 수 없고 80자를 넘을 수 없습니다.',
  org: '주최는 공백만으로 둘 수 없고 60자를 넘을 수 없습니다.',
  description: '설명은 공백만으로 둘 수 없고 400자를 넘을 수 없습니다.',
  time: '시간은 공백만으로 둘 수 없고 40자를 넘을 수 없습니다.',
};
export const DATE_RANGE_RULE_MSG = '날짜는 2020년~2035년 사이여야 합니다. 연도를 확인해 주세요.';
// [사진 소유자 절은 여기서 잡지 않는다 — 20260820140000] image_url 이 남의 폴더를 가리키면
//   정책 with check 에 걸려 insert 는 42501, update 는 **0행**으로 끝난다(둘 다 아래에서 이미
//   문구를 갖는다). 제약 위반이 아니라 정책 위반이라 사유 문자열이 오지 않으므로 따로 구분하지
//   않는다 — 폼으로는 절대 만들 수 없는 값이다(uploadProgramImage 가 항상 본인 폴더에 올린다).
/** DB CHECK(programs_image_url_shape, 20260814120000) = "우리 스토리지에 올린 사진만". 외부 주소는 거부된다. */
export const IMAGE_URL_RULE_MSG = '사진 주소가 올바르지 않습니다. 사진을 지우고 다시 올려 주세요.';

/**
 * @param {any} err supabase-js 에러 또는 ProgramNotAffectedError
 * @returns {{field?: 'title'|'org'|'description'|'date'|'time'|'points'|'capacity'|'end_date'|'min_attendance_days', message: string}}
 *          field 가 있으면 그 입력칸 아래 인라인으로 표시한다. 없으면 폼 상단에 한 줄로 뜬다
 *          (사진처럼 입력칸이 폼 필드가 아닌 경우가 여기 해당한다).
 */
export function describeSaveError(err) {
  const code = err?.code;
  const raw = String(err?.message ?? '');

  // DB CHECK 위반. 프런트 검증을 개발자도구로 우회하면 여기로 온다 —
  // "알 수 없는 오류"로 뭉개지 말고 어느 필드가 왜 거부됐는지 보여준다(제약 이름이 message 에 들어온다).
  if (code === '23514') {
    if (raw.includes('programs_points_rule')) return { field: 'points', message: POINTS_RULE_MSG };
    if (raw.includes('programs_capacity_range')) return { field: 'capacity', message: CAPACITY_RULE_MSG };
    // [20260820140000] 텍스트 4종 — 빈 값(공백만) / 길이 상한. 제약 이름이 message 에 들어온다.
    if (raw.includes('programs_title_shape')) return { field: 'title', message: TEXT_RULE_MSG.title };
    if (raw.includes('programs_org_shape')) return { field: 'org', message: TEXT_RULE_MSG.org };
    if (raw.includes('programs_description_shape')) {
      return { field: 'description', message: TEXT_RULE_MSG.description };
    }
    if (raw.includes('programs_time_shape')) return { field: 'time', message: TEXT_RULE_MSG.time };
    if (raw.includes('programs_end_date_range')) return { field: 'end_date', message: DATE_RANGE_RULE_MSG };
    if (raw.includes('programs_date_range')) return { field: 'date', message: DATE_RANGE_RULE_MSG };
    // 기간제 프로그램(20260809140000) / 지급 방식 3종(20260809160000) — 프런트가 이미 막지만,
    // 개발자도구 우회 시 여기서 잡힌다.
    if (raw.includes('programs_end_date_after_start')) return { field: 'end_date', message: END_DATE_RULE_MSG };
    if (raw.includes('programs_min_days_range')) return { field: 'min_attendance_days', message: MIN_DAYS_RULE_MSG };
    if (raw.includes('programs_threshold_requires_min_days') || raw.includes('programs_min_days_requires_threshold')) {
      return { field: 'min_attendance_days', message: MIN_DAYS_RULE_MSG };
    }
    // 대표 사진 URL (programs_image_url_shape, 20260814120000). 폼은 업로드 결과 URL 만 넣으므로
    // 정상 경로로는 절대 오지 않는다 — 여기 걸렸다면 (a) 개발자도구로 값을 바꿨거나
    // (b) 버킷/프로젝트가 바뀌어 uploadProgramImage 가 만든 주소가 체크와 어긋난 것이다.
    // (b)면 "다시 시도"로 안 풀리므로 사진을 빼라고 말해주는 편이 낫다.
    if (raw.includes('programs_image_url_shape')) return { message: IMAGE_URL_RULE_MSG };
    return { message: '입력값이 저장 규칙에 맞지 않습니다. 값을 다시 확인해 주세요.' };
  }

  // 아래 둘은 프런트 검증(필수 항목 / 드롭다운)에서 이미 막혔어야 한다. 여기까지 왔다면 버그 신호다.
  if (code === '23502') return { message: '필수 항목이 비어 있어 저장하지 못했어요. 모든 항목을 채워주세요.' };
  if (code === '22P02') return { message: '선택할 수 없는 값이 포함돼 있어요. 화면을 새로고침해 주세요.' };

  // [ADR 0025 / 20260821120000] 끝난 프로그램의 내용 수정 시도. 트리거가 22023 으로 던진다.
  //   목록이 이미 수정 버튼을 잠가두므로 정상 경로로는 오지 않는다 — 다른 탭에서 날짜가 지나
  //   버렸거나(자정을 넘겼거나) 폼을 우회한 경우다. 그래서 "새로고침"까지 함께 안내한다.
  if (code === '22023' && /끝난 프로그램/.test(raw)) {
    return { message: '진행이 끝난 프로그램은 내용을 수정할 수 없어요. 게시 상태만 바꿀 수 있습니다.' };
  }

  // 권한 실패는 "인증 거부"가 아니라 "권한 오류"로 분리해 말한다(정상 사용에서는 발생하지 않는다 = 버그 신호).
  if (code === '42501') return { message: '권한 오류입니다. 다시 로그인한 뒤 시도해 주세요.' };

  // update 가 0행으로 끝난 경우 (ProgramNotAffectedError — 스펙 이슈 1)
  if (code === 'ACCUMU_NO_ROWS') {
    return { message: '이 프로그램을 수정할 권한이 없거나 목록이 오래됐습니다. 새로고침해 주세요.' };
  }

  return { message: '저장하지 못했어요. 잠시 후 다시 시도해 주세요.' };
}
