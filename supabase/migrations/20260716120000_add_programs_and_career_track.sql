-- Accumu v2 — 마이그레이션: programs 테이블 + 계열(career_track) taxonomy
-- 출처: docs/db/schema.sql (단일 스키마 소스), docs/adr/0003-programs-schema-and-career-track-taxonomy.md
-- 기능: 학생 메인 화면(홈)의 추천 프로그램 — docs/specs/student-home.md
--
-- 범위: 학생 홈의 추천 프로그램에 필요한 것만 포함한다.
--   0) enum 3종: career_track, program_category, program_status
--   1) profiles.career_interest 타입 변경 (text -> career_track) — ADR 0002 profiles 스키마의 유일한 수정 지점
--   2) programs 테이블 + RLS 정책 1개 (programs_select_published)
-- CLAUDE.md 5장의 나머지 테이블(participations, point_transactions, reviews, notifications)은
-- 해당 기능이 architect-agent를 거칠 때 별도 마이그레이션으로 추가한다.
-- 임의로 없는 필드/정책/인덱스를 추가하지 않는다 — docs/db/schema.sql, ADR 0003 그대로 반영.
--
-- [실행 순서] 이 마이그레이션 -> scripts/seed-accounts.mjs -> scripts/seed-programs.mjs
--   - seed-accounts.mjs 가 넣는 profiles.career_interest 값이 아래 career_track enum에 의존한다.
--   - seed-programs.mjs 가 채우는 programs.created_by 가 seed-accounts.mjs 가 만든 관리자
--     (code='ADM-0001') profiles 행을 참조하므로 반드시 계정 시딩이 먼저다.

-- =========================================================
-- 0. 확장 / 타입
-- =========================================================
create extension if not exists pgcrypto; -- gen_random_uuid() 용. Supabase 프로젝트는 보통 기본 활성화되어 있음.

-- 진로 계열 (ADR 0003). 활동 유형(program_category)과는 별개 축.
-- programs.career_track 과 profiles.career_interest 가 "이 하나의 타입을 공유"한다
--   = 추천 매칭(계열 일치)의 두 축이 같은 값 공간임을 DB가 구조적으로 보장한다.
--     text + CHECK 였다면 두 목록이 따로 존재해 한쪽만 바뀌는 드리프트가 가능했다.
-- 값 집합 출처: Accumu_prototype.html TRACK 5종 (docs/specs/student-home.md 확정 F).
do $$ begin
  create type career_track as enum ('sci', 'it', 'hum', 'biz', 'art');
exception
  when duplicate_object then null;
end $$;

comment on type career_track is
  '진로 계열 5종. sci=이공계·자연과학, it=IT·소프트웨어, hum=인문·사회, biz=경영·경제, art=예술·체육. '
  '표시명/색상은 DB가 아니라 프런트엔드 TRACK 맵이 소유한다 (Accumu_prototype.html 703~709줄 재사용).';

-- 활동 유형 8종 (교내 4 + 교외 4). ADR 0003.
-- 값 집합 출처: Accumu_prototype.html CAT (docs/specs/student-home.md 확정 F). 프로토타입 키를 그대로 사용한다
--   = 프런트엔드가 CAT 맵(692~701줄)을 키까지 그대로 재사용할 수 있어 DB값<->맵키 변환 계층이 생기지 않는다.
do $$ begin
  create type program_category as enum ('hbk', 'hdo', 'hdc', 'het', 'ecp', 'evo', 'edc', 'eet');
exception
  when duplicate_object then null;
end $$;

comment on type program_category is
  '활동 유형 8종. 교내: hbk=방과후, hdo=동아리, hdc=대회, het=기타 / 교외: ecp=기업·국가기관, evo=봉사활동, edc=대회, eet=기타. '
  '그룹(교내/교외)·표시명·색상·아이콘은 DB가 아니라 프런트엔드 CAT 맵이 소유한다 (교내/교외를 별도 컬럼으로 쪼개지 않는 이유: ADR 0003).';

-- 프로그램 모집/진행 상태 5종. ADR 0003.
-- 이번 스코프에서는 참여수/정원 파생이 아니라 "정적 필드"다 (확정 D — participations 테이블이 아직 없음).
do $$ begin
  create type program_status as enum ('open', 'ing', 'wait', 'full', 'over');
exception
  when duplicate_object then null;
end $$;

comment on type program_status is
  'open=참석 가능(신청 가능), ing=참석 중(진행 중), wait=대기(정원이 찼지만 대기 신청 가능), full=마감(모집 기한 종료), over=정원 초과. '
  '신청 가능 여부(join) 매핑과 표시 라벨은 프런트엔드 STATUS 맵이 소유한다 (Accumu_prototype.html 710~716줄). '
  'participations 도입 시 파생값으로 전환 검토 — ADR 0003 "향후 변경" 참고.';

-- =========================================================
-- 1. profiles.career_interest — text -> career_track (ADR 0003)
--
--    [create table이 아니라 alter인 이유] public.profiles 는 20260709120000 마이그레이션으로 이미
--    생성되어 있다. create table if not exists 는 기존 테이블에 아무 변경도 가하지 않으므로
--    (= 조용히 no-op), 컬럼 타입 변경은 반드시 alter 로 반영해야 한다.
--
--    [캐스팅 안전성] seed-accounts.mjs 는 이 컬럼에 값을 넣지 않았고 profiles 에 update 정책이 0개라,
--    현재 모든 행의 career_interest 는 NULL 이다(= 캐스팅 실패 불가). 만약 이 문장에서 캐스팅 에러가
--    나면 예상 밖의 값이 들어있다는 뜻이므로, 강제로 밀어붙이지 말고 중단 후 케빈에게 보고할 것.
--
--    [재실행] 이 alter 문 한정으로는, 이미 career_track 타입인 상태에서 다시 실행해도 동일 타입으로의
--    캐스팅이라 실패하지 않는다. 단 이 마이그레이션 "전체"가 재실행 안전한 것은 아니다 — 아래
--    create policy 는 drop policy if exists 가드가 없어 두 번째 적용 시 "policy already exists" 로
--    실패한다(기존 20260709120000 과 동일한 관례. 1회 적용 전제).
--
--    ADR 0002 의 나머지 profiles 결정(id/role/code/name, 가상 이메일 규칙, 로그인 검증 흐름,
--    RLS profiles_select_own)은 전부 그대로 유효하다. supersede 가 아니라 이 컬럼 1건의 부분 수정이다.
-- =========================================================
alter table public.profiles
  alter column career_interest type career_track using career_interest::career_track;

comment on column public.profiles.career_interest is
  '학생의 관심 진로 계열. programs.career_track 과 같은 career_track 타입을 공유해 홈 추천 매칭의 값 공간이 일치함을 보장한다 (ADR 0003). '
  'NULL 허용은 의도된 도메인 상태: (1) 학생이 아직 계열을 고르지 않음 -> 홈 추천은 최신순 fallback (스펙 확정 E), '
  '(2) role=admin 은 계열 개념 자체가 없음. "admin 이면 NULL" 을 CHECK 로 강제하지 않는 이유는 mentor_students 의 role 정합성을 '
  '트리거로 강제하지 않은 판단과 동일하다 (데모 규모, 시딩 스크립트 책임 — ADR 0002).';

-- [RLS 권한 경계] profiles 정책은 이번 마이그레이션에서 변경하지 않는다.
--   대상 역할: student, admin 모두 — 기존 profiles_select_own 그대로 (본인 행만 select).
--   불가능: 여전히 insert/update/delete 정책 0개 = 전체 거부.
--   즉 career_interest 의 타입이 바뀌어도 노출 경계는 그대로다. 학생은 본인 행만 읽고, 계열 매칭은
--   본인 career_interest 로 클라이언트에서 수행되므로 다른 학생의 계열을 볼 경로가 없다.
--   [주의] update 정책이 0개라는 것은 곧 "앱에서 career_interest 를 저장할 방법이 없다"는 뜻이다.
--   계열 선택 UI는 마이페이지 스펙(이번 스코프 아님)이므로, 홈의 계열 매칭 시연에 필요한 값은
--   이번엔 시딩(scripts/seed-accounts.mjs)이 유일한 입력 경로다.

-- =========================================================
-- 2. programs
--    진로·커리어 활동 프로그램 (CLAUDE.md 5장 + 스펙 확정 D의 추가 필드).
--    ADR 0003 / docs/specs/student-home.md
-- =========================================================
create table if not exists public.programs (
  id            uuid primary key default gen_random_uuid(),
  category      program_category not null,
  title         text not null,
  description   text not null,                      -- 참여 팝업에서 필수 표시(다음 스펙). 프로토타입 전 프로그램에 설명이 있다.
  org           text not null,                      -- 주최/기관명. 확정 D. 모든 카드에 표시되므로 필수.
  date          date not null,                      -- 표시 포맷("7월 16일 (목)")은 프런트엔드가 생성한다.
  time          text not null,                      -- [주의] time 타입이 아니라 자유 텍스트다. 아래 comment 참고.
  capacity      integer,
  points        integer not null,
  career_track  career_track not null,              -- 확정 D/E. 계열 없는 프로그램은 매칭 축에서 누락되므로 필수.
  popularity    integer not null default 0,         -- 확정 D. 정적 값. [주의] 프로그램 인기 지표이지 학생 순위가 아니다.
  status        program_status not null default 'open', -- 확정 D. 정적 값(참여수/정원 파생 아님).
  is_published  boolean not null default true,      -- 게시/게시중단. 관리자 기능 "올리기/내리기"가 이 값을 토글한다.
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now(), -- 추천 "최신순" 정렬의 시간 축 (확정 E). uuid PK는 생성 순서를 담지 못한다.

  constraint programs_capacity_positive check (capacity is null or capacity > 0),
  -- CLAUDE.md 7장 포인트 규칙(최소 150P, 최대 3000P, 끝자리 0)을 DB 레벨에서 강제한다.
  constraint programs_points_rule      check (points between 150 and 3000 and points % 10 = 0),
  constraint programs_popularity_range check (popularity >= 0)
);

comment on table public.programs is
  '진로·커리어 활동 프로그램. CLAUDE.md 5장 기본 필드 + 스펙 확정 D의 추가 필드(org, career_track, popularity, status). '
  '학업(자습·문제풀이) 활동은 담지 않는다 (CLAUDE.md 2장 2번).';
comment on column public.programs.time is
  '표시용 자유 텍스트다. Postgres time 타입이 아닌 이유: 프로토타입 실제 값이 "15:30–17:00" 뿐 아니라 '
  '"방과후", "점심·방과후", "온라인 접수", "무박 2일", "협의", "마감 18:00" 처럼 시각으로 표현 불가능한 값을 포함한다. '
  '프런트엔드는 이 값을 파싱하지 말고 그대로 출력할 것.';
comment on column public.programs.capacity is 'NULL 허용 = 정원 미정/무제한. 이번 스코프에서 status 파생에 사용하지 않는다 (확정 D).';
comment on column public.programs.popularity is
  '[절대 원칙 가드] 프로그램의 인기 지표이지 학생 간 순위가 아니다. 학생 단위 집계/랭킹으로 파생시키는 설계 금지 (CLAUDE.md 2장 1번). '
  '학생 홈은 이 값을 표시하지도 정렬에 쓰지도 않는다(정렬은 계열 일치 우선 + created_at desc). '
  '사용처는 이후 "프로그램 선택" 화면의 인기순 정렬이다.';
comment on column public.programs.created_by is
  '프로그램을 등록한 관리자. on delete set null — 관리자 계정이 사라져도 프로그램 기록은 남긴다. '
  '시딩 시 데모 관리자(code=''ADM-0001'')의 id를 채운다 (scripts/seed-programs.mjs).';

-- [인덱스를 만들지 않는 이유 — 의도적 결정, ADR 0003 5번 "주의 4"]
--   데모 데이터가 16~20행이라 PK 외 인덱스는 순수 노이즈다(플래너가 어차피 seq scan을 고른다).
--   is_published / date / career_track 에 인덱스를 추가하지 말 것.

alter table public.programs enable row level security;

-- [RLS 권한 경계] programs_select_published
--   대상 역할: authenticated (student, admin 공통 — role 구분 없이 동일 정책 적용)
--   허용 행: is_published = true 인 행만 select
--   불가능: 미게시(is_published = false) 행 조회 — 학생/관리자 모두 차단.
--           anon(로그인하지 않은 키 보유자)의 모든 조회 — to authenticated 로 차단.
--           모든 insert/update/delete (아래 참고)
--   용도: 학생 홈의 추천 프로그램 조회 (docs/specs/student-home.md)
--
--   [to authenticated 를 명시하는 이유] using (is_published = true) 만 쓰고 to 절을 생략하면 기본 대상이
--   public 역할이라, 로그인하지 않은 anon 키 보유자도 전체 프로그램 목록을 읽을 수 있다. 개인정보는 아니지만
--   앱의 모든 프로그램 화면이 로그인 뒤에 있는데 데이터만 밖에 열어둘 이유가 없다.
--   (profiles_select_own 은 auth.uid() = id 조건 자체가 anon 을 걸러내 to 절 없이도 안전했다 — programs 는
--    그 방어가 없으므로 명시가 필요하다.)
create policy "programs_select_published"
  on public.programs
  for select
  to authenticated
  using (is_published = true);

-- [RLS 권한 경계] insert/update/delete 정책 없음 = 기본 전체 거부 (모든 역할, 모든 행에 대해 차단)
--  - 시딩(scripts/seed-programs.mjs)은 service_role 키로 수행되어 RLS를 우회하므로 이번 기능 동작에 지장 없다.
--  - 학생은 프로그램을 만들거나 고칠 수 없고, is_published=false 인 프로그램을 볼 수도 없다.
--  - created_by 로 관리자의 uuid 가 노출되지만, profiles 는 여전히 profiles_select_own 하나뿐이라
--    그 uuid 를 이름/코드로 조인할 경로가 없다(불투명 식별자만 보임).
--
-- [관리자 정책을 이번에 넣지 않는 이유]
--   관리자 "프로그램 관리(올리기/내리기/수정)" 화면은 이번 스코프가 아니고 스펙도 아직 없다. 지금
--   "본인이 만든 행만(created_by = auth.uid())" 으로 할지 "전체 허용" 으로 할지 정하면 근거 없는 추측이 되고,
--   쓰이지 않는 쓰기 권한이 열린 채로 남는다. mentor_students 에 정책을 0개 둔 것과 같은 원칙
--   (= 이번 스코프에 필요한 최소 정책만). 프로그램 관리 스펙이 오면 별도 ADR로 아래를 함께 결정한다:
--     - admin insert/update 정책의 행 경계 (created_by 기준 vs 전체)
--     - admin 이 미게시(is_published=false) 행을 select 할 수 있게 하는 정책 (위 정책은 admin 에게도 감춘다)

-- =========================================================
-- 참고: 데모 프로그램 데이터(16~20건)는 이 마이그레이션에 하드코딩하지 않는다.
--  - created_by 를 데모 관리자(ADM-0001)의 uuid 로 채우려면 seed-accounts.mjs 실행 후 조회가 필요하고,
--    시드 날짜가 리터럴이 아닌 "오늘 ± n일" 상대값이라 JS 쪽 계산이 자연스럽다 (ADR 0003 "시드 설계" 6번).
--  - 실제 시딩은 scripts/seed-programs.mjs (Node, service_role 키)에서 수행한다.
--  - "스키마는 마이그레이션, 데모 데이터는 scripts/" 라는 ADR 0002 의 관례와 일치한다.
-- =========================================================
