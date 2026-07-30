-- Accumu v2 — 초기 마이그레이션: profiles / mentor_students
-- 출처: docs/db/schema.sql (단일 스키마 소스), docs/adr/0002-profiles-schema-and-login-verification.md
-- 기능: 인증(로그인) — docs/specs/auth-login.md
--
-- 범위: 로그인 기능에 필요한 최소 테이블만 포함한다.
-- CLAUDE.md 5장의 나머지 테이블(programs, participations, point_transactions, reviews,
-- notifications)은 해당 기능이 architect-agent를 거칠 때 별도 마이그레이션으로 추가한다.
-- 임의로 없는 필드/정책을 추가하지 않는다 — docs/db/schema.sql, ADR 0002 그대로 반영.

-- =========================================================
-- 0. 확장 / 타입
-- =========================================================
create extension if not exists pgcrypto; -- gen_random_uuid() 용. Supabase 프로젝트는 보통 기본 활성화되어 있음.

do $$ begin
  create type user_role as enum ('student', 'admin');
exception
  when duplicate_object then null;
end $$;

-- =========================================================
-- 1. profiles
--    auth.users 1:1 매핑. 학생/관리자 공통 계정 테이블 (CLAUDE.md 5장).
-- =========================================================
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              user_role not null,
  code              text not null unique, -- 학번('10718') 또는 관리자코드('ADM-0001'). 원본 케이싱 그대로 저장(표시용).
  name              text not null,
  points_balance    integer not null default 0, -- 현재 사용 가능 포인트 (전환 시 차감)
  points_total      integer not null default 0, -- 누적 적립 포인트 (전환과 무관하게 증가만)
  currency_balance  integer not null default 0, -- 시뮬레이션 지역화폐 누적액 (1P=1원 개념, 실결제 없음)
  career_interest   text,                        -- 자유 텍스트, 학생 전용 개념. 이번 로그인 기능에서는 미사용
  created_at        timestamptz not null default now()
);

comment on table public.profiles is '학생/관리자 공통 계정 프로필. id는 auth.users.id와 1:1 매핑.';
comment on column public.profiles.code is '가상 이메일 생성 기준값: lower(trim(code)) || ''@accumu.local'' (src/lib/virtualEmail.js 참고). 컬럼 자체는 원본 케이싱 보존.';

alter table public.profiles enable row level security;

-- [RLS 권한 경계] profiles_select_own
--   대상 역할: student, admin 모두 (role 구분 없이 동일 정책 적용)
--   허용 행: auth.uid() = id 인 행, 즉 "자기 자신의 profiles 행"만 select 가능
--   불가능: 다른 사용자의 이름/학번/포인트/진로 관심사 등을 조회하는 것 (학생↔학생, 학생↔관리자, 관리자↔관리자 전부 차단)
--   용도: 로그인 직후 role/name 대조(클라이언트 authService.js)에 필요한 최소 조회 권한
create policy "profiles_select_own"
  on public.profiles
  for select
  using (auth.uid() = id);

-- [RLS 권한 경계] insert/update/delete 정책 없음 = 기본 전체 거부 (모든 역할, 모든 행에 대해 차단)
--  - 계정 생성(시딩)은 service_role 키(scripts/seed-accounts.mjs)로 수행되어 RLS를 우회하므로
--    클라이언트용 insert 정책이 필요 없다 (= 앱 내 회원가입 UI 없음 원칙과 일치).
--  - 학생/관리자 누구도 자신의 role, code, points_* 등을 앱에서 직접 고쳐쓸 수 없다.
--  - "마이페이지에서 career_interest 등 본인 정보 수정" 같은 기능이 생기면 그때
--    "본인 행 UPDATE, 단 role/code/points_* 등 민감 컬럼은 제외" 정책을 별도 ADR로 추가한다.

-- =========================================================
-- 2. mentor_students
--    관리자-담당학생 고정 매핑 (데모 기준 관리자 1명 : 학생 5명).
-- =========================================================
create table if not exists public.mentor_students (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid not null references public.profiles(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (admin_id, student_id)
);

comment on table public.mentor_students is
  '관리자-담당학생 매핑. admin_id가 실제 role=admin 행인지, student_id가 실제 role=student 행인지는 '
  'DB 레벨 CHECK/트리거로 강제하지 않고 시딩 스크립트(scripts/seed-accounts.mjs) 책임으로 둔다 (프로토타입 스코프, ADR 0002 참고).';

alter table public.mentor_students enable row level security;

-- [RLS 권한 경계] 이번 스코프(로그인 기능)에는 정책을 하나도 추가하지 않는다.
--   대상 역할: student, admin 모두
--   허용 행: 없음 (RLS enable 상태에서 정책 0개 = 기본적으로 전체 거부)
--   즉 학생/관리자 어느 쪽도 앱에서 이 테이블을 조회/수정할 수 없다. "담당 학생 매핑 노출" 리스크 없음.
--   시딩은 service_role 키로 수행되어 RLS를 우회하므로 데이터 삽입 자체는 문제 없다.
--
-- "담당 학생 아카이브" 기능 스펙이 오면 아래와 같은 정책을 추가할 예정(지금은 미구현):
--   create policy "mentor_students_select_own_as_admin"
--     on public.mentor_students for select
--     using (auth.uid() = admin_id);
--   -- 그리고 profiles에도 "관리자는 자기 담당 학생 행을 select 가능" 정책이 함께 필요해진다.

-- =========================================================
-- 참고: 데모 계정 데이터 자체(6개 계정, mentor_students 5행)는 이 마이그레이션에 하드코딩하지 않는다.
-- auth.users는 Supabase Auth Admin API로만 안전하게 생성 가능하므로, 실제 시딩은
-- scripts/seed-accounts.mjs (Node, service_role 키)에서 수행한다. 계정 목록은
-- docs/specs/auth-login.md의 "확정된 데모 계정" 표를 단일 출처로 참조한다.
-- =========================================================
