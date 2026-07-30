#!/usr/bin/env node
/**
 * scripts/seed-programs.mjs
 *
 * Accumu v2 — 데모 프로그램 시딩 스크립트
 * (ADR 0003 "시드 설계" 그대로 구현, docs/adr/0003-programs-schema-and-career-track-taxonomy.md 참고)
 *
 * 목적: 학생 홈(docs/specs/student-home.md)의 추천 프로그램 카드가 실제로 렌더되도록
 *   public.programs 에 데모 프로그램 20건을 넣는다. created_by 는 데모 관리자(ADM-0001)로 채운다.
 *
 * 전제 조건
 *   - supabase/migrations/*.sql 이 대상 Supabase 프로젝트에 이미 적용되어 있어야 함
 *     (career_track/program_category/program_status enum, public.programs 테이블 존재)
 *   - scripts/seed-accounts.mjs 가 먼저 실행되어 code='ADM-0001' 관리자 프로필이 존재해야 함
 *   - .env.seed 파일에 SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY 값이 채워져 있어야 함
 *     (.env.seed.example 참고). SUPABASE_SERVICE_ROLE_KEY는 RLS를 우회하는 매우 민감한 키이므로
 *     절대 커밋하거나 프런트엔드 코드/번들에 노출하지 않는다.
 *
 * [실행 순서] 마이그레이션 -> seed-accounts.mjs -> seed-programs.mjs(이 파일)
 *   1. cp .env.seed.example .env.seed  # 값 채우기
 *   2. Supabase 대시보드 SQL Editor 등으로 supabase/migrations/*.sql 적용
 *   3. cd scripts && npm install
 *   4. node seed-accounts.mjs
 *   5. node seed-programs.mjs
 *
 * 실행 옵션
 *   node seed-programs.mjs --dry-run   # DB에 접속하지 않고 시드 데이터 검증 + 요약만 출력
 *
 * 재실행 안전성(idempotency)
 *   seed-accounts.mjs 와 동일하게 "신규 프로젝트에 1회 실행" 전제이며, 재실행 시 즉시 중단된다.
 *   다만 중단 방식이 다르다: 계정 시딩은 이메일 unique 제약이 재실행을 자연히 막아주지만,
 *   programs 에는 unique 제약이 없어 그냥 두면 재실행이 "조용히 20건 더 쌓기"가 된다(홈에 중복 카드).
 *   그래서 insert 전에 기존 행 수를 확인하고 0이 아니면 중단한다 — 같은 fail-fast 정책을
 *   unique 제약이 없는 테이블에 옮긴 것이다. 다시 시딩하려면 아래를 먼저 실행할 것:
 *     delete from public.programs;
 */

import { createClient } from '@supabase/supabase-js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// .env.seed 로더
// 외부 dotenv 의존성 없이 최소 구현 (주석 #, 빈 줄, 앞뒤 따옴표만 처리하는 단순 파서).
// 이미 process.env에 값이 있으면(예: CI에서 export) 덮어쓰지 않는다.
//
// 주의(드리프트 방지): seed-accounts.mjs 의 동일 함수를 복제한 것이다. 시딩 스크립트를
// 자기완결적으로 유지하려는 기존 관례(seed-accounts.mjs 의 buildVirtualEmail 복제와 같은 판단)를
// 따랐다. 시딩 스크립트가 3개 이상으로 늘어나면 scripts/lib/ 로 추출할 것.
// ---------------------------------------------------------------------------
function loadEnvSeedFile() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const envPath = path.resolve(scriptDir, '..', '.env.seed');

  if (!existsSync(envPath)) {
    console.warn(
      `[경고] ${envPath} 파일을 찾을 수 없습니다. 셸에 SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY를 ` +
        '이미 export 했다면 무시해도 됩니다. 그렇지 않다면 .env.seed.example을 복사해 채워주세요.'
    );
    return;
  }

  const content = readFileSync(envPath, 'utf-8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    let value = line.slice(eqIdx + 1).trim();

    const isQuoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (isQuoted) value = value.slice(1, -1);

    if (!(key in process.env)) process.env[key] = value;
  }
}

// ---------------------------------------------------------------------------
// 날짜 유틸 — 반드시 로컬(KST) 기준
//
// [toISOString() 금지] new Date().toISOString().slice(0,10) 은 UTC 변환이라 KST 오전 9시 이전에
// 날짜가 하루 밀린다. 학생 홈의 추천 쿼리가 date >= {로컬 오늘} 로 거르므로(ADR 0003 6번 타임존 주의),
// 시드 날짜도 같은 로컬 기준으로 만들어야 "오늘 ± n일" 의도가 어긋나지 않는다.
// ---------------------------------------------------------------------------
function toLocalISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// 오늘 기준 offsetDays 만큼 이동한 날짜의 로컬 YYYY-MM-DD.
// setDate()는 월/연 경계를 자동으로 넘겨준다(예: 7/29 + 5 = 8/3).
function dateFromToday(offsetDays) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetDays);
  return toLocalISODate(d);
}

// ---------------------------------------------------------------------------
// 데모 프로그램 20건
//
// 출처: Accumu_prototype.html PROGRAMS(720~761줄). 제목/주최/설명/시간/포인트/계열/인기/상태를
//   그대로 가져왔고, 날짜만 상대값(dayOffset)으로 바꿨다.
//
// [날짜가 리터럴이 아닌 이유 — ADR 0003 "시드 설계" 4번]
//   프로토타입은 TODAY_ISO='2026-07-02' 고정 전제라 2026-03~08 리터럴이 유효했다. 그 값을 DB에 그대로
//   박으면 케빈이 몇 주 뒤 시연할 때 전부 과거가 되어 홈이 빈 상태로 뜬다(인수 조건 붕괴).
//   그래서 모든 날짜는 실행 시점의 "오늘 ± n일" 로 생성한다.
//
// [포인트] 전부 프로토타입 원본 값이며 CLAUDE.md 7장 규칙(150~3000, 끝자리 0, 150~700 구간에 두텁게,
//   2000~3000 극소수)을 만족한다 — 아래 assertSeedInvariants() 가 매 실행마다 재확인한다.
//   DB에도 동일 규칙이 CHECK(programs_points_rule)로 걸려 있다.
//
// [capacity 없음] 프로토타입에 정원 데이터가 없어 넣지 않는다(= NULL, "정원 미정"). 시연을 위해
//   없는 숫자를 지어내지 않는다. capacity 는 이번 스코프에서 status 파생에 쓰이지 않는다(확정 D).
//
// [배열 순서 = 최신순] 아래에서 created_at 을 배열 인덱스 기준으로 1분씩 어긋나게 넣는다(위쪽이 최신).
//   이유는 buildRows() 주석 참고.
//
// 인수 조건 검증용 fixture (ADR 0003 "시드 설계" 2·3번):
//   - "수학 심화 탐구반" = 유일한 과거 날짜 행. is_published 는 true 여야 한다
//     (미게시면 is_published 필터에 먼저 걸려서 "지난 날짜 제외" 를 검증하지 못한다).
//   - "교내 UCC 공모전" = 유일한 미게시 행. 날짜는 미래여야 한다
//     (과거면 날짜 필터에 먼저 걸려서 "미게시 제외" 를 검증하지 못한다).
//   - "또래 멘토링 프로그램"(het, 교내) + "지역 연계 진로 박람회"(eet, 교외) = dayOffset 0 = 오늘 (ADR 0005 결정 8-1).
//     관리자 홈의 "오늘 진행 프로그램" 이 항상 교내 1 + 교외 1 로 채워지게 하는 fixture 다.
//     [행을 추가하지 않고 기존 2건의 날짜를 옮긴 것이다] 2건을 추가하면 22건이 되어 확정 F(16~20)와
//     아래 assertSeedInvariants() 의 상한 검사에 걸린다. 관측 결과는 동일하다.
// ---------------------------------------------------------------------------
const DEMO_PROGRAMS = [
  // --- 교내: 방과후 (hbk) ---
  {
    category: 'hbk',
    title: '파이썬 코딩 기초 방과후',
    org: '정보교과부',
    dayOffset: 5,
    time: '15:30–17:00',
    points: 400,
    status: 'open',
    career_track: 'it',
    popularity: 98,
    is_published: true,
    description:
      '코딩이 처음인 학생을 위한 8주 방과후 과정. 간단한 게임을 직접 만들며 프로그래밍의 기초를 익힙니다.',
  },
  {
    category: 'hbk',
    title: 'AI·데이터 기초 방과후',
    org: '정보교과부',
    dayOffset: 12,
    time: '15:30–17:00',
    points: 450,
    status: 'open',
    career_track: 'it',
    popularity: 72,
    is_published: true,
    description: '엑셀과 파이썬으로 데이터를 다뤄보는 입문 방과후 과정.',
  },
  {
    // [fixture] 유일한 과거 날짜 행 — 인수 조건 "지난 날짜 제외" 검증용. 게시 상태는 true 유지.
    category: 'hbk',
    title: '수학 심화 탐구반',
    org: '수학교과부',
    dayOffset: -6,
    time: '16:00–17:30',
    points: 350,
    status: 'ing',
    career_track: 'sci',
    popularity: 61,
    is_published: true,
    description: '교과 과정 너머의 수학 주제를 탐구하고 발표하는 심화반입니다.',
  },

  // --- 교내: 동아리 (hdo) ---
  {
    category: 'hdo',
    title: '발명·메이커 동아리',
    org: '창의융합부',
    dayOffset: 8,
    time: '방과후',
    points: 350,
    status: 'open',
    career_track: 'it',
    popularity: 87,
    is_published: true,
    description: '아두이노와 3D 프린터로 나만의 아이디어를 직접 만들어보는 자율동아리.',
  },
  {
    category: 'hdo',
    title: '수리과학 탐구 동아리',
    org: '과학교과부',
    dayOffset: 10,
    time: '방과후',
    points: 300,
    status: 'wait',
    career_track: 'sci',
    popularity: 52,
    is_published: true,
    description: '실험과 데이터 분석을 중심으로 운영되는 과학 탐구 동아리.',
  },
  {
    category: 'hdo',
    title: '밴드부 정기공연 준비',
    org: '음악교과부',
    dayOffset: 14,
    time: '방과후',
    points: 300,
    status: 'open',
    career_track: 'art',
    popularity: 49,
    is_published: true,
    description: '악기 파트를 맡아 정기공연 무대를 함께 준비하는 동아리.',
  },

  // --- 교내: 대회 (hdc) ---
  {
    category: 'hdc',
    title: '교내 과학탐구대회',
    org: '과학교과부',
    dayOffset: 18,
    time: '09:00–12:00',
    points: 700,
    status: 'open',
    career_track: 'sci',
    popularity: 120,
    is_published: true,
    description: '자유 주제 과학 탐구 보고서를 작성해 발표하는 교내 대회. 수상 시 생기부 기재.',
  },
  {
    category: 'hdc',
    title: '교내 토론대회',
    org: '사회교과부',
    dayOffset: 6,
    time: '13:00–16:00',
    points: 600,
    status: 'open',
    career_track: 'hum',
    popularity: 74,
    is_published: true,
    description: '시사 주제로 진행되는 2인 1팀 토론 대회.',
  },
  {
    // [fixture] 유일한 미게시 행 — 인수 조건 "미게시 제외" 검증용. 날짜는 미래 유지.
    category: 'hdc',
    title: '교내 UCC 공모전',
    org: '방송부',
    dayOffset: 9,
    time: '마감 18:00',
    points: 500,
    status: 'over',
    career_track: 'art',
    popularity: 90,
    is_published: false,
    description: '우리 학교를 소개하는 1분 영상 공모전.',
  },

  // --- 교내: 기타 (het) ---
  {
    // [fixture] 오늘 진행 프로그램 (교내) — ADR 0005 결정 8-1. 관리자 홈 "오늘 진행 프로그램" 이 항상
    //   비지 않게 하려고 dayOffset 2 -> 0 으로 옮겼다(행을 추가하지 않는다 — 총 20건 = 확정 F 유지).
    //   교외 짝은 아래 "지역 연계 진로 박람회"(eet). 아래 assertSeedInvariants() 가 이 쌍을 매 실행마다 검증한다.
    category: 'het',
    title: '또래 멘토링 프로그램',
    org: '상담부',
    dayOffset: 0,
    time: '협의',
    points: 200,
    status: 'open',
    career_track: 'hum',
    popularity: 29,
    is_published: true,
    description: '후배에게 공부 방법을 알려주며 함께 성장하는 또래 멘토링.',
  },
  {
    category: 'het',
    title: '학생자치회 정책 제안',
    org: '학생자치회',
    dayOffset: 7,
    time: '점심시간',
    points: 250,
    status: 'open',
    career_track: 'biz',
    popularity: 46,
    is_published: true,
    description: '학교에 바라는 점을 정책으로 제안하고 직접 추진해봅니다.',
  },

  // --- 교외: 기업·국가기관 (ecp) ---
  {
    category: 'ecp',
    title: '삼성 주니어 SW 아카데미',
    org: '삼성전자',
    dayOffset: 15,
    time: '10:00–17:00',
    points: 1200,
    status: 'open',
    career_track: 'it',
    popularity: 210,
    is_published: true,
    description: '현직 개발자와 함께하는 1일 소프트웨어 집중 캠프. 수료증 발급.',
  },
  {
    category: 'ecp',
    title: '카카오 진로 멘토링 데이',
    org: '카카오',
    dayOffset: 11,
    time: '13:00–16:00',
    points: 900,
    status: 'wait',
    career_track: 'it',
    popularity: 165,
    is_published: true,
    description: 'IT 기업 현직자에게 직무와 진로를 직접 묻는 멘토링 행사.',
  },
  {
    category: 'ecp',
    title: '교육부 진로체험 캠프',
    org: '교육부',
    dayOffset: 21,
    time: '09:30–16:00',
    points: 1500,
    status: 'full',
    career_track: 'hum',
    popularity: 96,
    is_published: true,
    description: '다양한 직업을 체험하는 1박 진로 캠프.',
  },

  // --- 교외: 봉사활동 (evo) ---
  {
    category: 'evo',
    title: '지역 아동센터 학습 봉사',
    org: 'OO시 자원봉사센터',
    dayOffset: 13,
    time: '10:00–12:00',
    points: 400,
    status: 'open',
    career_track: 'hum',
    popularity: 110,
    is_published: true,
    description: '지역 아동센터 아이들의 학습을 돕는 정기 봉사. 봉사시간 인정.',
  },
  {
    category: 'evo',
    title: '하천 환경 정화 봉사',
    org: 'OO시청',
    dayOffset: 16,
    time: '09:00–11:00',
    points: 300,
    status: 'open',
    career_track: 'sci',
    popularity: 58,
    is_published: true,
    description: '우리 지역 하천을 함께 정화하는 환경 봉사 활동.',
  },

  // --- 교외: 대회 (edc) ---
  {
    category: 'edc',
    title: '경기도 메이커 챌린지',
    org: '경기도교육청',
    dayOffset: 19,
    time: '09:00–18:00',
    points: 2000,
    status: 'open',
    career_track: 'it',
    popularity: 128,
    is_published: true,
    description: '주어진 미션을 직접 제작물로 해결하는 메이커 경진대회.',
  },
  {
    category: 'edc',
    title: '전국 청소년 창업 경진대회',
    org: '중소벤처기업부',
    dayOffset: 25,
    time: '온라인 접수',
    points: 3000,
    status: 'open',
    career_track: 'biz',
    popularity: 230,
    is_published: true,
    description: '아이디어를 사업 모델로 발전시켜 겨루는 전국 단위 창업 대회.',
  },

  // --- 교외: 기타 (eet) ---
  {
    category: 'eet',
    title: '대학 전공 체험의 날',
    org: 'OO대학교',
    dayOffset: 17,
    time: '10:00–15:00',
    points: 600,
    status: 'open',
    career_track: 'hum',
    popularity: 83,
    is_published: true,
    description: '관심 전공의 수업을 미리 체험해보는 진로 탐색 프로그램.',
  },
  {
    // [fixture] 오늘 진행 프로그램 (교외) — ADR 0005 결정 8-1. dayOffset 4 -> 0 (교내 짝: "또래 멘토링 프로그램").
    category: 'eet',
    title: '지역 연계 진로 박람회',
    org: 'OO교육지원청',
    dayOffset: 0,
    time: '10:00–16:00',
    points: 400,
    status: 'open',
    career_track: 'hum',
    popularity: 55,
    is_published: true,
    description: '100여 개 직업 부스를 둘러보는 대규모 진로 박람회.',
  },
];

// 값 집합 — 마이그레이션의 enum 3종과 동일해야 한다. 아래 검증에서 오타를 잡는 용도.
const CATEGORIES = ['hbk', 'hdo', 'hdc', 'het', 'ecp', 'evo', 'edc', 'eet'];
const TRACKS = ['sci', 'it', 'hum', 'biz', 'art'];
const STATUSES = ['open', 'ing', 'wait', 'full', 'over'];

// 주 데모 계정(10718 신지훈)의 관심 계열. seed-accounts.mjs 의 DEMO_ACCOUNTS 와 맞춰야 한다.
const PRIMARY_DEMO_TRACK = 'it';

/**
 * insert 할 행 생성.
 *
 * [created_at 을 명시적으로 넣는 이유]
 * default now() 에 맡기면 now() 가 "트랜잭션 시작 시각" 이라 한 번에 insert 한 20행이 전부 같은
 * created_at 을 갖는다. 그러면 홈 추천의 order by created_at desc 가 동률 정렬이 되어 순서가
 * 비결정적이 된다(확정 E의 "최신순" 축이 무의미해짐). 배열 위쪽이 최신이 되도록 1분씩 어긋나게 넣어
 * 정렬을 결정적으로 만든다. created_at 은 ADR 0003 5번 컬럼 표에 이미 있는 컬럼이며, 여기서 정하는
 * 것은 스키마가 아니라 시드 값이다.
 */
function buildRows(adminId) {
  const now = Date.now();
  return DEMO_PROGRAMS.map((p, index) => ({
    category: p.category,
    title: p.title,
    description: p.description,
    org: p.org,
    date: dateFromToday(p.dayOffset),
    time: p.time,
    // capacity: 프로토타입에 데이터가 없어 넣지 않는다 (NULL = 정원 미정).
    points: p.points,
    career_track: p.career_track,
    popularity: p.popularity,
    status: p.status,
    is_published: p.is_published,
    created_by: adminId,
    created_at: new Date(now - index * 60_000).toISOString(),
  }));
}

/**
 * 시드 데이터 자체 검증 (ADR 0003 "시드 설계" 1~5번 + 확정 F + CLAUDE.md 7장).
 * DB에 넣기 전에 여기서 먼저 깨지게 해서, 잘못된 시드가 조용히 들어가 홈이 이상해지는 걸 막는다.
 * 실패 시 이유를 모두 모아 출력하고 즉시 중단한다.
 */
function assertSeedInvariants() {
  const today = dateFromToday(0);
  const rows = DEMO_PROGRAMS.map((p) => ({ ...p, date: dateFromToday(p.dayOffset) }));

  const publishedFuture = rows.filter((p) => p.is_published && p.date >= today);
  const unpublished = rows.filter((p) => !p.is_published);
  const past = rows.filter((p) => p.date < today);
  const primaryMatches = publishedFuture.filter((p) => p.career_track === PRIMARY_DEMO_TRACK);
  const usedCategories = new Set(rows.map((p) => p.category));

  // ADR 0005 결정 8-2: 관리자 홈 "오늘 진행 프로그램" fixture.
  // 교내/교외 판정은 카테고리 첫 글자로 한다(h=교내, e=교외 — DB에 그룹 컬럼을 두지 않기로 한 ADR 0003 그대로).
  const todayPrograms = rows.filter((p) => p.is_published && p.date === today);
  const todayOnCampus = todayPrograms.filter((p) => p.category[0] === 'h');
  const todayOffCampus = todayPrograms.filter((p) => p.category[0] === 'e');

  const problems = [];

  // 확정 F: 16~20개
  if (rows.length < 16 || rows.length > 20) {
    problems.push(`프로그램 수가 ${rows.length}건 — 확정 F(16~20개) 위반`);
  }

  // 확정 F: 카테고리 8종 전부 등장
  const missingCategories = CATEGORIES.filter((c) => !usedCategories.has(c));
  if (missingCategories.length > 0) {
    problems.push(`등장하지 않는 카테고리: ${missingCategories.join(', ')} — 확정 F(8종 유지) 위반`);
  }

  // 시드 설계 1번: 게시 + 미래 행이 8개 이상 (홈이 카드 8장을 채워야 함)
  if (publishedFuture.length < 8) {
    problems.push(`게시+미래 프로그램이 ${publishedFuture.length}건 — 홈 카드 8장을 채우려면 8건 이상 필요`);
  }

  // 시드 설계 2번: 미게시 행 1개 이상 (+ 날짜 필터에 먼저 걸리지 않도록 미래여야 검증 fixture 로 유효)
  if (unpublished.length < 1) {
    problems.push('미게시(is_published=false) 행이 없음 — 인수 조건 "미게시 제외" 를 검증할 수 없음');
  }
  const unpublishedFuture = unpublished.filter((p) => p.date >= today);
  if (unpublished.length >= 1 && unpublishedFuture.length < 1) {
    problems.push(
      '미게시 행이 전부 과거 날짜 — 날짜 필터에 먼저 걸려서 "미게시 제외" 를 단독 검증할 수 없음'
    );
  }

  // 시드 설계 3번: 지난 날짜 행 1개 이상 (+ is_published 필터에 먼저 걸리지 않도록 게시 상태여야 함)
  if (past.length < 1) {
    problems.push('지난 날짜(date < 오늘) 행이 없음 — 인수 조건 "지난 날짜 제외" 를 검증할 수 없음');
  }
  const pastPublished = past.filter((p) => p.is_published);
  if (past.length >= 1 && pastPublished.length < 1) {
    problems.push(
      '지난 날짜 행이 전부 미게시 — is_published 필터에 먼저 걸려서 "지난 날짜 제외" 를 단독 검증할 수 없음'
    );
  }

  // 시드 설계 5번: 주 데모 계정 계열과 일치하는 미래·게시 프로그램 3개 이상
  if (primaryMatches.length < 3) {
    problems.push(
      `주 데모 계정 계열(${PRIMARY_DEMO_TRACK}) 일치 + 게시 + 미래 프로그램이 ${primaryMatches.length}건 — ` +
        '"내 관심 계열" 배지 시연에 3건 이상 필요'
    );
  }

  // ADR 0005 결정 8-2: 오늘(dayOffset=0) 프로그램이 교내 1건 이상 + 교외 1건 이상.
  // 없으면 관리자 홈이 항상 빈 상태가 되는데, 그건 화면 버그가 아니라 시드가 조용히 깨진 것이다.
  if (todayOnCampus.length < 1) {
    problems.push(
      '오늘 날짜(dayOffset=0) 교내(category h*) 게시 프로그램이 없음 — 관리자 홈 "오늘 진행 프로그램" 이 비게 됨 (ADR 0005 결정 8-2)'
    );
  }
  if (todayOffCampus.length < 1) {
    problems.push(
      '오늘 날짜(dayOffset=0) 교외(category e*) 게시 프로그램이 없음 — 관리자 홈 "오늘 진행 프로그램" 이 비게 됨 (ADR 0005 결정 8-2)'
    );
  }

  for (const p of rows) {
    // CLAUDE.md 7장 포인트 규칙 (DB CHECK programs_points_rule 과 동일 조건)
    if (p.points < 150 || p.points > 3000 || p.points % 10 !== 0) {
      problems.push(`"${p.title}" 포인트 ${p.points} — CLAUDE.md 7장 규칙(150~3000, 끝자리 0) 위반`);
    }
    // enum 오타 방어 (DB가 거부하기 전에 여기서 먼저 잡는다)
    if (!CATEGORIES.includes(p.category)) problems.push(`"${p.title}" category 값 오류: ${p.category}`);
    if (!TRACKS.includes(p.career_track)) problems.push(`"${p.title}" career_track 값 오류: ${p.career_track}`);
    if (!STATUSES.includes(p.status)) problems.push(`"${p.title}" status 값 오류: ${p.status}`);
  }

  if (problems.length > 0) {
    console.error('[중단] 시드 데이터가 ADR 0003 "시드 설계" 요구사항을 만족하지 않습니다:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }

  // CLAUDE.md 7장 분포 규칙은 "두텁게/극소수" 라 자동 판정 대신 요약만 출력한다.
  const lowBand = rows.filter((p) => p.points <= 700).length;
  const highBand = rows.filter((p) => p.points >= 2000).length;

  console.log(`[검증] 총 ${rows.length}건 / 오늘 = ${today}`);
  console.log(`[검증] 게시+미래 ${publishedFuture.length}건, 미게시 ${unpublished.length}건, 지난 날짜 ${past.length}건`);
  console.log(`[검증] 카테고리 ${usedCategories.size}/8종 등장`);
  console.log(`[검증] 주 데모 계정(10718) 계열 '${PRIMARY_DEMO_TRACK}' 일치 + 게시 + 미래: ${primaryMatches.length}건`);
  console.log(`[검증] 포인트 분포: 150~700P ${lowBand}건 / 2000~3000P ${highBand}건 (CLAUDE.md 7장)`);
  console.log(
    `[검증] 오늘 진행 프로그램 ${todayPrograms.length}건 (교내 ${todayOnCampus.length} / 교외 ${todayOffCampus.length}) — ` +
      `관리자 홈 fixture (ADR 0005): ${todayPrograms.map((p) => p.title).join(', ')}`
  );

  return { today, publishedFuture, unpublished, past, primaryMatches, todayPrograms };
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');

  // 시드 데이터 검증은 DB 없이도 돌아간다 — 그래서 env 체크보다 먼저 한다.
  assertSeedInvariants();

  if (isDryRun) {
    console.log('\n[dry-run] DB에 아무것도 쓰지 않고 종료합니다. 실제 시딩은 --dry-run 없이 실행하세요.');
    return;
  }

  loadEnvSeedFile();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(
      '[오류] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다. ' +
        '.env.seed.example을 복사해 .env.seed를 만들고 값을 채워주세요.'
    );
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // ---- 재실행 가드 (위 "재실행 안전성" 주석 참고) ----
  const { count: existingCount, error: countError } = await supabase
    .from('programs')
    .select('id', { count: 'exact', head: true });

  if (countError) {
    console.error(`[중단] programs 테이블 조회 실패: ${countError.message}`);
    console.error(
      '  supabase/migrations/*.sql 이 대상 프로젝트에 모두 적용되었는지 확인해주세요 ' +
        '(20260716120000_add_programs_and_career_track.sql 포함).'
    );
    process.exit(1);
  }

  if (existingCount > 0) {
    console.error(`[중단] programs 에 이미 ${existingCount}건이 있습니다. 이 스크립트는 1회 실행 전제입니다.`);
    console.error('  그대로 다시 넣으면 홈에 중복 카드가 생깁니다. 다시 시딩하려면 먼저 실행하세요:');
    console.error('    delete from public.programs;');
    process.exit(1);
  }

  // ---- created_by 용 데모 관리자 조회 (ADR 0003 "시드 설계" 6번) ----
  const { data: admin, error: adminError } = await supabase
    .from('profiles')
    .select('id, name')
    .eq('code', 'ADM-0001')
    .maybeSingle();

  if (adminError) {
    console.error(`[중단] 관리자 프로필 조회 실패: ${adminError.message}`);
    process.exit(1);
  }

  if (!admin) {
    console.error('[중단] code=ADM-0001 관리자 프로필이 없습니다. seed-accounts.mjs 를 먼저 실행해주세요.');
    console.error('  실행 순서: 마이그레이션 -> node seed-accounts.mjs -> node seed-programs.mjs');
    process.exit(1);
  }

  console.log(`[조회] created_by = ${admin.name} (ADM-0001)`);

  const rows = buildRows(admin.id);

  console.log(`[생성] programs ${rows.length}건 insert`);

  const { error: insertError } = await supabase.from('programs').insert(rows);

  if (insertError) {
    console.error(`[중단] programs insert 실패: ${insertError.message}`);
    process.exit(1);
  }

  console.log(`완료: 데모 프로그램 ${rows.length}건 생성됨 (created_by = ADM-0001).`);
  console.log('확인: 학번 10718 / 비밀번호 accumu2026 으로 로그인하면 홈 추천에 "내 관심 계열"(it) 배지 카드가 보입니다.');
}

main().catch((err) => {
  console.error('[예외 발생]', err);
  process.exit(1);
});
