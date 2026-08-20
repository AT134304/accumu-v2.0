-- Accumu v2 — 신고 2분류(공개/참여자) + 게시 전 게이트 (ADR 0026)
--
-- [배경 — 케빈, 2026-08-21]
--   (1) "관리자가 그냥 바로 올릴 수 있는 기능이 별로야."
--   (2) "신고를 2가지로 나누어서 부적절한 내용처럼 참여하지 않아도 딱 보면 바로 알 수 있는 것 같은 건
--        바로 신고가 되지만, 시간엄수와 같은건 참여 한 학생만 가능하게 하는게 좋을 것 같아."
--   (3) "30자가 너무 적어서 몇 자가 좋을지 생각하고 늘려줘."
--
--   (1)과 (2)는 같은 저울의 양쪽이다. **관리자가 올리는 문턱**과 **학생이 신고하는 문턱**을 함께
--   올린다 — 한쪽만 올리면 한쪽이 무기가 된다.
--
-- [★ 이 파일의 중심 아이디어 — 게시 체크리스트와 공개 신고 사유가 같은 목록이다]
--   관리자가 게시 전에 스스로 확인하는 3가지와, 참여하지 않은 학생이 신고할 수 있는 3가지가
--   **정확히 같은 항목**이다:
--
--     관리자 확인                          공개 신고 사유
--     ─────────────────────────────────    ────────────────────
--     진로·커리어 활동입니다 (학업 아님)   irrelevant
--     참여에 비용이 들지 않습니다          paid
--     부적절한 내용이 없습니다             inappropriate
--
--   즉 "네가 올리며 확인한 것이 곧 학생이 신고할 수 있는 것"이다. 관리자가 체크한 문장을 어겼을 때만
--   공개 신고가 성립하므로, 신고가 "취향 차이"가 아니라 **약속 위반**을 가리키게 된다.
--   >>> 한쪽을 바꾸면 다른 쪽도 함께 바꿀 것. 갈리는 순간 이 대칭이 무너진다.
--
-- [선행] 20260822100000 을 **먼저 단독 실행**해야 한다(enum 값 55P04 — 그 파일 상단 참고).
-- [실행 순서] 20260821180000 -> 20260822100000 -> 이 파일.

-- =========================================================
-- 1. 사유 분류 — 서버가 소유한다
--
-- [함수로 두는 이유] 이 판정이 세 곳에서 필요하다: CHECK(길이 하한), report_my_program(참여 확인),
--   그리고 나중에 생길 무엇. 세 곳에 case 문을 복사하면 ADR 0025 의 초대코드 규칙과 같은 드리프트가 난다.
-- [immutable 이라 CHECK 에 쓸 수 있다] enum -> text 매핑일 뿐 테이블을 읽지 않는다.
-- =========================================================
create or replace function public.report_reason_scope(p_reason public.report_reason)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_reason
    -- 공고 텍스트만 보고 판단할 수 있는 것. 참여하지 않은 학생도 신고할 수 있다.
    when 'irrelevant'    then 'open'
    when 'paid'          then 'open'
    when 'inappropriate' then 'open'
    -- 실제로 그 자리에 있어야 알 수 있는 것.
    else 'participant'
  end;
$$;

comment on function public.report_reason_scope(public.report_reason) is
  '[ADR 0026] 신고 사유의 신고 자격. open=누구나(공고만 봐도 판단 가능), participant=참여한 학생만. '
  '>>> 이 함수가 분류의 유일한 소유자다. case 문을 다른 곳에 복사하지 말 것. '
  '프런트(reportService.js REPORT_REASONS.scope)는 표시용 사본이며, 최종 판정은 report_my_program() 이 한다.';

-- =========================================================
-- 2. 이유 길이 — 사유 분류에 따라 하한이 다르다 (케빈 (3))
--
-- [★ 왜 한 값이 아니라 두 값인가]
--   신고의 비용 = **진입장벽 + 글자 수**다. 두 신고는 진입장벽이 다르다.
--     공개 신고    : 목록만 봐도 누를 수 있다        -> 장벽이 없으니 글자 수로 비용을 만든다
--     참여자 신고  : QR 입장 인증까지 마쳐야 한다    -> 이미 큰 장벽을 통과했다
--   여기에 같은 하한을 걸면, 실제로 피해를 겪은 학생(참여자)이 오히려 더 손해를 본다 —
--   겪은 사람이 귀찮아서 포기하면 이 기능은 있으나 마나가 된다.
--
-- [숫자의 근거] 30자는 한국어로 짧은 한 문장이라 "아무 말"이 통과했다(케빈 지적).
--     공개 150자   = 3~4문장. 무엇이 어떻게 원칙에 어긋나는지 설명해야 채워진다.
--     참여자 80자  = 2문장. 겪은 사람이 상황을 적으면 자연히 넘는 길이다.
--   상한은 300 -> 500 으로 함께 올린다(하한 150 에 상한 300 이면 쓸 수 있는 폭이 너무 좁다).
--   >>> 공개 하한을 낮추지 말 것. 그 숫자가 "참여도 안 하고 누르는" 신고의 유일한 비용이다.
-- =========================================================
alter table public.program_reports
  drop constraint if exists program_reports_detail_shape;

-- ---------------------------------------------------------
-- [★ 새 하한을 못 채우는 기존 신고를 먼저 정리한다]
--   어제(20260821180000) 30자 규칙으로 접수된 행들이 남아 있으면 아래 add constraint 가 23514 로
--   **마이그레이션 전체를 롤백**시킨다. 실제로 그렇게 실패했다(케빈, 2026-08-21).
--
--   [왜 유예(not valid)가 아니라 삭제인가 — reviews 와 다르게 판단한 이유]
--     같은 상황에서 reviews.comment 는 not valid 로 기존 행을 살려 뒀다(20260821120000). 기준이 다르다:
--       reviews          = 학생이 쓴 **본인의 기록**. 포트폴리오의 내용물이라 남의 규칙 변경으로 지우면 안 된다.
--       program_reports  = **다른 사람에게 영향을 주는 판정 데이터**. 이 행 3개가 모이면 남의 프로그램이
--                          내려간다. 새 비용을 치르지 않은 신고가 임계치에 기여하면
--                          "모든 신고는 이 비용을 치렀다"가 첫날부터 거짓이 된다.
--     >>> 앞으로 제약을 좁힐 때 이 기준으로 고를 것: **본인 기록이면 유예, 남에게 영향을 주면 삭제.**
--
--   [지우기 전에 확인하고 싶다면]
--     select r.id, r.reason, public.report_reason_scope(r.reason) as scope,
--            char_length(btrim(r.detail)) as len, r.detail
--       from public.program_reports r
--      where char_length(btrim(r.detail))
--            < case when public.report_reason_scope(r.reason) = 'open' then 150 else 80 end;
--
--   [재실행 안전] 두 번째 실행에서는 이미 조건을 만족하는 행만 남아 0행이 지워진다.
-- ---------------------------------------------------------
delete from public.program_reports
 where char_length(btrim(detail))
       < case when public.report_reason_scope(reason) = 'open' then 150 else 80 end
    or char_length(btrim(detail)) > 500;

alter table public.program_reports
  add constraint program_reports_detail_shape
  check (
    char_length(btrim(detail)) <= 500
    and char_length(btrim(detail)) >=
        case when public.report_reason_scope(reason) = 'open' then 150 else 80 end
  );

comment on constraint program_reports_detail_shape on public.program_reports is
  '[ADR 0026] 신고 이유는 필수이며 공백 제외 500자 이하. 하한은 사유 분류에 따라 다르다 — '
  '공개(누구나) 150자 / 참여자 전용 80자. 신고의 비용 = 진입장벽 + 글자 수이고, 두 신고는 장벽이 달라서다. '
  '>>> 공개 하한을 낮추지 말 것. 참여하지 않고 누르는 신고의 유일한 비용이다.';

-- =========================================================
-- 3. report_my_program() 재정의 — 참여자 전용 사유 게이트
--
-- [★ "참여했다"의 기준 = status in ('entered','completed')]
--   applied(신청만 함)와 waitlisted(대기)는 **그 자리에 있지 않았다.** 신청만 하고 안 간 학생이
--   "시간이 안 지켜졌다"를 신고할 수 있으면 이 분류 자체가 무의미해진다.
--   entered 는 QR 입장 인증을 통과했다는 뜻이고, 그 인증은 관리자가 카메라로 찍어 준 것이다 —
--   **학생이 스스로 만들 수 없는 증거**라 자격 판정의 근거로 쓸 수 있다.
--   >>> applied 를 여기에 더하지 말 것. 더하는 순간 "신청 한 번 = 신고 자격"이 된다.
--
-- [기간제도 같은 기준이다] attendance_sessions 를 따로 보지 않는다 — 하루라도 입장 인증을 했으면
--   participations.status 가 entered 이상이다.
-- =========================================================
create or replace function public.report_my_program(
  p_program_id uuid,
  p_reason     text,
  p_detail     text default null
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_detail  text := nullif(btrim(coalesce(p_detail, '')), '');
  v_reason  public.report_reason;
  v_scope   text;
  v_min     integer;
  v_max     constant integer := 500;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if public.is_admin() then
    raise exception '학생만 신고할 수 있습니다.' using errcode = '42501';
  end if;

  begin
    v_reason := p_reason::public.report_reason;
  exception when others then
    return jsonb_build_object('ok', false, 'reason', 'bad_reason');
  end;

  v_scope := public.report_reason_scope(v_reason);
  v_min := case when v_scope = 'open' then 150 else 80 end;

  -- 볼 수 없는 프로그램은 신고할 수 없다. (참여 확인보다 먼저 본다 — 없는 프로그램에 대해
  -- "참여하지 않았다"고 답하면 존재 여부가 새어 나간다.)
  if not exists (select 1 from public.programs p where p.id = p_program_id and p.is_published) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- [★ 참여자 전용 사유 게이트 — ADR 0026]
  if v_scope = 'participant'
     and not exists (
       select 1 from public.participations pa
        where pa.student_id = v_student
          and pa.program_id = p_program_id
          and pa.status in ('entered', 'completed')
     ) then
    return jsonb_build_object('ok', false, 'reason', 'not_participant');
  end if;

  if v_detail is null then
    return jsonb_build_object('ok', false, 'reason', 'detail_required', 'min', v_min);
  end if;
  if char_length(v_detail) < v_min or char_length(v_detail) > v_max then
    return jsonb_build_object('ok', false, 'reason', 'detail_length', 'min', v_min, 'max', v_max);
  end if;

  begin
    insert into public.program_reports (program_id, student_id, reason, detail)
    values (p_program_id, v_student, v_reason, v_detail);
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'already');
  end;

  -- [신고 수를 돌려주지 않는다] 임계치까지 몇 명 남았는지 알려주면 그 자체가 게임이 된다(원칙 1).
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.report_my_program(uuid, text, text) is
  '[ADR 0026] 학생의 프로그램 신고. 사유가 참여자 전용(report_reason_scope=participant)이면 '
  'participations.status in (entered, completed) 인 학생만 신고할 수 있다 — 신청만 한 것은 참여가 아니다. '
  '이유 서술은 필수이며 공개 150자 / 참여자 80자 이상, 500자 이하. '
  '[신고 수를 반환하지 않는다] 임계치까지 몇 명 남았는지 알려주면 그 자체가 게임이 된다.';

revoke all on function public.report_my_program(uuid, text, text) from public;
grant execute on function public.report_my_program(uuid, text, text) to authenticated;

-- =========================================================
-- 4. publish_my_program() — 게시의 유일한 경로 (케빈 (1))
--
-- [지금까지 "올리기"는 확인 없는 update 한 줄이었다]
--   목록의 버튼을 누르면 그 순간 학생 전체에게 보였다. 내리기에는 확인 창이 있었는데(확정 J)
--   **더 되돌리기 어려운 쪽**인 올리기에는 없었다 — 내린 프로그램은 아무도 못 보지만, 올린
--   프로그램은 이미 본 학생을 되돌릴 수 없다.
--
-- [검사 항목 — 전부 "학생 화면에서 사고가 되는 것"만 고른다]
--   over        : 진행이 끝난 프로그램을 목록에 올리면 신청할 수 없는 카드가 학생 화면에 쌓인다.
--                 (내리기는 언제나 되고 올리기만 막는다 — 비대칭이 의도다. ADR 0025 결정 1은
--                  "게시 상태 토글"을 열어 둔 것이고, 그 목적은 stale 알림이 요구하는 **내리기**였다.)
--   too_short   : 설명 50자 미만. 참여 팝업의 본문이 이 값이다 — 비어 있으면 학생은 무엇을 신청하는지
--                 모른 채 신청한다. (초안 저장은 계속 짧아도 된다. 게시가 문턱이다.)
--   no_session  : 기간제인데 오늘 이후 진행일이 하나도 없다 = 사실상 끝난 프로그램이다.
--
-- [사진은 필수로 하지 않는다] ADR 0022 가 "NULL 이 정상 상태"라고 못박았다. 필수로 만들면 사진을
--   구하지 못한 활동은 아예 올릴 수 없다.
-- [체크리스트는 서버가 검사하지 않는다] "학업이 아닌가"는 서버가 알 수 없는 사실이다. 그건 화면에서
--   관리자가 스스로 확인하고, 어겼을 때 학생이 공개 신고로 되돌린다(파일 상단의 대칭).
-- =========================================================
create or replace function public.publish_my_program(p_program_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_admin  uuid := auth.uid();
  v_prog   public.programs%rowtype;
  v_today  date := public.today_kst();
begin
  if v_admin is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;
  if not public.is_admin() then
    raise exception '관리자만 호출할 수 있습니다.' using errcode = '42501';
  end if;

  select * into v_prog from public.programs where id = p_program_id for update;
  -- 없는 프로그램과 남의 프로그램을 구분해 알려주지 않는다(축 A 밖은 존재 자체를 모르는 것이 맞다).
  if not found or v_prog.created_by is null or v_prog.created_by <> v_admin then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_prog.is_published then
    return jsonb_build_object('ok', false, 'reason', 'already');
  end if;

  -- 튜토리얼은 상시 진행이라 아래 날짜 검사의 대상이 아니다(ADR 0021).
  if not coalesce(v_prog.is_tutorial, false) then
    if coalesce(v_prog.end_date, v_prog.date) < v_today then
      return jsonb_build_object('ok', false, 'reason', 'over');
    end if;
    if v_prog.end_date is not null
       and not exists (
         select 1 from unnest(coalesce(v_prog.session_dates, '{}'::date[])) d where d >= v_today
       ) then
      return jsonb_build_object('ok', false, 'reason', 'no_session');
    end if;
  end if;

  if char_length(btrim(coalesce(v_prog.description, ''))) < 50 then
    return jsonb_build_object('ok', false, 'reason', 'too_short', 'min', 50);
  end if;

  -- [★ 트리거에게 "검사를 거쳤다"고 알린다] 아래 5번 게이트가 이 설정 없는 false->true 를 거부한다.
  --   트랜잭션 로컬(3번째 인자 true)이라 이 함수 밖으로 새어 나가지 않는다.
  perform set_config('accumu.publish_ok', '1', true);
  update public.programs set is_published = true where id = p_program_id;
  perform set_config('accumu.publish_ok', '', true);

  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.publish_my_program(uuid) is
  '[ADR 0026] 프로그램 게시의 유일한 경로. 내 프로그램인가 / 이미 게시중인가 / 진행이 끝났는가 / '
  '설명이 50자 이상인가 / 기간제면 남은 진행일이 있는가 를 검사한 뒤에만 is_published 를 true 로 만든다. '
  '[내리기는 이 함수의 일이 아니다] 내리기는 여전히 평범한 update 이고 언제나 허용된다 — '
  'stale 알림이 요구하는 행동이라서다(ADR 0025 결정 1). 문턱은 올리는 쪽에만 있다.';

revoke all on function public.publish_my_program(uuid) from public;
grant execute on function public.publish_my_program(uuid) to authenticated;

-- =========================================================
-- 5. programs_publish_gate — 검사를 우회한 게시를 막는다
--
-- [★ RPC 만 만들면 경계가 아니다] 프런트가 RPC 를 쓰기로 해도 개발자도구에서 update 를 직접 보내면
--   그만이다. ADR 0005 이후 이 프로젝트의 규율은 "화면에서 막는 것은 UX, 경계는 DB"였다.
--   그래서 트리거가 **false -> true 전이**만 골라서 막는다.
--
-- [왜 RLS 정책이 아닌가] 정책은 OLD 와 NEW 를 연결할 수 없어 "false 였던 행이 true 가 되는가"를
--   표현할 수 없다. programs_lock_after_end 와 같은 이유다.
--
-- [내리기·내용 수정은 그대로 통과한다] 이 트리거가 보는 것은 오직 게시 전환 하나다.
-- [시딩은 INSERT 라 무관하다] seed-programs.mjs 는 is_published=true 로 insert 한다 — update 가 아니다.
--   >>> service_role 도 이 트리거를 탄다. SQL 콘솔에서 손으로 올릴 일이 있으면 다음처럼 쓸 것:
--       select public.publish_my_program('<id>');   -- 관리자 세션에서
--       -- 또는 검사를 건너뛰어야 한다면(시연 복구용):
--       begin; select set_config('accumu.publish_ok','1',true);
--       update public.programs set is_published = true where id = '<id>'; commit;
-- =========================================================
create or replace function public.programs_publish_gate()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 게시 전환이 아니면 관여하지 않는다.
  if not (old.is_published = false and new.is_published = true) then
    return new;
  end if;

  if coalesce(nullif(current_setting('accumu.publish_ok', true), ''), '') = '1' then
    return new;
  end if;

  raise exception '게시는 publish_my_program() 을 통해서만 할 수 있습니다.' using errcode = '42501';
end;
$$;

comment on function public.programs_publish_gate() is
  '[ADR 0026] is_published 를 false -> true 로 바꾸는 update 를 publish_my_program() 경유로 제한한다. '
  '화면에서 막는 것은 UX 이고 경계는 DB 라는 이 프로젝트의 규율(ADR 0005)을 게시에도 적용한 것이다. '
  '내리기(true -> false)와 내용 수정은 이 트리거의 대상이 아니다.';

drop trigger if exists programs_publish_gate on public.programs;
create trigger programs_publish_gate
  before update on public.programs
  for each row
  execute function public.programs_publish_gate();

-- =========================================================
-- 적용 후 확인
--   0) select count(*) from public.program_reports;   -- 새 하한을 못 채우던 옛 신고는 지워졌다
--   1) 관리자 세션에서 직접 게시 시도:
--      update public.programs set is_published = true where id = '<내 초안>';   -- 42501 거부
--   2) select public.publish_my_program('<설명 50자 미만인 내 초안>');          -- {"ok":false,"reason":"too_short"}
--   3) select public.publish_my_program('<정상 초안>');                          -- {"ok":true}
--   4) select public.publish_my_program('<끝난 프로그램>');                      -- {"ok":false,"reason":"over"}
--   5) 내리기는 그대로 되는지: update ... set is_published = false;             -- 통과
--   6) 참여하지 않은 학생이 'unpunctual' 신고 -> {"ok":false,"reason":"not_participant"}
--   7) 참여(entered/completed)한 학생이 'unpunctual' + 80자 -> {"ok":true}
--   8) 아무 학생이 'inappropriate' + 149자 -> detail_length / 150자 -> {"ok":true}
-- =========================================================
