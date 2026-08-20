-- Accumu v2 — 학생 신고 → 자동 게시중단 + 관리자 행위 감사 로그 (ADR 0025)
--
-- [배경 — 케빈, 2026-08-20]
--   "관리자가 프로그램 올릴 때 지금 막을 기능이 없잖아. 아무거나 막 올린다고 해서 그걸 막을 방법이
--    없어. 그 관리자를 조금 견제할 기능도 필요할 것 같아."
--
--   맞는 지적이고, 이 프로젝트의 구조적 공백이다. 실제 유사 시스템(교육부 꿈길의 학교운영자 승인,
--   청소년수련활동 인증제의 사전 심사)은 전부 **올리는 사람과 허락하는 사람이 분리**돼 있다.
--   Accumu 는 1인 시연이라 승인자를 둘 수 없다. 그래서 사람 대신 **두 가지 장치**를 둔다:
--     (a) 아래로부터의 제동 — 학생 신고가 쌓이면 서버가 자동으로 내린다 (사람이 처리하지 않는다)
--     (b) 흔적 — 관리자의 모든 쓰기 행위가 감사 로그에 남는다 (막지는 않지만 전부 추적된다)
--
-- [★ 원칙 6 체크 — 관리자가 새로 할 수 있게 된 일은 0개다]
--   신고는 **학생** 기능이고, 자동 게시중단은 **서버** 동작이며, 감사 로그는 **읽는 화면이 없다**.
--   관리자에게 늘어나는 것은 "내 프로그램이 내려갔다"는 알림 1종뿐이고, 그건 기존 4종 기능
--   (프로그램 관리)에 관한 읽기다 — ADR 0013 이 알림·캘린더를 통과시킨 것과 같은 판정이다.
--
-- [★ 관리자는 신고를 볼 수 없다]
--   program_reports 에 관리자용 select 정책을 만들지 않는다. 자기 프로그램에 대한 것도 못 읽는다.
--   신고자를 특정할 수 있으면 보복 경로가 생기고(관리자는 담당 학생의 비밀번호를 초기화할 수 있다 —
--   ADR 0019), 그 순간 학생은 신고를 하지 않는다. 관리자가 받는 것은 "내려갔다"는 사실 하나다.
--   >>> 여기에 "신고 사유 보기"·"신고자 수 보기"를 만들지 말 것. 만드는 순간 이 기능이 죽는다.
--
-- [선행] 20260808100000 을 **먼저 단독 실행**해 notification_type 에 'reported' 를 커밋해야 한다.
--   같은 트랜잭션에서 추가한 enum 값은 그 트랜잭션 안에서 쓸 수 없다(55P04) — 그 파일 상단 참고.
-- [실행 순서] 20260808100000(재실행) -> 20260821120000 -> 이 파일.

-- =========================================================
-- 1. 신고 사유 — 이 프로젝트의 원칙에서 그대로 뽑았다
--
-- [기타를 만들되 사유 텍스트를 함께 받는다] ADR 0014 는 "기타 칸을 만들지 말 것"이라고 했는데
--   그건 **분류 축**(category) 이야기다. 신고 사유는 분류가 아니라 신고자의 진술이고, 빠져나갈
--   칸이 없으면 애매한 신고가 엉뚱한 사유로 몰려 사유 자체가 무의미해진다.
--   대신 other 를 고르면 detail 을 필수로 만든다(아래 CHECK).
-- =========================================================
do $$ begin
  create type public.report_reason as enum ('not_real', 'mismatch', 'irrelevant', 'paid', 'other');
exception
  when duplicate_object then null;
end $$;

comment on type public.report_reason is
  '프로그램 신고 사유 5종. not_real=실제로 열리지 않았다, mismatch=설명과 실제가 다르다, '
  'irrelevant=진로·커리어 활동이 아니다(CLAUDE.md 원칙 2), paid=참여에 비용이 든다(원칙: 유료 활동 금지), '
  'other=기타(detail 필수).';

-- =========================================================
-- 2. program_reports
--
-- [학생 1명당 프로그램 1건] unique 가 경계다. 한 학생이 같은 프로그램을 여러 번 신고해 임계치를
--   혼자 채우는 경로가 구조적으로 없다("서로 다른 학생 N명"이 조건인 이유).
-- [수정·취소를 만들지 않는다] update/delete 정책 0개. 신고는 진술이지 편집 가능한 문서가 아니고,
--   취소를 열면 "임계치 직전에서 넣었다 뺐다"로 게시 상태를 흔드는 장난이 가능해진다.
-- =========================================================
create table if not exists public.program_reports (
  id         uuid primary key default gen_random_uuid(),
  program_id uuid not null references public.programs(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  reason     public.report_reason not null,
  detail     text,
  created_at timestamptz not null default now(),

  constraint program_reports_once unique (program_id, student_id),
  -- 자유 서술은 선택이지만, 쓴다면 의미가 있어야 한다(reviews 와 같은 규율 — ADR 0025).
  constraint program_reports_detail_shape
    check (detail is null or char_length(btrim(detail)) between 10 and 300),
  -- other 를 골랐으면 무엇이 문제인지 적어야 한다. 안 그러면 other 가 "아무 말 없는 신고"가 된다.
  constraint program_reports_other_needs_detail
    check (reason <> 'other' or detail is not null)
);

comment on table public.program_reports is
  '[ADR 0025] 학생의 프로그램 신고. 서로 다른 학생 3명이 신고하면 서버가 자동으로 게시를 중단한다(사람이 처리하지 않는다). '
  '[관리자는 이 테이블을 읽을 수 없다] 자기 프로그램에 대한 것도 못 읽는다 — 신고자를 특정하면 보복 경로가 생긴다. '
  '[학생 1명당 1건] unique(program_id, student_id) 가 "혼자 임계치 채우기"를 구조적으로 막는다.';

create index if not exists program_reports_program_idx on public.program_reports (program_id);

alter table public.program_reports enable row level security;

-- [RLS 권한 경계] program_reports_insert_own
--   대상: authenticated + 학생(관리자 제외)
--   허용 행: student_id = auth.uid() 이고, **본인이 볼 수 있는 게시된 프로그램**에 대한 신고만.
--   불가능: 남의 이름으로 신고(student_id 위조), 관리자가 다른 관리자 프로그램 신고(is_admin 차단),
--           미게시/초안 프로그램 신고(볼 수 없는 것을 신고할 수 없다)
--   [관리자를 막는 이유] 관리자끼리 서로의 프로그램을 내리는 도구가 되면 "견제"가 아니라 무기가 된다.
drop policy if exists "program_reports_insert_own" on public.program_reports;
create policy "program_reports_insert_own"
  on public.program_reports
  for insert
  to authenticated
  with check (
    student_id = auth.uid()
    and not public.is_admin()
    and exists (
      select 1 from public.programs p
       where p.id = program_id and p.is_published = true
    )
  );

-- [RLS 권한 경계] program_reports_select_own
--   허용 행: 본인이 낸 신고. 화면이 "이미 신고함"을 그리려면 이 값이 필요하다.
--   불가능: 남의 신고 조회, 관리자의 조회(정책 자체가 student_id = auth.uid() 뿐이고 관리자는
--           그 프로그램의 신고자가 아니다), 신고 수 집계(자기 행 1개만 보이므로 count 가 무의미)
drop policy if exists "program_reports_select_own" on public.program_reports;
create policy "program_reports_select_own"
  on public.program_reports
  for select
  to authenticated
  using (student_id = auth.uid());

-- update/delete 정책 없음 = 전체 거부.

-- =========================================================
-- 3. admin_audit — 관리자 행위의 흔적
--
-- [읽는 화면이 0개다] 정책을 하나도 만들지 않는다. 앱의 어떤 키로도 이 테이블을 읽을 수 없고,
--   확인은 Supabase SQL 콘솔(service_role)에서 한다.
--   >>> 관리자 화면에 "내 활동 기록"을 만들지 말 것 — 그 순간 관리자 기능이 6번째가 되고(원칙 6),
--       무엇보다 감시 대상이 자기 감시 기록을 보는 구조가 된다.
--
-- [무엇을 남기나] 관리자가 만든 쓰기 전부:
--   program_insert / program_update / program_publish / program_unpublish
--   / auto_unpublish_reported (서버가 내린 것) / mentor_remove / password_reset(Edge Function)
--
-- [값을 통째로 남기지 않는다] changes 는 **바뀐 키만** {from, to} 로 담는다. 안 바뀐 컬럼까지
--   담으면 로그가 행 복사본이 되고, 그러면 이 테이블 자체가 두 번째 데이터 소스가 된다.
-- =========================================================
create table if not exists public.admin_audit (
  id           bigint generated always as identity primary key,
  actor_id     uuid references public.profiles(id) on delete set null,
  action       text not null,
  target_table text not null,
  target_id    uuid,
  changes      jsonb,
  created_at   timestamptz not null default now()
);

comment on table public.admin_audit is
  '[ADR 0025] 관리자 쓰기 행위의 감사 로그. 막지 않고 남긴다 — 1인 시연이라 승인자를 둘 수 없는 대신 흔적을 남긴다. '
  '[정책 0개 = 앱에서 아무도 못 읽는다] 확인은 SQL 콘솔(service_role) 전용. 관리자 화면을 만들지 말 것(원칙 6). '
  '[actor_id 가 NULL 인 행] 서버가 스스로 한 일(auto_unpublish_reported). 사람이 한 것이 아니다.';

create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
create index if not exists admin_audit_actor_idx on public.admin_audit (actor_id, created_at desc);

alter table public.admin_audit enable row level security;
-- 정책 0개 = 전체 거부. service_role 만 읽고 쓴다.

-- =========================================================
-- 4. programs 감사 트리거
--
-- [action 을 무엇이 바뀌었는지로 정한다] is_published 만 바뀌었으면 publish/unpublish,
--   그 외에는 program_update. 등록은 program_insert.
-- [★ 서버가 스스로 내린 경우를 구분한다]
--   아래 5절의 신고 트리거가 게시를 내릴 때는 auth.uid() 가 **신고한 학생**이다. 그대로 남기면
--   "학생이 프로그램을 내렸다"로 읽히는 거짓 기록이 된다. 그래서 신고 트리거가 트랜잭션 로컬
--   설정(accumu.audit_action)을 세워 두고, 여기서 그 값을 우선한다.
-- =========================================================
create or replace function public.programs_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old     jsonb;
  v_new     jsonb := to_jsonb(new);
  v_changes jsonb;
  v_action  text;
  v_forced  text := nullif(current_setting('accumu.audit_action', true), '');
begin
  if tg_op = 'INSERT' then
    insert into public.admin_audit (actor_id, action, target_table, target_id, changes)
    values (
      auth.uid(),
      'program_insert',
      'programs',
      new.id,
      jsonb_build_object('title', new.title, 'points', new.points, 'date', new.date)
    );
    return new;
  end if;

  v_old := to_jsonb(old);

  select coalesce(jsonb_object_agg(k, jsonb_build_object('from', v_old -> k, 'to', v_new -> k)), '{}'::jsonb)
    into v_changes
    from jsonb_object_keys(v_new) as k
   where v_new -> k is distinct from v_old -> k;

  -- 아무것도 안 바뀐 update 는 기록하지 않는다(같은 값 저장이 로그를 늘리지 않게).
  if v_changes = '{}'::jsonb then
    return new;
  end if;

  if v_forced is not null then
    v_action := v_forced;
  elsif (v_changes -> 'is_published') is not null
        and (select count(*) from jsonb_object_keys(v_changes)) = 1 then
    v_action := case when new.is_published then 'program_publish' else 'program_unpublish' end;
  else
    v_action := 'program_update';
  end if;

  insert into public.admin_audit (actor_id, action, target_table, target_id, changes)
  values (
    -- 서버가 스스로 한 일은 사람을 적지 않는다(위 설명).
    case when v_forced is null then auth.uid() else null end,
    v_action,
    'programs',
    new.id,
    v_changes
  );
  return new;
end;
$$;

comment on function public.programs_audit() is
  '[ADR 0025] programs 쓰기를 admin_audit 에 남긴다. changes 는 바뀐 키만 {from,to} 로 담는다(행 복사본을 만들지 않는다). '
  'accumu.audit_action 설정이 있으면 그 값을 action 으로 쓰고 actor_id 를 NULL 로 둔다 — 서버가 스스로 내린 게시중단을 '
  '"학생이 내렸다"로 잘못 기록하지 않기 위해서다.';

drop trigger if exists programs_audit on public.programs;
create trigger programs_audit
  after insert or update on public.programs
  for each row
  execute function public.programs_audit();

-- 담당 해제(ADR 0015)도 관리자의 쓰기다. 되돌릴 수 없는 행위라 오히려 흔적이 더 필요하다.
create or replace function public.mentor_students_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.admin_audit (actor_id, action, target_table, target_id, changes)
  values (
    auth.uid(),
    case when tg_op = 'DELETE' then 'mentor_remove' else 'mentor_add' end,
    'mentor_students',
    case when tg_op = 'DELETE' then old.student_id else new.student_id end,
    jsonb_build_object('admin_id', case when tg_op = 'DELETE' then old.admin_id else new.admin_id end)
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists mentor_students_audit on public.mentor_students;
create trigger mentor_students_audit
  after insert or delete on public.mentor_students
  for each row
  execute function public.mentor_students_audit();

-- =========================================================
-- 5. 신고 누적 -> 자동 게시중단
--
-- [임계치 3명] 서로 다른 학생 3명. 값을 여기 한 곳에만 둔다.
--   >>> 낮추면 소수의 장난으로 프로그램이 내려가고, 높이면 데모 규모(학생 5명)에서 도달할 수 없다.
-- [내리기만 한다 — 지우지 않는다] 학생의 참여 기록·포인트는 그대로 살아 있다(ADR 0005 결정 7-4).
--   관리자가 문제를 고치고 다시 올릴 수 있다. 신고는 삭제가 아니라 **일시 정지**다.
-- [이미 내려간 프로그램에는 아무 일도 하지 않는다] where is_published 조건이 그것을 보장하고,
--   그래서 알림도 한 번만 간다(내려간 뒤 4번째 신고가 들어와도 update 0행 = 알림 없음).
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
  --   관리자가 신고자를 특정할 수 있으면 보복 경로가 생긴다(파일 상단 참고).
  if v_owner is not null then
    insert into public.notifications (student_id, type, message, detail, program_id)
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

comment on function public.program_reports_autohide() is
  '[ADR 0025] 서로 다른 학생 3명이 신고하면 programs.is_published 를 false 로 내린다. 사람이 처리하지 않는다. '
  '삭제가 아니라 일시 정지다 — 참여 기록·포인트는 그대로이고 관리자가 고쳐서 다시 올릴 수 있다. '
  '관리자 알림에는 신고자·신고 수·사유를 담지 않는다.';

drop trigger if exists program_reports_autohide on public.program_reports;
create trigger program_reports_autohide
  after insert on public.program_reports
  for each row
  execute function public.program_reports_autohide();

-- =========================================================
-- 6. report_my_program() — 학생이 부르는 유일한 신고 경로
--
-- [정책이 있는데 RPC 를 또 두는 이유]
--   (a) 중복 신고(23505)를 에러가 아니라 {ok:false, reason:'already'} 로 돌려줘야 화면이 조용히
--       "이미 신고함"으로 맞출 수 있다. 프런트가 에러 코드를 해석하는 자리를 하나 줄인다.
--   (b) student_id 를 클라이언트가 보내지 않게 한다 — 정책이 이미 막지만 애초에 보내지 않는 것이 경계다
--       (participations 의 컬럼 grant 와 같은 태도).
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

  if v_reason = 'other' and v_detail is null then
    return jsonb_build_object('ok', false, 'reason', 'detail_required');
  end if;
  if v_detail is not null and (char_length(v_detail) < 10 or char_length(v_detail) > 300) then
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
  --   돌려주는 것은 "접수됐다" 하나다.
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.report_my_program(uuid, text, text) is
  '[ADR 0025] 학생의 프로그램 신고. 중복은 에러가 아니라 {ok:false, reason:"already"} 로 돌려준다. '
  '[신고 수를 반환하지 않는다] 임계치까지 몇 명 남았는지 알려주면 그 자체가 게임이 된다.';

revoke all on function public.report_my_program(uuid, text, text) from public;
grant execute on function public.report_my_program(uuid, text, text) to authenticated;

-- =========================================================
-- 적용 후 확인
--   1) 학생 A/B 로 같은 프로그램 신고 -> 게시 유지 (임계치 미달)
--   2) 학생 C 로 신고 -> is_published = false 로 바뀌고, 그 프로그램 관리자에게 'reported' 알림 1건
--   3) 같은 학생이 두 번 신고 -> {"ok": false, "reason": "already"} (에러가 아니다)
--   4) 관리자 세션에서 select * from public.program_reports;  -- 0행이어야 정상
--   5) 관리자 세션에서 select * from public.admin_audit;      -- 권한 오류/0행이어야 정상
--   6) SQL 콘솔에서:
--      select created_at, actor_id, action, target_id, changes from public.admin_audit order by id desc limit 20;
--      -- 2)의 자동 게시중단 행은 actor_id 가 NULL 이고 action 이 auto_unpublish_reported 여야 한다
-- =========================================================
