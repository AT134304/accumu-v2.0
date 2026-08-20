-- Accumu v2 — 진행이 끝난 프로그램 수정 잠금 + 한줄평 길이 규칙 교체 (ADR 0025)
--
-- [배경 — 케빈, 2026-08-20]
--   (1) "기간이 지난 프로그램은 수정할 수 없게 해줘."
--       지금은 작년 프로그램의 제목·날짜·포인트를 언제든 바꿀 수 있다. 그 프로그램에는 이미 참여한
--       학생과 지급된 포인트가 붙어 있어서, 사후 수정은 **끝난 사실의 기록을 바꾸는 일**이 된다.
--   (2) "한줄평 길이 제한을 주지 말고 오히려 최소 길이를 정하는 게 좋겠다."
--       상한 60자는 포트폴리오에 남길 글로는 너무 짧았고, 반대로 한두 글자짜리 성의 없는 평을
--       막을 장치는 없었다. 상한과 하한을 맞바꾼다.
--
-- [범위] programs 에 트리거 1개, reviews 의 CHECK 1개 교체. 정책·함수·다른 테이블은 건드리지 않는다.
-- [실행 순서] 20260820140000 이후.

-- =========================================================
-- 1. 진행이 끝난 프로그램은 내용을 못 바꾼다 (게시 상태만 바꿀 수 있다)
--
-- [★ 게시 토글은 반드시 열어 둬야 한다]
--   `stale` 알림(ADR 0013)이 관리자에게 "일정이 지난 게시중 프로그램이 있어요"라고 말한다.
--   그 알림이 요구하는 행동이 바로 **내리기**다. 여기서 update 를 통째로 막으면 앱이 하라는 일을
--   앱이 막는 상태가 된다. 그래서 잠그는 것은 "내용"이고, is_published 는 예외다.
--   >>> 이 예외를 지우지 말 것. 지우면 stale 알림이 실행 불가능한 지시가 된다.
--
-- [왜 RLS 정책이 아니라 트리거인가]
--   정책의 using/with check 는 OLD 와 NEW 를 **연결할 수단이 없다**. "다른 컬럼은 그대로인 채
--   is_published 만 바뀌었는가"는 두 상태를 함께 봐야 표현되는 조건이라 정책으로 쓸 수 없다.
--   ADR 0006 이 정원 게이트를 트리거로 만든 것과 같은 이유(교차 상태 제약)다.
--
-- [★ 판정 기준이 OLD 인 이유]
--   NEW 를 보면 "날짜를 미래로 밀어서 잠금을 푼 다음 마음대로 고친다"가 한 번의 update 로 성립한다.
--   OLD 기준이면 끝난 프로그램은 끝난 채로 고정된다 — 되살리는 경로 자체가 없다.
--   >>> 오타를 고칠 수도 없다는 뜻이고, 그게 이 기능의 목적이다(기록은 고쳐 쓰는 것이 아니다).
--
-- [끝났다의 기준 = coalesce(end_date, date)]
--   기간제는 종료일, 단일 일자는 그 날짜다. 진행 **중**인 기간제(date <= 오늘 <= end_date)는
--   아직 끝나지 않았으므로 수정할 수 있다.
--   >>> AdminProgramsPage 의 "지난 프로그램" 접이식 그룹도 같은 식으로 맞췄다(전에는 date 만 봐서
--       진행 중인 기간제가 '지난'에 들어갔다).
--
-- [튜토리얼 제외] ADR 0021 의 연습용 프로그램은 date 가 자리표시자이고 "상시 진행"이다.
--   끝나는 개념이 없으므로 이 잠금의 대상이 아니다.
-- =========================================================
create or replace function public.programs_lock_after_end()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 아직 끝나지 않았으면 아무것도 하지 않는다.
  if coalesce(old.end_date, old.date) >= public.today_kst() then
    return new;
  end if;

  -- 상시 진행(튜토리얼)은 끝나지 않는다.
  if coalesce(old.is_tutorial, false) then
    return new;
  end if;

  -- is_published 하나만 달라졌으면 통과. jsonb 로 비교하므로 **앞으로 컬럼이 늘어도 자동으로
  -- 포함된다** — 컬럼 목록을 여기 적어두면 새 컬럼이 조용히 잠금 밖으로 새어나간다.
  if (to_jsonb(new) - 'is_published') = (to_jsonb(old) - 'is_published') then
    return new;
  end if;

  raise exception '진행이 끝난 프로그램은 내용을 수정할 수 없습니다. 게시 상태(올리기/내리기)만 바꿀 수 있어요.'
    using errcode = '22023';
end;
$$;

comment on function public.programs_lock_after_end() is
  '[ADR 0025] 진행이 끝난 프로그램(coalesce(end_date, date) < 오늘)의 내용 수정을 막는다. '
  'is_published 토글만 예외 — stale 알림이 요구하는 행동이 "내리기"라서 그것까지 막으면 모순이 된다. '
  '판정은 OLD 기준이다(NEW 기준이면 날짜를 미래로 밀어 잠금을 푸는 우회가 한 번의 update 로 성립한다). '
  '튜토리얼(is_tutorial)은 상시 진행이라 대상이 아니다.';

drop trigger if exists programs_lock_after_end on public.programs;
create trigger programs_lock_after_end
  before update on public.programs
  for each row
  execute function public.programs_lock_after_end();

-- =========================================================
-- 2. 한줄평 — 상한 60자를 버리고 "쓸 거면 20자 이상, 500자까지"
--
-- [빈 값은 그대로 허용한다] 한줄평은 선택 입력이다(스펙 D-2 "건너뛰기는 필수다"). 최소 길이는
--   **쓰기로 한 사람에게만** 적용된다 — 안 쓰면 NULL 이고 아무 제약도 걸리지 않는다.
--   >>> "최소 20자"를 "한줄평 필수"로 바꾸지 말 것. 평가를 강제하면 QR 흐름의 마지막이 막힌다.
--
-- [빈 문자열('')은 여전히 프런트가 null 로 바꿔 보낸다] 그 규율은 그대로다. 다만 이제는 ''이
--   들어와도 CHECK 가 잡는다(btrim 길이 0 은 20 미만) — 방어선이 하나 늘었다.
--
-- [상한을 완전히 없애지 않은 이유 — 케빈에게 보고할 것]
--   "제한을 주지 말고"였지만 무제한 text 는 20260820140000 에서 programs 에 대해 막 닫은 구멍과
--   같은 모양이다. 리뷰는 본인만 읽으므로(reviews_select_own) 피해 범위가 자기 아카이브·PDF 로
--   한정되지만, 그래도 상한이 없으면 폼을 우회한 요청이 자기 PDF 를 못 열게 만들 수 있다.
--   60 -> 500 은 한줄평으로는 사실상 무제한이면서(원고지 2.5매) 경계는 남긴다.
--
-- [★ not valid 로 붙이는 이유]
--   이미 저장된 리뷰 중 20자 미만이 있으면 일반 add constraint 는 23514 로 **마이그레이션 전체를
--   롤백**시킨다. 시연 중에 남긴 짧은 평이 있을 수 있고, 그 데이터를 지우거나 늘려 쓰는 것은
--   이 마이그레이션이 결정할 일이 아니다. not valid 는 **앞으로의 insert/update 만** 검사하고
--   기존 행은 건드리지 않는다(그 행을 수정하려 하면 그때 검사된다 — 의도한 동작이다).
--   나중에 정리했다면:
--     select id, comment from public.reviews where char_length(btrim(comment)) < 20;  -- 범인 찾기
--     alter table public.reviews validate constraint reviews_comment_shape;            -- 전수 검증
-- =========================================================
alter table public.reviews drop constraint if exists reviews_comment_length;

alter table public.reviews
  add constraint reviews_comment_shape
  check (comment is null or char_length(btrim(comment)) between 20 and 500)
  not valid;

comment on constraint reviews_comment_shape on public.reviews is
  '[ADR 0025] 한줄평은 선택이지만, 쓴다면 공백 제외 20자 이상 500자 이하. '
  '옛 제약(60자 상한)을 대체한다 — 상한은 포트폴리오에 남길 글로 너무 짧았고 하한은 없었다. '
  '[not valid] 기존 행은 검사하지 않는다(시연 중 남긴 짧은 평 때문에 마이그레이션이 통째로 실패하지 않도록). '
  '그 행을 수정하려 하면 그때 검사된다.';

-- =========================================================
-- 적용 후 확인
--   1) 지난 프로그램 수정 시도 (관리자 세션):
--      update public.programs set title = '바꿔보기' where date < public.today_kst() limit 1;  -- 22023 거부
--   2) 지난 프로그램 내리기:
--      update public.programs set is_published = false where date < public.today_kst() limit 1; -- 통과해야 한다
--   3) 오늘/미래 프로그램 수정 -> 그대로 통과 (회귀 확인)
--   4) 리뷰 5자 저장 -> 23514 / 25자 저장 -> 통과 / 빈 값(null) -> 통과
-- =========================================================
