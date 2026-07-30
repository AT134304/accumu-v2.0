-- Accumu v2 — 마이그레이션: QR 이중 인증 + 포인트 지급 + 관리자 권한 경계
-- 출처: docs/db/schema.sql (단일 스키마 소스), docs/adr/0005-qr-token-state-machine-and-admin-write-boundaries.md
-- 기능: docs/specs/qr-dual-auth.md (확정 A-1 / B-1 / C-1 / D-1 / E-1 / F-1 / G-3 / H-1)
--
-- [이 마이그레이션에서 세 가지가 동시에 처음 열린다 — 이 파일에서 가장 먼저 알아야 할 사실]
--   1) 앱 최초의 update 경로   : 단, RLS 정책이 아니라 security definer 함수 안의 update 문 3개뿐이다.
--   2) 앱 최초의 관리자 쓰기   : programs insert/update (축 A = created_by).
--   3) 앱 최초의 포인트 지급   : verify_participation_qr() 안의 profiles update 1개뿐이다.
--   여기에 확정 G-3이 더해지면서 "남의 profiles 를 볼 수 있는 최초의 경로"(담당 학생 5명)까지 열린다.
--   >>> 그래서 이 파일의 주석은 장식이 아니다. 정책/함수를 손대기 전에 해당 블록의 [RLS 권한 경계] /
--       [RPC 권한 경계] 주석을 반드시 읽을 것. 한 절만 지워도 "관리자 무한 적립" 같은 폐루프가 열린다.
--
-- 범위 (docs/db/schema.sql 을 그대로 옮긴 것이며, 여기에 없는 필드/정책/인덱스/함수를 추가하지 않는다):
--   0) 타입 1종 신규: point_transaction_type ('적립'/'전환')  + 기존 타입 comment 갱신
--   1) 함수 public.is_admin()  <<< 아래 정책 5개가 참조하므로 반드시 먼저 생성한다
--   2) participations: 컬럼 2개(entry_token_expires_at, exit_token_expires_at) + unique 2개
--                      + participations_insert_own 개정(with check 6절 -> 9절) + 컬럼 단위 insert grant
--   3) point_transactions 테이블 신규 (RLS 활성화, 정책 0개가 의도)
--   4) 함수 4개: qr_normalize_token / qr_generate_token / issue_participation_qr / verify_participation_qr
--   5) 관리자 권한 경계 정책 6개 (programs 3 / mentor_students 1 / profiles 1 / participations 1)
--
-- [이번에도 열지 않는 것 — 의도적이며, ADR 0005 의 핵심 결정이다]
--   - participations update / delete 정책: 학생·관리자 모두 0개. 상태 전이는 RPC만.
--   - profiles update 정책 0개. 포인트는 definer 함수만 늘린다.
--   - point_transactions 정책 0개(select 포함).
--   - programs delete 정책 0개. "내리기"는 is_published=false 토글이지 삭제가 아니다.
--   - mentor_students insert/update/delete 정책 0개.
--
-- [실행 순서] 20260709120000 -> 20260716120000 -> 20260716140000 -> 이 마이그레이션
--             -> seed-accounts.mjs -> seed-programs.mjs
--   profiles / mentor_students / programs / participations 는 이미 존재한다. 이 파일은 그것들을 만들지 않고
--   변경(alter/정책 추가)만 한다.
--
-- [재실행] create policy / alter table add column·add constraint 에 가드가 없어 두 번째 적용 시 실패한다
--   (기존 마이그레이션 3개와 동일한 관례. 1회 적용 전제).

-- =========================================================
-- 0. 확장 / 타입
-- =========================================================
create extension if not exists pgcrypto; -- gen_random_uuid() 용. Supabase 프로젝트는 보통 기본 활성화되어 있음.

-- 포인트 거래 유형 2종. ADR 0005 (확정 C-1).
-- 값 이름은 CLAUDE.md 5장이 명시한 '적립'/'전환' 그대로다 (ASCII 키로 바꾸면 CLAUDE.md 가 확정한
-- taxonomy 를 임의로 다시 짓는 셈이 된다 — ADR 0005 "대안으로 고려했던 것" 참고).
-- [이번 스코프에서 생성되는 값은 '적립' 하나뿐이다] '전환'(포인트 -> 지역화폐 시뮬레이션)은 마이페이지 스펙 몫이며,
-- 값 집합만 미리 정의한다. 어떤 경로로도 currency_balance 를 건드리지 않는다 (CLAUDE.md 2장 3번).
do $$ begin
  create type point_transaction_type as enum ('적립', '전환');
exception
  when duplicate_object then null;
end $$;

comment on type point_transaction_type is
  '적립=활동 참여 완료(QR 퇴장 인증)로 포인트가 늘어난 거래, 전환=포인트를 지역화폐로 바꾼 거래(시뮬레이션, 마이페이지 스펙 몫). '
  '이번 스코프(ADR 0005)에서는 적립만 생성된다. 전환은 값 집합만 정의되어 있고 이를 생성하는 코드는 존재하지 않는다.';

-- participation_status 는 20260716140000 에서 이미 만들어졌다(값 3종 동일). 타입 자체는 바뀌지 않지만
-- 의미가 바뀌었다: 이번 마이그레이션부터 entered/completed 가 실제로 생성되기 시작한다. comment 를 갱신한다.
comment on type participation_status is
  'applied=신청함(행 생성 시점), entered=입장 인증 완료(entry_at 기록됨), completed=퇴장 인증 완료(=참여 완료, 포인트 지급됨). '
  '[주의] programs.status(program_status)와 다른 개념이다 — 저쪽은 프로그램의 모집 상태, 이쪽은 한 학생의 참여 진행도. '
  '전이는 public.verify_participation_qr() 안의 update 2개만 수행한다 (participations 에 update 정책 0개 — ADR 0005).';

-- program_status 도 값은 그대로지만, 이번에 관리자 프로그램 관리가 열리면서 "사람이 입력하는 값"이 된다.
comment on type program_status is
  'open=참석 가능(신청 가능), ing=참석 중(진행 중), wait=대기(정원이 찼지만 대기 신청 가능), full=마감(모집 기한 종료), over=정원 초과. '
  '신청 가능 여부(join) 매핑과 표시 라벨은 프런트엔드 STATUS 맵이 소유한다 (Accumu_prototype.html 710~716줄). '
  '[ADR 0005] 관리자 프로그램 관리에서 이 값을 수동으로 지정한다 — 여전히 파생값이 아니다(시드 20건 전부 capacity NULL).';

-- =========================================================
-- 1. is_admin() — 호출자가 관리자인지 (RLS 정책 4개 + 검증 RPC 가 이 함수를 쓴다)
--
-- [security definer 인 것이 편의가 아니라 유일한 작성 방법이다]
--   profiles 의 RLS 정책 안에서 profiles 를 select 하면 Postgres 가 정책 재귀를 감지해 에러를 낸다
--   ("infinite recursion detected in policy"). definer 함수는 RLS 를 우회하므로 재귀가 성립하지 않는다.
--   아래 5번 절의 profiles_select_mentored_students_as_admin 은 이 함수 없이는 작성 자체가 불가능하다.
--
-- [순서가 중요하다 — 이 함수를 마이그레이션 맨 앞에 두는 이유]
--   아래 정책 5개가 이 함수를 참조하므로 함수가 먼저 존재해야 한다:
--     participations_insert_own(2번 절) / programs_insert_own_as_admin / programs_update_own_as_admin /
--     profiles_select_mentored_students_as_admin / participations_select_mentored_as_admin (5번 절).
--   함수 본문이 public.profiles 를 읽으므로 profiles 테이블(20260709120000)보다는 뒤여야 한다 — 충족됨.
-- =========================================================
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

-- [실행 권한] Postgres 함수의 기본 실행 권한은 PUBLIC 이다. 회수하지 않으면 anon 키 보유자도 호출할 수 있다.
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- profiles.points_balance 는 이번 마이그레이션부터 실제로 증가하기 시작한다. comment 로 그 유일한 경로를 못박는다.
comment on column public.profiles.points_balance is
  '[ADR 0005] 이 컬럼을 증가시키는 코드는 public.verify_participation_qr() 안의 update 1개뿐이다. '
  'profiles 에 update 정책이 0개이므로 학생도 관리자도 직접 수정할 수 없다 (CLAUDE.md 2장 3번). '
  '지급 사유는 point_transactions 에 1행씩 남는다 — 잔액과 원장이 어긋나면 그 update 경로 밖에서 누가 손댄 것이다.';

-- =========================================================
-- 2. participations 변경 — 만료 컬럼 2개 + 토큰 unique 2개 + insert 정책 개정 + 컬럼 단위 grant
-- =========================================================

-- [ADR 0005 1-3] 만료 시각을 DB 컬럼에 둔다. QR payload 의 expires_at 은 학생 화면 카운트다운 표시용일 뿐이고,
--   판정은 오로지 이 컬럼으로 한다 — payload 는 학생 기기에 있으므로 신뢰하면 만료를 위조할 수 있다.
alter table public.participations add column entry_token_expires_at timestamptz;
alter table public.participations add column exit_token_expires_at  timestamptz;

comment on column public.participations.entry_token_expires_at is
  '발급 시각 + 30분 (CLAUDE.md 6장). 만료 판정의 유일한 소스. QR payload 안의 expires_at 은 학생 화면 카운트다운용 표시값이며 '
  '검증에 쓰지 않는다(위조 가능). 학생은 이 컬럼에 insert 할 수 없다 — 컬럼 단위 insert grant + with check 9절.';
comment on column public.participations.exit_token_expires_at is
  '발급 시각 + 30분 (CLAUDE.md 6장). 만료 판정의 유일한 소스. entry_token_expires_at 과 동일한 규칙.';

-- [ADR 0005 1-5] 토큰 유일성. "인덱스를 추가하지 않는다"는 기존 원칙(ADR 0003 주의 4)의 예외이며,
--   unique (student_id, program_id) 와 같은 "제약의 부산물" 범주다. 여기서 막는 것은 실제 사고다 —
--   토큰이 충돌하면 A 학생의 QR 로 B 학생이 완료 처리된다.
--   Postgres unique 는 NULL 을 여러 개 허용하므로 nullable 컬럼에 그대로 걸린다(partial index 불필요).
--   [컬럼 간 충돌(entry_token = 다른 행의 exit_token)은 unique 로 표현할 수 없다] — 발급 함수의
--   "생성 -> 두 컬럼 전체에서 존재 확인 -> 충돌 시 재시도(최대 5회)" 루프가 그것을 담당한다(4번 절).
alter table public.participations
  add constraint participations_entry_token_unique unique (entry_token);
alter table public.participations
  add constraint participations_exit_token_unique  unique (exit_token);

comment on column public.participations.entry_token is
  'QR 1회용 입장 토큰. Crockford Base32 10자. public.issue_participation_qr() 이 발급하며 재발급 시 덮어쓴다'
  '(= 이전 토큰은 어느 행과도 매칭되지 않아 not_found 로 거부된다). '
  '[사용 후에도 문자열을 지우지 않는 이유] NULL 로 지우면 재스캔 시 행을 찾지 못해 "이미 사용됨(used)"과 '
  '"없는 토큰(not_found)"을 구분할 수 없다(스펙이 두 사유를 구분해 표시하도록 요구). 대신 status 전이가 무효화 역할을 한다 — '
  '입장 토큰은 status=applied 일 때만 소비되므로 한 번 entered 가 되면 같은 토큰으로 두 번 전이할 수 없다.';
comment on column public.participations.exit_token is
  'QR 1회용 퇴장 토큰. entry_token 과 동일한 규칙이며, status=entered 일 때만 소비된다(소비 시 completed + 포인트 지급).';
comment on column public.participations.status is
  '한 학생의 참여 진행도. [주의] programs.status 와 다른 개념이다. '
  '학생은 applied 로만 insert 할 수 있고(with check), update 정책이 0개라 이후 변경도 불가능하다. '
  'entered/completed 전이는 public.verify_participation_qr() 안의 update 2개만 수행하며, 그 update 는 '
  'where 절에 이전 상태를 함께 걸어(applied->entered, entered->completed) 동시 스캔에서도 한 번만 성공한다(CAS).';
comment on column public.participations.created_at is
  '신청 시각. [ADR 0005] 컬럼 단위 insert grant(student_id, program_id) 도입으로 ADR 0004 의 "created_at 위조 가능" 틈이 닫혔다.';
comment on table public.participations is
  '학생의 프로그램 신청/참여 행. applied(신청) -> entered(입장 인증) -> completed(퇴장 인증 + 포인트 지급). '
  '[시연 리셋] 아래 2개를 함께 실행해야 포인트 정합이 맞는다 (service_role 로 실행):'
  '  delete from public.participations;  -- point_transactions 는 on delete cascade 로 함께 지워진다'
  '  update public.profiles set points_balance = 0, points_total = 0;';

-- ---------------------------------------------------------
-- 2-1. participations_insert_own 개정 (with check 6절 -> 9절)
--
-- [대체가 아니라 추가다] 기존 6절을 하나도 지우지 않고 3절을 더한다.
--   신규: not public.is_admin() / entry_token_expires_at is null / exit_token_expires_at is null
-- ---------------------------------------------------------
drop policy if exists "participations_insert_own" on public.participations;

-- [RLS 권한 경계] participations_insert_own  <<< 학생이 DB에 쓰는 유일한 직접 경로. 각 절이 공격 경로를 하나씩 막는다.
--   대상 역할: authenticated
--   허용 행: 아래 with check 9절을 전부 만족하는 행만 insert (= 본인 이름으로, 게시된 프로그램에, applied 상태로)
--   용도: 참여 신청 팝업의 "참석 신청하기" (docs/specs/student-programs.md)
--   불가능(= 각 절이 막는 것):
--     1) student_id = auth.uid()          -> 남의 이름으로 신청.                                 위반 시 42501/403
--     2) not public.is_admin()            -> [ADR 0005 신규] 관리자 계정의 자기참여. 아래 참고.  위반 시 42501/403
--     3) status = 'applied'               -> 스스로 "참여 완료" 상태로 insert = 부정 적립.        위반 시 42501/403
--     4) entry_at/exit_at is null         -> 입·퇴장 시각을 직접 기록해 QR 인증 건너뛰기.        위반 시 42501/403
--     5) entry_token/exit_token is null   -> 자기가 아는 토큰을 심어두고 그 QR 을 생성하기.      위반 시 42501/403
--     6) *_token_expires_at is null       -> [ADR 0005 신규] 만료 시각 선주입.                    위반 시 42501/403
--     7) exists(... is_published = true)  -> 미게시 프로그램에 신청.                              위반 시 42501/403
--     + unique (student_id, program_id)   -> 중복 신청 (제약이 담당).                             위반 시 23505/409
--
--   [2번 — 이번에 새로 막는 폐루프. 확정 G-3 이 만든 것이며 이 마이그레이션 최대의 보안 항목이다]
--   관리자에게 programs insert 권한이 열리면서, 관리자 한 계정이 다음을 전부 할 수 있게 됐다:
--     (1) 3,000P 짜리 프로그램을 만든다(created_by = 본인)  -> programs_insert_own_as_admin (5번 절, 이번 신규)
--     (2) 그 프로그램에 자기 이름으로 신청한다               -> student_id = auth.uid() 를 만족한다!
--                                                              (관리자도 profiles 행이 있으므로 통과한다)
--     (3) 자기 QR 을 발급받는다                              -> issue_participation_qr (본인 참여 건이므로 통과)
--     (4) 자기가 스캔해 완료 처리한다                        -> verify_participation_qr (created_by = 본인이라 H-1 통과)
--   = 관리자가 자기 포인트를 무한히 찍어내는 경로다. 이전 스코프에서는 (1)이 불가능해 성립하지 않았다.
--   >>> 확정 H-1("본인이 올린 프로그램만 스캔")은 이 경우 방어가 아니라 오히려 (4)의 통과 조건이 된다.
--       그래서 방어를 (2)에 둔다. `not public.is_admin()` 한 절이 고리를 끊는다.
--       도메인적으로도 맞다 — CLAUDE.md 4장에서 신청은 student 의 행위이고 admin 은 등록/스캔/조회만 한다.
--       (관리자가 학생 계정으로 신청하는 것은 여전히 가능하지만, 그건 학생 계정의 권한이고 QR 2회 인증도 그대로다.)
--
--   [6번 절이 늘어난 이유] ADR 0004 가 "컬럼이 추가되면 이 with check 를 반드시 함께 재검토하라"고 지목했다.
--   RLS 는 행 단위 술어라 새 컬럼을 자동으로 막지 않는다. 만료 컬럼만 위조한 토큰은 (토큰 자체를 심을 수
--   없으므로) 실제로는 무해하지만, "봉인은 컬럼이 생길 때 함께 한다"는 규율을 여기서 깨면 다음 컬럼에서
--   진짜 구멍이 생긴다.
--
--   [7번 — 서브쿼리의 p.is_published = true 를 지우지 말 것. ADR 0005 에서 실제로 시험대에 올랐다]
--   5번 절에서 programs 에 "관리자는 본인이 만든 미게시 행도 select 가능" 정책이 추가된다. ADR 0004 가
--   예고한 함정이 현실이 됐다: 정책 표현식은 질의자 권한으로 평가되므로, 관리자가 스스로 신청하면 이
--   서브쿼리가 그 관리자에게 자기 미게시 프로그램을 보여준다. >>> 그럼에도 and p.is_published = true 가
--   명시돼 있어 결과는 여전히 거부다. 그 절이 없었다면 관리자가 자기 미게시 프로그램에 자기 이름으로
--   신청할 수 있었다(그 뒤 자기 QR 을 자기가 인증하는 폐루프까지 이어진다).
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

-- [권한 경계] 컬럼 단위 insert grant — ADR 0004 가 "QR 스펙 시점이 이 방법의 원래 자리"라며 미뤄둔 것.
--   위 with check 가 "값"을 검사한다면, 이 grant 는 "지정할 수 있는 컬럼 자체"를 못박는다.
--   효과:
--     - 앞으로 participations 에 어떤 컬럼이 추가되어도 학생은 그 컬럼을 쓸 수 없다 (fail-closed).
--       정책 개정을 잊어도 구멍이 생기지 않는다 — 이번 스펙에서 실제로 컬럼 2개가 늘었고, 앞으로도 늘어난다
--       (reviews/notifications 스펙).
--     - ADR 0004 가 "알려진 틈"으로 수용했던 created_at 위조와 id 지정이 함께 닫힌다.
--   주의:
--     - 위반도 42501/403 이라 with check 위반과 구분되지 않는다. 프런트는 insert 에 student_id/program_id
--       외 어떤 컬럼도 보내지 않는다(src/lib/programService.js applyToProgram 이미 그렇게 되어 있다).
--     - RETURNING(supabase-js 의 .insert().select())은 select 권한을 쓰므로 계속 동작한다.
--     - service_role 은 별도 역할이라 이 revoke 의 영향을 받지 않는다(시딩/리셋 무관).
revoke insert on public.participations from authenticated;
revoke insert on public.participations from anon;
grant  insert (student_id, program_id) on public.participations to authenticated;

-- [RLS 권한 경계] participations update/delete 정책 — 이번에도 0개 = 전체 거부 (학생·관리자 모두).
--  >>> ADR 0005 의 핵심 결정이다. 이번 스펙에서 status/entry_at/exit_at/토큰을 쓰는 경로가 필요해졌지만,
--      그 경로를 정책으로 열지 않고 security definer 함수 2개로만 열었다(4번 절).
--      - 학생에게 열면: 스스로 completed 로 바꿔 QR 2회 인증을 통째로 우회한다(부정 적립).
--      - 관리자에게 열면: RLS 는 컬럼 단위가 아니고 using(OLD)/with check(NEW)를 연결할 수단이 없어
--        "student_id 는 그대로 두고 status 만 바꾸기"를 표현할 수 없다. 관리자가 남의 참여를 자기 학생으로
--        옮기거나, 토큰 없이 completed 로 만들어 포인트를 찍어낼 수 있다.
--        또 "유효한 토큰을 제시했을 때만"은 정책 표현식에 인자를 넘길 수 없어 애초에 표현 불가능하다.
--  - 시연 리셋(delete)은 service_role 키로 수행한다.

-- =========================================================
-- 3. point_transactions (신규)
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

  -- [절대 원칙 3·CLAUDE.md 6장 가드를 DB 로 표현] 적립은 반드시 참여에서 나오고(= QR 퇴장 인증 없이는
  --   적립이 불가능), 전환은 참여와 무관하다. "출처 없는 적립"이 원장에 남을 수 없다.
  constraint point_transactions_source_rule check (
    (type = '적립' and related_participation_id is not null)
    or (type = '전환' and related_participation_id is null)
  )
);

comment on table public.point_transactions is
  '포인트 적립/전환 원장 (CLAUDE.md 5장). 이번 스코프에서는 public.verify_participation_qr() 의 퇴장 인증 성공 시 '
  '적립 1행만 생성된다. 전환(포인트 -> 지역화폐 시뮬레이션)은 마이페이지 스펙 몫이며 이를 생성하는 코드가 아직 없다. '
  '[RLS] 정책 0개 = 전체 거부. 학생도 아직 자기 내역을 조회하지 않는다(포인트 내역 화면이 없음) — '
  '마이페이지 스펙에서 point_transactions_select_own(student_id = auth.uid())을 열 자리다.';
comment on column public.point_transactions.amount is
  '지급 시점의 programs.points 스냅샷이다. programs.points 를 나중에 관리자가 수정해도(ADR 0005 프로그램 관리) '
  '이미 지급된 금액은 바뀌지 않는다 — 아카이브/포인트 내역은 programs.points 가 아니라 이 값을 읽어야 한다. '
  '[원칙 1 가드] 랜덤·배수·연속 참여 보너스 같은 가산 규칙을 넣지 않는다. 정액 그대로다.';
comment on column public.point_transactions.related_participation_id is
  'unique 제약이 걸린 컬럼. on delete cascade 로 둔 이유: 시연 리셋(delete from participations)이 원장을 남기면 '
  '"참여는 없는데 적립 기록만 있는" 상태가 된다. 리셋 시 profiles.points_* 초기화도 함께 해야 한다(participations comment 참고).';

alter table public.point_transactions enable row level security;

-- [RLS 권한 경계] point_transactions
--   대상 역할: 없음 — 정책 0개 = 전체 거부 (학생·관리자 모두, select 포함).
--   허용 행: 없음.
--   불가능: 학생의 직접 적립 insert(= 이 테이블이 막으려던 바로 그 공격), 학생/관리자의 원장 조회·수정·삭제.
--   용도: 쓰기는 security definer 함수(verify_participation_qr)만 수행한다. 정의자 권한이 RLS 를 우회하므로
--         정책 없이 쓸 수 있고, 그것이 유일한 경로다.
--   >>> 관리자에게 select 를 열지 않는 이유: 담당 학생 아카이브는 "무슨 활동을 했는가"이지 "얼마 벌었는가"가
--       아니다(원칙 4 — 포트폴리오가 포인트보다 먼저). 아카이브의 포인트 표시는 programs.points 로 충분하다.

-- =========================================================
-- 4. 함수 (QR 토큰 발급/검증) — 앱 최초의 update 경로 / 포인트 지급
--    ADR 0005 2·3번. 이 절은 이 파일에서 가장 조심해서 읽어야 하는 블록이다.
--
--    [왜 정책이 아니라 함수인가 — 요약]
--      1) RLS 는 컬럼 단위가 아니다. using 은 OLD, with check 는 NEW 만 보고 둘을 연결할 수단이 없어
--         "student_id 는 그대로, status 만 전이" 를 표현할 수 없다.
--      2) "유효한 토큰을 제시했을 때만" 이라는 조건은 정책 표현식에 인자를 넘길 수 없어 표현 불가능하다.
--         정책으로 여는 순간 그것은 "토큰 없이도 completed 로 바꿀 수 있는 권한"이 된다 = 원칙 5 우회.
--      3) 포인트 지급은 남의 profiles 행을 수정한다. 정책으로 하려면 profiles 에 update 를 열어야 하는데,
--         그건 학생이 자기 포인트를 고치는 문을 함께 여는 것이다.
--      4) 상태 전이 + 원장 insert + 잔액 update 가 한 트랜잭션이어야 한다. 함수는 그 자체로 한 트랜잭션이다.
--      5) 거부 사유를 6가지로 구분해 돌려줘야 한다. 정책은 403/0행밖에 못 준다.
--
--    [security definer 취급 주의 — 전부 지킬 것]
--      - set search_path = '' 로 고정한다. 검색 경로 하이재킹 방지. 사용자 객체는 전부 스키마 수식(public./auth.).
--        (pg_catalog 는 항상 암묵적으로 먼저 검색되므로 내장 함수는 수식하지 않아도 안전하다.)
--      - 정의자(소유자)로 실행되므로 이 함수들 안에서는 RLS 가 적용되지 않는다.
--        >>> 즉 함수 본문이 곧 권한 경계 전부다. 함수 안에서 호출자 신원을 직접 검사한다.
--      - execute 권한을 public 에서 회수하고 authenticated 에만 부여한다(기본값은 public 실행 허용이다).
--      - [중요] Supabase 에서 학생과 관리자는 같은 DB 역할(authenticated)이다. grant 로 역할을 구분할 수 없으므로
--        "관리자만" 은 반드시 함수 본문의 is_admin() 검사로 표현된다.
--      - 권한 실패는 예외(42501 -> HTTP 403), 도메인 실패는 {ok:false, reason} 반환으로 분리한다.
-- =========================================================

-- ---------------------------------------------------------
-- 4-1. qr_normalize_token() — 입력 정규화 (수동 입력 fallback 확정 D-1)
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
-- 4-2. qr_generate_token() — 토큰 생성 (내부 전용)
--
-- Crockford Base32(0-9 A-Z 에서 I, L, O, U 제외) 10자 = 명목상 50비트.
--   - 난수원은 gen_random_uuid()(v4, CSPRNG). pgcrypto 의 gen_random_bytes 를 쓰지 않는 이유:
--     Supabase 는 확장을 extensions 스키마에 설치하는데, search_path = '' 환경에서 그 위치가 환경마다 달라
--     깨질 수 있다. gen_random_uuid() 는 PG13+ 내장(pg_catalog)이라 항상 안전하다.
--   - uuid 32 hex 중 앞 20자(=10바이트)를 쓰고, 바이트마다 & 31 로 알파벳 인덱스를 만든다.
--     32 는 256 의 약수라 모듈로 편향이 없다.
--   - [정확히는 49비트다] uuid v4 는 7번째 바이트의 상위 니블이 버전값 '4' 로 고정돼 있어 그 한 글자만
--     32 가지가 아니라 16 가지다. 아래 위협 모델상 무해하므로 uuid 를 잘라 쓰는 단순함을 유지한다.
--   - [위협 모델] 토큰 추측은 위협이 아니다(검증 RPC 는 관리자만 호출할 수 있고 관리자는 이미 인증 권한자다).
--     이 비트 수는 우발적 충돌 방지가 목적이지 무차별 대입 방어가 목적이 아니다.
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
-- >>> grant 없음(의도적). 이 함수는 security definer 함수(issue_participation_qr) 안에서 소유자 권한으로만
--     호출된다. authenticated 에 grant 를 주면 학생이 유효한 형식의 토큰을 마음대로 뽑아볼 수 있게 된다.
--     이 줄 아래에 grant execute ... to authenticated 를 추가하지 말 것.

-- ---------------------------------------------------------
-- 4-3. issue_participation_qr() — 학생 본인의 입장/퇴장 토큰 발급
--
-- [RPC 권한 경계] issue_participation_qr(p_participation_id uuid, p_type text)
--   호출 가능: authenticated (본문에서 "본인 참여 건" 인지 다시 검사한다)
--   허용 대상: participations.student_id = auth.uid() 인 행만
--   쓰는 컬럼: entry_token + entry_token_expires_at  또는  exit_token + exit_token_expires_at  둘 중 하나뿐.
--   >>> status / entry_at / exit_at / student_id 를 절대 쓰지 않는다. 즉 학생이 이 함수를 아무리 호출해도
--       참여 상태는 1mm 도 진행되지 않는다. 상태 전이는 관리자 스캔(4-4)에서만 일어난다.
--       "학생이 자기 토큰을 알아도 스스로 인증할 수 없다"(스펙)가 여기서 성립한다.
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
-- 4-4. verify_participation_qr() — 관리자 스캔: 토큰 검증 + 상태 전이 + 포인트 지급
--
-- [RPC 권한 경계] verify_participation_qr(p_token text)
--   호출 가능: authenticated 이면서 본문의 is_admin() 검사를 통과한 호출자만. 학생이 호출하면 42501/403.
--   허용 대상: 토큰이 가리키는 참여 건의 programs.created_by = auth.uid() 인 경우만 (확정 H-1).
--             created_by 가 NULL 이면 거부(fail-closed).
--   쓰는 컬럼: participations.status/entry_at 또는 status/exit_at + point_transactions 1행 + profiles.points_*.
--   >>> student_id / program_id / 토큰 컬럼을 절대 쓰지 않는다. 관리자가 참여 건의 주인을 바꿀 수 있는
--       경로는 앱 어디에도 없다 — 정책이 아니라 "이 update 문의 SET 목록"이 그 경계다.
--       이 함수는 student_id 를 인자로 받지도 않는다. 관리자가 서버에 넘길 수 있는 값은 토큰 문자열 하나뿐이다.
--   불가능: 남의 프로그램 참여 건 인증(not_authorized), 만료/재사용 토큰 통과, 순서 뒤집기,
--           이중 지급(participations CAS + point_transactions unique 이중 방어),
--           목록 조회(이 함수는 스캔한 그 한 건만 돌려준다 — 관리자에게 participations select 를 넓게 열지 않는 이유)
--
-- [인자가 토큰 문자열 하나뿐인 것이 설계다] payload 의 participation_id / type 을 인자로 받으면 학생 기기가
--   만든 위조 가능한 값이 검증에 들어온다. 종류(entry/exit)는 "어느 컬럼에 매칭됐는가"로만 결정된다.
--   또 카메라는 어떤 종류의 QR 이 들어올지 미리 알 수 없으므로 함수를 2개로 쪼갤 수도 없다.
--
-- [반환 jsonb]
--   { ok, reason, type, student_name, program_title, points_awarded, at }
--   - 실패 시 reason: expired | used | not_found | wrong_order | already_completed | not_authorized
--   - [검사 순서가 곧 정보 노출 정책이다] not_found -> not_authorized -> (소비 상태) -> expired.
--     즉 "본인이 만든 프로그램" 이 확인되기 전에는 어떤 식별 정보도 나가지 않는다. 확인 후에는 이름·프로그램명을
--     준다 — 관리자가 학생에게 "다시 발급해 주세요" 라고 말하려면 누구인지 알아야 한다(스펙 요구사항).
--   - 소비 상태(used)를 만료(expired)보다 먼저 검사한다. 이미 쓰인 토큰의 만료 여부는 알려줄 필요가 없다.
--   - camera_error / network_error 는 서버 사유가 아니라 프런트가 만드는 별도 분류다. 인증 거부와 섞지 말 것.
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

  -- (2) 토큰 -> 참여 행. entry_token 을 먼저 보고, 없으면 exit_token (결정적 순서 = 모호성 원천 차단).
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
  -- [원칙 1 가드] 랜덤·배수·연속 참여 보너스 같은 가산 규칙을 넣지 않는다. 정액 그대로다.
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
  '관리자에게 전교생 participations/profiles select 정책을 열지 않는 대신, 방금 스캔한 한 건의 학생 이름과 프로그램명을 반환값으로만 준다.';

revoke all on function public.verify_participation_qr(text) from public;
grant execute on function public.verify_participation_qr(text) to authenticated;

-- =========================================================
-- 5. 관리자 권한 경계 정책 6개 (ADR 0005 확정 G-3 — 관리자 기능 3종)
--
--    [행 경계는 두 축뿐이다. 새 축을 만들지 말 것]
--      축 A) programs.created_by = auth.uid()          -> 프로그램 관리 + QR 스캔(H-1). "내가 운영하는 프로그램"
--      축 B) mentor_students(admin_id = auth.uid())    -> 담당 학생 아카이브. "내가 멘토링하는 학생"
--    두 축은 목적이 다르다(운영 vs 멘토링). 한쪽 축을 다른 쪽 기능에 쓰지 않는다.
--    축이 어긋나면 "내가 스캔할 수 없는 프로그램을 내가 수정할 수 있다"는 조합이 생기고, 남의 프로그램의
--    points 를 3,000P 로 올려두고 그 관리자가 스캔하게 만드는 간접 경로가 열린다.
--
--    [delete 를 어느 테이블에도 열지 않는다]
--      CLAUDE.md 10장의 관리자 기능은 "올리기/내리기/수정" 이고 내리기는 is_published=false 토글이지 삭제가 아니다.
--      programs delete 를 열면 on delete cascade 로 학생의 participations 와 point_transactions 까지 사라지는데,
--      profiles.points_* 는 그대로 남아 잔액과 원장이 어긋난다. 삭제는 시연 리셋(service_role) 전용으로 둔다.
--
--    [이 절의 정책 5개가 public.is_admin() 을 참조한다] 1번 절에서 이미 생성했다.
-- =========================================================

-- ---------------------------------------------------------
-- 5-1. 프로그램 관리 (축 A) — programs 정책 3개
-- ---------------------------------------------------------

comment on column public.programs.created_by is
  '프로그램을 등록한 관리자. on delete set null — 관리자 계정이 사라져도 프로그램 기록은 남긴다. '
  '[ADR 0005 — 이 컬럼이 관리자 권한의 단일 축이다] 프로그램 수정/게시중단/미게시 조회(3개 정책)와 '
  'QR 스캔 인증(확정 H-1, verify_participation_qr)이 모두 created_by = auth.uid() 하나를 경계로 쓴다. '
  'NULL 이면 어느 관리자에게도 권한이 없다(fail-closed) — RLS 에서는 NULL = auth.uid() 가 NULL 이라 통과하지 않고, '
  'verify_participation_qr 은 명시적으로 not_authorized 를 반환한다.';
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
comment on column public.programs.popularity is
  '[절대 원칙 가드] 프로그램의 인기 지표이지 학생 간 순위가 아니다. 학생 단위 집계/랭킹으로 파생시키는 설계 금지 (CLAUDE.md 2장 1번). '
  '[ADR 0005] 실참여자 수로 전환하지 않는다 — participations 로 집계하려면 관리자에게 전교생 참여 조회 권한이 필요해지는데 '
  '그것이 정확히 이번에 열지 않기로 한 권한이다. 관리자 프로그램 관리 화면에서도 이 값을 노출/편집하지 않는다.';
comment on column public.programs.capacity is
  'NULL 허용 = 정원 미정/무제한. status 파생에 사용하지 않는다 (확정 D). '
  '[ADR 0005] 관리자 프로그램 관리가 열려도 정원 차단을 구현하지 않는다 — 시드 20건 전부 capacity 가 NULL 이라 '
  '정원 개념이 데모에 존재하지 않는다(확정 C-1 유지).';

-- [RLS 권한 경계] programs_select_own_as_admin
--   대상 역할: authenticated
--   허용 행: created_by = auth.uid() 인 행 (게시 여부 무관)
--   용도: 관리자 프로그램 관리 화면의 미게시 행 조회 + "다시 올리기"
--   효과: 관리자는 "게시된 전부(programs_select_published) + 본인이 만든 미게시" 를 본다. 정책은 OR 로 합쳐진다.
--   불가능: 다른 관리자가 만든 미게시 행 조회. created_by 가 NULL 인 미게시 행 조회(NULL = auth.uid() 는 참이 아니다).
--   [ADR 0004 가 예고한 함정 재검토 결과 — 이 정책이 다른 정책을 시험대에 올린다]
--     이 정책 때문에 participations_insert_own 의 서브쿼리가 관리자에게 자기 미게시 프로그램을 보여주게 되지만,
--     그 서브쿼리에 p.is_published = true 가 명시돼 있어 결과는 여전히 거부다. 그 명시가 없었다면 관리자가
--     자기 미게시 프로그램에 자기 이름으로 신청할 수 있었다. >>> 그 절을 지우지 말 것(2-1절 참고).
create policy "programs_select_own_as_admin"
  on public.programs
  for select
  to authenticated
  using (created_by = auth.uid());

-- [RLS 권한 경계] programs_insert_own_as_admin
--   대상 역할: authenticated + is_admin()
--   허용 행: created_by = auth.uid() 인 행만
--   용도: 관리자 프로그램 "올리기"(등록)
--   불가능: 학생의 프로그램 등록(is_admin() 이 막는다 — 이 절이 없으면 학생이 created_by=본인 으로 프로그램을
--           만들 수 있고, 그러면 자기 프로그램에 자기가 신청하고 자기 QR 을 자기가 인증하는 폐루프가 생긴다.
--           이번 변경에서 가장 조용하지만 중요한 한 줄이다),
--           남의 이름으로 등록(created_by 위조), created_by 를 NULL 로 둔 등록(고아 프로그램 = 아무도 스캔 못 함)
--   [points 규칙] 150~3000, 끝자리 0 은 테이블 CHECK(programs_points_rule)가 담당한다. 정책에 중복해 넣지 않는다.
--     이번에 처음으로 그 CHECK 가 "사람이 입력한 값"을 막게 된다(위반 시 23514 -> HTTP 400).
create policy "programs_insert_own_as_admin"
  on public.programs
  for insert
  to authenticated
  with check (public.is_admin() and created_by = auth.uid());

-- [RLS 권한 경계] programs_update_own_as_admin
--   대상 역할: authenticated + is_admin()
--   허용 행: created_by = auth.uid() 인 행. 수정 후에도 created_by = auth.uid() 여야 한다(with check).
--   용도: 올리기/내리기(is_published 토글) + 내용 수정
--   불가능: 남의 프로그램 수정, 소유권 이전(created_by 를 남에게 넘기거나 NULL 로 만들기 — with check 가 막는다),
--           학생의 프로그램 수정(is_admin())
--   [수용하는 것 — RLS 는 컬럼 단위가 아니다] 관리자는 본인 프로그램의 모든 컬럼을 바꿀 수 있다(points 포함).
--     이것이 부정 적립 경로가 되지 않는 이유:
--       (a) 지급액은 지급 시점의 값이 point_transactions.amount 에 스냅샷으로 남는다. 나중에 points 를 올려도
--           이미 지급된 금액은 변하지 않는다.
--       (b) 관리자는 participations 를 만들 수 없다 — 남의 참여는 student_id = auth.uid() 가,
--           자기 참여는 not public.is_admin() 이 막는다(2-1절). 즉 "고액 프로그램 + 참여 조작 + 완료 처리"
--           폐루프가 성립하지 않는다. >>> 이 두 절 중 하나만 빠져도 관리자 무한 적립이 열린다.
--       (c) points 상한 3000P 와 끝자리 0 은 테이블 CHECK 가 막는다.
create policy "programs_update_own_as_admin"
  on public.programs
  for update
  to authenticated
  using      (public.is_admin() and created_by = auth.uid())
  with check (public.is_admin() and created_by = auth.uid());

-- [RLS 권한 경계] programs delete 정책 없음 = 전체 거부 (위 5번 절 상단 근거 참고).
--   프런트에 삭제 버튼을 만들지 말 것 — 정책이 0개라 동작하지도 않는다.

-- ---------------------------------------------------------
-- 5-2. 담당 학생 아카이브 (축 B) — "남의 profiles 를 볼 수 있는 최초의 경로"
-- ---------------------------------------------------------

comment on table public.mentor_students is
  '관리자-담당학생 매핑. admin_id가 실제 role=admin 행인지, student_id가 실제 role=student 행인지는 '
  'DB 레벨 CHECK/트리거로 강제하지 않고 시딩 스크립트(scripts/seed-accounts.mjs) 책임으로 둔다 (ADR 0002). '
  '[ADR 0005 경고] 이 테이블이 이제 "관리자가 남의 profiles/participations 를 볼 수 있는 행 경계"가 되었다. '
  '즉 시딩 정합성(admin_id 자리에 학생이 들어가지 않는 것)이 문서 규율에서 권한 경계의 일부로 승격됐다. '
  '실제 방어는 profiles/participations 정책의 public.is_admin() 이 함께 담당한다(이중 방어라 트리거를 추가하지 않는다).';

-- [RLS 권한 경계] mentor_students_select_own_as_admin
--   대상 역할: authenticated
--   허용 행: admin_id = auth.uid() 인 행 (= 내가 담당하는 학생 매핑)
--   용도: 담당 학생 5명 목록 조회 (CLAUDE.md 10장)
--   불가능: 학생이 "내 멘토가 누구인지" 조회(student_id 축 정책 없음), 다른 관리자의 담당 목록 조회,
--           insert/update/delete (정책 0개 — 매핑 변경 UI 없음. 시딩이 유일한 입력 경로)
--   [이 정책에 profiles 조인을 넣지 말 것] 아래 profiles 정책이 이 테이블을 참조하므로, 여기서 profiles 를
--   참조하면 두 정책이 서로를 부르는 순환이 된다. 현재 구조는 profiles -> mentor_students -> (끝) 으로 단방향이다.
--   관리자 여부 검사는 아래 profiles/participations 정책의 is_admin()(security definer, RLS 우회)이 담당한다.
create policy "mentor_students_select_own_as_admin"
  on public.mentor_students
  for select
  to authenticated
  using (admin_id = auth.uid());

-- [RLS 권한 경계] profiles_select_mentored_students_as_admin   <<< 이 마이그레이션에서 가장 조심할 select 정책
--   대상 역할: authenticated + is_admin()
--   허용 행: mentor_students 에 (admin_id = 나, student_id = 그 행) 매핑이 있는 profiles 행 (데모 기준 5명)
--   용도: 담당 학생 아카이브의 이름·학번 표시 (CLAUDE.md 10장)
--   불가능: 학생이 다른 학생의 profiles 조회(is_admin() 이 즉시 거짓),
--           관리자 A 가 관리자 B 의 담당 학생 조회(admin_id 축),
--           담당이 아닌 학생 조회, 다른 관리자의 profiles 조회
--   [수용하는 것 — RLS 는 컬럼 단위가 아니다] 이 정책은 담당 학생 행의 모든 컬럼(points_balance,
--     currency_balance, career_interest 포함)을 연다. 컬럼 단위 grant 로 좁힐 수 없다: Supabase 에서 학생과
--     관리자가 같은 DB 역할(authenticated)이라 컬럼 grant 를 걸면 학생 본인 조회까지 함께 막힌다.
--     좁히려면 아카이브 전체를 definer RPC 로 옮겨야 하는데, "조회는 RLS, 쓰기는 RPC" 라는 이 프로젝트의
--     구조를 아카이브 하나 때문에 깨는 비용이 더 크다고 판단했다(정렬·필터까지 서버로 넘어간다).
--     >>> [원칙 1 가드 — frontend 필수] 담당 학생들의 포인트를 나란히 놓고 비교/정렬/순위로 렌더하지 말 것.
--         아카이브는 학생 1명 단위의 활동 기록 화면이다.
--   [재귀 없음] is_admin() 은 security definer 라 profiles 의 RLS 를 타지 않는다. 이 함수 없이 정책 안에서
--     profiles 를 직접 select 하면 Postgres 가 정책 재귀 에러를 낸다 — 그래서 1번 절의 함수가 필수다.
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
--           전교생 참여 목록/집계 조회, 학생이 남의 참여 조회(is_admin() 이 즉시 거짓)
--   [status = 'completed' 를 정책에 넣는 이유 — UX 규칙이 아니라 노출 범위 결정이다]
--     "무엇을 신청했다가 안 갔는가" 는 아카이브가 보여줄 정보가 아니라 학생의 사생활에 가깝다.
--     아카이브 화면이 어떤 필터를 걸든 DB 가 완료분 외에는 내려주지 않는 편이 경계가 명확하다.
--     ADR 0004 가 "권한 경계는 DB, 신청 가능 여부는 프런트" 로 그은 선의 DB 쪽에 해당한다.
--   [원칙 1·6 가드가 UI 규율이 아니라 RLS 구조로 성립한다] 관리자가 볼 수 있는 참여는 담당 5명의 완료분뿐이라,
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
-- 참고: 시드 / 시연 리셋
--  - participations / point_transactions 는 시드하지 않는다. 신청은 학생이, 완료·적립은 QR 인증이 만든다
--    (ADR 0004·0005: 가짜 참여를 하드코딩하지 않는다). 담당 학생 아카이브가 일부 학생에게 빈 상태로 뜨는 것은
--    깨진 것이 아니라 의도된 결과다(ADR 0005 "케빈 확인 필요" 2번 해소분).
--  - scripts/seed-programs.mjs 는 이 마이그레이션과 함께 수정된다: 관리자 홈 "오늘 진행 프로그램" 이 항상
--    비지 않도록 dayOffset = 0 인 프로그램이 교내 1 + 교외 1 존재해야 한다(총 20건은 그대로 — 기존 2건의
--    날짜를 옮겼다. 확정 F 16~20 유지).
--  - [시연 리셋] 아래 2줄을 함께 실행한다. service_role 키로만 가능하다(학생/관리자 세션은 delete 정책이
--    0개, profiles update 정책도 0개라 0행 영향으로 끝난다).
--
--      delete from public.participations;                                -- point_transactions 는 cascade
--      update public.profiles set points_balance = 0, points_total = 0;  -- 잔액도 되돌려야 원장과 정합이 맞는다
--
--    >>> delete 만 하고 profiles 를 되돌리지 않으면 "참여도 원장도 없는데 포인트만 남은" 상태가 된다.
-- =========================================================
