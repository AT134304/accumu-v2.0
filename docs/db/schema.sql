-- Accumu v2 — 스키마 소스 (ADR 0007 시점의 상태)
--
-- ============================================================================
-- ★ [2026-08-20 경고] 이 파일은 **더 이상 현재 스키마가 아니다.** 2026-07-30(ADR 0007) 이후로
--   갱신되지 않았고, 그 뒤에 들어온 것들이 여기에 없다:
--     notifications / 월 정산 / 기간제 프로그램(end_date, session_dates, attendance_sessions) /
--     taxonomy 재편(ADR 0014) / 담당 해제 / 대기열 / 튜토리얼 / 대표 사진(image_url) /
--     profiles.school / 초대코드 난수화(ADR 0024) / programs 텍스트 제약(ADR 0024)
--
--   >>> **현재 스키마의 진실은 `supabase/migrations/` 전체다.** 이 파일은 초기 설계 의도와
--       정책 하나하나의 근거 주석을 읽으려고 남겨 둔 참고 문서로 다룰 것.
--   >>> 새 마이그레이션을 쓸 때 이 파일만 보고 컬럼/정책 유무를 판단하지 말 것 —
--       실제로는 이미 있는 것을 "없다"고 판단해 중복 생성하게 된다.
-- ============================================================================
--
-- 최종 갱신: 2026-07-30 (학생 마이페이지/아카이브: 원장 조회 + reviews + 전환/계열 RPC, ADR 0007)
-- 범위: 로그인(ADR 0001/0002) + 학생 홈 추천(ADR 0003) + 프로그램 선택/참여 신청(ADR 0004)
--       + QR 입·퇴장 인증 / 포인트 지급 / 관리자 기능 3종(ADR 0005) + 정원 초과 신청 차단(ADR 0006)
--       + 포인트 내역 조회 / 만족도 평가 / 지역화폐 전환 / 관심 계열 저장(ADR 0007).
-- CLAUDE.md 5장의 나머지 테이블(notifications)은 해당 기능이 architect-agent를 거칠 때
-- 이 파일에 이어서 추가한다. 임의로 없는 필드를 지어내지 않는다 — 여기 없는 필드가 필요하면 먼저 ADR로 논의한다.
--
-- =========================================================
-- [마이그레이션 작성 시 주의] 이 파일은 "현재 목표 스키마 상태"를 기술한다. 실제 DB에는 이미 아래가 적용돼 있다:
--   20260709120000_init_profiles_and_mentor_students.sql
--   20260716120000_add_programs_and_career_track.sql
--   20260716140000_add_participations.sql
-- 따라서 profiles / mentor_students / programs / participations 는 새로 만들어지지 않는다.
-- ADR 0005 의 변경은 create table 이 아니라 아래 형태로 반영해야 한다:
--   - participations: alter table ... add column (2개) + add constraint (unique 2개)
--   - participations_insert_own: drop policy + create policy (with check 절이 6 -> 9절로 늘어난다)
--   - participations: revoke insert / grant insert (컬럼 단위)
--   - point_transactions: create table (신규)
--   - 함수 5개: create or replace function + revoke/grant execute
--   - 관리자 정책 6개: create policy (신규)
-- 자세한 지시는 ADR 0005 "구현 가이드 → backend-agent".
--
-- [ADR 0006 — 정원 게이트] 별도 마이그레이션 1건으로 나간다. 새 테이블/컬럼/제약/인덱스/정책이 0개이고,
--   추가되는 것은 아래 두 가지뿐이다:
--   - 함수 1개: public.participations_capacity_guard()  (4-1절)
--   - 트리거 1개: participations_capacity_guard  before insert on public.participations
--   그 밖에 comment 3종을 덮어쓴다(programs.capacity / participations_insert_own 주석 / 신규 함수 주석).
--   >>> participations_insert_own 정책을 drop/create 하지 말 것. SQL 은 불변이고 주석만 늘어난다
--       (다시 만들다가 with check 9절 중 한 절을 잃는 것이 이 파일에서 가장 비싼 사고다).
-- 자세한 지시는 ADR 0006 "구현 가이드 → backend-agent".
--
-- [ADR 0007 — 마이페이지/아카이브] 별도 마이그레이션 1건으로 나간다. 추가되는 것은 다음뿐이다:
--   - 제약 1개: profiles_balances_non_negative        (1번 절. alter table ... add constraint 로 반영할 것)
--   - 정책 1개: point_transactions_select_own          (5번 절. 이 테이블 최초이자 유일한 정책)
--   - 테이블 1개 + 정책 3개 + 컬럼 grant: public.reviews (8번 절)
--   - 함수 2개: convert_points_to_currency / set_career_interest (9번 절)
--   그 밖에 comment 를 덮어쓴다(point_transaction_type / profiles.points_balance·currency_balance·career_interest /
--   point_transactions 테이블 / participations 의 시연 리셋 절차).
--   >>> 다음을 한 글자도 수정하지 말 것: participations_insert_own, 컬럼 단위 insert grant,
--       issue_participation_qr(), verify_participation_qr(), participations_capacity_guard(),
--       point_transactions_source_rule CHECK, profiles 의 update 정책 0개.
--   >>> profiles 에 update 정책을 열지 않는다. 계열 저장도 전환도 definer 함수다 (ADR 0007 결정 3-6/4-3).
-- 자세한 지시는 ADR 0007 "구현 가이드 → backend-agent".
-- =========================================================

-- =========================================================
-- 0. 확장 / 타입
-- =========================================================
create extension if not exists pgcrypto; -- gen_random_uuid() 용. Supabase 프로젝트는 보통 기본 활성화되어 있음.

do $$ begin
  create type user_role as enum ('student', 'admin');
exception
  when duplicate_object then null;
end $$;

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
  '[ADR 0005] 관리자 프로그램 관리에서 이 값을 수동으로 지정한다 — 여전히 파생값이 아니다. '
  '[ADR 0006] 정원 차단이 도입된 뒤에도 이 값은 파생되지 않는다 — 정원이 차도 status 가 자동으로 full 이 되지 않는다. '
  '정원 게이트(DB 경계)와 status(표시용 라벨)는 서로 독립이며, 둘이 어긋난 상태(status=open 인데 정원이 참)를 수용한다.';

-- 한 학생의 참여 진행도 3종. ADR 0004.
--
-- [program_status 와 혼동 금지 — 이름만 비슷하고 개념이 완전히 다르다]
--   programs.status (program_status)       = 프로그램의 모집 상태. 정적 필드. join 매핑은 프런트 STATUS 맵 소유.
--   participations.status (아래 타입)      = 한 학생의 참여 진행도. 상태 전이는 DB/서버만 수행한다
--                                            (QR 토큰 검증 결과로만 바뀐다 — 학생도 관리자도 직접 못 쓴다).
--
-- [ADR 0005] 이제 3종 전부 실제로 생성된다:
--   applied  : 학생이 participations 행을 insert (participations_insert_own)
--   entered  : verify_participation_qr() 가 입장 토큰을 소비할 때만
--   completed: verify_participation_qr() 가 퇴장 토큰을 소비할 때만 (+ 포인트 지급이 같은 트랜잭션)
--   >>> 이 두 전이를 수행하는 update 문은 앱 전체에서 verify_participation_qr() 안의 2개뿐이다.
--       participations 에 update 정책이 0개이므로 다른 경로가 존재하지 않는다.
do $$ begin
  create type participation_status as enum ('applied', 'entered', 'completed');
exception
  when duplicate_object then null;
end $$;
comment on type participation_status is
  'applied=신청함(행 생성 시점), entered=입장 인증 완료(entry_at 기록됨), completed=퇴장 인증 완료(=참여 완료, 포인트 지급됨). '
  '[주의] programs.status(program_status)와 다른 개념이다 — 저쪽은 프로그램의 모집 상태, 이쪽은 한 학생의 참여 진행도. '
  '전이는 public.verify_participation_qr() 안의 update 2개만 수행한다 (participations 에 update 정책 0개 — ADR 0005).';

-- 포인트 거래 유형 2종. ADR 0005 (확정 C-1) / ADR 0007.
-- 값 이름은 CLAUDE.md 5장이 명시한 '적립'/'전환' 그대로다 (ASCII 키로 바꾸면 CLAUDE.md 가 확정한
-- taxonomy 를 임의로 다시 짓는 셈이 된다 — ADR 0005 "대안으로 고려했던 것" 참고).
-- [ADR 0007 — 이제 두 값이 모두 생성된다] '전환'(포인트 -> 지역화폐 시뮬레이션)을 만드는 코드는
--   public.convert_points_to_currency() 하나뿐이다(9번 절). 실제 결제/계좌 연동은 없다 (CLAUDE.md 2장 3번).
do $$ begin
  create type point_transaction_type as enum ('적립', '전환');
exception
  when duplicate_object then null;
end $$;
comment on type point_transaction_type is
  '적립=활동 참여 완료(QR 퇴장 인증)로 포인트가 늘어난 거래, 전환=포인트를 지역화폐로 바꾼 거래(시뮬레이션). '
  '[ADR 0007] 생성 주체는 각각 하나뿐이다: 적립 = public.verify_participation_qr(), 전환 = public.convert_points_to_currency(). '
  '두 값 모두 amount 는 양수이며 부호를 쓰지 않는다 — 방향은 type 이 정한다.';

-- =========================================================
-- 1. profiles
--    auth.users 1:1 매핑. 학생/관리자 공통 계정 테이블 (CLAUDE.md 5장).
--
--    [주의] 이 테이블은 이미 생성되어 있다(20260709120000 + 20260716120000 의 career_interest 타입 변경).
--    ADR 0005 의 변경은 "정책 1개 추가"뿐이며, 그 정책은 mentor_students 테이블을 참조하므로
--    이 파일 7번 절(관리자 권한 경계)에 모아 두었다. 아래를 함께 읽을 것.
-- =========================================================
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  role              user_role not null,
  code              text not null unique, -- 학번('10718') 또는 관리자코드('ADM-0001'). 원본 케이싱 그대로 저장(표시용).
  name              text not null,
  points_balance    integer not null default 0, -- 현재 사용 가능 포인트 (전환 시 차감)
  points_total      integer not null default 0, -- 누적 적립 포인트 (전환과 무관하게 증가만)
  currency_balance  integer not null default 0, -- 시뮬레이션 지역화폐 누적액 (1P=1원 개념, 실결제 없음)
  career_interest   career_track,                -- ADR 0003: text -> career_track enum 으로 좁힘. 학생 전용 개념.
  created_at        timestamptz not null default now(),

  -- [ADR 0007] 잔액은 음수가 될 수 없다. 잔액을 "줄이는" 경로(지역화폐 전환)가 처음 생기는 시점에
  --   그 불변식을 DB 에 적는다. 이 제약은 인덱스가 아니라 CHECK 이므로 "인덱스 추가 금지" 원칙과 무관하다.
  --   전환 함수의 조건부 UPDATE(points_balance >= p_amount)가 1차 방어이고, 이것이 마지막 방어선이다 —
  --   어떤 미래 경로가 잔액을 음수로 만들려 해도 트랜잭션이 통째로 실패한다(fail-closed).
  --   [마이그레이션 주의] 이 테이블은 이미 존재하므로 alter table ... add constraint 로 반영할 것.
  constraint profiles_balances_non_negative check (
    points_balance >= 0 and points_total >= 0 and currency_balance >= 0
  )
);

comment on table public.profiles is '학생/관리자 공통 계정 프로필. id는 auth.users.id와 1:1 매핑.';
comment on column public.profiles.code is '가상 이메일 생성 기준값: lower(trim(code)) || ''@accumu.local'' (src/lib/virtualEmail.js 참고). 컬럼 자체는 원본 케이싱 보존.';
comment on column public.profiles.career_interest is
  '학생의 관심 진로 계열. programs.career_track 과 같은 career_track 타입을 공유해 홈 추천 매칭의 값 공간이 일치함을 보장한다 (ADR 0003). '
  'NULL 허용은 의도된 도메인 상태: (1) 학생이 아직 계열을 고르지 않음 -> 홈 추천은 최신순 fallback (스펙 확정 E), '
  '(2) role=admin 은 계열 개념 자체가 없음. '
  '[ADR 0007] 이 컬럼을 바꾸는 유일한 경로는 public.set_career_interest(career_track) 이다(9-2절). '
  '인자 타입이 enum 이라 5종/NULL 외의 값은 함수 본문에 도달조차 못 한다. 관리자는 호출할 수 없다(학생 전용 개념). '
  '확정 K-1: 단일 유지. 배열(career_track[])로 넓히지 않는다 — 넓히면 ADR 0003 의 타입 공유 보장이 = ANY 로 느슨해진다.';
comment on column public.profiles.points_balance is
  '[ADR 0005 + 0007 — profiles 를 쓰는 경로 전체 표. 여기 없는 경로가 생기면 그것이 사고다] '
  'points_balance : 증가 = verify_participation_qr() 뿐 / 감소 = convert_points_to_currency() 뿐. '
  'points_total   : 증가 = verify_participation_qr() 뿐 / 감소 = 없음(영구 누적. 전환해도 줄지 않는다). '
  'currency_balance: 증가 = convert_points_to_currency() 뿐 / 감소 = 없음(표시용 누적 숫자, 사용처 없음). '
  'career_interest : set_career_interest() 뿐.  id/role/code/name: 없음(시딩 = service_role). '
  '>>> 셋 다 security definer 함수이고 profiles 의 update 정책은 여전히 0개다 = 학생도 관리자도 직접 수정할 수 없다. '
  '    못이 박힌 자리는 "함수가 하나뿐"이 아니라 "정책이 0개"다. 함수를 추가할 때는 UPDATE SET 목록에 '
  '    그 기능의 컬럼만 적고 이 표를 함께 갱신할 것. update 정책을 여는 선택지는 검토 대상이 아니다 (ADR 0007 결정 3-6). '
  '지급 사유는 point_transactions 에 1행씩 남는다 — 잔액과 원장이 어긋나면 위 경로 밖에서 누가 손댄 것이다.';
comment on column public.profiles.currency_balance is
  '시뮬레이션 지역화폐 누적액 (1P = 1원 개념). [절대 원칙 3] 실제 결제/계좌/외부 API 연동이 0줄이다. '
  '[ADR 0007] 이 값을 늘리는 유일한 경로는 convert_points_to_currency() 이고, 줄이는 경로/사용처/잔액 조회 API 를 만들지 않는다. '
  '화면에서는 "전환한 지역화폐 N원" 표시 전용이다. [시연 리셋 시 이 컬럼도 0 으로 되돌려야 한다]';

alter table public.profiles enable row level security;

-- [RLS 권한 경계] profiles_select_own
--   대상 역할: (미지정 = public) — auth.uid() = id 조건 자체가 anon 을 걸러낸다.
--   허용 행: 본인 행만 select
create policy "profiles_select_own"
  on public.profiles
  for select
  using (auth.uid() = id);

-- [ADR 0005] profiles 의 두 번째 select 정책(관리자 -> 담당 학생 5명)은 7번 절에 있다.
--   여기 두지 않은 이유: 그 정책이 public.mentor_students 를 참조하므로 해당 테이블이 먼저 존재해야 한다.
--
-- insert/update/delete 정책 없음 = 기본 전체 거부. [ADR 0005 / 0007 에서도 유지한다 — 열지 않았다.]
--  - 계정 생성(시딩)은 service_role 키(scripts/seed-accounts.mjs)로 수행되어 RLS를 우회한다.
--  - points_balance / points_total / currency_balance / career_interest 는 실제로 변하지만, 그 변경은 전부
--    security definer 함수 안에서만 일어난다(위 points_balance comment 의 표). update 정책을 여는 것이 아니다.
--    >>> 학생에게 update 정책을 열면 그 순간 "자기 포인트를 자기가 고치는" 경로가 생긴다. 절대 열지 말 것.
--
--  - [ADR 0007 — "마이페이지 계열 수정"이 실제로 왔고, 그때도 정책을 열지 않았다]
--    검토한 안: `create policy profiles_update_own for update using (id = auth.uid())`
--               + `revoke update ... from authenticated` + `grant update (career_interest) ... to authenticated`.
--    이 안은 기술적으로 동작한다(update 는 select 와 달리 학생/관리자를 구분할 필요가 없어 컬럼 grant 가 성립한다).
--    그럼에도 기각한 이유:
--      (a) 컬럼 경계를 지키는 것이 정책이 아니라 grant 한 줄이 된다. 정책 자체는 "본인 행 전체 수정 허용"이고,
--          Supabase 는 public 스키마 테이블에 authenticated 로 ALL 을 주는 기본 권한을 갖고 있다
--          (participations 에서 revoke insert 를 해야 했던 이유가 정확히 이것이다). 누군가 권한을 재설정하거나
--          grant all 을 한 줄 넣는 순간 정책은 그대로인 채 문이 열린다 = fail-open.
--          RPC 는 반대다 — 정책이 0개면 함수 밖에 update 경로가 아예 없다(fail-closed).
--      (b) grant 위반도 정책 위반도 둘 다 42501 이라 "왜 거부됐는가"의 출처가 하나 더 늘어난다. 가장 민감한 테이블에서.
--      (c) 전환은 원자성 때문에 반드시 RPC 다. 계열까지 RPC 여야 "profiles 를 쓰는 것은 definer 함수뿐"이라는
--          규칙이 하나로 유지된다. 정책과 함수로 갈라지면 다음 사람이 "이것도 정책으로 열면 되겠네"의 출발점을 갖는다.
--    >>> 일반 규율: 컬럼 단위 grant 는 정책이 이미 표현한 경계 위에 얹는 2차 방어로만 쓴다.
--        그것이 유일한 1차 경계가 되는 설계는 채택하지 않는다. (그래서 reviews 에서는 쓰고 profiles 에서는 안 쓴다.)
--    >>> profiles 의 grant/revoke 를 건드리지 않는다. grant 조작은 "무언가를 돌려줄 때"만 한다 —
--        여기서는 돌려주는 것이 없으므로 방어적 revoke 도 넣지 않는다(경계의 소재만 흐려진다).

-- ---------------------------------------------------------
-- 1-1. is_admin() — 호출자가 관리자인지 (RLS 정책 4개 + 검증 RPC 가 이 함수를 쓴다)
--
-- [security definer 인 이유가 편의가 아니다] profiles 의 RLS 정책 안에서 profiles 를 select 하면
-- Postgres 가 정책 재귀를 감지해 에러를 낸다("infinite recursion detected in policy"). definer 함수는
-- RLS 를 우회하므로 재귀가 성립하지 않는다. 7번 절 profiles_select_mentored_students_as_admin 이
-- 이 함수 없이는 작성 불가능하다.
--
-- [여기(profiles 바로 뒤)에 두는 이유 — 순서가 중요하다] 아래 정책 4개가 이 함수를 참조하므로
-- 함수가 먼저 존재해야 한다: participations_insert_own(4번 절) / programs_insert_own_as_admin /
-- programs_update_own_as_admin / profiles_select_mentored_students_as_admin /
-- participations_select_mentored_as_admin(7번 절). 함수 본문이 public.profiles 를 읽으므로
-- profiles 테이블보다는 뒤여야 한다.
-- ---------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin'
  );
$$;

comment on function public.is_admin() is
  '호출자(auth.uid())가 role=admin 인지. RLS 정책에서 profiles 를 참조할 때 정책 재귀를 피하려고 security definer 로 만들었다. '
  '읽는 것은 호출자 본인 행 하나뿐이라 이 함수 자체로는 아무 데이터도 노출하지 않는다.';

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

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
  'DB 레벨 CHECK/트리거로 강제하지 않고 시딩 스크립트(scripts/seed-accounts.mjs) 책임으로 둔다 (ADR 0002). '
  '[ADR 0005 경고] 이 테이블이 이제 "관리자가 남의 profiles/participations 를 볼 수 있는 행 경계"가 되었다. '
  '즉 시딩 정합성(admin_id 자리에 학생이 들어가지 않는 것)이 문서 규율에서 권한 경계의 일부로 승격됐다. '
  '실제 방어는 profiles/participations 정책의 public.is_admin() 이 함께 담당한다(7번 절).';

alter table public.mentor_students enable row level security;

-- [ADR 0005] 정책은 7번 절(mentor_students_select_own_as_admin) 참고. 이번에 처음 열린다.
--   insert/update/delete 는 계속 0개 = 전체 거부 (담당 매핑 변경 UI 없음. 시딩이 유일한 입력 경로).

-- =========================================================
-- 3. programs
--    진로·커리어 활동 프로그램 (CLAUDE.md 5장 + 스펙 확정 D의 추가 필드).
--    ADR 0003 / ADR 0005(관리자 프로그램 관리)
-- =========================================================
create table if not exists public.programs (
  id            uuid primary key default gen_random_uuid(),
  category      program_category not null,
  title         text not null,
  description   text not null,                      -- 참여 팝업에서 필수 표시. 프로토타입 전 프로그램에 설명이 있다.
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
  created_at    timestamptz not null default now(), -- 추천 "최신순" 정렬의 시간 축 (확정 E).

  constraint programs_capacity_positive check (capacity is null or capacity > 0),
  -- CLAUDE.md 7장 포인트 규칙(최소 150P, 최대 3000P, 끝자리 0)을 DB 레벨에서 강제한다.
  -- [ADR 0005] 관리자 프로그램 등록/수정이 열리면서 이 CHECK 가 처음으로 "사람이 입력한 값"을 막게 된다.
  --   위반 시 23514 -> HTTP 400. 프런트도 같은 규칙으로 미리 검증하되, 경계의 소유자는 이 CHECK 다.
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
comment on column public.programs.capacity is
  '(a) NULL = 정원 미정/무제한. 검사 자체를 하지 않는다. 시드 20건은 전부 NULL 이므로 기존 프로그램의 신청 동작에 회귀가 없다. '
  '(b) [ADR 0006 — ADR 0005 의 "정원 차단을 구현하지 않는다" 를 뒤집는다] 정원 차단을 구현한다(확정 F). '
  '    막는 주체는 RLS 정책이 아니라 participations 의 before insert 트리거 participations_capacity_guard 다(4-1절). '
  '(c) "찼다" 의 기준 = status 무관, 그 프로그램의 참여 행 수. count(*) where program_id = P >= capacity. '
  '    applied/entered/completed 를 모두 센다 — 어느 상태든 자리 1개이고, 전이 도중 count 가 흔들리지 않는다. '
  '(d) 기존 행에 소급 적용되지 않는다. 정원은 insert 시점의 게이트일 뿐이다 — 관리자가 정원을 줄여도 이미 신청한 '
  '    학생의 행/QR 발급/입장/퇴장/포인트 지급이 전부 그대로 동작한다(ADR 0005 결정 7-4 와 같은 계열의 판단). '
  '(e) status 파생에는 여전히 사용하지 않는다(확정 D / F-5). 정원이 차도 status 가 자동으로 full 이 되지 않는다. '
  '(f) 신청자 수를 관리자/학생 어느 화면에도 노출하지 않는다. 서버는 count 를 알지만 응답에 담지 않는다 — '
  '    거부 응답은 사유 1비트뿐이고 숫자가 없다. "N/20명"/"남은 자리 N석"/"마감 임박" 을 만들지 말 것.';
comment on column public.programs.popularity is
  '[절대 원칙 가드] 프로그램의 인기 지표이지 학생 간 순위가 아니다. 학생 단위 집계/랭킹으로 파생시키는 설계 금지 (CLAUDE.md 2장 1번). '
  '[ADR 0005] 실참여자 수로 전환하지 않는다 — participations 로 집계하려면 관리자에게 전교생 참여 조회 권한이 필요해지는데 '
  '그것이 정확히 이번에 열지 않기로 한 권한이다(7번 절 참고). 관리자 프로그램 관리 화면에서도 이 값을 노출/편집하지 않는다.';
comment on column public.programs.is_published is
  '게시/게시중단. 관리자 기능 "올리기/내리기" 가 이 값을 토글한다 (CLAUDE.md 10장). 삭제가 아니다. '
  '[ADR 0005 — 게시중단이 이미 신청한 학생에게 주는 영향. 반드시 알고 있을 것] '
  '(1) participations 행은 그대로 남는다 — 게시중단은 programs 의 값 변경일 뿐 참여를 지우지 않는다. '
  '(2) 그럼에도 학생은 그 programs 행을 더 이상 select 할 수 없다(programs_select_published 가 가린다). '
  '    학생 화면의 제목/일시/포인트는 participations 가 아니라 programs 에서 오므로 빈칸이 된다. '
  '    >>> frontend 는 programs 조회 결과에 해당 program_id 가 없는 경우를 정상 경로로 다뤄야 한다 '
  '        (QR 목록/아카이브에서 "게시가 중단된 프로그램" 으로 표시. 에러로 죽지 않게 할 것). '
  '(3) QR 인증은 계속 동작한다 — verify_participation_qr 은 security definer 라 RLS 를 타지 않고 '
  '    is_published 를 조건으로 쓰지도 않는다. 이미 신청한 학생이 게시중단 때문에 포인트를 못 받는 일은 없다. '
  '(4) 막히는 것은 신규 신청뿐이다 — participations_insert_own 의 exists 서브쿼리가 is_published = true 를 요구한다.';
comment on column public.programs.created_by is
  '프로그램을 등록한 관리자. on delete set null — 관리자 계정이 사라져도 프로그램 기록은 남긴다. '
  '[ADR 0005 — 이 컬럼이 관리자 권한의 단일 축이다] 프로그램 수정/게시중단/미게시 조회(3개 정책)와 '
  'QR 스캔 인증(확정 H-1, verify_participation_qr)이 모두 created_by = auth.uid() 하나를 경계로 쓴다. '
  'NULL 이면 어느 관리자에게도 권한이 없다(fail-closed) — RLS 에서는 NULL = auth.uid() 가 NULL 이라 통과하지 않고, '
  'verify_participation_qr 은 명시적으로 not_authorized 를 반환한다.';

alter table public.programs enable row level security;

-- [RLS 권한 경계] programs_select_published
--   대상 역할: authenticated (student, admin 공통)
--   허용 행: is_published = true 인 행만 select
--   [ADR 0005] 이 정책은 그대로 유지된다. 관리자용 미게시 조회는 별도 정책으로 7번 절에 추가되며,
--             두 정책은 OR 로 합쳐진다(= 관리자는 "게시된 전부 + 본인이 만든 미게시").
create policy "programs_select_published"
  on public.programs
  for select
  to authenticated
  using (is_published = true);

-- [ADR 0005] programs 의 관리자 정책 3개(미게시 select / insert / update)는 7번 절 참고.
--   delete 정책은 이번에도 열지 않는다 — 근거는 7번 절 상단.

-- =========================================================
-- 4. participations
--    학생의 프로그램 신청/참여 행 (CLAUDE.md 5장).
--    ADR 0004(신청) / ADR 0005(QR 인증 + 포인트 지급)
--
--    [권한 구조 한눈에 — ADR 0005 이후]
--      insert : 학생 본인만(관리자 제외). 컬럼 단위 grant(student_id, program_id) + with check 9절
--               + [ADR 0006] before insert 트리거(정원 게이트, 4-1절). 정원은 정책이 아니라 트리거가 막는다.
--      select : 본인 행(학생) / 담당 학생의 completed 행(관리자, 7번 절).
--      update : 정책 0개. 전이는 public.verify_participation_qr()(security definer) 안의 update 2개뿐.
--      delete : 정책 0개. 시연 리셋은 service_role.
-- =========================================================
create table if not exists public.participations (
  id           uuid primary key default gen_random_uuid(),
  student_id   uuid not null references public.profiles(id) on delete cascade,
  program_id   uuid not null references public.programs(id) on delete cascade,
  status       participation_status not null default 'applied',

  entry_at     timestamptz,                          -- 입장 인증 시각. verify_participation_qr() 만 기록한다.
  exit_at      timestamptz,                          -- 퇴장 인증 시각. 기록과 동시에 포인트가 지급된다(같은 트랜잭션).

  -- [QR 1회용 토큰 — ADR 0005 1번]
  --   형식: Crockford Base32 10자 (0-9 A-Z 에서 I, L, O, U 제외 = 32문자, 50비트).
  --   발급: public.issue_participation_qr() 만. 학생은 이 컬럼에 쓸 수 없다(insert 컬럼 grant + with check).
  --   무효화: 토큰 문자열을 지우지 않는다. status 전이가 곧 무효화다(아래 comment 참고).
  entry_token  text,
  exit_token   text,

  -- [ADR 0005 신규] 만료 시각을 DB 컬럼에 둔다. QR payload 의 expires_at 은 학생 화면 카운트다운 표시용일 뿐이고,
  --   판정은 오로지 이 컬럼으로 한다 — payload 를 신뢰하면 만료를 위조할 수 있다(스펙 "검증 판정은 DB 값 기준").
  entry_token_expires_at timestamptz,
  exit_token_expires_at  timestamptz,

  created_at   timestamptz not null default now(),   -- 신청 시각.

  -- [중복 신청 차단] 위반 시 23505 -> PostgREST HTTP 409.
  unique (student_id, program_id),

  -- [ADR 0005] 토큰 유일성. 인덱스를 만들지 않는다는 기존 원칙(ADR 0003 주의 4)의 예외이며,
  --   unique (student_id, program_id) 와 같은 "제약의 부산물" 범주다.
  --   컬럼 간(entry_token vs exit_token) 충돌은 unique 로 표현할 수 없으므로 발급 함수의 재시도 루프가 담당한다.
  constraint participations_entry_token_unique unique (entry_token),
  constraint participations_exit_token_unique  unique (exit_token)
);

comment on table public.participations is
  '학생의 프로그램 신청/참여 행. applied(신청) -> entered(입장 인증) -> completed(퇴장 인증 + 포인트 지급). '
  '[시연 리셋] 아래 2문장을 함께 실행해야 포인트 정합이 맞는다 (service_role 로 실행):'
  '  delete from public.participations;  -- point_transactions 와 reviews 가 on delete cascade 로 함께 지워진다'
  '  update public.profiles set points_balance = 0, points_total = 0, currency_balance = 0;'
  '  [ADR 0007] currency_balance 초기화가 새로 필요하다 — 빠뜨리면 리셋 후에도 "전환한 지역화폐" 가 남는다.';
comment on column public.participations.status is
  '한 학생의 참여 진행도. [주의] programs.status 와 다른 개념이다. '
  '학생은 applied 로만 insert 할 수 있고(with check), update 정책이 0개라 이후 변경도 불가능하다. '
  'entered/completed 전이는 public.verify_participation_qr() 안의 update 2개만 수행하며, 그 update 는 '
  'where 절에 이전 상태를 함께 걸어(applied->entered, entered->completed) 동시 스캔에서도 한 번만 성공한다(CAS).';
comment on column public.participations.entry_token is
  'QR 1회용 입장 토큰. Crockford Base32 10자. public.issue_participation_qr() 이 발급하며 재발급 시 덮어쓴다'
  '(= 이전 토큰은 어느 행과도 매칭되지 않아 not_found 로 거부된다). '
  '[사용 후에도 문자열을 지우지 않는 이유] NULL 로 지우면 재스캔 시 행을 찾지 못해 "이미 사용됨(used)"과 '
  '"없는 토큰(not_found)"을 구분할 수 없다(스펙이 두 사유를 구분해 표시하도록 요구). 대신 status 전이가 무효화 역할을 한다 — '
  '입장 토큰은 status=applied 일 때만 소비되므로 한 번 entered 가 되면 같은 토큰으로 두 번 전이할 수 없다.';
comment on column public.participations.entry_token_expires_at is
  '발급 시각 + 30분 (CLAUDE.md 6장). 만료 판정의 유일한 소스. QR payload 안의 expires_at 은 학생 화면 카운트다운용 표시값이며 '
  '검증에 쓰지 않는다(위조 가능). 학생은 이 컬럼에 insert 할 수 없다 — 컬럼 단위 insert grant + with check 9절.';
comment on column public.participations.created_at is
  '신청 시각. [ADR 0005] 컬럼 단위 insert grant(student_id, program_id) 도입으로 ADR 0004 의 "created_at 위조 가능" 틈이 닫혔다.';

alter table public.participations enable row level security;

-- [RLS 권한 경계] participations_select_own
--   대상 역할: authenticated
--   허용 행: student_id = auth.uid() 인 행만 select
--   용도: "신청됨" 판정, 홈 추천 제외(D-1), QR 발급 대상 목록, QR 모달 폴링(상태 자동 반영),
--         홈 stackviz(완료 활동 월별 집계 — 확정 B-1. 새 정책이 필요 없다)
create policy "participations_select_own"
  on public.participations
  for select
  to authenticated
  using (student_id = auth.uid());

-- [ADR 0005] participations 의 관리자 select 정책(담당 학생의 completed 행만)은 7번 절 참고.

-- [RLS 권한 경계] participations_insert_own  <<< 학생이 DB에 쓰는 유일한 직접 경로. 각 절이 공격 경로를 하나씩 막는다.
--   대상 역할: authenticated
--   허용 행: 아래 with check 9절을 전부 만족하는 행만 insert
--   불가능(= 각 절이 막는 것):
--     1) student_id = auth.uid()          -> 남의 이름으로 신청.                                 위반 시 42501/403
--     2) not public.is_admin()            -> [ADR 0005 신규] 관리자 계정의 자기참여. 아래 참고.  위반 시 42501/403
--     3) status = 'applied'               -> 스스로 "참여 완료" 상태로 insert = 부정 적립.        위반 시 42501/403
--     4) entry_at/exit_at is null         -> 입·퇴장 시각을 직접 기록해 QR 인증 건너뛰기.        위반 시 42501/403
--     5) entry_token/exit_token is null   -> 자기가 아는 토큰을 심어두고 그 QR 을 생성하기.      위반 시 42501/403
--     6) *_token_expires_at is null       -> [ADR 0005 신규] 만료 시각 선주입.                    위반 시 42501/403
--     7) exists(... is_published = true)  -> 미게시 프로그램에 신청.                              위반 시 42501/403
--     + unique (student_id, program_id)   -> 중복 신청 (제약이 담당).                             위반 시 23505/409
--     + 정원 초과 (capacity)              -> [ADR 0006] 이 정책이 막지 않는다. before insert 트리거
--                                            participations_capacity_guard 가 막는다(4-1절).
--                                            위반 시 P0001 / hint='capacity_full' / HTTP 400.
--
--   [정원은 왜 이 정책에 들어오지 않았는가 — ADR 0006 결정 1]
--     (1) 정책 표현식 안에서 participations 를 세면 Postgres 가 정책 재귀를 낸다.
--     (2) 우회해도 위반이 42501 로 나와 위 1~7번(권한 오류)과 구분되지 않는다. 학생 화면이 "정원 마감"과
--         "버그 신호"를 구분할 수 없게 된다(스펙 F-6).
--     (3) 정책은 잠금을 걸 수 없어 마지막 1자리에 동시 신청한 두 건이 둘 다 통과한다(F-7).
--   [실행 순서 주의] BEFORE INSERT 트리거는 이 with check 보다 먼저 실행된다. 따라서 정원이 찬 미게시
--     프로그램에 신청하면 42501 이 아니라 정원 거부가 먼저 나온다(수용 — 어느 쪽이든 거부이고 행은 안 생긴다).
--     같은 이유로 "이미 신청한 학생의 재신청"이 duplicate 대신 full 로 나갈 뻔했고, 트리거 본문의
--     "같은 student_id 행이 이미 있으면 통과" 절이 그것을 막는다(ADR 0006 결정 5-2).
--
--   [2번 — 이번에 새로 막는 폐루프. G-3 이 만든 것이다]
--   확정 G-3 으로 관리자에게 programs insert 권한이 열리면서, 관리자 한 계정이 다음을 전부 할 수 있게 됐다:
--     (1) 3,000P 짜리 프로그램을 만든다(created_by = 본인)  -> programs_insert_own_as_admin
--     (2) 그 프로그램에 자기 이름으로 신청한다               -> student_id = auth.uid() 를 만족한다!
--     (3) 자기 QR 을 발급받는다                              -> issue_participation_qr (본인 참여 건이므로 통과)
--     (4) 자기가 스캔해 완료 처리한다                        -> verify_participation_qr (created_by = 본인이므로 H-1 통과)
--   = 관리자가 자기 포인트를 무한히 찍어내는 경로다. 이전 스코프에서는 (1)이 불가능해 성립하지 않았다.
--   >>> `not public.is_admin()` 한 절이 (2)를 끊어서 루프를 연다. 도메인적으로도 맞다 —
--       CLAUDE.md 4장에서 신청은 student 의 행위이고 admin 은 등록/스캔/조회만 한다.
--       (관리자가 학생 계정으로 신청하는 것은 여전히 가능하지만, 그건 학생 계정의 권한이고 QR 2회 인증도 그대로다.)
--
--   [6번 절이 늘어난 이유] ADR 0004 가 "컬럼이 추가되면 이 with check 를 반드시 함께 재검토하라"고
--   지목했다. RLS 는 행 단위 술어라 새 컬럼을 자동으로 막지 않는다. 만료 컬럼만 위조한 토큰은
--   (토큰 자체를 심을 수 없으므로) 실제로는 무해하지만, "봉인은 컬럼이 생길 때 함께 한다"는
--   규율을 여기서 깨면 다음 컬럼에서 진짜 구멍이 생긴다.
--
--   [7번 — with check 안의 서브쿼리 재검토 (ADR 0005 에서 실제로 확인함)]
--   7번 절에서 programs 에 "관리자는 본인이 만든 미게시 행도 select 가능" 정책이 추가된다. ADR 0004 가
--   예고한 함정이 이제 현실이 됐다: 정책 표현식은 질의자 권한으로 평가되므로, 관리자가 스스로 신청하면
--   이 서브쿼리가 그 관리자에게 자기 미게시 프로그램을 보여준다. >>> 그럼에도 `and p.is_published = true`
--   를 명시적으로 걸어둔 덕분에 결과는 여전히 거부다. ADR 0004 의 방어가 설계대로 작동했다.
--   (위 2번 절이 관리자 신청을 통째로 막으므로 이제 방어가 2중이지만, 두 절 중 어느 것도 지우지 말 것 —
--    2번은 "누가", 7번은 "어떤 프로그램에" 를 막는 서로 다른 축이다.)
create policy "participations_insert_own"
  on public.participations
  for insert
  to authenticated
  with check (
    student_id = auth.uid()
    and not public.is_admin()
    and status = 'applied'
    and entry_at is null
    and exit_at is null
    and entry_token is null
    and exit_token is null
    and entry_token_expires_at is null
    and exit_token_expires_at is null
    and exists (
      select 1
      from public.programs p
      where p.id = participations.program_id
        and p.is_published = true
    )
  );

-- [권한 경계] 컬럼 단위 insert grant — ADR 0004 가 "QR 스펙 시점이 이 방법의 원래 자리"라며 미뤄둔 것
--   이번에 채택한다. 위 with check 가 "값"을 검사한다면, 이 grant 는 "지정할 수 있는 컬럼 자체"를 못박는다.
--   효과:
--     - 앞으로 participations 에 어떤 컬럼이 추가되어도 학생은 그 컬럼을 쓸 수 없다 (fail-closed).
--       정책 개정을 잊어도 구멍이 생기지 않는다 — 이번 스펙에서 실제로 컬럼 2개가 늘었고, 앞으로도 늘어난다.
--     - ADR 0004 가 "알려진 틈"으로 수용했던 created_at / id 위조가 함께 닫힌다.
--   주의:
--     - 위반도 42501/403 이라 with check 위반과 구분되지 않는다. 프런트는 insert 에 student_id/program_id
--       외 어떤 컬럼도 보내지 않는다(src/lib/programService.js applyToProgram 이미 그렇게 되어 있다).
--     - RETURNING(supabase-js 의 .insert().select())은 select 권한을 쓰므로 계속 동작한다.
--     - service_role 은 별도 역할이라 이 revoke 의 영향을 받지 않는다(시딩/리셋 무관).
revoke insert on public.participations from authenticated;
revoke insert on public.participations from anon;
grant  insert (student_id, program_id) on public.participations to authenticated;

-- [RLS 권한 경계] update/delete 정책 없음 = 기본 전체 거부 (학생·관리자 모두).
--  >>> ADR 0005 의 핵심 결정이다. 이번 스펙에서 status/entry_at/exit_at/토큰을 쓰는 경로가 필요해졌지만,
--      그 경로를 정책으로 열지 않고 security definer 함수 2개로만 열었다. 이유는 6번 절 함수 주석과 ADR 0005 2번.
--      - 학생에게 열면: 스스로 completed 로 바꿔 QR 2회 인증을 통째로 우회한다(부정 적립).
--      - 관리자에게 열면: RLS 는 컬럼 단위가 아니고 using(OLD)/with check(NEW)를 연결할 수단이 없어
--        "student_id 는 그대로 두고 status 만 바꾸기"를 표현할 수 없다. 관리자가 남의 참여를 자기 학생으로
--        옮기거나, 토큰 없이 completed 로 만들어 포인트를 찍어낼 수 있다.
--  - 시연 리셋(delete)은 service_role 키로 수행한다.

-- ---------------------------------------------------------
-- 4-1. 정원 게이트 (ADR 0006 — 확정 F)
--
-- [무엇을 막는가] capacity 가 지정된 프로그램에 정원을 넘는 신규 신청.
--   정원이 찼다 <=> capacity is not null and count(*) from participations where program_id = P >= capacity.
--   status 를 조건에 넣지 않는다(applied/entered/completed 전부 자리 1개다 — 스펙 F-2).
--   count 가 뒤로 가지 않는 근거: participations 에 update/delete 정책이 0개라 행이 사라지거나 되돌아갈 수 없다.
--
-- [왜 정책이 아니라 트리거인가] 정원은 "교차 행 제약"이라 unique/check 로 표현할 수 없고, 정책으로 쓰면
--   재귀 + 42501(사유 구분 불가) + 잠금 불가 세 가지를 동시에 어긴다. 근거 전문은 ADR 0006 결정 1.
--   신청 자체를 security definer RPC 로 옮기는 안도 검토했으나, 그러려면 컬럼 단위 insert grant 를 회수해야
--   하고 그 순간 위 with check 9절이 죽은 정책이 된다(특히 not public.is_admin() 을 함수 본문에 다시 쓰게 된다).
--   >>> 부가 기능(정원) 때문에 최대 보안 항목(관리자 무한 적립 차단)을 재작성하지 않는다. ADR 0006 결정 1-3.
--
-- [security definer 인 이유가 재귀 회피가 아니다 — 이 함수에서 가장 중요한 한 줄]
--   invoker 로 만들면 함수 안의 count 가 호출한 학생의 권한으로 평가된다. 학생에게 열린 정책은
--   participations_select_own(본인 행) 뿐이므로 count 는 항상 0 이 되고, 0 >= capacity 는 언제나 거짓이라
--   >>> 정원이 조용히 무력화된다. 에러도 로그도 없이 fail-open 이다. definer 는 편의가 아니라 정확성의 조건이다.
--
-- [노출 표면 0] 이 함수는 트리거 전용이라 클라이언트에 값을 돌려줄 수 없다 = count 가 밖으로 나갈 경로가 없다.
--   revoke all from public 으로 직접 호출도 막는다(qr_generate_token() 전례).
--   >>> "찼는가"를 알려주는 호출 가능한 함수(program_is_full 등)를 만들지 말 것. 그건 학생 화면의 사전 마감
--       표시(스펙 K-2)이고 아직 확정되지 않았다. 현재 확정은 K-1(신청 시도 후 사후 거부)이다.
--
-- [before insert 만이다 — or update 를 붙이면 사고가 난다]
--   verify_participation_qr() 은 participations 를 update 한다. 트리거가 update 에도 걸리면 정원을 줄여
--   count > capacity 가 된 프로그램에서 입·퇴장 스캔이 통째로 거부된다 = 현장에 온 학생을 돌려보내는 지점.
--   스펙이 원칙 5 가드로 명시 금지했다. 정원은 "insert 시점의 게이트"일 뿐이며 기존 행에 소급 적용되지 않는다.
--
-- [인덱스를 추가하지 않는다] count 가 program_id 로 필터하지만 ADR 0004 주의 5 가 program_id 단독 인덱스를
--   이름까지 지목해 금지했다. 예외는 "제약의 부산물"뿐이고(ADR 0005 결정 1-5) 이건 조회 성능이다.
--   participations 는 데모 전체에서 수십 행이다.
-- ---------------------------------------------------------
create or replace function public.participations_capacity_guard()
returns trigger
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_capacity integer;
  v_taken    integer;
begin
  -- (1) 정원을 읽으면서 그 programs 행을 잠근다. 동시성 방어의 전부가 이 for update 다 (ADR 0006 결정 4).
  --     같은 프로그램에 동시에 도착한 두 신청은 여기서 직렬화되고, 두 번째는 첫 번째가 커밋된 뒤에
  --     (READ COMMITTED 는 문장마다 새 스냅샷을 뜬다) 갱신된 count 를 다시 읽어 거부된다.
  select p.capacity into v_capacity
    from public.programs p
   where p.id = new.program_id
   for update;

  -- (2) 없는 program_id 는 FK(23503)가 담당한다. 여기서 판정하면 거부 사유가 둘로 갈린다.
  if not found then
    return new;
  end if;

  -- (3) NULL = 무제한. 시드 20건이 전부 이 분기로 빠지므로 기존 신청 동작에 회귀가 없다.
  if v_capacity is null then
    return new;
  end if;

  -- (4) [사유 순서 보정 — 지우지 말 것. ADR 0006 결정 5-2]
  --     BEFORE INSERT 트리거는 unique 제약보다 먼저 실행된다. 이 절이 없으면 이미 신청한 학생의 재요청
  --     (다른 탭 / 오래된 화면)이 23505(duplicate) 대신 정원 거부로 나가고, 프런트가 "이미 신청됨" 상태
  --     동기화 대신 "마감" 을 표시한다 — 정작 그 학생은 자리를 갖고 있다.
  --     도메인적으로도 맞다: 이미 자리를 가진 사람은 정원에 막히는 대상이 아니다.
  if exists (
    select 1
      from public.participations
     where program_id = new.program_id
       and student_id = new.student_id
  ) then
    return new;
  end if;

  -- (5) status 를 조건에 넣지 않는다 (F-2). definer 이므로 RLS 를 타지 않고 전원을 센다.
  select count(*) into v_taken
    from public.participations
   where program_id = new.program_id;

  if v_taken >= v_capacity then
    -- [거부 신호 — 프런트 계약이다. 문자열을 바꾸거나 번역하지 말 것]
    --   errcode P0001 -> PostgREST HTTP 400. 42501(403)/23505(409)와 상태 코드부터 다르다.
    --   판별은 hint 로 한다(P0001 은 raise exception 의 기본 코드라 언젠가 충돌한다).
    --   [정보 노출 금지] message/detail 에 숫자를 넣지 말 것 — 신청자 수도, 정원 값도, 남은 자리도.
    raise exception '정원이 모두 찼습니다.'
      using errcode = 'P0001',
            hint    = 'capacity_full';
  end if;

  return new;
end;
$$;

comment on function public.participations_capacity_guard() is
  '[ADR 0006] 프로그램 정원 게이트. participations 의 before insert 트리거 전용 함수. '
  'capacity 가 NULL 이면 무제한이라 즉시 통과하고, 지정돼 있으면 그 프로그램의 참여 행 수를 세어 '
  'count >= capacity 이면 P0001 / hint=capacity_full 로 거부한다(status 무관 — F-2). '
  '[security definer 인 이유] 재귀 회피가 아니라 정확성이다 — invoker 면 count 가 participations_select_own 에 '
  '걸려 본인 행만 보이고 항상 0 이 되어 정원이 조용히 무력화된다(fail-open). '
  '[for update] 정원을 읽는 select 의 for update 가 동시 신청 직렬화의 전부다. 빼면 마지막 1자리에 두 건이 통과한다. '
  '[before insert 만] update 에 걸면 정원 초과 상태의 프로그램에서 QR 입·퇴장 스캔이 거부된다 — 절대 금지. '
  '[노출] 반환값이 없고 grant execute 도 없다. count 가 클라이언트에 도달할 경로가 존재하지 않는다.';

revoke all on function public.participations_capacity_guard() from public;
-- grant execute 를 아무에게도 주지 않는다. 트리거는 소유자 권한으로 호출된다.

-- 재적용 안전성: create or replace trigger 는 PG14+ 에서 지원된다. 하위 호환이 필요하면
--   drop trigger if exists participations_capacity_guard on public.participations; 를 먼저 실행할 것.
create or replace trigger participations_capacity_guard
  before insert on public.participations
  for each row
  execute function public.participations_capacity_guard();

-- =========================================================
-- 5. point_transactions
--    포인트 적립/전환 원장 (CLAUDE.md 5장). ADR 0005 확정 C-1.
--
--    [이 테이블의 존재 이유 절반은 unique 제약이다]
--    "한 참여당 적립 정확히 1회"를 애플리케이션 로직이 아니라 DB 제약으로 표현할 자리다.
--    재스캔·동시 스캔·네트워크 재시도가 두 번째 적립을 시도하면 23505 로 튕기고,
--    verify_participation_qr() 은 그 예외를 잡아 트랜잭션 전체를 되돌린 뒤 already_completed 를 반환한다.
-- =========================================================
create table if not exists public.point_transactions (
  id                       uuid primary key default gen_random_uuid(),
  student_id               uuid not null references public.profiles(id) on delete cascade,
  type                     point_transaction_type not null,
  amount                   integer not null,
  related_participation_id uuid references public.participations(id) on delete cascade,
  created_at               timestamptz not null default now(),

  -- 부호를 쓰지 않는다. 방향은 type 이 정한다(적립 = 증가, 전환 = 감소). 0P 거래는 의미가 없다.
  constraint point_transactions_amount_positive check (amount > 0),

  -- [확정 C-1 — 이중 지급 방어의 핵심] 한 참여당 최대 1건. NULL 은 여러 개 허용되므로
  --   전환('전환') 거래는 이 제약에 걸리지 않는다.
  constraint point_transactions_participation_unique unique (related_participation_id),

  -- [절대 원칙 3·6장 가드를 DB 로 표현] 적립은 반드시 참여에서 나오고(= QR 퇴장 인증 없이는 적립이 불가능),
  --   전환은 참여와 무관하다. "출처 없는 적립"이 원장에 남을 수 없다.
  constraint point_transactions_source_rule check (
    (type = '적립' and related_participation_id is not null)
    or (type = '전환' and related_participation_id is null)
  )
);

comment on table public.point_transactions is
  '포인트 적립/전환 원장 (CLAUDE.md 5장). 생성 주체는 둘뿐이다: '
  '적립 = public.verify_participation_qr() 의 퇴장 인증 성공 시 1행, 전환 = public.convert_points_to_currency() 1행. '
  '[RLS — ADR 0007] select 정책 1개(본인 축)만 열려 있고 insert/update/delete 정책은 여전히 0개다. '
  '학생이 원장에 직접 쓸 수 있으면 포인트를 스스로 찍어낼 수 있다 = 이 테이블이 막으려던 바로 그 공격이다. '
  '관리자용 정책은 만들지 않았다 — 담당 학생 아카이브는 "무슨 활동을 했는가"이지 "얼마 벌었는가"가 아니다(원칙 4).';
comment on column public.point_transactions.amount is
  '지급 시점의 programs.points 스냅샷이다. programs.points 를 나중에 관리자가 수정해도(ADR 0005 프로그램 관리) '
  '이미 지급된 금액은 바뀌지 않는다 — 아카이브/포인트 내역은 programs.points 가 아니라 이 값을 읽어야 한다. '
  '[원칙 1 가드] 랜덤·배수·연속 참여 보너스 같은 가산 규칙을 넣지 않는다. 정액 그대로다.';
comment on column public.point_transactions.related_participation_id is
  'unique 제약이 걸린 컬럼. on delete cascade 로 둔 이유: 시연 리셋(delete from participations)이 원장을 남기면 '
  '"참여는 없는데 적립 기록만 있는" 상태가 된다. 리셋 시 profiles.points_* 초기화도 함께 해야 한다(participations comment 참고).';

alter table public.point_transactions enable row level security;

-- [RLS 권한 경계] point_transactions_select_own   <<< ADR 0005 가 "마이페이지 스펙에서 열 자리" 로 예약해둔 정책
--   대상 역할: authenticated
--   허용 행: student_id = auth.uid() 인 행만 select
--   용도: 마이페이지 포인트 내역(적립/전환 시간순 50건) + 아카이브 활동 행의 포인트 표시(확정 L-1)
--   불가능: 다른 학생의 원장 조회(0행), 관리자의 조회(아래 참고), 어떤 역할의 insert/update/delete 도(정책 0개)
--
--   [컬럼 노출 범위 — 전부 열리고 그래도 안전하다] RLS 는 행 단위라 보이는 행의 모든 컬럼이 열린다.
--     student_id 는 언제나 본인이고, related_participation_id 는 반드시 본인의 참여를 가리킨다
--     (유일한 생성자인 verify_participation_qr 이 (v_p.student_id, ..., v_p.id) 를 같은 행에서 함께 꺼내 쓴다).
--     전환 행은 NULL 이다(CHECK). >>> 남에 대한 정보가 한 컬럼도 없으므로 컬럼 grant 로 좁힐 이유가 없다.
--
--   [관리자에게 열지 않는다 — 뒤집지 말 것] docs/specs/admin-students.md 결정 D 가 "관리자 아카이브에 포인트를
--     표시하지 않는다" 로 확정했고 그 근거가 "원장 테이블을 관리자에게 처음 여는 결정을 하지 않는다" 였다.
--     정책이 본인 축 하나뿐이므로 관리자가 조회하면 본인 행만 나오는데, 관리자에게는 적립 행이 존재할 수 없다
--     (participations_insert_own 의 not is_admin() 때문에 참여를 만들 수 없고, 적립은 참여에서만 나온다).
--     전환도 convert_points_to_currency() 가 관리자를 42501 로 막는다. >>> 결과적으로 항상 0행이다.
--
--   [쓰기는 여전히 0개] 적립은 verify_participation_qr(), 전환은 convert_points_to_currency() 안에서만 일어난다.
--     둘 다 security definer 라 정책 없이 쓴다.
create policy "point_transactions_select_own"
  on public.point_transactions
  for select
  to authenticated
  using (student_id = auth.uid());

-- [인덱스를 추가하지 않는다] 마이페이지 조회가 student_id 필터 + created_at 정렬 + limit 50 이라
--   인덱스를 부르고 싶어지지만, ADR 0003 주의 4 / 0004 주의 5 / 0006 결정 8 의 원칙 그대로다.
--   예외는 "제약의 부산물인 인덱스" 뿐인데(0005 결정 1-5) 이건 조회 성능이다. 데모 전체에서 수십 행이다.

-- =========================================================
-- 6. 함수 (security definer) — 앱 최초의 update 경로 / 관리자 쓰기 / 포인트 지급
--    ADR 0005 2·3번. 이 절은 이 파일에서 가장 조심해서 읽어야 하는 블록이다.
--
--    [왜 정책이 아니라 함수인가 — 요약]
--      1) RLS 는 컬럼 단위가 아니다. using 은 OLD, with check 는 NEW 만 보고 둘을 연결할 수단이 없어
--         "student_id 는 그대로, status 만 전이" 를 표현할 수 없다.
--      2) "유효한 토큰을 제시했을 때만" 이라는 조건은 정책 표현식에 인자를 넘길 수 없어 표현 불가능하다.
--      3) 포인트 지급은 남의 profiles 행을 수정한다. 정책으로 하려면 profiles 에 update 를 열어야 하는데,
--         그건 학생이 자기 포인트를 고치는 문을 함께 여는 것이다.
--      4) 상태 전이 + 원장 insert + 잔액 update 가 한 트랜잭션이어야 한다. 함수는 그 자체로 한 트랜잭션이다.
--      5) 거부 사유를 구분해 돌려줘야 한다. 정책은 403/0행밖에 못 준다.
--
--    [security definer 취급 주의 — 전부 지킬 것]
--      - set search_path = '' 로 고정한다. 검색 경로 하이재킹 방지. 사용자 객체는 전부 스키마 수식(public./auth.).
--        (pg_catalog 는 항상 암묵적으로 먼저 검색되므로 내장 함수는 수식하지 않아도 안전하다.)
--      - 정의자(소유자=postgres)로 실행되므로 이 함수들 안에서는 RLS 가 적용되지 않는다.
--        >>> 즉 함수 본문이 곧 권한 경계 전부다. 함수 안에서 호출자 신원을 직접 검사한다.
--      - execute 권한을 public 에서 회수하고 authenticated 에만 부여한다(기본값은 public 실행 허용이다).
--      - [중요] Supabase 에서 학생과 관리자는 같은 DB 역할(authenticated)이다. grant 로 역할을 구분할 수 없으므로
--        "관리자만" 은 반드시 함수 본문의 is_admin() 검사로 표현된다.
-- =========================================================

-- ---------------------------------------------------------
-- 6-1. qr_normalize_token() — 입력 정규화 (수동 입력 fallback 확정 D-1)
--
-- 카메라로 읽은 토큰과 사람이 손으로 친 토큰이 "같은 문자열"이 되게 만든다.
--   - 영숫자가 아닌 문자(공백·하이픈)를 전부 제거 -> 프런트가 읽기 좋게 "ABCDE FGHJK" 로 끊어 보여줘도 된다.
--   - 대문자화.
--   - Crockford 규칙대로 혼동 문자를 접는다: I, L -> 1 / O -> 0.
--     (생성 알파벳에 I/L/O/U 가 없으므로 이 접기는 오탈자만 구제하고 충돌을 만들지 않는다.)
-- ---------------------------------------------------------
create or replace function public.qr_normalize_token(p_input text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select translate(
           upper(regexp_replace(coalesce(p_input, ''), '[^0-9A-Za-z]', '', 'g')),
           'ILO', '110'
         );
$$;

comment on function public.qr_normalize_token(text) is
  'QR/수동 입력 토큰 정규화. 구분자 제거 + 대문자화 + Crockford 혼동 문자 접기(I,L->1 / O->0). '
  '수동 입력 fallback(확정 D-1)이 카메라와 완전히 동일한 검증 경로를 타게 만드는 장치다.';

revoke all on function public.qr_normalize_token(text) from public;
grant execute on function public.qr_normalize_token(text) to authenticated;

-- ---------------------------------------------------------
-- 6-2. qr_generate_token() — 토큰 생성 (내부 전용)
--
-- Crockford Base32(0-9 A-Z 에서 I, L, O, U 제외) 10자 = 명목상 50비트.
--   - 난수원은 gen_random_uuid()(v4, CSPRNG). pgcrypto 의 gen_random_bytes 를 쓰지 않는 이유:
--     Supabase 는 확장을 extensions 스키마에 설치하는데, search_path = '' 환경에서 그 위치가 환경마다 달라
--     깨질 수 있다. gen_random_uuid() 는 PG13+ 내장(pg_catalog)이라 항상 안전하다.
--   - uuid 32 hex 중 앞 20자(=10바이트)를 쓰고, 바이트마다 & 31 로 알파벳 인덱스를 만든다.
--     32 는 256 의 약수라 모듈로 편향이 없다.
--   - [정확히는 49비트다] uuid v4 는 7번째 바이트의 상위 니블이 버전값 '4' 로 고정돼 있어 그 한 글자만
--     32 가지가 아니라 16 가지다. 아래 위협 모델상 무해하므로 uuid 를 잘라 쓰는 단순함을 유지한다.
--   - [위협 모델] 스펙 이슈 3: 토큰 추측은 위협이 아니다(검증 RPC 는 관리자만 호출할 수 있고 관리자는 이미
--     인증 권한자다). 이 비트 수는 우발적 충돌 방지가 목적이지 무차별 대입 방어가 목적이 아니다.
-- ---------------------------------------------------------
create or replace function public.qr_generate_token()
returns text
language plpgsql
volatile
security invoker
set search_path = ''
as $$
declare
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; -- 32문자. I, L, O, U 제외.
  v_hex text;
  v_out text := '';
  i     integer;
begin
  v_hex := replace(gen_random_uuid()::text, '-', '');
  for i in 0..9 loop
    v_out := v_out || substr(v_alphabet, 1 + (('x' || substr(v_hex, i * 2 + 1, 2))::bit(8)::integer & 31), 1);
  end loop;
  return v_out;
end;
$$;

comment on function public.qr_generate_token() is
  'QR 1회용 토큰 생성(Crockford Base32 10자). 내부 전용 — 클라이언트에서 호출할 일이 없으므로 execute 를 아무에게도 주지 않는다. '
  '토큰을 클라이언트가 만들면 학생이 자기가 아는 값을 심을 수 있고, 그것은 ADR 0004 가 entry_token is null 로 막아둔 공격과 같다.';

revoke all on function public.qr_generate_token() from public;
-- grant 없음: security definer 함수(issue_participation_qr) 안에서 소유자 권한으로만 호출된다.

-- ---------------------------------------------------------
-- 6-3. issue_participation_qr() — 학생 본인의 입장/퇴장 토큰 발급
--
-- [RPC 권한 경계] issue_participation_qr(p_participation_id uuid, p_type text)
--   호출 가능: authenticated (본문에서 "본인 참여 건" 인지 다시 검사한다)
--   허용 대상: participations.student_id = auth.uid() 인 행만
--   쓰는 컬럼: entry_token + entry_token_expires_at  또는  exit_token + exit_token_expires_at  둘 중 하나뿐.
--   >>> status / entry_at / exit_at / student_id 를 절대 쓰지 않는다. 즉 학생이 이 함수를 아무리 호출해도
--       참여 상태는 1mm 도 진행되지 않는다. 상태 전이는 관리자 스캔(6-5)에서만 일어난다.
--   불가능: 남의 참여 건 토큰 발급(42501), 없는 id 존재 여부 탐지(같은 42501 로 구분 불가하게 처리),
--           completed 건 재발급, 상태에 맞지 않는 타입 발급(입장 전 퇴장 토큰)
--
-- [재발급 정책] 호출할 때마다 새 토큰으로 덮어쓴다(= 이전 토큰 즉시 무효, 만료 30분 재시작).
--   "다시 발급받기" 버튼과 목록의 QR 버튼이 같은 동작이라 분기가 없다. 이전 토큰은 어느 행과도 매칭되지 않아
--   not_found 로 거부된다(만료와 다른 사유로 뜨는데, 어차피 학생이 방금 새로 받은 상태라 혼동이 없다).
-- ---------------------------------------------------------
create or replace function public.issue_participation_qr(p_participation_id uuid, p_type text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_p       public.participations%rowtype;
  v_token   text;
  v_expires timestamptz;
  v_try     integer := 0;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;

  if p_type is null or p_type not in ('entry', 'exit') then
    raise exception '토큰 종류는 entry 또는 exit 여야 합니다.' using errcode = '22023';
  end if;

  -- 본인 행만. for update 로 잠가 동시 발급 요청을 직렬화한다.
  -- [존재 여부를 노출하지 않는다] "없는 id" 와 "남의 id" 를 같은 예외로 처리한다.
  select * into v_p
    from public.participations
   where id = p_participation_id
     and student_id = v_student
   for update;

  if not found then
    raise exception '본인의 참여 건이 아닙니다.' using errcode = '42501';
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;
  if p_type = 'entry' and v_p.status <> 'applied' then
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if p_type = 'exit' and v_p.status <> 'entered' then
    -- 입장 인증 없이 퇴장 토큰을 만들려는 시도. 화면에서도 버튼이 안 뜨지만 서버가 다시 막는다.
    return jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;

  -- 컬럼 간 충돌까지 막는다(unique 제약은 컬럼 안에서만 유일성을 보장한다).
  loop
    v_try := v_try + 1;
    v_token := public.qr_generate_token();
    exit when not exists (
      select 1 from public.participations
       where entry_token = v_token or exit_token = v_token
    );
    if v_try >= 5 then
      raise exception '토큰 생성에 실패했습니다.' using errcode = '55000';
    end if;
  end loop;

  v_expires := now() + interval '30 minutes'; -- CLAUDE.md 6장. now() 는 트랜잭션 시작 시각.

  if p_type = 'entry' then
    update public.participations
       set entry_token = v_token, entry_token_expires_at = v_expires
     where id = v_p.id;
  else
    update public.participations
       set exit_token = v_token, exit_token_expires_at = v_expires
     where id = v_p.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'participation_id', v_p.id,
    'type', p_type,
    'token', v_token,
    'expires_at', v_expires
  );
end;
$$;

comment on function public.issue_participation_qr(uuid, text) is
  '학생 본인의 QR 토큰 발급(30분 만료, 호출마다 재발급). 반환 jsonb 로 프런트가 QR payload '
  '{participation_id, type, expires_at, token} 을 만든다(CLAUDE.md 6장). '
  '이 함수는 status/entry_at/exit_at 을 쓰지 않는다 — 학생이 스스로 참여를 진행시킬 수 있는 경로가 없다는 뜻이다.';

revoke all on function public.issue_participation_qr(uuid, text) from public;
grant execute on function public.issue_participation_qr(uuid, text) to authenticated;

-- ---------------------------------------------------------
-- 6-4. verify_participation_qr() — 관리자 스캔: 토큰 검증 + 상태 전이 + 포인트 지급
--
-- [RPC 권한 경계] verify_participation_qr(p_token text)
--   호출 가능: authenticated 이면서 본문의 is_admin() 검사를 통과한 호출자만. 학생이 호출하면 42501/403.
--   허용 대상: 토큰이 가리키는 참여 건의 programs.created_by = auth.uid() 인 경우만 (확정 H-1).
--             created_by 가 NULL 이면 거부(fail-closed).
--   쓰는 컬럼: participations.status/entry_at 또는 status/exit_at + point_transactions 1행 + profiles.points_*.
--   >>> student_id / program_id / 토큰 컬럼을 절대 쓰지 않는다. 관리자가 참여 건의 주인을 바꿀 수 있는
--       경로는 앱 어디에도 없다 — 정책이 아니라 "이 update 문의 SET 목록"이 그 경계다.
--   불가능: 남의 프로그램 참여 건 인증(not_authorized), 만료/재사용 토큰 통과, 순서 뒤집기,
--           이중 지급(participations CAS + point_transactions unique 이중 방어),
--           목록 조회(이 함수는 스캔한 그 한 건만 돌려준다 — 관리자에게 participations select 를 열지 않는 이유)
--
-- [입장/퇴장을 한 함수로 합친 이유] 카메라는 어떤 종류의 QR 이 들어올지 미리 알 수 없다. 토큰 자체가
--   종류를 결정해야 하므로 분리하면 프런트가 payload 의 type 을 믿고 함수를 골라야 하는데, 그건 검증 판정을
--   위조 가능한 payload 에 의존시키는 것이다.
--
-- [반환 jsonb]
--   { ok, reason, type, student_name, program_title, points_awarded, at }
--   - 실패 시 reason: expired | used | not_found | wrong_order | already_completed | not_authorized
--   - [정보 노출 검토] not_found / not_authorized 에는 학생·프로그램 정보를 일절 싣지 않는다.
--     나머지 사유는 "본인이 만든 프로그램" 이라는 확인을 통과한 뒤에만 도달하므로 이름/프로그램명을 함께 준다
--     (관리자가 학생에게 "다시 발급해 주세요" 라고 말할 수 있어야 한다 — 스펙 요구사항).
--   - not_authorized 가 "유효한 토큰이 존재한다" 는 사실을 알려주긴 하지만, 호출자는 이미 인증된 관리자이고
--     그 사실만으로는 누구의 무엇인지 알 수 없다. 사유 구분(스펙 필수)을 포기할 만한 이득이 없다.
-- ---------------------------------------------------------
create or replace function public.verify_participation_qr(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin   uuid := auth.uid();
  v_token   text;
  v_kind    text;
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
  v_name    text;
  v_base    jsonb;
  v_rows    integer;
  v_points  integer;
  v_now     timestamptz := now();
begin
  -- (1) 호출자 신원. 정책이 아니라 여기가 "관리자 전용" 의 유일한 표현이다(학생/관리자가 같은 DB 역할이므로).
  if v_admin is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception '관리자만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  v_token := public.qr_normalize_token(p_token);
  if length(v_token) <> 10 then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- (2) 토큰 -> 참여 행. entry_token 을 먼저 보고, 없으면 exit_token.
  --     for update 로 잠근다: 동시 스캔 2건 중 하나만 전이에 성공하고, 다른 하나는 잠금 해제 후
  --     갱신된 status 를 다시 읽어 used/already_completed 로 떨어진다.
  select * into v_p from public.participations where entry_token = v_token for update;
  if found then
    v_kind := 'entry';
  else
    select * into v_p from public.participations where exit_token = v_token for update;
    if found then
      v_kind := 'exit';
    end if;
  end if;

  if v_kind is null then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- (3) 확정 H-1: 본인이 올린 프로그램의 참여 건만. created_by 가 NULL 이면 거부(fail-closed).
  select * into v_prog from public.programs where id = v_p.program_id;
  if not found or v_prog.created_by is null or v_prog.created_by <> v_admin then
    return jsonb_build_object('ok', false, 'reason', 'not_authorized');
  end if;

  -- 여기서부터는 "본인 프로그램" 이 확인된 뒤라 학생/프로그램 정보를 실어도 된다.
  select p.name into v_name from public.profiles p where p.id = v_p.student_id;
  v_base := jsonb_build_object('type', v_kind, 'student_name', v_name, 'program_title', v_prog.title);

  if v_p.status = 'completed' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end if;

  if v_kind = 'entry' then
    -- 입장 토큰은 status=applied 일 때만 소비된다. 이미 entered 면 그 토큰은 쓰인 것이다.
    if v_p.status <> 'applied' then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;
    if v_p.entry_token_expires_at is null or v_p.entry_token_expires_at <= v_now then
      return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
    end if;

    update public.participations
       set status = 'entered', entry_at = v_now
     where id = v_p.id
       and status = 'applied';          -- CAS: 동시 스캔에서 한 번만 성공한다
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'used');
    end if;

    return v_base || jsonb_build_object('ok', true, 'reason', null, 'at', v_now);
  end if;

  -- v_kind = 'exit'
  if v_p.status = 'applied' then
    return v_base || jsonb_build_object('ok', false, 'reason', 'wrong_order');
  end if;
  if v_p.exit_token_expires_at is null or v_p.exit_token_expires_at <= v_now then
    return v_base || jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- [지급액은 서버가 DB 에서 읽는다] 클라이언트가 보낸 값을 쓰지 않는다. 이 값이 원장에 스냅샷으로 남는다.
  v_points := v_prog.points;

  -- [상태 전이 + 원장 + 잔액 = 한 트랜잭션]
  --   중간 실패 시 서브트랜잭션 전체가 롤백되므로 "포인트만 오르고 completed 가 안 되는" 상태가 생기지 않는다.
  begin
    update public.participations
       set status = 'completed', exit_at = v_now
     where id = v_p.id
       and status = 'entered';          -- CAS
    get diagnostics v_rows = row_count;
    if v_rows <> 1 then
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
    end if;

    -- 2차 방어선. 위 CAS 를 어떤 이유로든 통과했더라도 한 참여당 적립은 1건뿐이다(unique).
    insert into public.point_transactions (student_id, type, amount, related_participation_id)
    values (v_p.student_id, '적립', v_points, v_p.id);

    update public.profiles
       set points_balance = points_balance + v_points,
           points_total   = points_total   + v_points
     where id = v_p.student_id;
  exception
    when unique_violation then
      -- 이미 적립된 참여. 이 블록의 상태 전이까지 함께 롤백되고 포인트는 늘지 않는다.
      return v_base || jsonb_build_object('ok', false, 'reason', 'already_completed');
  end;

  return v_base || jsonb_build_object('ok', true, 'reason', null, 'points_awarded', v_points, 'at', v_now);
end;
$$;

comment on function public.verify_participation_qr(text) is
  '관리자 QR 스캔 검증. 성공 시 입장(status=entered) 또는 퇴장(status=completed + 포인트 지급)을 한 트랜잭션으로 처리한다. '
  '카메라 스캔과 수동 코드 입력(확정 D-1)이 모두 이 함수 하나를 호출한다 — 입력 수단만 다르고 검증은 동일하다(원칙 5 훼손 아님). '
  '관리자에게 participations/profiles select 정책을 열지 않는 대신, 방금 스캔한 한 건의 학생 이름과 프로그램명을 반환값으로만 준다.';

revoke all on function public.verify_participation_qr(text) from public;
grant execute on function public.verify_participation_qr(text) to authenticated;

-- =========================================================
-- 7. 관리자 권한 경계 정책 (ADR 0005 확정 G-3 — 관리자 기능 3종)
--
--    [행 경계는 두 축뿐이다. 새 축을 만들지 말 것]
--      축 A) programs.created_by = auth.uid()          -> 프로그램 관리 + QR 스캔(H-1). "내가 운영하는 프로그램"
--      축 B) mentor_students(admin_id = auth.uid())    -> 담당 학생 아카이브. "내가 멘토링하는 학생"
--    두 축은 목적이 다르다(운영 vs 멘토링). 한쪽 축을 다른 쪽 기능에 쓰지 않는다.
--
--    [delete 를 어느 테이블에도 열지 않는다]
--      CLAUDE.md 10장의 관리자 기능은 "올리기/내리기/수정" 이고 내리기는 is_published=false 토글이지 삭제가 아니다.
--      programs delete 를 열면 on delete cascade 로 학생의 participations 와 point_transactions 까지 사라지는데,
--      profiles.points_* 는 그대로 남아 잔액과 원장이 어긋난다. 삭제는 시연 리셋(service_role) 전용으로 둔다.
-- =========================================================

-- ---------------------------------------------------------
-- 7-1. 프로그램 관리 (축 A)
-- ---------------------------------------------------------

-- [RLS 권한 경계] programs_select_own_as_admin
--   대상 역할: authenticated
--   허용 행: created_by = auth.uid() 인 행 (게시 여부 무관)
--   효과: 관리자는 "게시된 전부(programs_select_published) + 본인이 만든 미게시" 를 본다. 정책은 OR 로 합쳐진다.
--   불가능: 다른 관리자가 만든 미게시 행 조회. created_by 가 NULL 인 미게시 행 조회(NULL = auth.uid() 는 참이 아니다).
--   [ADR 0004 가 예고한 함정 재검토 결과] 이 정책 때문에 participations_insert_own 의 서브쿼리가 관리자에게
--   자기 미게시 프로그램을 보여주게 되지만, 그 서브쿼리에 p.is_published = true 가 명시돼 있어 결과는 여전히 거부다.
--   그 명시가 없었다면 관리자가 자기 미게시 프로그램에 자기 이름으로 신청할 수 있었다.
create policy "programs_select_own_as_admin"
  on public.programs
  for select
  to authenticated
  using (created_by = auth.uid());

-- [RLS 권한 경계] programs_insert_own_as_admin
--   대상 역할: authenticated + is_admin()
--   허용 행: created_by = auth.uid() 인 행만
--   불가능: 학생의 프로그램 등록(is_admin() 이 막는다 — 이 절이 없으면 학생이 created_by=본인 으로 프로그램을
--           만들 수 있고, 그러면 자기 프로그램에 자기가 신청하고 자기 QR 을 자기가 인증하는 폐루프가 생긴다),
--           남의 이름으로 등록(created_by 위조), created_by 를 NULL 로 둔 등록(고아 프로그램 = 아무도 스캔 못 함)
--   [points 규칙] 150~3000, 끝자리 0 은 테이블 CHECK(programs_points_rule)가 담당한다. 정책에 중복해 넣지 않는다.
create policy "programs_insert_own_as_admin"
  on public.programs
  for insert
  to authenticated
  with check (public.is_admin() and created_by = auth.uid());

-- [RLS 권한 경계] programs_update_own_as_admin
--   대상 역할: authenticated + is_admin()
--   허용 행: created_by = auth.uid() 인 행. 수정 후에도 created_by = auth.uid() 여야 한다(with check).
--   용도: 올리기/내리기(is_published 토글) + 내용 수정
--   불가능: 남의 프로그램 수정, 소유권 이전(created_by 를 남에게 넘기거나 NULL 로 만들기 — with check 가 막는다)
--   [수용하는 것 — RLS 는 컬럼 단위가 아니다] 관리자는 본인 프로그램의 모든 컬럼을 바꿀 수 있다(points 포함).
--     이것이 부정 적립 경로가 되지 않는 이유:
--       (a) 지급액은 지급 시점의 값이 point_transactions.amount 에 스냅샷으로 남는다. 나중에 points 를 올려도
--           이미 지급된 금액은 변하지 않는다.
--       (b) 관리자는 participations 를 만들 수 없다(insert 정책이 student_id = auth.uid() 를 요구한다).
--           즉 "포인트 3000P 짜리 프로그램을 만들고 스스로 참여를 꽂아 완료 처리" 하는 폐루프가 성립하지 않는다.
--           관리자가 학생 계정으로 신청하는 것은 가능하지만 그건 학생 계정의 권한이고, 그때도 QR 2회 인증이 필요하다.
--       (c) points 상한 3000P 는 테이블 CHECK 가 막는다.
create policy "programs_update_own_as_admin"
  on public.programs
  for update
  to authenticated
  using      (public.is_admin() and created_by = auth.uid())
  with check (public.is_admin() and created_by = auth.uid());

-- [RLS 권한 경계] programs delete 정책 없음 = 전체 거부 (위 7번 절 상단 근거 참고).

-- ---------------------------------------------------------
-- 7-2. 담당 학생 아카이브 (축 B) — "남의 profiles 를 볼 수 있는 최초의 경로"
-- ---------------------------------------------------------

-- [RLS 권한 경계] mentor_students_select_own_as_admin
--   대상 역할: authenticated
--   허용 행: admin_id = auth.uid() 인 행 (= 내가 담당하는 학생 매핑)
--   불가능: 학생이 "내 멘토가 누구인지" 조회(student_id 축 정책 없음), 다른 관리자의 담당 목록 조회
--   [이 정책에 profiles 조인을 넣지 말 것] 아래 profiles 정책이 이 테이블을 참조하므로, 여기서 profiles 를
--   참조하면 두 정책이 서로를 부르는 순환이 된다. 관리자 여부 검사는 아래 profiles/participations 정책의
--   is_admin()(security definer, RLS 우회)이 담당한다.
create policy "mentor_students_select_own_as_admin"
  on public.mentor_students
  for select
  to authenticated
  using (admin_id = auth.uid());

-- [RLS 권한 경계] profiles_select_mentored_students_as_admin   <<< 이 파일에서 가장 조심할 select 정책
--   대상 역할: authenticated + is_admin()
--   허용 행: mentor_students 에 (admin_id = 나, student_id = 그 행) 매핑이 있는 profiles 행 (데모 기준 5명)
--   용도: 담당 학생 아카이브의 이름·학번 표시 (CLAUDE.md 10장)
--   불가능: 학생이 다른 학생의 profiles 조회(is_admin() 이 즉시 거짓),
--           관리자 A 가 관리자 B 의 담당 학생 조회(admin_id 축),
--           담당이 아닌 학생 조회, 다른 관리자의 profiles 조회
--   [수용하는 것 — RLS 는 컬럼 단위가 아니다] 이 정책은 담당 학생 행의 모든 컬럼(points_balance 포함)을 연다.
--     컬럼 단위 grant 로 좁힐 수 없다: Supabase 에서 학생과 관리자가 같은 DB 역할(authenticated)이라
--     컬럼 grant 를 걸면 학생 본인 조회까지 함께 막힌다. 좁히려면 아카이브 전체를 definer RPC 로 옮겨야 하는데,
--     "조회는 RLS, 쓰기는 RPC" 라는 이 프로젝트의 구조를 아카이브 하나 때문에 깨는 비용이 더 크다고 판단했다.
--     >>> [원칙 1 가드 — frontend 필수] 담당 학생들의 포인트를 나란히 놓고 비교/정렬/순위로 렌더하지 말 것.
--         아카이브는 학생 1명 단위의 활동 기록 화면이다.
--   [재귀 없음] is_admin() 은 security definer 라 profiles 의 RLS 를 타지 않는다. 이 함수 없이 정책 안에서
--     profiles 를 직접 select 하면 Postgres 가 정책 재귀 에러를 낸다.
create policy "profiles_select_mentored_students_as_admin"
  on public.profiles
  for select
  to authenticated
  using (
    public.is_admin()
    and exists (
      select 1
      from public.mentor_students ms
      where ms.admin_id = auth.uid()
        and ms.student_id = profiles.id
    )
  );

-- [RLS 권한 경계] participations_select_mentored_as_admin
--   대상 역할: authenticated + is_admin()
--   허용 행: 담당 학생(축 B)의 행이면서 status = 'completed' 인 행만
--   용도: 담당 학생 아카이브 = 완료한 활동 목록
--   불가능: 담당이 아닌 학생의 참여 조회, 담당 학생의 미완료(applied/entered) 참여 조회,
--           전교생 참여 목록/집계 조회
--   [status = 'completed' 를 정책에 넣는 이유 — UX 규칙이 아니라 노출 범위 결정이다]
--     "무엇을 신청했다가 안 갔는가" 는 아카이브가 보여줄 정보가 아니라 학생의 사생활에 가깝다.
--     아카이브 화면이 어떤 필터를 걸든 DB 가 완료분 외에는 내려주지 않는 편이 경계가 명확하다.
--     ADR 0004 가 "권한 경계는 DB, 신청 가능 여부는 프런트" 로 그은 선의 DB 쪽에 해당한다.
--   [원칙 1 가드가 여전히 구조로 성립한다] 관리자가 볼 수 있는 참여는 담당 5명의 완료분뿐이라,
--     프로그램별 참여자 수·출석률·전교생 랭킹은 애초에 데이터를 얻을 수 없다.
create policy "participations_select_mentored_as_admin"
  on public.participations
  for select
  to authenticated
  using (
    public.is_admin()
    and status = 'completed'
    and exists (
      select 1
      from public.mentor_students ms
      where ms.admin_id = auth.uid()
        and ms.student_id = participations.student_id
    )
  );

-- [PDF 확인 — 새 권한 0개]
--   담당 학생 아카이브 PDF 는 위 정책들로 이미 조회한 데이터를 클라이언트에서 렌더/인쇄한다.
--   서버 렌더가 필요하다는 결론이 나오면 그것은 service_role 을 쓰겠다는 뜻이므로 RLS 밖으로 나가는 설계다 — 금지.

-- =========================================================
-- 8. reviews (ADR 0007 — CLAUDE.md 5장 / 6장 3번 "퇴장 인증 완료 시 만족도 평가")
--
--    [여기(7번 절 뒤)에 두는 이유] 아래 정책 3개가 public.participations 를 참조하므로 그 테이블이 먼저
--    존재해야 한다. 4번 절 바로 뒤에 두지 않은 것은 참여/정원/원장 블록을 쪼개지 않기 위해서다.
--
--    [권한 구조 한눈에]
--      select : 본인 참여의 리뷰만. 관리자도 다른 학생도 0행.
--      insert : 완료된(status='completed') 본인 참여에만. 컬럼 grant (participation_id, rating, comment).
--      update : 같은 경계 + 컬럼 grant (rating, comment) — participation_id 를 옮길 수 없다.
--      delete : 정책 0개. 삭제 경로를 만들지 않는다(수정으로 갈음 — 스펙 결정 D-4).
--
--    [왜 정책이고 RPC 가 아닌가] ADR 0005 결정 2-2 의 5가지 사유 중 해당하는 것이 0개다:
--      컬럼 경계는 컬럼 grant 가 2차로 봉인하고, 정책 표현식에 넘길 인자가 없고(participation_id 는 삽입될
--      행 안에 있다), 남의 행을 수정하지 않고, 쓰기가 1행이라 원자성 요구가 없고, 거부 사유가 하나다.
--      = "RLS 로 표현할 수 없는 쓰기만 RPC"(ADR 0006 결정 1-3(a)) 기준에서 이건 RLS 쪽이다.
--
--    [부작용 0] 리뷰 저장이 participations / point_transactions / profiles 를 건드리지 않는다.
--      트리거를 만들지 않았고, participations 의 update 정책은 여전히 0개다. 평가를 남겨도 포인트가 늘지 않는다.
--
--    [participations 에 컬럼을 추가하지 않은 이득] ADR 0005 는 "participations 에 컬럼이 추가되면 또
--      participations_insert_own 을 재검토해야 한다" 고 경고했다. 별도 테이블이라 그 재검토가 아예 발생하지 않는다.
-- =========================================================
create table if not exists public.reviews (
  id                uuid primary key default gen_random_uuid(),
  participation_id  uuid not null references public.participations(id) on delete cascade,
  rating            integer not null,
  comment           text,
  created_at        timestamptz not null default now(),

  -- [1참여 1리뷰] 같은 활동에 리뷰가 2행 생길 수 없다. 아카이브가 "어느 것을 표시할지" 를 고민할 자리를 없앤다.
  --   위반 시 23505 -> 409. 프런트는 이것을 에러가 아니라 "수정 경로로 전환" 신호로 다룬다.
  --   [인덱스 예외] 이 unique 가 만드는 인덱스가 이번 변경에서 유일하게 추가되는 인덱스다
  --   ("제약의 부산물" 예외 — ADR 0005 결정 1-5). 조회용 인덱스는 하나도 만들지 않는다.
  constraint reviews_participation_unique unique (participation_id),

  -- 별점 1~5 정수(스펙 D-3). 범위 밖은 DB 가 거부한다(23514). 프런트 검증은 우회 가능하다.
  constraint reviews_rating_range check (rating between 1 and 5),

  -- 한줄평은 선택이고 60자 상한(프로토타입 maxlength=60). 프런트 maxlength 는 우회 가능하므로 DB 에도 건다.
  --   빈 문자열은 막지 않는다 — 프런트가 빈 값을 null 로 보내는 규율을 진다(''을 23514 로 튕기면
  --   정상 UI 에서 발생하는 오류가 생긴다).
  constraint reviews_comment_length check (comment is null or char_length(comment) <= 60)
);

comment on table public.reviews is
  '활동 만족도 평가(별점 + 한줄평). CLAUDE.md 5장 필드 + created_at. 6장 3번("퇴장 인증 완료 시 자동 노출")의 구현체다. '
  '[원칙 1 가드가 UI 규율이 아니라 RLS 구조다] 본인만 읽으므로 평균 별점/리뷰 수/인기 정렬/평가 완료율을 '
  '만들려 해도 데이터를 얻을 수 없다. CLAUDE.md 2장 1번이 "별점 리뷰" 를 허용하되 집계되어 순위가 되는 순간 '
  '위반이 되므로, 그 경로를 정책으로 차단한다. '
  '[updated_at 을 두지 않는다] 수정은 허용하지만 화면 어디에도 "수정됨" 표시가 없다. 쓰이지 않는 컬럼을 만들지 않는다. '
  '[student_id 를 비정규화하지 않는다] 소유자는 participation_id 로 유일하게 결정된다. 컬럼을 두면 '
  'participations.student_id 와 어긋날 자리가 생기고 정합용 트리거가 또 필요해진다.';
comment on column public.reviews.participation_id is
  '리뷰 대상 참여. unique 라 한 참여당 최대 1행이다. on delete cascade 로 둔 이유: 시연 리셋'
  '(delete from participations)이 리뷰를 남기면 "참여는 없는데 평가만 있는" 상태가 된다'
  '(point_transactions.related_participation_id 전례 그대로). '
  '[이 컬럼은 update 컬럼 grant 에 없다] = 리뷰를 다른 참여로 옮기는 문장 자체를 쓸 수 없다(아래 grant 블록).';
comment on column public.reviews.rating is
  '별점 1~5 (필수). 표시 라벨 5종("별로였어요"~"최고였어요!")과 별 색(amber)은 프런트가 소유한다. '
  '[원칙 4 위반이 아닌 이유] 별점은 포인트 표시가 아니고 CLAUDE.md 2장 1번이 명시적으로 허용한 요소다.';

alter table public.reviews enable row level security;

-- [RLS 권한 경계] reviews_select_own
--   대상 역할: authenticated
--   허용 행: 본인 참여(participations.student_id = auth.uid())의 리뷰만
--   불가능: 다른 학생의 리뷰 조회, 관리자의 조회(담당 학생 것 포함), 프로그램 단위 집계
--
--   [★ p.student_id = auth.uid() 를 "RLS 가 어차피 막아준다" 며 지우지 말 것 — 이 파일에서 가장 위험한 지점]
--     정책 표현식 안의 서브쿼리는 질의자 권한으로 평가되므로 participations 의 RLS 를 탄다. 그런데 관리자에게는
--     participations_select_mentored_as_admin(담당 5명의 completed)이 열려 있다. 따라서
--       exists (select 1 from public.participations p where p.id = reviews.participation_id)
--     로 단순화하는 순간 >>> 관리자가 담당 학생 5명의 리뷰를 전부 읽는다. 스펙 결정 E("본인만 읽는다")가 무너진다.
--     ADR 0005 결정 6-3 이 p.is_published = true 에서 이미 한 번 확인한 함정과 같은 계열이며, 처방도 같다 —
--     경계를 명시적으로 다시 건다.
--
--   [select 에는 status='completed' 를 넣지 않는다] 상태 전이가 단방향(applied->entered->completed)이라
--     리뷰가 존재한다는 것은 이미 완료됐다는 뜻이다. 조건을 늘리면 미래에 "리뷰가 안 보이는" 경로만 늘어난다.
--
--   [정책 재귀 없음] 참조 방향이 reviews -> participations -> {programs, mentor_students} 로 단방향이다.
--     >>> participations 쪽 정책에서 reviews 를 참조하지 말 것. 그 순간 순환이 된다(ADR 0005 결정 7-2(a) 규율).
create policy "reviews_select_own"
  on public.reviews
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()
    )
  );

-- [RLS 권한 경계] reviews_insert_own
--   대상 역할: authenticated
--   허용 행: participation_id 가 (a) 본인 참여이고 (b) status = 'completed' 인 경우만
--   불가능: 남의 참여에 작성(42501), 미완료(applied/entered) 참여에 작성(42501),
--           같은 참여에 2행(23505 — unique 가 담당), id/created_at 지정(컬럼 grant 가 담당)
--   [게시중단된 프로그램의 완료 건에도 평가할 수 있다] 경계가 participations 이지 programs 가 아니고,
--     participations_select_own 에 is_published 조건이 없다. 스펙 "방어적 렌더" 요구와 일치한다.
create policy "reviews_insert_own"
  on public.reviews
  for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()
        and p.status = 'completed'
    )
  );

-- [RLS 권한 경계] reviews_update_own
--   대상 역할: authenticated
--   허용 행: using(OLD) / with check(NEW) 양쪽이 같은 조건 — 본인의 completed 참여
--   불가능: 남의 리뷰 수정, 남의 참여로 participation_id 이동(with check + 컬럼 grant 2중)
--   [양쪽에 다 거는 이유] using 만 걸면 "남의 참여로 옮기는" NEW 를 검사하지 못한다
--     (programs_update_own_as_admin 이 소유권 이전을 막은 것과 같은 규율).
--     본인의 "다른" 완료 참여로 옮기는 것은 with check 로 막을 수 없는데(RLS 는 OLD/NEW 를 연결할 수단이 없다),
--     그건 아래 컬럼 grant 가 문장 층에서 막는다.
--   [프런트 주의] .update() 는 0행이어도 error === null 이다. 반드시 .select() 로 영향 행을 확인할 것.
create policy "reviews_update_own"
  on public.reviews
  for update
  to authenticated
  using (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()
        and p.status = 'completed'
    )
  )
  with check (
    exists (
      select 1
      from public.participations p
      where p.id = reviews.participation_id
        and p.student_id = auth.uid()
        and p.status = 'completed'
    )
  );

-- [RLS 권한 경계] delete 정책 없음 = 전체 거부. 삭제 경로를 만들지 않는다(수정으로 갈음).
--   delete grant 는 건드리지 않는다 — 정책 0개가 경계다(participations 전례).

-- [권한 경계] 컬럼 단위 insert/update grant — ADR 0005 결정 6-2 의 규율을 새 테이블에도 적용한다.
--   효과 1: update 목록에 participation_id 가 없으므로 "리뷰를 다른 참여로 옮기는" 문장 자체를 쓸 수 없다.
--           RLS 만으로는 여기까지 못 간다(with check 는 NEW 만 보므로 "본인의 다른 완료 참여로 이동" 을 못 막는다).
--           before update 트리거로도 가능하지만 컬럼 grant 가 함수 0개로 같은 결과를 낸다.
--   효과 2: insert 목록에 id / created_at 이 없으므로 위조가 처음부터 닫혀 있다. 앞으로 컬럼이 늘어도 fail-closed.
--   주의:  위반도 42501/403 이라 정책 위반과 구분되지 않는다. 프런트는 위 목록 외 어떤 컬럼도 보내지 않는다.
--   [여기서는 컬럼 grant 를 쓰고 profiles 에서는 쓰지 않는 이유] 여기서는 정책 3개가 이미 행 경계를 완전히
--   표현하고 grant 는 그 위에 얹는 2차 방어다. profiles 에서는 grant 가 유일한 1차 경계가 되어 fail-open 이다
--   (1번 절 하단 블록 참고). >>> 규율: 컬럼 grant 는 2차 방어로만 쓴다.
revoke insert, update on public.reviews from authenticated;
revoke insert, update on public.reviews from anon;
grant  insert (participation_id, rating, comment) on public.reviews to authenticated;
grant  update (rating, comment)                   on public.reviews to authenticated;

-- =========================================================
-- 9. 마이페이지 RPC 2개 (ADR 0007 — security definer)
--
--    [profiles 를 쓰는 두 번째·세 번째 경로다. 그래도 update 정책은 0개다]
--    ADR 0005 결정 3-4 의 못은 "함수가 하나뿐" 이 아니라 "정책이 0개" 에 박혀 있다. 함수가 셋이 되어도
--    학생이 자기 잔액을 손으로 고칠 경로는 존재하지 않는다. 각 함수는 UPDATE SET 목록에 자기 컬럼만 적는다
--    (ADR 0005 결정 2-3 과 같은 형태의 경계 — 정책이 아니라 SQL 문장이 컬럼 경계다).
--
--    [두 함수를 합치지 않는다] 권한 표면이 다르다. 합치면 계열 저장 호출이 잔액 로직을 지나간다.
--
--    [6번 절의 security definer 취급 5원칙을 그대로 적용한다]
--      set search_path = '' / 객체 전부 스키마 수식 / 함수 본문이 곧 권한 경계 / revoke all from public 후
--      grant execute to authenticated / 권한 실패는 예외(42501), 도메인 실패는 반환값.
-- =========================================================

-- ---------------------------------------------------------
-- 9-1. convert_points_to_currency() — 포인트 -> 지역화폐 전환 (절대 원칙 3: 시뮬레이션)
--
-- [RPC 권한 경계] convert_points_to_currency(p_amount integer)
--   호출 가능: authenticated. 본문에서 (a) 로그인 여부 (b) 관리자가 아님 을 검사한다.
--   허용 대상: auth.uid() 본인 행뿐. 함수가 student_id 를 인자로 받지 않는다 = 남의 잔액을 전환할 경로가 없다.
--   쓰는 컬럼: profiles.points_balance / currency_balance + point_transactions 1행.
--   >>> points_total / role / code / name / career_interest 를 절대 쓰지 않는다. 누적은 영구 기록이다.
--   불가능: 잔액 초과 전환(도메인 실패), 음수/단위 위반 금액(22023), 관리자 호출(42501), 남의 잔액 전환(경로 없음)
--
-- [반환]
--   성공: { ok:true, amount, points_balance, points_total, currency_balance, at }
--   실패: { ok:false, reason:'insufficient_balance', points_balance, points_total, currency_balance }
--   >>> 갱신된 잔액을 함께 싣는 이유: 프런트가 profiles 를 재조회하는 왕복을 없애고(AuthContext 갱신),
--       실패 시에도 화면의 잔액을 최신값으로 맞출 수 있다(두 탭 시나리오).
--   >>> 잔액 부족은 42501 이 아니다. 권한 오류와 화면 문구가 반드시 달라야 한다(ADR 0005 결정 4 규율).
--
-- [★ 금액 검증은 UX 가 아니라 보안 경계다 — 절대 생략하지 말 것]
--   p_amount 가 음수면 points_balance - (-N) = 증가이고 where 절의 >= 도 언제나 참이다.
--   = 학생이 RPC 한 번으로 포인트를 찍어낸다. 절대 원칙 3 이 통째로 무너진다.
--   2차 방어가 이미 DB 에 있다: 아래 원장 insert 가 point_transactions_amount_positive(amount > 0)에 걸려
--   23514 로 튕기고, 같은 트랜잭션인 잔액 update 까지 함께 롤백된다.
--   >>> 그래서 원장 insert 를 잔액 update "뒤" 에 둔다. 순서를 바꾸면 이 2차 방어가 사라진다.
--   3차 방어: profiles_balances_non_negative CHECK(1번 절).
--
-- [동시성 / 음수 방지 = 조건부 UPDATE 한 문장]
--   where points_balance >= p_amount 로 잠그고 검사한다. 같은 행에 동시 도착한 두 UPDATE 중 두 번째는
--   행 잠금에서 대기했다가 READ COMMITTED 규칙에 따라 "갱신된 행 버전으로 WHERE 를 다시 평가" 하므로
--   줄어든 잔액을 보고 0행이 된다. >>> 별도 select ... for update 가 필요 없다.
--   이는 ADR 0005 결정 3-3 의 CAS(where ... and status = '이전 상태' + 영향 행 검사)와 같은 기법이다.
--
-- [멱등이 아니다 — QR 과 다른 점] 전환을 두 번 하면 두 번 차감되는 것이 정상 도메인이다. 전환용 unique 제약을
--   만들지 않는다(related_participation_id 가 NULL 이라 만들 수도 없다). 더블클릭 방어는 프런트 버튼 잠금이며,
--   서버가 매번 잔액을 검사하므로 정합은 어떤 경우에도 깨지지 않는다.
--
-- [절대 원칙 3] 결제/계좌/외부 API 호출이 0줄이다. currency_balance 는 표시용 누적 숫자이고 사용처가 없다.
-- ---------------------------------------------------------
create or replace function public.convert_points_to_currency(p_amount integer)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student  uuid := auth.uid();
  v_balance  integer;
  v_total    integer;
  v_currency integer;
  v_now      timestamptz := now();
begin
  -- (1) 호출자 신원. 학생/관리자가 같은 DB 역할이므로 "학생만" 은 여기서만 표현된다.
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자는 참여할 수 없어 잔액이 언제나 0 이다(participations_insert_own 의 not is_admin()).
    -- 포인트/지역화폐는 학생의 도메인이라는 불변식을 여기서도 명시한다 (CLAUDE.md 4장).
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  -- (2) 금액 검증. ★ 위 주석 참고 — 음수 인자는 잔액을 "늘리는" 경로다. 절대 생략하지 말 것.
  --     10P 단위/최소 100P 는 도메인 규칙(스펙 확정 F), p_amount > 0 은 보안 경계다.
  if p_amount is null or p_amount <= 0 or p_amount % 10 <> 0 or p_amount < 100 then
    raise exception '전환 금액이 올바르지 않습니다.' using errcode = '22023';
  end if;

  -- (3) 차감 + 지역화폐 증가. SET 목록에 points_total 이 없다(누적은 영구 기록 — ADR 0005 결정 3-4).
  update public.profiles
     set points_balance   = points_balance   - p_amount,
         currency_balance = currency_balance + p_amount
   where id = v_student
     and points_balance >= p_amount        -- CAS: 음수 방지 + 동시 요청 직렬화의 전부
  returning points_balance, points_total, currency_balance
       into v_balance, v_total, v_currency;

  -- (4) 0행 = 잔액 부족. 도메인 실패이므로 예외가 아니라 반환값이다.
  if not found then
    select p.points_balance, p.points_total, p.currency_balance
      into v_balance, v_total, v_currency
      from public.profiles p
     where p.id = v_student;
    if not found then
      raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
    end if;
    return jsonb_build_object(
      'ok', false,
      'reason', 'insufficient_balance',
      'points_balance', v_balance,
      'points_total', v_total,
      'currency_balance', v_currency
    );
  end if;

  -- (5) 원장 1행. related_participation_id 는 반드시 NULL 이다 — point_transactions_source_rule CHECK 가
  --     (type='전환' and related is null) 을 요구한다. 그 CHECK 를 수정하지 말 것(ADR 0005 결정 3-1).
  insert into public.point_transactions (student_id, type, amount, related_participation_id)
  values (v_student, '전환', p_amount, null);

  return jsonb_build_object(
    'ok', true,
    'amount', p_amount,
    'points_balance', v_balance,
    'points_total', v_total,
    'currency_balance', v_currency,
    'at', v_now
  );
end;
$$;

comment on function public.convert_points_to_currency(integer) is
  '[ADR 0007] 포인트 -> 지역화폐 전환(시뮬레이션, 절대 원칙 3). points_balance 차감 + currency_balance 증가 + '
  'point_transactions(type=전환) 1행이 한 트랜잭션이다. points_total 은 건드리지 않는다(누적은 영구 기록). '
  '[음수 인자가 포인트 자가 발행 경로다] p_amount > 0 검증은 UX 가 아니라 보안 경계다. 2차 방어로 원장의 '
  'amount > 0 CHECK 가 트랜잭션 전체를 롤백하고, 3차로 profiles_balances_non_negative 가 있다. '
  '[동시성] where points_balance >= p_amount 조건부 UPDATE 한 문장이 잠금이자 검사다(READ COMMITTED 재평가). '
  '[거부 신호] 잔액 부족은 예외가 아니라 ok=false / reason=insufficient_balance 다 — 42501(권한)과 반드시 구분된다. '
  '[멱등이 아니다] 두 번 호출하면 두 번 차감되는 것이 정상 도메인이다. 실제 결제/계좌/외부 API 호출은 0줄이다.';

revoke all on function public.convert_points_to_currency(integer) from public;
grant execute on function public.convert_points_to_currency(integer) to authenticated;

-- ---------------------------------------------------------
-- 9-2. set_career_interest() — 학생 본인의 관심 진로 계열 저장/해제
--
-- [RPC 권한 경계] set_career_interest(p_track public.career_track)
--   호출 가능: authenticated. 본문에서 (a) 로그인 여부 (b) 관리자가 아님 을 검사한다.
--   허용 대상: auth.uid() 본인 행뿐. 함수가 학생 id 를 인자로 받지 않는다.
--   쓰는 컬럼: profiles.career_interest 하나뿐.
--   >>> points_balance / points_total / currency_balance / role / code / name / id 는 이 함수의 시그니처에도
--       UPDATE 문장에도 등장하지 않는다. "그 컬럼을 고를 수 있는 지점" 이 설계상 존재하지 않는다.
--   불가능: 남의 계열 변경(경로 없음), 관리자의 학생 계열 변경(관리자 기능 3종 밖 — 42501),
--           career_track 5종 외의 값(인자 캐스팅 단계에서 22P02/400. 함수 본문에 도달조차 못 한다)
--
-- [인자 타입을 text 가 아니라 enum 으로 두는 이유] ADR 0003 결정 3 이 programs.career_track 과
--   profiles.career_interest 가 같은 타입을 공유하게 만들어 값 공간 일치를 타입 시스템에 맡겼다.
--   인자를 text 로 받으면 쓰기 경로에서만 그 보장이 사라지고, 5종 목록을 함수 본문에 다시 적게 된다(드리프트).
--   (issue_participation_qr 의 p_type 이 text 인 것은 'entry'/'exit' 이 enum 타입이 아니기 때문이다.)
--
-- [해제는 p_track => null] 별도 함수/별도 인자를 만들지 않는다. NULL 은 이미 정의된 도메인 상태다
--   (계열 미선택 -> 홈 추천 최신순 fallback). >>> 프런트는 키를 생략하지 말고 명시적으로 null 을 보낼 것.
--
-- [반환] { ok:true, career_interest } — 프런트가 AuthContext 를 즉시 갱신한다. 갱신하지 않으면 학생 홈의
--   [profile] 의존 useEffect 가 재실행되지 않아 "계열을 바꿨는데 추천이 안 바뀌는" 상태가 된다.
-- ---------------------------------------------------------
create or replace function public.set_career_interest(p_track public.career_track)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_track   public.career_track;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- role=admin 은 계열 개념 자체가 없다(profiles.career_interest comment). 관리자가 학생의 계열을 바꾸는
    -- 경로도 만들지 않는다 — 관리자 기능 3종(CLAUDE.md 2장 6번) 밖이다.
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  update public.profiles
     set career_interest = p_track          -- SET 목록은 이 한 컬럼뿐이다. 여기가 컬럼 경계다.
   where id = v_student
  returning career_interest into v_track;

  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;

  return jsonb_build_object('ok', true, 'career_interest', v_track);
end;
$$;

comment on function public.set_career_interest(public.career_track) is
  '[ADR 0007] 학생 본인의 관심 진로 계열 저장/해제(p_track => null 이 해제). '
  'profiles 에 update 정책을 열지 않고 이 함수 하나로만 연다 — 정책을 열면(설령 컬럼 grant 를 함께 걸어도) '
  '보안 성질이 grant 한 줄에 얹혀 fail-open 이 된다(근거 전문은 1번 절 하단 블록 / ADR 0007 결정 4-3). '
  'UPDATE SET 목록이 career_interest 하나뿐이라는 것이 컬럼 경계의 전부다. 인자 타입이 enum 이라 '
  '5종/NULL 외의 값은 캐스팅 단계(22P02)에서 걸러진다. 관리자는 호출할 수 없다.';

revoke all on function public.set_career_interest(public.career_track) from public;
grant execute on function public.set_career_interest(public.career_track) to authenticated;

-- =========================================================
-- 참고: 데모 데이터(계정 6개, mentor_students 5행, 프로그램 20건)는 이 파일에 하드코딩하지 않는다.
--  - 계정 + mentor_students: scripts/seed-accounts.mjs (Node, service_role)
--  - 프로그램: scripts/seed-programs.mjs (Node, service_role)
--    [ADR 0005] 관리자 홈 "오늘 진행 프로그램" 이 항상 비지 않도록 dayOffset = 0 인 프로그램이 2건 필요하다
--    (교내 1 + 교외 1). 상세 지시는 ADR 0005 "구현 가이드 → backend-agent".
--  - participations / point_transactions / reviews: 시드 없음. 신청은 학생이, 완료·적립은 QR 인증이,
--    평가는 학생이 만든다. [ADR 0007] 빈 상태가 이 화면들의 기본 상태다 — 가짜 데이터를 시드하지 않는다.
--  - 실행 순서: 마이그레이션 -> seed-accounts.mjs -> seed-programs.mjs
--  - [시연 리셋] service_role 로:
--      delete from public.participations;   -- point_transactions 와 reviews 가 함께 삭제됨(cascade)
--      update public.profiles set points_balance = 0, points_total = 0, currency_balance = 0;
--      >>> [ADR 0007] currency_balance 초기화가 새로 필요하다. 빠뜨리면 리셋 후에도 "전환한 지역화폐" 가 남는다.
-- =========================================================
