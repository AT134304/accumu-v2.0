-- Accumu v2 — 학교를 학생이 직접 입력·대조하는 방식으로 되돌린다 (케빈 결정 2026-08-14, 같은 날 재변경)
--
-- [무엇이 바뀌나] 직전 마이그레이션(20260814160000)은 "관리자가 학교의 주인, 학생은 초대코드로 상속"
--   이었다. 케빈 요청으로 두 가지를 바꾼다:
--     1. 학생이 가입할 때 **자기 학교를 직접 입력**하고, 로그인할 때 그 값을 대조한다.
--     2. **같은 학교의 관리자가 없어도 성립한다** — 학교가 더 이상 관리자에게 매여 있지 않다.
--
-- [무엇이 그대로인가] profiles.school 컬럼·제약, 관리자도 학교를 갖는 것, 로그인 대조가 자격증명
--   오류와 같은 문구를 쓰는 것(어느 항목이 틀렸는지 말하지 않는다)은 그대로다. 컬럼을 다시 만들지 않는다.
--
-- [상속 트리거는 지우지 않고 "비어 있을 때만"으로 낮춘다]
--   지우면 개인 → 학교 전환(link_school_account)으로 들어온 학생이 학교 없는 계정으로 남는다.
--   반대로 그대로 두면 **학생이 직접 입력한 값을 관리자 값으로 덮어쓴다** — 표기가 조금만 달라도
--   (가온고 / 가온고등학교) 그 순간부터 학생은 자기가 입력한 이름으로 로그인하지 못한다.
--   그래서 "학생에게 학교가 없을 때만 관리자 값을 채운다"로 바꾼다. 덮어쓰기는 하지 않는다.
--
-- [school_names() 는 지운다] 로그인 화면이 드롭다운을 쓰지 않게 되어 호출자가 0개가 됐다.
--   그리고 이제 학교는 관리자 목록과 무관하므로, 그 함수가 주는 목록은 **부분 목록**이라 오히려
--   "내 학교가 목록에 없다"는 오해를 만든다. anon 에게 열린 함수를 쓰는 곳 없이 남겨두지 않는다.

-- =========================================================
-- 1. 상속 트리거 — 덮어쓰지 않고, 비어 있을 때만 채운다
-- =========================================================
create or replace function public.sync_student_school()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- p.school is null 조건이 이 함수의 전부다(2026-08-14 재변경).
  -- 학생이 가입 때 직접 입력한 학교가 있으면 건드리지 않는다 — 덮어쓰면 그 학생은 자기가 입력한
  -- 이름으로 로그인하지 못하게 된다. 관리자 학교는 "학교가 아예 없는 학생"의 기본값일 뿐이다.
  update public.profiles p
     set school = a.school
    from public.profiles a
   where p.id = new.student_id
     and a.id = new.admin_id
     and a.school is not null
     and p.school is null;
  return new;
end;
$$;

comment on function public.sync_student_school() is
  '[2026-08-14] mentor_students 매핑이 생길 때 학생의 school 이 **비어 있으면** 담당 관리자 값으로 채운다. '
  '이미 값이 있으면 덮어쓰지 않는다 — 학생이 가입 때 입력한 학교가 로그인 대조 항목이라 '
  '표기가 다른 값으로 바뀌면 그 학생이 로그인하지 못한다. 개인 -> 학교 전환처럼 학교 없이 들어온 '
  '계정에 기본값을 주는 것이 이 트리거의 남은 역할이다.';

-- =========================================================
-- 2. handle_new_user() — 학교 계정 학생도 school 을 직접 넣는다
--    (직전 버전은 학생 분기에서 v_school := null 로 지우고 상속만 허용했다)
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
  -- [2026-08-14 재변경] 관리자와 **학교 계정 학생** 둘 다 직접 입력한다.
  --   개인 계정·소셜은 소속이 없으므로 아래 분기에서 NULL 로 지운다.
  v_school   text  := nullif(btrim(coalesce(v_meta->>'school', '')), '');
  v_role     public.user_role;
  v_account  public.account_type;
  v_track    public.career_track;
  v_admin    uuid;
begin
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  -- (b) 소셜 로그인 — 학생·개인 고정. 초대코드도 role 도 school 도 읽지 않는다.
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

  -- (a) 시딩 경로: metadata 가 비어 있으면 관여하지 않는다.
  if v_code = '' and v_name = '' then
    return new;
  end if;

  -- (c) 개인 이메일 가입: 학번도 소속도 없다.
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
    if v_school is null then
      raise exception '학교 이름을 입력해주세요.' using errcode = '22023';
    end if;
    v_role := 'admin';
    v_account := null;
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
      -- [2026-08-14 재변경] 학교 계정 학생은 자기 학교를 직접 넣는다. 로그인 대조 항목이므로
      --   비어 있으면 그 검사가 조용히 없는 계정이 된다 — 프런트가 이미 막지만 여기서도 막는다.
      --   >>> 같은 학교의 관리자가 있어야 한다는 조건은 **없다**. 초대코드의 주인이 어느 학교든
      --   >>> 학생이 적은 학교가 그 학생의 학교다(케빈 결정 2026-08-14).
      if v_school is null then
        raise exception '학교 이름을 입력해주세요.' using errcode = '22023';
      end if;
    else
      v_account := 'personal';
      v_school := null; -- 소속이 없다. 학생이 실어 보내도 저장하지 않는다.
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
  '[ADR 0008 / 2026-08-14] 회원가입 시 auth.users insert 와 같은 트랜잭션에서 profiles 를 만든다. '
  '진입 4가지: 시딩(관여 안 함) / 소셜(학생·개인 고정) / 개인 이메일 가입 / 학교·관리자 가입. '
  '[소셜로는 관리자가 될 수 없다] 소셜 분기는 role 을 student 로 고정하며 metadata 의 role/invite 를 읽지 않는다. '
  '[school] 관리자와 학교 계정 학생이 각각 직접 입력한다(둘 다 필수). 개인·소셜 계정은 NULL. '
  '학생의 학교가 초대코드 주인의 학교와 같아야 한다는 조건은 없다.';

-- =========================================================
-- 3. school_names() 제거 — 호출자가 0개가 됐다
--    로그인 화면이 드롭다운 대신 직접 입력을 쓰고, 학교가 관리자 목록과 무관해지면서
--    이 함수가 주는 목록은 부분 목록이 됐다("내 학교가 없다"는 오해를 만든다).
--    anon 에게 열린 함수를 쓰는 곳 없이 남겨두지 않는다.
-- =========================================================
drop function if exists public.school_names();

-- 적용 후 확인:
--   select role, account_type, code, name, school from public.profiles order by role, code;
--   select proname from pg_proc where proname = 'school_names';  -- 0행이어야 정상
