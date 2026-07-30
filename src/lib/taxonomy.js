// Accumu v2 — 프로그램 taxonomy 맵 (ADR 0003 "frontend-agent가 구현할 부분" 2번)
//
// [키 = DB enum 값] 아래 맵의 키는 supabase/migrations/20260716120000_add_programs_and_career_track.sql 의
//   program_category / career_track / program_status enum 값과 정확히 같다.
//   ADR 0003 2번: DB 값과 맵 키가 다르면 그 사이에 변환 계층이 생기고 거기가 버그 자리가 된다.
//   -> 그래서 Accumu_prototype.html 692~716줄을 "키까지 그대로" 옮겼다. 키를 바꾸지 말 것.
//
// [프런트 소유] 표시명·색상·아이콘·group·join 여부는 DB에 없다(있을 성격도 아니다). 이 파일이 유일한 소유자다.

/** 활동 유형 8종 (교내 4 + 교외 4). DB: program_category. 프로토타입 692~701줄. */
export const CAT = {
  hbk: { group: '교내', name: '방과후', color: '#3B6FEF', soft: '#E2EAFE', icon: 'ic-book' },
  hdo: { group: '교내', name: '동아리', color: '#0EA5E9', soft: '#DBF0FD', icon: 'ic-users' },
  hdc: { group: '교내', name: '대회', color: '#E0922F', soft: '#FAE7CE', icon: 'ic-trophy' },
  het: { group: '교내', name: '기타', color: '#64748B', soft: '#E9EDF3', icon: 'ic-grid' },
  ecp: { group: '교외', name: '기업·국가기관', color: '#8B5CF0', soft: '#EBE2FD', icon: 'ic-building' },
  evo: { group: '교외', name: '봉사활동', color: '#0E7490', soft: '#D6EAF0', icon: 'ic-heart' },
  edc: { group: '교외', name: '대회', color: '#E2556A', soft: '#FBDDE2', icon: 'ic-rocket' },
  eet: { group: '교외', name: '기타', color: '#0FA9C4', soft: '#D4F0F5', icon: 'ic-globe' },
};

/**
 * 진로 계열 5종 — 활동 유형(CAT)과는 별개 축. DB: career_track.
 * programs.career_track 과 profiles.career_interest 가 이 값 공간을 공유한다 (ADR 0003 3번).
 * 프로토타입 703~709줄.
 */
export const TRACK = {
  sci: { name: '이공계·자연과학', color: '#0284C7' },
  it: { name: 'IT·소프트웨어', color: '#2563EB' },
  hum: { name: '인문·사회', color: '#6D5CE0' },
  biz: { name: '경영·경제', color: '#475569' },
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
export const catOf = (key) => CAT[key] ?? { group: '', name: '기타', color: '#64748B', soft: '#E9EDF3', icon: 'ic-grid' };
export const statusOf = (key) => STATUS[key] ?? { label: '확인 필요', cls: 'b-close', join: false };
