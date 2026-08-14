-- Accumu v2 — 학교 이름 (케빈 요청 2026-08-14: "학교 계정으로 로그인 할 때는 학교 입력하게")
--
-- [지금까지 학교라는 값이 없었다] profiles 에는 소속을 나타내는 값이 account_type(school/personal)
--   하나뿐이었다 — "학교에 속했는가"는 알지만 "어느 학교인가"는 어디에도 없었다. 로그인에 학교를
--   넣으려면 그 값부터 있어야 한다.
--
-- [학교의 주인은 관리자다 — 케빈 선택 2026-08-14]
--   학생이 가입할 때 학교를 직접 치게 하면 "가온고" / "가온고등학교" 같은 오타가 그대로 계정에
--   박히고, 로그인할 때 그 오타를 똑같이 재현해야만 통과한다. 원인을 모른 채 로그인이 막힌다.
--   대신 **관리자가 가입할 때 자기 학교를 입력**하고, 학생은 초대코드를 넣는 순간 그 관리자의
--   학교를 그대로 물려받는다. 학생은 학교를 입력하지 않는다 — 그래서 틀릴 수가 없다.
--   로그인 화면에서는 등록된 학교 목록에서 고른다(school_names()).
--
-- [상속을 mentor_students 트리거로 구현하는 이유]
--   담당 관계가 생기는 경로는 둘이다 — handle_new_user()(가입 시)와 link_school_account()(개인 →
--   학교 전환). 두 함수에 각각 학교 복사를 넣으면 한쪽만 고쳐지는 날이 온다. **매핑이 생기는
--   순간**을 잡으면 경로가 몇 개든 한 곳에서 끝난다(시딩으로 매핑을 넣어도 학교가 따라간다).
--
-- [원칙 체크] 관리자가 새로 할 수 있게 된 일 0개(원칙 6) — 자기 계정 정보에 학교가 한 줄 붙었을
--   뿐이다. 학교 단위 대시보드·통계는 여전히 없고, 이 마이그레이션은 그런 조회 경로를 만들지 않는다.
--   >>> school 로 학생을 가로질러 조회하는 정책·함수를 만들지 말 것. 그 순간 "학교 단위 대시보드"가
--   >>> 시작되고 CLAUDE.md 11장 스코프 제외 사항을 넘는다.

-- =========================================================
-- 1. 컬럼 + 제약
-- =========================================================
alter table public.profiles add column if not exists school text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_school_shape') then
    alter table public.profiles
      add constraint profiles_school_shape
      check (school is null or (btrim(school) <> '' and length(school) <= 60));
  end if;
end $$;

comment on column public.profiles.school is
  '[2026-08-14] 소속 학교 이름. 관리자는 가입 시 직접 입력(학교의 주인), 학생은 담당 관리자에게서 '
  '상속받는다(mentor_students_sync_school 트리거). 개인 계정·소셜 계정은 NULL — 소속이 없다. '
  '학교 계정 학생의 로그인 4번째 대조 항목이다(학번·이름·비밀번호·학교).';

-- =========================================================
-- 2. 상속 트리거 — 담당 매핑이 생기면 학생의 학교를 관리자 값으로 맞춘다
-- =========================================================
create or replace function public.sync_student_school()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 관리자에게 학교가 없으면(예전 시드 계정) 아무것도 하지 않는다 — NULL 로 덮어써서
  -- 학생이 갖고 있던 값을 지우는 쪽이 더 나쁘다.
  update public.profiles p
     set school = a.school
    from public.profiles a
   where p.id = new.student_id
     and a.id = new.admin_id
     and a.school is not null;
  return new;
end;
$$;

comment on function public.sync_student_school() is
  '[2026-08-14] mentor_students 에 매핑이 생기면 학생의 profiles.school 을 담당 관리자 값으로 맞춘다. '
  '담당 관계가 생기는 경로(가입 트리거 / link_school_account / 시딩)가 여럿이라 각 함수에 복사 로직을 '
  '넣는 대신 매핑이 생기는 지점 한 곳에서 처리한다. 해제(담당 해제)는 학교를 지우지 않는다 — '
  '이미 쌓인 활동 기록의 문맥이고, 다시 연동될 때 덮어써진다.';

drop trigger if exists mentor_students_sync_school on public.mentor_students;
create trigger mentor_students_sync_school
  after insert on public.mentor_students
  for each row execute function public.sync_student_school();

-- =========================================================
-- 3. 기존 데이터 백필
--    >>> 데모 학교 이름이다. 다른 이름을 쓰려면 아래 두 UPDATE 의 문자열만 바꾸고 다시 실행하면 된다
--    >>> (관리자를 바꾸면 트리거가 아니라 두 번째 UPDATE 가 학생까지 맞춘다).
-- =========================================================
update public.profiles
   set school = '가온고등학교'
 where role = 'admin' and school is null;

-- 학생은 담당 관리자에게서 받는다(위 트리거와 같은 규칙을 이미 있는 행에 한 번 적용).
update public.profiles p
   set school = a.school
  from public.mentor_students ms
  join public.profiles a on a.id = ms.admin_id
 where ms.student_id = p.id
   and p.school is null
   and a.school is not null;

-- =========================================================
-- 4. handle_new_user() 개정 — 관리자 가입에서 학교를 받는다
--    (학생 쪽은 손대지 않는다: 위 트리거가 mentor_students insert 직후에 채운다)
-- =========================================================
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_meta     jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_provider text  := coalesce(new.raw_app_meta_data->>'provider', 'email');
  v_code     text  := trim(coalesce(v_meta->>'code', ''));
  v_name     text  := trim(coalesce(v_meta->>'name', ''));
  v_invite   text  := public.invite_normalize(v_meta->>'invite');
  -- [2026-08-14 신규] 관리자 가입에서만 읽는다. 학생 경로에서는 무시된다 —
  --   학생이 metadata 에 school 을 실어 보내도 profiles 에 들어가지 않는다(상속만이 유일한 경로다).
  v_school   text  := nullif(btrim(coalesce(v_meta->>'school', '')), '');
  v_role     public.user_role;
  v_account  public.account_type;
  v_track    public.career_track;
  v_admin    uuid;
begin
  -- 관심 계열은 선택 입력이다. enum 밖의 값이 와도 가입을 막을 이유가 아니므로 조용히 NULL 로 둔다.
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  -- (b) 소셜 로그인 — 학생·개인 고정. 초대코드도 role 신청도 school 도 읽지 않는다.
  if v_provider <> 'email' then
    if v_name = '' then
      v_name := trim(coalesce(
        v_meta->>'full_name',
        v_meta->>'name',
        v_meta->>'user_name',
        v_meta->>'preferred_username',
        ''
      ));
    end if;
    if v_name = '' then
      v_name := '이름 미설정';
    end if;

    insert into public.profiles (id, role, code, name, career_interest, account_type)
    values (new.id, 'student', public.generate_personal_code(), v_name, null, 'personal');
    return new;
  end if;

  -- (a) 시딩 경로(service_role + admin.createUser): metadata 가 비어 있으면 관여하지 않는다.
  if v_code = '' and v_name = '' then
    return new;
  end if;

  -- (c) 개인 이메일 가입: 학번을 받지 않으므로 code 가 비어 있다. 서버가 발급한다. 소속이 없으니 school 도 없다.
  if v_code = '' then
    insert into public.profiles (id, role, code, name, career_interest, account_type)
    values (
      new.id,
      'student',
      public.generate_personal_code(),
      v_name,
      nullif(v_meta->>'career_interest', '')::public.career_track,
      'personal'
    );
    return new;
  end if;

  -- (d) 학교 학생 / 관리자 가입
  if coalesce(v_meta->>'role', 'student') = 'admin' then
    if v_invite is null
       or not exists (
         select 1 from public.invite_codes ic
          where ic.code = v_invite and ic.kind = 'admin' and ic.is_active
       ) then
      raise exception '관리자 초대코드가 올바르지 않습니다.' using errcode = '22023';
    end if;
    -- [2026-08-14] 관리자는 학교의 주인이다 — 학교 없이 만들면 그 관리자의 담당 학생들이 전부
    --   학교 없는 계정이 되고, 로그인 화면의 학교 목록에도 나타나지 않는다. 가입 자체를 막는다.
    if v_school is null then
      raise exception '학교 이름을 입력해주세요.' using errcode = '22023';
    end if;
    v_role := 'admin';
    v_account := null;
  else
    v_role := 'student';
    v_school := null; -- 학생은 상속만 받는다(아래 mentor_students insert -> 트리거)
    if v_invite is not null then
      select ic.admin_id into v_admin
        from public.invite_codes ic
       where ic.code = v_invite and ic.kind = 'school' and ic.is_active;
      if v_admin is null then
        raise exception '학교 초대코드가 올바르지 않습니다.' using errcode = '22023';
      end if;
      v_account := 'school';
    else
      v_account := 'personal';
    end if;
  end if;

  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  insert into public.profiles (id, role, code, name, career_interest, account_type, school)
  values (new.id, v_role, v_code, v_name, v_track, v_account, v_school);

  if v_admin is not null then
    insert into public.mentor_students (admin_id, student_id)
    values (v_admin, new.id)
    on conflict (admin_id, student_id) do nothing;
  end if;

  if v_role = 'admin' then
    insert into public.invite_codes (code, kind, admin_id)
    values ('SCH-' || upper(substr(md5(new.id::text), 1, 4)), 'school', new.id)
    on conflict (code) do nothing;
  end if;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  '[ADR 0008 / 2026-08-14 school 추가] 회원가입 시 auth.users insert 와 같은 트랜잭션에서 profiles 를 만든다. '
  '진입 4가지를 구분한다: 시딩(관여 안 함) / 소셜(학생·개인 고정, code 자동 발급) / '
  '개인 이메일 가입(학번 없음, code 자동 발급) / 학교·관리자 가입(초대코드로 role 판정). '
  '[소셜로는 관리자가 될 수 없다] 소셜 분기는 role 을 student 로 고정하며 metadata 의 role/invite 를 읽지 않는다. '
  '[school 은 관리자만 직접 넣는다] 학생 경로는 metadata 의 school 을 무시하고 담당 관리자에게서 상속받는다.';

-- =========================================================
-- 5. school_names() — 로그인 화면의 학교 목록
--    [anon 에게 연다] 로그인 **전** 화면에서 쓰는 값이라 인증된 호출자가 없다.
--    나가는 것은 학교 이름 목록뿐이다 — 학생 수·관리자 수·계정 정보는 어떤 형태로도 나가지 않는다.
--    학교 이름 자체는 공개된 사실이고(간판에 적혀 있다), 이 목록이 있어야 오타 없는 선택이 가능하다.
--    >>> 이 함수에 컬럼을 추가하지 말 것. 인원수 하나만 붙어도 "학교 단위 통계"가 된다(원칙 6).
-- =========================================================
create or replace function public.school_names()
returns setof text
language sql
stable
security definer
set search_path = ''
as $$
  select distinct p.school
    from public.profiles p
   where p.role = 'admin'
     and p.school is not null
   order by 1;
$$;

comment on function public.school_names() is
  '[2026-08-14] 로그인 화면의 학교 선택 목록. 관리자가 등록한 학교 이름만 중복 없이 돌려준다. '
  'anon 실행을 허용하는 이유는 로그인 전 화면이 쓰기 때문이다 — 이름 외에는 아무것도 나가지 않는다.';

revoke all on function public.school_names() from public;
grant execute on function public.school_names() to anon, authenticated;

-- 적용 후 확인:
--   select * from public.school_names();                        -- '가온고등학교' 1행
--   select code, name, school from public.profiles order by role;  -- 관리자·학교 학생 전부 채워짐
--   select code, school from public.profiles where account_type = 'personal';  -- school 은 NULL
