-- Accumu v2 — 프로그램 대표 사진 (ADR 0022)
--
-- [배경] 케빈 요청(2026-08-13): "관리자가 프로그램 올릴 때 사진 넣을 수 있게. 그러면 프로그램
--   화면에서 원래 아이콘으로만 보이던 위치에 사진 들어가게."
--   지금까지 카드/팝업의 썸네일 자리는 category 색 그라데이션 + duotone 아이콘이었다(ProgramCard
--   .thumb / JoinModal .mthumb). 그 자리에 실제 사진을 넣는다 — 아이콘은 사라지지 않고
--   **사진이 없을 때의 대체 표시**로 남는다(기존 20여 행 + 튜토리얼 행은 사진이 없다).
--
-- [이 마이그레이션이 만드는 것]
--   1) public.programs.image_url  — 사진 1장의 공개 URL (nullable)
--   2) storage 버킷 'program-images' (public read)
--   3) storage.objects 정책 2개 — 공개 읽기 / 관리자 본인 폴더에만 업로드
--
-- [원칙 체크]
--   원칙 1 : 사진은 꾸밈이지 보상·경쟁 요소가 아니다. 개수·조회수·인기 표시 없음.
--   원칙 4 : 사진은 포트폴리오(활동) 쪽 요소다. amber 는 이 마이그레이션 어디에도 없다.
--   원칙 6 : 관리자 기능이 6번째로 늘지 않는다 — "프로그램 올리기/수정" 폼 안의 입력칸 하나다
--            (새 메뉴·새 화면 0개, 담당 학생/QR/아카이브 쪽은 한 글자도 안 바뀐다).
--
-- 재실행해도 안전하다(if not exists / on conflict / drop policy if exists).

-- =========================================================
-- 1) programs.image_url
-- =========================================================

alter table public.programs
  add column if not exists image_url text;

-- [체크 제약을 두는 이유] 이 컬럼은 <img src> 로 그대로 나간다. 스킴을 강제하지 않으면
--   javascript: 같은 값이 들어갈 자리가 생긴다(폼은 파일 업로드만 허용하지만, 방어는 DB 에 둔다 —
--   ADR 0004 주의 4 "default 는 방어가 아니다"와 같은 태도).
--   길이 상한 500 은 Supabase public URL(프로젝트 ref + 버킷 + uuid) 대비 넉넉하다.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'programs_image_url_shape'
  ) then
    alter table public.programs
      add constraint programs_image_url_shape
      check (image_url is null or (image_url ~ '^https://' and length(image_url) <= 500));
  end if;
end $$;

comment on column public.programs.image_url is
  '[ADR 0022] 프로그램 대표 사진 1장의 공개 URL. NULL 이면 카드/팝업이 기존 category 아이콘을 그린다 '
  '(아이콘은 폐기가 아니라 fallback 이다 — 기존 행과 튜토리얼 행은 계속 NULL 이다). '
  '값의 출처는 storage 버킷 program-images 뿐이고, 관리자 폼(ProgramFormModal)이 업로드 후 받은 '
  'public URL 을 그대로 저장한다. 학생은 이 컬럼에 쓰기 경로가 없다(programs 는 학생 update 정책 0개). '
  '[사진은 1장이다] 갤러리/여러 장을 만들지 말 것 — 카드 썸네일 한 자리에 들어갈 값이고, '
  '배열이 되는 순간 순서·대표 선택 UI 가 따라붙어 원칙 6(관리자 기능 5종)을 넘본다.';

-- =========================================================
-- 2) storage 버킷
--
-- [public 버킷인 이유] 프로그램 카드는 **로그인 전에도** 보이지 않지만(RLS로 막힌 화면),
--   이미지 자체는 서명 URL 을 쓸 이유가 없는 공개 홍보물이다. 서명 URL 로 하면 카드 20장마다
--   만료 갱신 로직이 붙는다 — 시연용 프로토타입에 그 복잡도를 넣지 않는다.
-- [file_size_limit / allowed_mime_types 를 버킷에 거는 이유] 프런트 검증은 개발자도구로 우회된다.
--   진짜 상한은 여기다 (ProgramFormModal 의 검증은 "사용자에게 먼저 알려주는" 역할).
-- =========================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'program-images',
  'program-images',
  true,
  3145728, -- 3MB. 카드 썸네일(236×108)과 팝업(460×120)에 3MB 넘는 원본은 의미가 없다.
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- =========================================================
-- 3) storage.objects 정책
--
-- [경계는 programs 와 같은 축이다] programs 의 행 경계가 created_by = auth.uid() 인 것처럼
--   (ADR 0005 결정 7-0 축 A), 오브젝트 경계는 **경로 첫 폴더 = auth.uid()** 다.
--   관리자 A 가 관리자 B 의 폴더에 파일을 넣을 수 없다.
-- [delete 정책을 만들지 않는다] programs 에 delete 정책이 0개인 것과 같은 이유이자, 더 실질적인
--   이유가 하나 더 있다: 폼에서 사진을 교체하고 **저장하지 않고 취소**하면 DB 는 여전히 옛 URL 을
--   가리킨다. 교체 시점에 옛 파일을 지우는 코드가 있으면 그 순간 저장된 행의 이미지가 깨진다.
--   그래서 앱은 스토리지 오브젝트를 지우지 않는다 — 안 쓰이는 파일이 남는 것은 시연 스코프에서
--   해가 없고, 정리가 필요하면 대시보드에서 사람이 지운다.
-- =========================================================

drop policy if exists "program_images_select_public" on storage.objects;
create policy "program_images_select_public"
  on storage.objects for select
  to public
  using (bucket_id = 'program-images');

drop policy if exists "program_images_insert_admin_own" on storage.objects;
create policy "program_images_insert_admin_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'program-images'
    and public.is_admin()
    and (storage.foldername(name))[1] = auth.uid()::text
  );
