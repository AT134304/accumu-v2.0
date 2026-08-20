-- Accumu v2 — 프로그램 입력 검증을 DB 로 내린다 (ADR 0024)
--
-- [배경 — 2026-08-20 점검] 프로그램 등록·수정 폼의 검증이 사실상 **클라이언트에만** 있었다.
--
--   | 필드        | 폼(ProgramFormModal) | DB          |
--   |-------------|----------------------|-------------|
--   | title       | maxLength 80         | (없음)      |
--   | org         | maxLength 60         | (없음)      |
--   | description | maxLength 400        | (없음)      |
--   | time        | maxLength 40         | (없음)      |
--   | points      | 150~3000, 끝자리 0   | CHECK ✅    |
--   | capacity    | >= 1                 | > 0         |
--
--   `not null` 은 빈 문자열('')을 막지 못한다. 그래서 개발자도구나 curl 로 폼을 우회하면
--   **제목이 빈 카드**, **설명 1MB 짜리 프로그램**을 모든 학생 목록에 밀어 넣을 수 있었다.
--   ADR 0005 가 points CHECK 에 대해 적어둔 원칙("프런트도 같은 규칙으로 미리 검증하되,
--   경계의 소유자는 이 CHECK 다")이 나머지 텍스트 필드에는 적용되지 않은 상태였다.
--
--   같은 규율이 이미 다른 곳엔 있다 — profiles.school 은 20260814160000 에서
--   `btrim(school) <> '' and length(school) <= 60` 을 받았다. programs 만 빠져 있었다.
--
-- [숫자를 폼과 정확히 같게 맞춘다] 80 / 60 / 400 / 40 은 ProgramFormModal 의 maxLength 그대로다.
--   >>> 두 값이 어긋나면 "폼에서는 되는데 저장이 안 되는" 칸이 생기고, 어느 쪽이 진짜 규칙인지
--   >>> 아무도 모르게 된다. 한쪽을 바꾸면 반드시 다른 쪽도 바꿀 것.
--
-- [기존 행 안전성] 시드 실측 최댓값은 title 21 / org 11 / description 68 / time 11 이고 capacity 는
--   전부 NULL 이라 아래 제약에 걸리는 행이 없다. 그래도 23514 로 실패하면 트랜잭션이 통째로
--   롤백되므로 데이터가 반쯤 바뀌는 일은 없다. 범인 찾기:
--     select id, title from public.programs
--      where btrim(title) = '' or length(title) > 80
--         or btrim(org) = '' or length(org) > 60
--         or btrim(description) = '' or length(description) > 400
--         or btrim("time") = '' or length("time") > 40
--         or capacity > 1000
--         or date not between date '2020-01-01' and date '2035-12-31'
--         or end_date not between date '2020-01-01' and date '2035-12-31';
--
-- [실행 순서] 20260820120000 이후(순서상 뒤일 뿐 의존하지 않는다).

-- =========================================================
-- 1. 텍스트 4종 — 빈 값 금지 + 길이 상한
--
-- [btrim 을 함께 보는 이유] 길이만 재면 '   ' (공백 3칸)이 통과한다. 그러면 카드에 제목 자리가
--   비어 보이는데 DB 는 "값이 있다"고 답한다 — 화면과 데이터가 갈리는 상태다.
-- [프런트가 이미 trim 해서 보낸다] ProgramFormModal 이 저장 직전에 .trim() 한다. 이 제약은
--   그 처리를 신뢰하지 않는 두 번째 방어선이다(폼을 우회한 요청에는 trim 이 없다).
-- =========================================================
alter table public.programs
  add constraint programs_title_shape
    check (btrim(title) <> '' and length(title) <= 80),
  add constraint programs_org_shape
    check (btrim(org) <> '' and length(org) <= 60),
  add constraint programs_description_shape
    check (btrim(description) <> '' and length(description) <= 400),
  add constraint programs_time_shape
    check (btrim("time") <> '' and length("time") <= 40);

comment on constraint programs_title_shape on public.programs is
  '[2026-08-20] 공백만 있는 제목 금지 + 80자 상한. ProgramFormModal 의 maxLength 와 같은 값이다 — 한쪽을 바꾸면 다른 쪽도 바꿀 것.';
comment on constraint programs_description_shape on public.programs is
  '[2026-08-20] 공백만 있는 설명 금지 + 400자 상한. 상한이 없으면 폼을 우회한 요청이 학생 목록 응답 자체를 부풀릴 수 있다.';

-- =========================================================
-- 2. capacity — 상한을 준다
--
-- [programs_capacity_positive 를 대체한다] 규칙 하나에 제약 두 개를 두지 않는다. 제약 이름이
--   바뀌므로 프런트의 에러 해석(programErrors.js describeSaveError)도 함께 고쳤다.
-- [상한 1000 의 근거] 정원은 "이 활동에 몇 명이 들어갈 수 있는가"다. 학교 단위 활동에서 네 자리를
--   넘길 일이 없고, 상한이 없으면 20억 같은 값이 그대로 저장돼 "정원 있음"이 사실상 "정원 없음"이
--   된다(그건 NULL 이 표현하는 상태다 — 두 가지 표현이 겹친다).
-- =========================================================
alter table public.programs drop constraint if exists programs_capacity_positive;

alter table public.programs
  add constraint programs_capacity_range
    check (capacity is null or capacity between 1 and 1000);

comment on constraint programs_capacity_range on public.programs is
  '[2026-08-20] NULL = 정원 미정/무제한, 값이 있으면 1~1000. 상한이 없으면 "정원 있음"이 사실상 "정원 없음"과 같아진다.';

-- =========================================================
-- 3. date / end_date — 범위를 준다
--
-- [지난 날짜는 계속 허용한다] 확정 H 는 "지난 날짜를 막지 않고 경고만 한다"였고 그대로 둔다 —
--   시드에 과거 행이 있고 그것을 수정할 수 있어야 한다. 여기서 막는 것은 **오타 수준의 값**이다
--   (연도를 잘못 눌러 2999 년, 0202 년으로 저장되는 것).
-- [상한 2035] 이 프로젝트가 다룰 수 있는 시간 범위를 명시하는 값이다. 데모 스코프를 넘긴다.
-- =========================================================
alter table public.programs
  add constraint programs_date_range
    check (date between date '2020-01-01' and date '2035-12-31'),
  add constraint programs_end_date_range
    check (end_date is null or end_date between date '2020-01-01' and date '2035-12-31');

comment on constraint programs_date_range on public.programs is
  '[2026-08-20] 연도 오타 방어. "지난 날짜 금지"가 아니다 — 과거 날짜는 확정 H 대로 계속 허용한다(경고만).';

-- =========================================================
-- 4. image_url 이 **내 폴더**를 가리키는지 (RLS with check 에 한 절 추가)
--
-- [왜 CHECK 가 아니라 정책인가] auth.uid() 는 IMMUTABLE 이 아니라 CHECK 제약에 쓸 수 없다.
--   행 경계를 판정하는 자리는 어차피 정책이므로 거기에 붙이는 것이 맞다.
--
-- [무엇이 열려 있었나] 20260814120000 이 image_url 을 "우리 버킷 공개 URL"까지 좁혔지만,
--   경로 안의 폴더(= 업로더의 uuid)는 보지 않았다. 그래서 관리자 A 가 자기 프로그램의 사진으로
--   관리자 B 의 폴더에 있는 파일을 가리킬 수 있었다. 스토리지 insert 정책은
--   `(storage.foldername(name))[1] = auth.uid()::text` 로 **올리는 쪽**을 이미 막고 있었는데,
--   **참조하는 쪽**이 비어 있었다 — 두 정책이 같은 축(폴더 = 소유자)을 말하도록 맞춘다.
--
-- [정상 경로에는 영향이 없다] uploadProgramImage() 가 만드는 경로가 언제나 `${adminId}/...` 라서
--   폼으로 올린 사진은 전부 이 조건을 만족한다. NULL(사진 없음)도 그대로 통과한다.
-- [나머지 절은 그대로다] is_admin() + created_by = auth.uid(). ADR 0005 결정 7-0 의 축 A 를
--   바꾸지 않는다 — 한 절이 늘어날 뿐이다.
-- =========================================================
drop policy if exists "programs_insert_own_as_admin" on public.programs;
create policy "programs_insert_own_as_admin"
  on public.programs
  for insert
  to authenticated
  with check (
    public.is_admin()
    and created_by = auth.uid()
    and (
      image_url is null
      or position('/program-images/' || auth.uid()::text || '/' in image_url) > 0
    )
  );

drop policy if exists "programs_update_own_as_admin" on public.programs;
create policy "programs_update_own_as_admin"
  on public.programs
  for update
  to authenticated
  using      (public.is_admin() and created_by = auth.uid())
  with check (
    public.is_admin()
    and created_by = auth.uid()
    and (
      image_url is null
      or position('/program-images/' || auth.uid()::text || '/' in image_url) > 0
    )
  );

-- =========================================================
-- 적용 후 확인 (관리자로 로그인한 세션에서)
--   1) update public.programs set title = '   ' where id = <내 프로그램>;              -- 23514 (programs_title_shape)
--   2) update public.programs set description = repeat('가', 401) where id = <내 것>;  -- 23514
--   3) update public.programs set capacity = 2000000000 where id = <내 것>;            -- 23514 (programs_capacity_range)
--   4) update public.programs set date = date '2999-01-01' where id = <내 것>;         -- 23514 (programs_date_range)
--   5) 남의 폴더 사진 참조:
--      update public.programs
--         set image_url = 'https://<ref>.supabase.co/storage/v1/object/public/program-images/<다른 uuid>/x.webp'
--       where id = <내 것>;                                                            -- 0행 (정책 with check)
--   6) 폼으로 정상 등록·수정·사진 업로드가 그대로 되는지 (회귀 확인)
-- =========================================================
