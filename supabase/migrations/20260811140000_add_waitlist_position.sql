-- Accumu v2 — 대기 순번 공개 (ADR 0018)
--
-- [배경] 케빈이 지목한 사용성 문제 7번: "대기 순번 안 알려줌". ADR 0016 구현 당시엔 "원칙 1과도
--   맞물린다 — 순번은 순위처럼 읽힐 수 있다"며 의도적으로 숨겼지만, 이번에 명시적으로 뒤집혔다.
--   신청자 수를 이미 공개한 것과 같은 논리다(ADR 0016 결정 3) — "내가 몇 번째인가"는 다른 학생과의
--   경쟁 순위가 아니라 "내 차례가 언제쯤 올까"라는 내 상황에 대한 사실 하나다.
--
-- [설계] program_applicant_counts()(ADR 0016)와 같은 패턴 — 본인 소유 조회이므로 RLS
--   participations_select_own에 걸리지 않고 "몇 명이 나보다 먼저 대기 중인가"를 세려면 다른 학생의
--   행을 봐야 한다. security definer로 그 카운트만 계산해 돌려준다(다른 학생의 행 자체는 반환하지
--   않는다 — 세는 것과 보여주는 것은 다르다).
-- [created_at 기준] cancel_my_participation()의 승격 로직(ADR 0016)이 이미 "가장 먼저 신청한 대기자
--   1명"을 created_at asc로 고른다 — 순번 계산도 같은 정렬 기준을 써야 "3번째"라고 알려준 학생이
--   실제로 승격 순서상 3번째와 일치한다(기준이 둘로 갈리면 화면과 실제 승격 순서가 어긋난다).
--
-- [실행 순서] 아무 때나(다른 마이그레이션에 의존하지 않는다 — participations.status='waitlisted'는
--   20260810160000에서 이미 추가됨).

create or replace function public.my_waitlist_positions()
returns table(program_id uuid, waitlist_position integer)
language sql
stable
security definer
set search_path = ''
as $$
  select pa.program_id,
         (
           select count(*)::integer + 1
             from public.participations pa2
            where pa2.program_id = pa.program_id
              and pa2.status = 'waitlisted'
              and pa2.created_at < pa.created_at
         ) as waitlist_position
    from public.participations pa
   where pa.student_id = auth.uid()
     and pa.status = 'waitlisted';
$$;

comment on function public.my_waitlist_positions() is
  '[ADR 0018] 내가 대기 중인(waitlisted) 프로그램마다 몇 번째로 대기 중인지. 1부터 시작(가장 먼저
   대기한 사람이 1). cancel_my_participation()의 승격 순서(created_at asc, ADR 0016)와 같은 기준이라
   "N번째"가 실제 승격 순서와 일치한다. 다른 학생의 행 자체(이름·학번 등)는 반환하지 않는다 — 세기만
   한다(ADR 0005 결정 7-2(d)와 같은 경계, program_applicant_counts()와 같은 패턴). security definer인
   이유는 participations_select_own(본인 행만)에 걸리지 않고 다른 학생의 waitlisted 행 개수를 세기
   위해서다 — 그 행의 내용을 읽어 반환하지는 않는다.';

revoke all on function public.my_waitlist_positions() from public;
grant execute on function public.my_waitlist_positions() to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 정원 1짜리 프로그램에 학생 A(applied) -> B(waitlisted, 1번째) -> C(waitlisted, 2번째) 순서로 신청
--   2) B로 로그인해 my_waitlist_positions() 호출 -> {program_id, waitlist_position:1}
--   3) C로 로그인해 호출 -> {program_id, waitlist_position:2}
--   4) A가 취소 -> B가 applied로 승격 -> B는 더 이상 my_waitlist_positions() 결과에 안 나옴,
--      C의 waitlist_position은 여전히 2가 아니라 1로 계산되는지(B가 빠졌으므로 앞사람이 0명)
-- =========================================================
