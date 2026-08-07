// Accumu v2 — 프로그램 taxonomy 맵 (ADR 0003 "frontend-agent가 구현할 부분" 2번)
//
// [키 = DB enum 값] 아래 맵의 키는 supabase/migrations/20260716120000_add_programs_and_career_track.sql 의
//   program_category / career_track / program_status enum 값과 정확히 같다.
//   ADR 0003 2번: DB 값과 맵 키가 다르면 그 사이에 변환 계층이 생기고 거기가 버그 자리가 된다.
//   -> 그래서 Accumu_prototype.html 692~716줄을 "키까지 그대로" 옮겼다. 키를 바꾸지 말 것.
//
// [프런트 소유] 표시명·색상·아이콘·group·join 여부는 DB에 없다(있을 성격도 아니다). 이 파일이 유일한 소유자다.

/**
 * 활동 유형 4종. DB: program_category (마이그레이션 20260809100000 / ADR 0014).
 *
 * [group 필드가 없다 — 2026-08-09] 이전에는 8종이었고 group('교내'|'교외')이 있었다.
 *   한 enum 에 "어디서 여는가"와 "무엇을 하는가" 두 축이 눌려 있어 대회·기타가 각각 두 키로 갈렸고,
 *   정작 이 앱의 주제인 '진로 체험' 칸이 없어서 진로 박람회·전공 체험이 전부 '기타'로 갔다.
 *   >>> group 을 되살리지 말 것. 화면에서 "○○ · △△" 로 찍던 자리는 이제 name 하나다.
 *
 * [기타 칸을 만들지 말 것] 애매한 것이 갈 곳이 생기면 그리로 몰려 분류가 다시 무너진다.
 *   시드 17건이 기타 없이 전부 들어간다는 것이 4종으로 충분하다는 근거다.
 * [주최는 카테고리가 아니다] 기업/대학/국가기관/공유학교/온라인학교 구분은 programs.org 텍스트가
 *   화면에 이미 찍어 준다("삼성전자", "○○대학교", "경기도교육청 공유학교"). 축을 더 만들지 않는다.
 * [방과후가 없다] 참여에 비용이 드는 활동을 포인트로 보상하면 "돈 내고 포인트 사는" 구조가 된다(케빈 결정).
 *
 * [색 규칙] amber 계열을 쓰지 않는다 — amber 는 포인트 전용이다(절대 원칙 4).
 *   이전 8종에는 교내 대회가 amber(#E0922F)였는데, 4종으로 줄면 그 비중이 커져 "대회=포인트"로 읽힌다.
 *   초록 계열도 금지(CLAUDE.md 8장).
 */
export const CAT = {
  school: { name: '교내 활동', color: '#3B6FEF', soft: '#E2EAFE', icon: 'ic-school' },
  contest: { name: '대회·공모전', color: '#8B5CF0', soft: '#EBE2FD', icon: 'ic-trophy' },
  volunteer: { name: '봉사활동', color: '#E2556A', soft: '#FBDDE2', icon: 'ic-heart' },
  career: { name: '진로 체험', color: '#0EA5E9', soft: '#DBF0FD', icon: 'ic-compass' },
};

/**
 * 진로 계열 7종 — 활동 유형(CAT)과는 별개 축. DB: career_track (ADR 0014).
 * programs.career_track 과 profiles.career_interest 가 이 값 공간을 공유한다 (ADR 0003 3번).
 *
 * [2026-08-09 재편] 이전 5종(sci/it/hum/biz/art)의 문제:
 *   - it(IT·소프트웨어)이 sci 와 동급이었다. IT 는 공학의 부분집합이라 "AI 로봇 대회"가 애매했다 → eng 로 흡수.
 *   - 교육(사범) 지망이 갈 곳이 없었다 → soc(사회·교육) 신설.
 *   - 의약·보건이 없어 sci 로 억지로 들어갔다. 고교생 진로 희망 최상위권이다 → med 신설.
 * [선언 순서가 곧 화면 순서다] 레이더 축·요약 분포가 이 순서를 그대로 쓴다(archiveService).
 *   값 크기순으로 정렬하면 그 순간 순위표가 된다(원칙 1).
 */
export const TRACK = {
  hum: { name: '인문·어학', color: '#6D5CE0' },
  soc: { name: '사회·교육', color: '#334155' },
  biz: { name: '상경·경영', color: '#0369A1' },
  sci: { name: '자연과학', color: '#0EA5E9' },
  eng: { name: '공학·IT', color: '#2563EB' },
  med: { name: '의약·보건', color: '#E2556A' },
  art: { name: '예술·체육', color: '#D6336C' },
};

/**
 * 모집/진행 상태 5종. DB: program_status (이번 스코프에서는 정적 필드 — 확정 D).
 * `join`(신청 가능 여부) 매핑은 DB가 아니라 이 맵이 소유한다 (ADR 0003 4번).
 * 홈에서는 표시 전용: 카드 참여 버튼의 라벨/비활성에만 쓴다. 프로토타입 710~716줄.
 */
export const STATUS = {
  open: { label: '참석 가능', cls: 'b-ok', join: true },
  ing: { label: '참석 중', cls: 'b-ing', join: false },
  wait: { label: '대기', cls: 'b-wait', join: true },
  full: { label: '마감', cls: 'b-close', join: false },
  over: { label: '정원 초과', cls: 'b-over', join: false },
};

// enum과 맵이 어긋날 수 없는 구조지만(양쪽 다 닫힌 값 집합), 마이그레이션만 먼저 확장되는 등의
// 상황에서 undefined 접근으로 화면 전체가 죽는 것보다는 카드 한 장이 얌전히 뜨는 편이 낫다.
export const catOf = (key) => CAT[key] ?? { name: '분류 없음', color: '#64748B', soft: '#E9EDF3', icon: 'ic-grid' };
export const statusOf = (key) => STATUS[key] ?? { label: '확인 필요', cls: 'b-close', join: false };
