-- Accumu v2 — 마이그레이션: 회원가입(초대코드 + role 발급 경로)
-- 출처: docs/adr/0008-signup-invite-codes-and-role-provisioning.md, docs/specs/auth-signup.md
--
-- 범위
--   1) account_type enum + profiles.account_type (학생 전용: school/personal, 관리자는 NULL)
--   2) invite_codes 테이블 + 정규화 함수 + RLS(정책 1개: 관리자 본인 school 코드 select)
--   3) 기존 관리자에게 school 코드 백필 + 데모용 관리자 초대코드 1개
--   4) check_signup_availability() — 가입 폼 사전 검증(UX 계층, anon 실행 가능)
--   5) handle_new_user() 트리거 — auth.users insert 와 같은 트랜잭션에서 profiles 생성
--   6) link_school_account() — 개인 -> 학교 전환(유일한 경로)
--
-- [★ 이 마이그레이션의 무게중심은 role 이다]
--   앱의 모든 권한 경계가 profiles.role 에서 갈라진다(admin 이면 포인트 지급 RPC 가 열린다).
--   그래서 role 은 클라이언트가 보낸 값이 아니라 **DB 안에서 초대코드로 판정**된다. 아래 5번 참고.
--
-- [★ 수정하지 않는 것 — 회귀 금지]
--   verify_participation_qr() / issue_participation_qr() / participations_capacity_guard() /
--   profiles·mentor_students 의 기존 정책 / point_transactions 의 어떤 것도 건드리지 않는다.
--   scripts/seed-accounts.mjs 도 수정 0줄로 계속 동작해야 한다(아래 5-1).
--
-- [실행 순서] 기존 마이그레이션 전부 -> 이 파일. 시딩 이후에 실행해도 안전하다(3번이 백필한다).
-- [대시보드 설정] Authentication > Email > "Confirm email" 을 꺼야 한다. 가상 이메일이라 확인 메일을
--   받을 수 없어, 켜져 있으면 가입은 되는데 세션이 생기지 않는다(코드로 할 수 없는 유일한 단계).

-- =========================================================
-- 1. account_type — 학생 계정 종류 (스펙 확정 B / ADR 0008 결정 5)
--
-- [왜 profiles 컬럼인가] mentor_students 로는 학생이 자기 소속을 알 수 없다. 그 테이블 정책에는
--   학생 축이 아예 없고(ADR 0005: "학생은 자기 멘토가 누구인지도 모른다") 이 마이그레이션은 그 경계를
--   열지 않는다. 화면이 "학교 계정 / 개인 계정"을 표시하려면 본인 행에 값이 있어야 한다.
-- [관리자는 NULL] 관리자에게는 소속 개념이 없다(career_interest 를 NULL 로 둔 것과 같은 규율).
-- =========================================================
do $$ begin
  create type account_type as enum ('school', 'personal');
exception
  when duplicate_object then null;
end $$;

alter table public.profiles add column if not exists account_type account_type;

-- 기존 행 백필: 담당 매핑이 있으면 school, 없으면 personal. 관리자는 NULL 유지.
--   시드 학생 5명은 ADM-0001 에 매핑돼 있으므로 전부 school 이 된다(사실과 일치).
--   세 문장으로 나눈 이유는 하나의 case 표현식보다 "무엇을 무엇으로 채우는가"가 그대로 읽히기 때문이다.
update public.profiles p
   set account_type = 'school'
 where p.role = 'student' and p.account_type is null
   and exists (select 1 from public.mentor_students m where m.student_id = p.id);

update public.profiles p
   set account_type = 'personal'
 where p.role = 'student' and p.account_type is null;

update public.profiles p
   set account_type = null
 where p.role = 'admin' and p.account_type is not null;

-- 불변식: 학생은 반드시 값이 있고, 관리자는 반드시 NULL 이다.
--   트리거(5번)와 전환 함수(6번)가 이 규칙을 지키며, 어긋나는 경로가 생기면 여기서 막힌다.
do $$ begin
  alter table public.profiles
    add constraint profiles_account_type_rule
    check ((role = 'admin' and account_type is null) or (role = 'student' and account_type is not null));
exception
  when duplicate_object then null;
end $$;

comment on column public.profiles.account_type is
  '학생 계정 종류(school=관리자 초대코드로 가입/연동, personal=소속 없음). 관리자는 NULL. '
  '[ADR 0008] 값을 넣는 경로는 handle_new_user() 트리거와 link_school_account() 둘뿐이며 '
  'profiles 의 update 정책은 여전히 0개다. 학생이 자기 소속을 아는 유일한 수단이라 컬럼으로 둔다 '
  '(mentor_students 에는 학생 축 정책이 없다 — 그 경계를 열지 않는다).';

-- =========================================================
-- 2. invite_codes (ADR 0008 결정 3)
--
-- [권한 구조 한눈에]
--   select : 관리자 본인의 school 코드 1행만. 학생·anon 은 0행(검증은 정의자 함수 안에서 한다).
--   insert/update/delete : 정책 0개. 코드 생성은 시딩/SQL 전용이다(스펙 확정 C).
--   >>> 앱에서 코드를 만들 수 있게 하면 관리자가 관리자를 무한 증식시킬 수 있다(kind='admin').
-- =========================================================
do $$ begin
  create type invite_kind as enum ('school', 'admin');
exception
  when duplicate_object then null;
end $$;

-- 코드 정규화의 유일한 소유자. 저장도 조회도 이 함수를 통과한 형태만 쓴다
-- (qr_normalize_token() 전례 — 대소문자/공백 때문에 "맞는 코드인데 안 된다"가 생기지 않게).
create or replace function public.invite_normalize(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select nullif(upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), '');
$$;

create table if not exists public.invite_codes (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  kind       invite_kind not null,
  -- kind='school' 이면 이 관리자의 담당 학생이 된다. kind='admin' 이면 담당 개념이 없다.
  admin_id   uuid references public.profiles(id) on delete cascade,
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),

  constraint invite_codes_admin_rule check (
    (kind = 'school' and admin_id is not null) or (kind = 'admin' and admin_id is null)
  )
);

comment on table public.invite_codes is
  '가입 초대코드. school=학생이 가입 시 입력하면 해당 관리자의 담당 학생이 된다, admin=관리자 승격용. '
  '[ADR 0008] insert/update/delete 정책이 0개다 — 앱에서 코드를 만들 수 없다. 만들 수 있으면 '
  '관리자가 관리자를 무한 증식시켜 role 경계 자체가 사라진다. 생성은 시딩/SQL 콘솔 전용. '
  '[1회용이 아니다] 관리자별 고정 코드라 여러 학생이 같은 코드로 가입하는 것이 정상 도메인이다 '
  '(used_by 컬럼을 두지 않는 이유).';

alter table public.invite_codes enable row level security;

-- [RLS 권한 경계] invite_codes_select_own_as_admin
--   허용 행: 본인이 소유한 school 코드 1행. 다른 관리자의 코드도, admin 승격 코드도 보이지 않는다.
--   용도: 관리자 마이페이지의 "내 학교 초대코드" 표시(스펙 D). 그 외 조회 목적이 없다.
--   [학생에게 열지 않는다] 코드 유효성 검사는 정의자 함수 안에서 일어나므로 읽기 권한이 필요 없다.
--     열면 전체 코드가 열거되고, 그건 아무나 아무 관리자에게 붙을 수 있다는 뜻이다.
drop policy if exists "invite_codes_select_own_as_admin" on public.invite_codes;
create policy "invite_codes_select_own_as_admin"
  on public.invite_codes
  for select
  to authenticated
  using (kind = 'school' and admin_id = auth.uid());

-- =========================================================
-- 3. 코드 백필 — 이미 시딩된 관리자에게 school 코드를 하나씩
--
-- [결정론적이라 재실행이 안전하다] md5(id) 앞 4자리라 같은 관리자는 언제나 같은 코드를 얻는다.
-- 새 관리자가 가입하면? 아래 5번 트리거가 같은 규칙으로 코드를 함께 만든다.
-- =========================================================
insert into public.invite_codes (code, kind, admin_id)
select 'SCH-' || upper(substr(md5(p.id::text), 1, 4)), 'school', p.id
  from public.profiles p
 where p.role = 'admin'
   and not exists (select 1 from public.invite_codes ic where ic.admin_id = p.id and ic.kind = 'school')
on conflict (code) do nothing;

-- 데모용 관리자 승격 코드 1개. 이 코드를 아는 사람만 관리자로 가입할 수 있다.
-- 운영이라면 발급 절차가 따로 있어야 하지만, 이 프로젝트는 1인 시연용이다(CLAUDE.md 1장).
insert into public.invite_codes (code, kind, admin_id)
values ('ADMIN-2026', 'admin', null)
on conflict (code) do nothing;

-- =========================================================
-- 4. check_signup_availability() — 가입 폼 사전 검증 (ADR 0008 결정 4)
--
-- [보안 경계가 아니라 UX 계층이다] 우회하면 5번 트리거와 profiles.code unique 가 최종 판정한다.
--   같은 규칙을 두 곳에서 검사하는 것이 의도된 구조다(프런트 문구용 / DB 판정용).
-- [반환값에 남의 정보를 담지 않는다] {ok, reason} 뿐이다 — 이름·id·관리자 정보를 돌려주지 않는다.
-- [학번 존재 여부 노출을 수용한다] 학번은 교실에서 공개적으로 쓰이는 식별자이고 비밀번호 없이는
--   아무것도 되지 않는다. 가입 UX 에 필요한 최소 노출이다(ADR 0008 결정 4).
-- =========================================================
create or replace function public.check_signup_availability(
  p_role   text,
  p_code   text,
  p_invite text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_code   text := upper(trim(coalesce(p_code, '')));
  v_invite text := public.invite_normalize(p_invite);
begin
  if v_code = '' then
    return jsonb_build_object('ok', false, 'reason', 'invalid_code');
  end if;

  -- code 는 대소문자를 구분하지 않고 중복으로 본다('adm-0001' 로 우회 가입할 수 없게).
  if exists (select 1 from public.profiles p where upper(p.code) = v_code) then
    return jsonb_build_object('ok', false, 'reason', 'code_taken');
  end if;

  if p_role = 'admin' then
    if v_invite is null
       or not exists (
         select 1 from public.invite_codes ic
          where ic.code = v_invite and ic.kind = 'admin' and ic.is_active
       ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_admin_invite');
    end if;
  elsif v_invite is not null then
    -- 학생은 초대코드가 선택이다(개인 계정). 넣었다면 유효해야 한다.
    if not exists (
      select 1 from public.invite_codes ic
       where ic.code = v_invite and ic.kind = 'school' and ic.is_active
    ) then
      return jsonb_build_object('ok', false, 'reason', 'invalid_school_invite');
    end if;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.check_signup_availability(text, text, text) is
  '[ADR 0008 결정 4] 가입 폼 사전 검증(중복 code / 초대코드 유효성). UX 계층이며 보안 경계가 아니다 — '
  '최종 판정은 handle_new_user() 트리거와 profiles.code unique 다.';

revoke all on function public.check_signup_availability(text, text, text) from public;
grant execute on function public.check_signup_availability(text, text, text) to anon, authenticated;

-- =========================================================
-- 5. handle_new_user() — auth.users insert 와 같은 트랜잭션에서 profiles 생성 (ADR 0008 결정 1·2)
--
-- [★ role 은 클라이언트가 정하지 않는다]
--   raw_user_meta_data 는 가입 요청자가 자유롭게 채울 수 있다. 그래서 metadata 의 role 은 *신청*이고,
--   승인은 아래 invite_codes 조회가 한다. 관리자 초대코드가 없으면 예외를 던져 **가입 자체를 롤백**한다.
--   >>> 학생으로 대신 만들어주지 않는다(fail-closed). 그러면 사용자는 "가입됐다"고 믿고 관리자 기능이
--       없는 이유를 영원히 모른다.
--
-- [★ 5-1. 시딩 경로를 방해하지 않는다 — 회귀 방지]
--   scripts/seed-accounts.mjs 는 admin.createUser() 후 profiles 를 **직접 insert** 한다.
--   metadata 에 code/name 이 없으면 이 트리거는 아무것도 하지 않고 통과한다.
--   >>> 시드 스크립트 수정 0줄. 이 early return 을 지우면 시딩이 23505 로 깨진다.
--
-- [유령 계정이 생기지 않는 이유] after insert 트리거의 예외는 auth.users insert 까지 롤백시킨다.
--   가입 후 별도 RPC 로 프로필을 만드는 방식(기각안 1-2)에서는 RPC 실패 시 그 학번으로 영원히
--   재가입할 수 없는 계정이 남는다.
-- =========================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta    jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_code    text  := trim(coalesce(v_meta->>'code', ''));
  v_name    text  := trim(coalesce(v_meta->>'name', ''));
  v_invite  text  := public.invite_normalize(v_meta->>'invite');
  v_role    public.user_role;
  v_account public.account_type;
  v_track   public.career_track;
  v_admin   uuid;
begin
  -- (0) 시딩 경로: metadata 가 비어 있으면 이 트리거는 관여하지 않는다 (위 5-1).
  if v_code = '' or v_name = '' then
    return new;
  end if;

  -- (1) role 판정. metadata 의 값은 신청일 뿐이고 승인은 invite_codes 가 한다.
  if coalesce(v_meta->>'role', 'student') = 'admin' then
    if v_invite is null
       or not exists (
         select 1 from public.invite_codes ic
          where ic.code = v_invite and ic.kind = 'admin' and ic.is_active
       ) then
      raise exception '관리자 초대코드가 올바르지 않습니다.' using errcode = '22023';
    end if;
    v_role := 'admin';
    v_account := null;           -- 관리자에게는 소속 개념이 없다
  else
    v_role := 'student';
    if v_invite is not null then
      select ic.admin_id into v_admin
        from public.invite_codes ic
       where ic.code = v_invite and ic.kind = 'school' and ic.is_active;
      if v_admin is null then
        raise exception '학교 초대코드가 올바르지 않습니다.' using errcode = '22023';
      end if;
      v_account := 'school';
    else
      v_account := 'personal';   -- 개인 계정 — 어떤 관리자에게도 소속되지 않는다
    end if;
  end if;

  -- (2) 관심 계열은 선택 입력이다. enum 밖의 값이 오면 조용히 NULL 로 둔다(가입을 막을 이유가 아니다).
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  -- (3) 프로필 생성. points_* / currency_balance 를 SET 하지 않는다 = 가입 보너스가 없다(원칙 1).
  --     code unique 위반(23505)은 여기서 터지고 가입 전체가 롤백된다.
  insert into public.profiles (id, role, code, name, career_interest, account_type)
  values (new.id, v_role, v_code, v_name, v_track, v_account);

  -- (4) 학교 계정이면 담당 매핑 1행. 앱에서 mentor_students 가 만들어지는 두 경로 중 하나이며,
  --     주체는 언제나 "학생 본인의 코드 입력"이다(관리자가 학생을 지목하는 경로는 여전히 0개).
  if v_admin is not null then
    insert into public.mentor_students (admin_id, student_id)
    values (v_admin, new.id)
    on conflict (admin_id, student_id) do nothing;
  end if;

  -- (5) 새로 가입한 관리자에게도 school 코드를 하나 만들어 준다(3번 백필과 같은 규칙).
  --     없으면 그 관리자는 학생을 연동시킬 방법이 없다.
  if v_role = 'admin' then
    insert into public.invite_codes (code, kind, admin_id)
    values ('SCH-' || upper(substr(md5(new.id::text), 1, 4)), 'school', new.id)
    on conflict (code) do nothing;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  '[ADR 0008 결정 1·2] 회원가입 시 auth.users insert 와 같은 트랜잭션에서 profiles 를 만든다. '
  'role 은 raw_user_meta_data 가 아니라 invite_codes 조회로 판정된다 — 관리자 초대코드가 없으면 '
  '22023 예외로 가입 자체가 롤백된다(학생으로 대신 만들지 않는다). '
  'metadata 에 code/name 이 없으면(=service_role 시딩) 아무것도 하지 않고 통과한다.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- =========================================================
-- 6. link_school_account() — 개인 -> 학교 전환 (스펙 확정 D / ADR 0008 결정 5)
--
-- [UPDATE SET 목록이 컬럼 경계다] account_type 하나뿐이다. points_* / role / code / name /
--   career_interest 는 이 함수의 어디에도 등장하지 않는다(ADR 0007 결정 3-6 규율 그대로).
-- [해제 경로를 만들지 않는다] school -> personal 은 mentor_students delete 가 필요하고, 그건 학생이
--   자기 기록을 관리자 시야에서 지울 수 있게 만드는 일이다(스펙 "스코프 아님").
-- =========================================================
create or replace function public.link_school_account(p_invite text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_invite  text := public.invite_normalize(p_invite);
  v_current public.account_type;
  v_admin   uuid;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    -- 관리자에게는 소속 개념이 없다. 관리자가 다른 관리자의 담당이 되는 구조를 만들지 않는다.
    raise exception '학생만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  select p.account_type into v_current from public.profiles p where p.id = v_student;
  if not found then
    raise exception '프로필을 찾을 수 없습니다.' using errcode = '42501';
  end if;
  if v_current = 'school' then
    -- 도메인 상태이지 오류가 아니다(이미 연동됨). 예외로 던지지 않는다.
    return jsonb_build_object('ok', false, 'reason', 'already_linked', 'account_type', v_current);
  end if;

  select ic.admin_id into v_admin
    from public.invite_codes ic
   where ic.code = v_invite and ic.kind = 'school' and ic.is_active;
  if v_admin is null then
    return jsonb_build_object('ok', false, 'reason', 'invalid_invite', 'account_type', v_current);
  end if;

  update public.profiles
     set account_type = 'school'     -- SET 목록은 이 한 컬럼뿐이다
   where id = v_student;

  insert into public.mentor_students (admin_id, student_id)
  values (v_admin, v_student)
  on conflict (admin_id, student_id) do nothing;

  return jsonb_build_object('ok', true, 'account_type', 'school');
end;
$$;

comment on function public.link_school_account(text) is
  '[ADR 0008 결정 5] 개인 계정 학생이 초대코드로 학교 계정이 되는 유일한 경로. '
  'UPDATE SET 목록이 account_type 하나뿐이라 points_*/role/code 는 이 경로로 바뀔 수 없다. '
  '학생 id 를 인자로 받지 않으므로 남을 남의 담당에 넣을 수 없다. 해제(school->personal) 경로는 없다.';

revoke all on function public.link_school_account(text) from public;
grant execute on function public.link_school_account(text) to authenticated;

-- =========================================================
-- 7. 시연 리셋 참고 (기존 절차에 추가되는 부분)
--
--   가입으로 만들어진 계정을 지우려면 auth.users 를 지우면 된다(profiles 는 on delete cascade).
--     delete from auth.users where email like '%@accumu.local' and created_at > '2026-07-31';
--   invite_codes 는 남겨둔다 — 관리자별 고정 코드라 지우면 학생 연동 경로가 사라진다.
-- =========================================================
