-- Accumu v2 — programs.image_url 을 "우리 스토리지 주소"로 좁힌다 (QA 지적 [중간] / ADR 0022 후속)
--
-- [무엇이 문제였나]
--   20260813120000 이 건 체크는 `image_url ~ '^https://' and length <= 500` 이었다. 폼은 파일
--   업로드만 허용하므로 화면으로는 다른 값이 들어갈 수 없지만, 체크의 목적은 애초에 **폼을
--   우회했을 때**를 막는 것이다. 지금 상태로는 관리자 세션을 가진 사람이 REST 로 programs 를
--   직접 update 해서 임의의 외부 https 주소를 넣을 수 있고, 그러면 그 URL 이 학생 카드마다
--   <img src> 로 렌더된다 — 프로그램을 연 학생의 IP·UA·시각이 그 외부 서버에 남는다.
--   추적 픽셀이 관리자 1명의 update 한 번으로 전 학생 화면에 깔리는 모양이다.
--
-- [무엇으로 좁히는가]
--   Supabase Storage 의 공개 URL 모양 + 우리 버킷 이름까지 요구한다:
--     https://<project-ref>.supabase.co/storage/v1/object/public/program-images/...
--   uploadProgramImage() 의 getPublicUrl() 이 만드는 문자열이 정확히 이 모양이다(programService.js).
--
-- [project ref 를 하드코딩하지 않는 이유]
--   마이그레이션은 새 Supabase 프로젝트에서도 그대로 돌아야 한다. ref 를 박아 넣으면 프로젝트를
--   다시 만드는 순간 이 파일이 거짓이 되고, 그 사실은 사진을 처음 저장할 때 23514 로만 드러난다.
--   호스트를 `*.supabase.co` 로 묶는 것만으로 "임의의 추적 도메인"은 전부 막힌다 — 남는 구멍은
--   "공격자가 자기 Supabase 프로젝트에 program-images 공개 버킷을 만들어 쓰는 경우"뿐이고,
--   그건 이미 관리자 세션을 쥔 사람이 굳이 그 준비를 한다는 뜻이라 1인 시연 위협 모델 밖이다.
--
-- [http 로컬 스택은 계속 거부된다] 이 프로젝트에는 supabase/config.toml 이 없어 로컬 스택을 쓰지
--   않는다(호스티드 전용). 나중에 `supabase start` 를 쓰게 되면 127.0.0.1:54321 은 http 라 여기서
--   막히므로, 그때는 이 체크에 로컬 형태를 함께 허용해야 한다. >>> 그 전에 미리 열어두지 말 것.
--
-- [적용 순서] 이 파일 하나만 실행하면 된다. 실패하면(23514) 기존 행 중 새 모양을 벗어난 값이
--   있다는 뜻이고, 트랜잭션이 통째로 롤백되므로 데이터가 반쯤 바뀌는 일은 없다. 범인 찾기:
--     select id, title, image_url from public.programs
--      where image_url is not null
--        and image_url !~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/program-images/';

alter table public.programs
  drop constraint if exists programs_image_url_shape;

alter table public.programs
  add constraint programs_image_url_shape
  check (
    image_url is null
    or (
      image_url ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/program-images/.+'
      and length(image_url) <= 500
    )
  );

comment on constraint programs_image_url_shape on public.programs is
  '[ADR 0022 / 20260814120000] image_url 은 이 프로젝트의 program-images 버킷 공개 URL 만 허용한다. '
  '임의의 외부 https 주소를 넣어 학생 화면에 추적 픽셀을 심는 경로를 막는다(폼 우회 대비). '
  '길이 상한 500 은 project ref + 버킷 + uuid 경로 대비 넉넉하다.';

-- 적용 후 확인 (기대: 아래 두 줄이 각각 거부/통과)
--   update public.programs set image_url = 'https://evil.example.com/x.png' where id = <아무 id>;  -- 23514
--   update public.programs set image_url = null where id = <아무 id>;                              -- 통과
