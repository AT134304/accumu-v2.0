-- Accumu v2 — 마이그레이션: 개인 계정(학번 없음) + 소셜 로그인
-- 출처: docs/specs/auth-signup.md(개정), docs/adr/0008-signup-invite-codes-and-role-provisioning.md
--
-- 배경: 개인 계정은 학교에 소속되지 않으므로 학번이 없다. 그런데 profiles.code 는 NOT NULL unique 이고
--   지금까지 로그인 아이디(가상 이메일 {code}@accumu.local)의 소스이기도 했다. 그래서 두 가지가 필요하다:
--     1) 개인 계정용 code 자동 발급 (사람이 입력하지 않는 값)
--     2) 소셜 로그인으로 들어온 사용자도 프로필이 만들어지는 경로
--
-- [★ 이 마이그레이션이 지키는 불변식 — 이전과 동일]
--   role 은 여전히 클라이언트가 정하지 않는다. 오히려 경계가 더 좁아진다:
--   **소셜 로그인으로는 절대 관리자가 될 수 없다** (아래 handle_new_user 의 소셜 분기는 role 을
--   'student' 로 고정한다). 관리자는 초대코드를 입력하는 이메일 가입 경로에서만 만들어진다.
--
-- 범위
--   1) generate_personal_code() — 'P-XXXXXX' 형식의 미사용 code 발급
--   2) handle_new_user() 개정 — 소셜 / 개인 이메일 / 학교 이메일 / 시딩 4가지 진입을 구분
--   3) 시연 리셋 주석 갱신
-- [수정하지 않는 것] invite_codes / link_school_account / check_signup_availability / 기존 정책 전부.

-- =========================================================
-- 1. 개인 계정 code 자동 발급
--
-- [왜 사람이 안 만드는가] 개인 계정에는 학번이 없다. 그렇다고 code 를 NULL 허용으로 바꾸면
--   "로그인 아이디이자 표시용 식별자"라는 이 컬럼의 성격이 계정 종류마다 갈라진다(그리고 unique 도
--   함께 흔들린다). 값은 유지하되 **생성 주체를 서버로 옮기는** 편이 변경 폭이 훨씬 작다.
-- [형식] 'P-' + 6자리 대문자 base36. 학번(숫자)·관리자코드(ADM-)와 눈으로 구분된다.
-- [충돌] unique 라 만에 하나 겹치면 다시 뽑는다(최대 10회). 데모 규모에서는 사실상 1회에 끝난다.
-- =========================================================
create or replace function public.generate_personal_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_code text;
begin
  for i in 1..10 loop
    -- gen_random_uuid() 를 base 로 삼아 6자리만 취한다(읽어서 불러줄 일이 없는 값이라 길이보다 충돌 회피가 중요).
    v_code := 'P-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    if not exists (select 1 from public.profiles p where p.code = v_code) then
      return v_code;
    end if;
  end loop;
  -- 10회 연속 충돌은 사실상 불가능하지만, 조용히 중복 code 를 만들지 않고 실패시킨다(fail-closed).
  raise exception '개인 계정 식별자를 발급하지 못했습니다.' using errcode = '55000';
end;
$$;

comment on function public.generate_personal_code() is
  '개인 계정(학번 없음)용 profiles.code 자동 발급. 형식 P-XXXXXX. '
  '[사람이 입력하지 않는 값이다] 개인 계정에는 학번이 없고, code 를 NULL 허용으로 바꾸는 대신 '
  '생성 주체만 서버로 옮겼다 — 로그인 아이디이자 식별자라는 컬럼의 성격을 계정 종류마다 갈라지게 하지 않는다.';

-- =========================================================
-- 2. handle_new_user() 개정 — 진입 4가지를 구분한다
--
--   (a) 시딩            : provider='email', metadata 에 code/name 없음        -> 트리거 관여 안 함
--   (b) 소셜            : provider != 'email' (google/kakao/...)              -> 학생 + 개인 계정, code 자동
--   (c) 개인 이메일 가입 : metadata.name 있고 code 없음                        -> 학생 + 개인 계정, code 자동
--   (d) 학교/관리자 가입 : metadata.code + name 있음 (기존 경로, 변경 없음)     -> 초대코드로 role 판정
--
-- [★ 소셜은 언제나 학생·개인이다] 소셜 프로필에는 초대코드를 실을 자리가 없다. 그래서 소셜 경로는
--   role='student', account_type='personal' 로 고정된다 — 소셜 로그인으로 관리자가 되는 경로가
--   구조적으로 존재하지 않는다. 학교 연동이 필요하면 가입 후 마이페이지에서 link_school_account() 를 쓴다.
-- [이름] 소셜은 제공자마다 키가 다르다(full_name/name/user_name). 전부 비면 '이름 미설정'으로 둔다 —
--   가입을 막을 이유가 아니고, 이름은 profiles 에 있어야 화면이 성립한다(NOT NULL).
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
  v_role     public.user_role;
  v_account  public.account_type;
  v_track    public.career_track;
  v_admin    uuid;
begin
  -- 관심 계열은 선택 입력이다. enum 밖의 값이 와도 가입을 막을 이유가 아니므로 조용히 NULL 로 둔다.
  -- (분기 안에서 캐스팅하면 경로마다 이 방어가 갈라진다 — 한 곳에서 한 번만 한다.)
  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  -- (b) 소셜 로그인 — 학생·개인 고정. 초대코드도 role 신청도 읽지 않는다.
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
  --     scripts/seed-accounts.mjs 가 profiles 를 직접 insert 한다 — 이 줄을 지우면 시딩이 23505 로 깨진다.
  if v_code = '' and v_name = '' then
    return new;
  end if;

  -- (c) 개인 이메일 가입: 학번을 받지 않으므로 code 가 비어 있다. 서버가 발급한다.
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

  -- (d) 학교 학생 / 관리자 가입 — 기존 경로 그대로.
  if coalesce(v_meta->>'role', 'student') = 'admin' then
    if v_invite is null
       or not exists (
         select 1 from public.invite_codes ic
          where ic.code = v_invite and ic.kind = 'admin' and ic.is_active
       ) then
      raise exception '관리자 초대코드가 올바르지 않습니다.' using errcode = '22023';
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
    else
      v_account := 'personal';
    end if;
  end if;

  begin
    v_track := nullif(v_meta->>'career_interest', '')::public.career_track;
  exception when others then
    v_track := null;
  end;

  insert into public.profiles (id, role, code, name, career_interest, account_type)
  values (new.id, v_role, v_code, v_name, v_track, v_account);

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
  '[ADR 0008] 회원가입 시 auth.users insert 와 같은 트랜잭션에서 profiles 를 만든다. '
  '진입 4가지를 구분한다: 시딩(관여 안 함) / 소셜(학생·개인 고정, code 자동 발급) / '
  '개인 이메일 가입(학번 없음, code 자동 발급) / 학교·관리자 가입(초대코드로 role 판정). '
  '[소셜로는 관리자가 될 수 없다] 소셜 분기는 role 을 student 로 고정하며 metadata 의 role/invite 를 읽지 않는다. '
  'metadata 의 role 은 어디까지나 신청이고 승인은 invite_codes 조회가 한다.';

-- =========================================================
-- 3. 시연 리셋 참고 (갱신)
--   소셜/개인 가입 계정도 auth.users 를 지우면 profiles 가 함께 지워진다(on delete cascade).
--     delete from auth.users where id in (select id from public.profiles where code like 'P-%');
--   >>> 학번 계정(시드 6개)은 code 가 'P-' 로 시작하지 않으므로 위 문장에 걸리지 않는다.
-- =========================================================
