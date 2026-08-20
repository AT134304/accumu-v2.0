-- Accumu v2 — ADR 0025 후속 수정 2건 (2026-08-21)
--
-- 어제 들어간 것 중 두 가지를 고친다. 성격이 다르지만 둘 다 어제 만든 함수를 다시 정의하는 일이라
-- 한 파일에 둔다.
--
-- =============================================================================
-- (1) ★ 버그 — notifications 의 컬럼 이름을 틀렸다
--
--   어제 만든 두 함수가 `notifications.student_id` 를 쓴다. 그런데 그 컬럼은 20260808120000 에서
--   **`recipient_id` 로 이름이 바뀌었다**(ADR 0013 — 수신자가 학생만이 아니게 되면서).
--
--     program_reports_autohide()     insert into notifications (student_id, ...)   -> 42703
--     dismiss_my_participation()     delete from notifications where student_id=.. -> 42703
--
--   [왜 마이그레이션은 성공했는데 지금 발견되나] plpgsql 함수 본문은 **생성 시점에 검증되지 않는다.**
--   `create or replace function` 은 문법만 보고 통과시키고, 컬럼 이름은 그 함수가 처음 실행될 때
--   확인된다. 그래서 "적용 성공"과 "동작함"이 같은 뜻이 아니었다.
--   >>> 교훈: definer 함수를 새로 쓸 때 적용 성공만으로 끝내지 말고 **한 번은 실제로 호출해 볼 것.**
--       (RLS 회귀 테스트가 이 자리를 메운다 — 그 테스트도 같은 컬럼명을 써서 함께 틀렸었다.)
--
--   증상: 세 번째 신고가 들어오는 순간 함수가 42703 으로 죽어 **신고 자체가 롤백**된다(자동 게시중단도
--   일어나지 않는다). "목록에서 지우기"도 마찬가지로 전부 실패한다.
--
-- =============================================================================
-- (2) 신고에 이유를 반드시 받는다 — 최소 30자 (케빈, 2026-08-21)
--
--   "3명째에 자동 내려감인데 장난 신고일 수도 있으니까 어떤 신고를 하든 이유를 작성하게 해서
--    최소 30자로 해서 수정해줘."
--
--   전에는 `other` 를 골랐을 때만 이유가 필수였다. 나머지 4개 사유는 클릭 한 번이면 신고가 됐고,
--   그건 장난 신고의 비용이 **클릭 1회**라는 뜻이다. 세 명이 각각 한 번씩 누르면 프로그램이 내려간다.
--   이유를 30자 쓰게 하면 비용이 올라가고, 동시에 **관리자가 나중에 무엇이 문제였는지 알 수 있는
--   기록**이 남는다(관리자에게 보여주지는 않지만 SQL 콘솔에서 확인할 수 있다).
--
--   >>> 30자를 낮추지 말 것. 이 숫자가 곧 장난 신고의 비용이다.
--   >>> 그렇다고 크게 올리지도 말 것 — 진짜 문제를 겪은 학생이 귀찮아서 신고를 포기하면 견제 장치가
--       있으나 마나가 된다.
--
-- [실행 순서] 20260821160000 이후. 이 파일 하나만 실행하면 된다.

-- =========================================================
-- 1. 이유 없는 기존 신고를 정리한다
--
-- [지우는 이유] 아래에서 detail 을 필수로 만드는데, 이유 없이 접수된 행이 남아 있으면 그 행들이
--   그대로 임계치를 채운다 — "모든 신고에는 이유가 있다"는 새 규칙이 첫날부터 거짓이 된다.
-- [이 테이블은 어제 생겼다] 실사용 데이터가 아니라 시연 중 만든 몇 건이다. 운영 중인 테이블이라면
--   지우는 대신 백필하거나 not valid 로 유예했을 것이다(reviews 에서 실제로 그렇게 했다).
-- =========================================================
delete from public.program_reports where detail is null;

-- =========================================================
-- 2. detail 을 필수 + 30~300자로
--
-- [other 전용 제약을 없앤다] 모든 사유가 필수가 됐으므로 program_reports_other_needs_detail 은
--   아래 not null 에 완전히 흡수된다. 같은 규칙을 두 곳에서 말하지 않는다.
-- [not null 과 CHECK 를 둘 다 두는 이유] not null 은 "값이 있는가", CHECK 는 "그 값이 의미가 있는가"
--   를 본다. not null 만으로는 공백 30칸이 통과한다.
-- =========================================================
alter table public.program_reports
  drop constraint if exists program_reports_other_needs_detail;

alter table public.program_reports
  drop constraint if exists program_reports_detail_shape;

alter table public.program_reports
  alter column detail set not null;

alter table public.program_reports
  add constraint program_reports_detail_shape
  check (char_length(btrim(detail)) between 30 and 300);

comment on constraint program_reports_detail_shape on public.program_reports is
  '[2026-08-21] 신고 사유 서술은 필수이며 공백 제외 30~300자. 사유 종류와 무관하다 — 전에는 other 일 때만 '
  '필수였고, 나머지는 클릭 한 번이면 신고가 됐다(= 장난 신고의 비용이 클릭 1회). '
  '>>> 30 을 낮추지 말 것. 이 숫자가 곧 장난 신고의 비용이다.';

comment on column public.program_reports.detail is
  '신고 사유 서술(필수, 30~300자). 관리자에게는 보여주지 않는다 — 신고자를 특정할 수 있는 정보가 섞일 수 있고, '
  '관리자가 받는 것은 "내려갔다"는 사실 하나다(ADR 0025 결정 3-1). 확인이 필요하면 SQL 콘솔에서 읽는다.';

-- =========================================================
-- 3. report_my_program() 재정의 — 모든 사유에 이유를 요구한다
--
-- [바뀐 곳은 검증 두 줄뿐이다] other 조건부 검사 -> 무조건 검사, 하한 10 -> 30.
--   나머지(관리자 차단, 게시 여부 확인, 중복을 already 로 축약, 신고 수 미반환)는 그대로다.
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
  v_student  uuid := auth.uid();
  v_detail   text := nullif(btrim(coalesce(p_detail, '')), '');
  v_reason   public.report_reason;
  v_min      constant integer := 30;
  v_max      constant integer := 300;
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

  -- [★ 사유 종류와 무관하게 필수다 — 2026-08-21] 전에는 other 일 때만 요구했다.
  if v_detail is null then
    return jsonb_build_object('ok', false, 'reason', 'detail_required');
  end if;
  if char_length(v_detail) < v_min or char_length(v_detail) > v_max then
    return jsonb_build_object('ok', false, 'reason', 'detail_length');
  end if;

  -- 볼 수 없는 프로그램은 신고할 수 없다(정책과 같은 조건 — 여기서 먼저 사유를 분명히 만든다).
  if not exists (select 1 from public.programs p where p.id = p_program_id and p.is_published) then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  begin
    insert into public.program_reports (program_id, student_id, reason, detail)
    values (p_program_id, v_student, v_reason, v_detail);
  exception
    when unique_violation then
      return jsonb_build_object('ok', false, 'reason', 'already');
  end;

  -- [신고 수를 돌려주지 않는다] 학생이 "지금 2명이다"를 알면 임계치까지 몇 명 남았는지 세는 게임이 된다.
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.report_my_program(uuid, text, text) is
  '[ADR 0025 / 2026-08-21 개정] 학생의 프로그램 신고. **사유 종류와 무관하게 이유 서술 30~300자가 필수다.** '
  '중복은 에러가 아니라 {ok:false, reason:"already"} 로 돌려준다. '
  '[신고 수를 반환하지 않는다] 임계치까지 몇 명 남았는지 알려주면 그 자체가 게임이 된다.';

revoke all on function public.report_my_program(uuid, text, text) from public;
grant execute on function public.report_my_program(uuid, text, text) to authenticated;

-- =========================================================
-- 4. program_reports_autohide() 재정의 — notifications.recipient_id (위 (1))
--
-- [바뀐 곳은 컬럼 이름 하나다] 나머지 로직(임계치 3, 이미 내려가 있으면 아무것도 안 함,
--   감사 로그를 위한 트랜잭션 로컬 설정, 신고자를 알리지 않는 문구)은 그대로다.
-- =========================================================
create or replace function public.program_reports_autohide()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_threshold constant integer := 3;
  v_count     integer;
  v_owner     uuid;
  v_title     text;
  v_rows      integer;
begin
  select count(distinct r.student_id) into v_count
    from public.program_reports r
   where r.program_id = new.program_id;

  if v_count < v_threshold then
    return new;
  end if;

  select p.created_by, p.title into v_owner, v_title
    from public.programs p
   where p.id = new.program_id;

  -- 아래 update 가 programs_audit 트리거를 탄다. 그때 "학생이 내렸다"로 기록되지 않도록
  -- 트랜잭션 로컬 설정을 세운다(3번째 인자 true = local).
  perform set_config('accumu.audit_action', 'auto_unpublish_reported', true);

  update public.programs
     set is_published = false
   where id = new.program_id
     and is_published = true;
  get diagnostics v_rows = row_count;

  perform set_config('accumu.audit_action', '', true);

  -- 이미 내려가 있었다면 아무 일도 없었던 것이다(알림도 보내지 않는다).
  if v_rows = 0 then
    return new;
  end if;

  -- [★ 신고자를 알려주지 않는다] 학생 이름·수·사유가 메시지에 들어가지 않는다.
  --   관리자가 신고자를 특정할 수 있으면 보복 경로가 생긴다(ADR 0025 결정 3-1).
  -- [컬럼은 recipient_id 다] student_id 가 아니다 — 20260808120000 에서 이름이 바뀌었다.
  --   수신자가 학생만이 아니게 되면서(관리자도 받는다) 이름이 사실과 맞게 넓어진 것이다.
  if v_owner is not null then
    insert into public.notifications (recipient_id, type, message, detail, program_id)
    values (
      v_owner,
      'reported',
      '신고가 접수되어 프로그램 게시가 중단되었습니다',
      coalesce(v_title, '프로그램') || ' — 내용을 확인한 뒤 다시 올릴 수 있어요.',
      new.program_id
    );
  end if;

  return new;
end;
$$;

-- =========================================================
-- 5. dismiss_my_participation() 재정의 — 같은 컬럼 이름 수정
-- =========================================================
create or replace function public.dismiss_my_participation(p_participation_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_student uuid := auth.uid();
  v_p       public.participations%rowtype;
  v_prog    public.programs%rowtype;
begin
  if v_student is null then
    raise exception '인증되지 않은 호출입니다.' using errcode = '42501';
  end if;

  select * into v_p
    from public.participations
   where id = p_participation_id
   for update;

  if not found or v_p.student_id <> v_student then
    -- 없는 행과 남의 행을 구분해 알려주지 않는다(존재 여부를 캐내는 데 쓰이지 않도록).
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  if v_p.status = 'completed' then
    return jsonb_build_object('ok', false, 'reason', 'completed');
  end if;

  select * into v_prog from public.programs where id = v_p.program_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- 상시 진행(튜토리얼)은 끝나지 않는다 — ADR 0021.
  if coalesce(v_prog.is_tutorial, false) then
    return jsonb_build_object('ok', false, 'reason', 'not_over');
  end if;

  if coalesce(v_prog.end_date, v_prog.date) >= public.today_kst() then
    return jsonb_build_object('ok', false, 'reason', 'not_over');
  end if;

  -- 포인트가 한 번이라도 지급됐으면 지우지 않는다(원장 정합성 — 20260821160000 헤더 참고).
  if exists (
    select 1 from public.point_transactions t
     where t.related_participation_id = v_p.id
  ) then
    return jsonb_build_object('ok', false, 'reason', 'has_points');
  end if;

  -- 이 활동을 가리키던 내 알림도 함께 정리한다.
  -- [컬럼은 recipient_id 다] 위 4절과 같은 수정.
  delete from public.notifications
   where recipient_id = v_student
     and program_id = v_p.program_id;

  -- attendance_sessions 는 on delete cascade 로 함께 사라진다(20260809140000).
  delete from public.participations where id = v_p.id;

  return jsonb_build_object('ok', true);
end;
$$;

-- =========================================================
-- 적용 후 확인
--   1) select count(*) from public.program_reports where detail is null;   -- 0 이어야 한다
--   2) 학생 세션에서 이유 없이 신고 -> {"ok": false, "reason": "detail_required"}
--   3) 29자로 신고 -> {"ok": false, "reason": "detail_length"} / 30자 -> {"ok": true}
--   4) ★ 서로 다른 학생 3명이 신고 -> 게시중단 + 관리자에게 'reported' 알림 1건
--      (여기가 (1)의 버그로 죽던 자리다. 이제 통과해야 한다.)
--   5) ★ 끝난 프로그램의 참여로 dismiss_my_participation() -> {"ok": true}
--      (알림 삭제 문장에서 죽던 자리다.)
--   6) npm run test:rls  -- 전부 통과
-- =========================================================
